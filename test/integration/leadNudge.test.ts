import { afterAll, beforeAll, beforeEach, afterEach, describe, expect, it } from "vitest";
import { migrate, pool } from "../../src/db/index.js";
import { config } from "../../src/config.js";
import { PACK_DISCOVERY_CAMPAIGN } from "../../src/domain/packDiscoveryCampaign.js";
import { sweepSilentLeadNudges } from "../../src/domain/leadNudge.js";
import {
  silentLeadCandidates,
  claimSilentLeadNudge,
  markOutboundNudgeFailedByWamid,
  silentLeadDedupKey,
} from "../../src/domain/leadNudgeRepo.js";
import { makeFetchMock, seedClient, truncateAll, type FetchMock } from "./helpers.js";

let mock: FetchMock;
const log = { info() {}, error() {} };

const original = {
  enabled: config.LEAD_NUDGE_ENABLED,
  quietStart: config.LEAD_NUDGE_QUIET_START,
  quietEnd: config.LEAD_NUDGE_QUIET_END,
  delay: config.LEAD_NUDGE_DELAY_MINUTES,
  maxAge: config.LEAD_NUDGE_MAX_AGE_HOURS,
  holdout: config.LEAD_NUDGE_HOLDOUT_MOD,
};

beforeAll(async () => {
  await migrate();
  mock = makeFetchMock();
  mock.install();
});

afterAll(async () => {
  mock.restore();
  await pool.end();
});

beforeEach(async () => {
  await truncateAll();
  mock.reset();
  config.LEAD_NUDGE_ENABLED = true;
  config.LEAD_NUDGE_QUIET_START = 0; // start == end → never quiet (time-of-day independent)
  config.LEAD_NUDGE_QUIET_END = 0;
  config.LEAD_NUDGE_DELAY_MINUTES = 180;
  config.LEAD_NUDGE_MAX_AGE_HOURS = 22;
  config.LEAD_NUDGE_HOLDOUT_MOD = 0; // everyone treatment unless a test overrides
});

afterEach(() => {
  Object.assign(config, {
    LEAD_NUDGE_ENABLED: original.enabled,
    LEAD_NUDGE_QUIET_START: original.quietStart,
    LEAD_NUDGE_QUIET_END: original.quietEnd,
    LEAD_NUDGE_DELAY_MINUTES: original.delay,
    LEAD_NUDGE_MAX_AGE_HOURS: original.maxAge,
    LEAD_NUDGE_HOLDOUT_MOD: original.holdout,
  });
});

/** A lead who clicked the ad, got Awa's pitch, and never wrote back. */
async function seedSilentLead(opts: {
  phone: string;
  name?: string;
  language?: string;
  triggerAgoH?: number;
  pitchAgoMin?: number;
  priorHistory?: boolean;
}) {
  const client = await seedClient({
    wa_phone: opts.phone,
    name: opts.name ?? "Lead",
    language: opts.language ?? "fr",
  });
  const triggerWamid = `trigger-${opts.phone}`;
  await pool.query(
    `insert into campaign_leads (client_id, campaign_key, trigger_message_id, matched_by)
     values ($1, $2, $3, 'meta_referral')`,
    [client.id, PACK_DISCOVERY_CAMPAIGN, triggerWamid],
  );
  if (opts.priorHistory) {
    // Old back-and-forth from a previous relationship, BEFORE the ad click.
    await pool.query(
      `insert into conversations (client_id, role, content, created_at) values
         ($1, 'user', 'ancienne question', now() - interval '10 days'),
         ($1, 'assistant', 'ancienne réponse', now() - interval '10 days')`,
      [client.id],
    );
  }
  await pool.query(
    `insert into conversations (client_id, role, content, wa_message_id, created_at)
     values ($1, 'user', 'Bonjour, je veux réserver la clé invité', $2,
             now() - make_interval(hours => $3))`,
    [client.id, triggerWamid, opts.triggerAgoH ?? 4],
  );
  await pool.query(
    `insert into conversations (client_id, role, content, created_at)
     values ($1, 'assistant', 'pitch Awa L''Invitée', now() - make_interval(mins => $2))`,
    [client.id, opts.pitchAgoMin ?? 210],
  );
  return client;
}

async function nudgeRow(clientId: string) {
  const res = await pool.query(`select * from outbound_nudges where dedup_key = $1`, [
    silentLeadDedupKey(clientId),
  ]);
  return res.rows[0];
}

describe("silent-lead nudge (relance A)", () => {
  it("nudges a silent lead once, records TREATMENT/SENT and journals the turn", async () => {
    const c = await seedSilentLead({ phone: "221770001001", name: "Fatou" });

    const sent = await sweepSilentLeadNudges(log);
    expect(sent).toBe(1);

    const texts = mock.waTextsTo("221770001001");
    expect(texts).toHaveLength(1);
    expect(texts[0]).toContain("L'Invitée");
    expect(texts[0]).toContain("Fatou");

    const row = await nudgeRow(c.id);
    expect(row.arm).toBe("TREATMENT");
    expect(row.outcome).toBe("SENT");
    expect(row.sent_at).not.toBeNull();
    expect(row.wa_message_id).toMatch(/^wamid\./);

    // journaled so Awa has context when they reply
    const turns = await pool.query(
      `select count(*)::int as n from conversations
        where client_id = $1 and role = 'assistant' and content like '%L''Invitée%'
          and wa_message_id is not null`,
      [c.id],
    );
    expect(turns.rows[0].n).toBe(1);

    // one-shot: a second sweep sends nothing more
    const again = await sweepSilentLeadNudges(log);
    expect(again).toBe(0);
    expect(mock.waTextsTo("221770001001")).toHaveLength(1);
  });

  it("refuses the claim when a reply lands between selection and claim (ITT race)", async () => {
    const c = await seedSilentLead({ phone: "221770001002" });

    const before = await silentLeadCandidates({
      campaignKey: PACK_DISCOVERY_CAMPAIGN,
      delayMinutes: 180,
      maxAgeHours: 22,
    });
    expect(before.map((r) => r.client_id)).toContain(c.id);

    // The lead replies right after we selected them.
    await pool.query(
      `insert into conversations (client_id, role, content) values ($1, 'user', 'oui le matin')`,
      [c.id],
    );

    const claimed = await claimSilentLeadNudge({
      clientId: c.id,
      campaignKey: PACK_DISCOVERY_CAMPAIGN,
      arm: "TREATMENT",
      delayMinutes: 180,
      maxAgeHours: 22,
    });
    expect(claimed).toBe(false);
    expect(await nudgeRow(c.id)).toBeUndefined();
  });

  it("excludes a lead who already entered the payment funnel (EXPIRED plan order)", async () => {
    const c = await seedSilentLead({ phone: "221770001003" });
    await pool.query(
      `insert into pending_plan_orders (client_id, plan_id, plan_name, amount_xof, status, payment_link)
       values ($1, 'plan-invitee', 'L''Invitée — Clé 3 séances', 30000, 'EXPIRED', 'https://pay.wave.com/x')`,
      [c.id],
    );

    const candidates = await silentLeadCandidates({
      campaignKey: PACK_DISCOVERY_CAMPAIGN,
      delayMinutes: 180,
      maxAgeHours: 22,
    });
    expect(candidates.map((r) => r.client_id)).not.toContain(c.id);
  });

  it("still nudges an old client with prior history who clicks the ad (trigger anchoring)", async () => {
    const c = await seedSilentLead({ phone: "221770001004", priorHistory: true });

    const candidates = await silentLeadCandidates({
      campaignKey: PACK_DISCOVERY_CAMPAIGN,
      delayMinutes: 180,
      maxAgeHours: 22,
    });
    // count-based "one user message ever" logic would wrongly drop them
    expect(candidates.map((r) => r.client_id)).toContain(c.id);
  });

  it("assigns the holdout arm and never sends (SUPPRESSED)", async () => {
    config.LEAD_NUDGE_HOLDOUT_MOD = 1; // fnv1aMod(id, 1) === 0 → everyone control
    const c = await seedSilentLead({ phone: "221770001005" });

    const sent = await sweepSilentLeadNudges(log);
    expect(sent).toBe(0);
    expect(mock.waTextsTo("221770001005")).toHaveLength(0);

    const row = await nudgeRow(c.id);
    expect(row.arm).toBe("HOLDOUT");
    expect(row.outcome).toBe("SUPPRESSED");
    expect(row.sent_at).toBeNull();

    // still assigned, never re-processed
    const again = await sweepSilentLeadNudges(log);
    expect(again).toBe(0);
    const rows = await pool.query(`select count(*)::int as n from outbound_nudges where client_id = $1`, [c.id]);
    expect(rows.rows[0].n).toBe(1);
  });

  it("flips SENT→FAILED on an async Meta failure, leaving the arm untouched (ITT)", async () => {
    const c = await seedSilentLead({ phone: "221770001006" });
    await sweepSilentLeadNudges(log);
    const before = await nudgeRow(c.id);
    expect(before.outcome).toBe("SENT");

    const flipped = await markOutboundNudgeFailedByWamid(before.wa_message_id, "131047 re-engagement");
    expect(flipped).toBe(1);

    const after = await nudgeRow(c.id);
    expect(after.outcome).toBe("FAILED");
    expect(after.arm).toBe("TREATMENT"); // assignment is immutable
  });

  it("gates both arms on the identical guard (open handoff blocks treatment and holdout alike)", async () => {
    const treated = await seedSilentLead({ phone: "221770001007" });
    const control = await seedSilentLead({ phone: "221770001008" });
    for (const id of [treated.id, control.id]) {
      await pool.query(
        `insert into handoffs (client_id, status) values ($1, 'OPEN')`,
        [id],
      );
    }

    const candidates = await silentLeadCandidates({
      campaignKey: PACK_DISCOVERY_CAMPAIGN,
      delayMinutes: 180,
      maxAgeHours: 22,
    });
    expect(candidates).toHaveLength(0);

    const t = await claimSilentLeadNudge({
      clientId: treated.id, campaignKey: PACK_DISCOVERY_CAMPAIGN,
      arm: "TREATMENT", delayMinutes: 180, maxAgeHours: 22,
    });
    const h = await claimSilentLeadNudge({
      clientId: control.id, campaignKey: PACK_DISCOVERY_CAMPAIGN,
      arm: "HOLDOUT", delayMinutes: 180, maxAgeHours: 22,
    });
    expect(t).toBe(false);
    expect(h).toBe(false);
  });

  it("does not nudge before the silence delay has elapsed", async () => {
    // Awa answered only 30 min ago — too soon.
    await seedSilentLead({ phone: "221770001009", pitchAgoMin: 30 });
    const sent = await sweepSilentLeadNudges(log);
    expect(sent).toBe(0);
  });

  it("does not nudge past the 24h window bound", async () => {
    // Last inbound 23h ago — outside LEAD_NUDGE_MAX_AGE_HOURS.
    await seedSilentLead({ phone: "221770001010", triggerAgoH: 23, pitchAgoMin: 1370 });
    const sent = await sweepSilentLeadNudges(log);
    expect(sent).toBe(0);
  });

  it("is a no-op while disabled", async () => {
    config.LEAD_NUDGE_ENABLED = false;
    await seedSilentLead({ phone: "221770001011" });
    expect(await sweepSilentLeadNudges(log)).toBe(0);
  });
});
