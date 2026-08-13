import { afterAll, beforeAll, beforeEach, afterEach, describe, expect, it } from "vitest";
import { pool } from "../../src/db/index.js";
import { config } from "../../src/config.js";
import { PACK_DISCOVERY_CAMPAIGN } from "../../src/domain/packDiscoveryCampaign.js";
import { sendManualLeadNudge, skipLeadNudge } from "../../src/domain/leadNudge.js";
import {
  silentLeadCandidates,
  countSilentLeadCandidates,
  silentLeadDedupKey,
  markOutboundNudgeFailedByWamid,
} from "../../src/domain/leadNudgeRepo.js";
import { makeFetchMock, seedClient, truncateAll, type FetchMock } from "./helpers.js";

let mock: FetchMock;
const log = { info() {}, error() {} };

const original = {
  delay: config.LEAD_NUDGE_DELAY_MINUTES,
  maxAge: config.LEAD_NUDGE_MAX_AGE_HOURS,
};

beforeAll(async () => {
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
  config.LEAD_NUDGE_DELAY_MINUTES = 180;
  config.LEAD_NUDGE_MAX_AGE_HOURS = 22;
});

afterEach(() => {
  config.LEAD_NUDGE_DELAY_MINUTES = original.delay;
  config.LEAD_NUDGE_MAX_AGE_HOURS = original.maxAge;
});

const params = () => ({
  campaignKey: PACK_DISCOVERY_CAMPAIGN,
  delayMinutes: config.LEAD_NUDGE_DELAY_MINUTES,
  maxAgeHours: config.LEAD_NUDGE_MAX_AGE_HOURS,
});

/**
 * A lead who clicked the ad (auto pre-filled message) then had a back-and-forth
 * with Awa and went quiet. `replies` = genuine typed replies AFTER the
 * auto-message (2+ = a warm candidate; 0 = reflex clicker; 1 = shallow).
 * lastAssistantAgoMin controls the stall depth; Awa always answers last.
 */
async function seedLead(opts: {
  phone: string;
  name?: string;
  language?: string;
  replies?: number;
  triggerAgoMin?: number;
  lastAssistantAgoMin?: number;
  priorHistory?: boolean;
}) {
  const client = await seedClient({
    wa_phone: opts.phone,
    name: opts.name ?? "Lead",
    language: opts.language ?? "fr",
  });
  const triggerWamid = `trigger-${opts.phone}`;
  const triggerAgo = opts.triggerAgoMin ?? 360;
  const replies = opts.replies ?? 2;
  const lastAssistantAgo = opts.lastAssistantAgoMin ?? 210;
  await pool.query(
    `insert into campaign_leads (client_id, campaign_key, trigger_message_id, matched_by)
     values ($1, $2, $3, 'meta_referral')`,
    [client.id, PACK_DISCOVERY_CAMPAIGN, triggerWamid],
  );
  if (opts.priorHistory) {
    await pool.query(
      `insert into conversations (client_id, role, content, created_at) values
         ($1, 'user', 'ancienne question', now() - interval '10 days'),
         ($1, 'assistant', 'ancienne réponse', now() - interval '10 days')`,
      [client.id],
    );
  }
  // The auto-filled ad message (the trigger).
  await pool.query(
    `insert into conversations (client_id, role, content, wa_message_id, created_at)
     values ($1, 'user', 'Bonjour, je veux réserver la clé invité', $2,
             now() - make_interval(mins => $3))`,
    [client.id, triggerWamid, triggerAgo],
  );
  // R genuine replies after the trigger (spaced so all sit before the last Awa turn).
  for (let i = 0; i < replies; i++) {
    await pool.query(
      `insert into conversations (client_id, role, content, created_at)
       values ($1, 'user', 'question du lead', now() - make_interval(mins => $2))`,
      [client.id, triggerAgo - 60 - i * 10],
    );
  }
  // Awa answers last → stalled with the ball in the lead's court.
  await pool.query(
    `insert into conversations (client_id, role, content, created_at)
     values ($1, 'assistant', 'réponse Awa L''Invitée', now() - make_interval(mins => $2))`,
    [client.id, lastAssistantAgo],
  );
  return client;
}

async function nudgeRow(clientId: string) {
  const res = await pool.query(`select * from outbound_nudges where dedup_key = $1`, [
    silentLeadDedupKey(clientId),
  ]);
  return res.rows[0];
}

describe("manual warm-lead nudge (/admin/relances)", () => {
  it("lists a warm lead (2+ replies) with its exchange count and counts it", async () => {
    const c = await seedLead({ phone: "221770001001", name: "Fatou", replies: 2 });
    const list = await silentLeadCandidates(params());
    const row = list.find((r) => r.client_id === c.id);
    expect(row).toBeTruthy();
    expect(row!.replies_after_trigger).toBe(2);
    expect(row!.last_user_at).toBeTruthy();
    expect(await countSilentLeadCandidates(params())).toBe(1);
  });

  it("does NOT list a reflex clicker who never replied (0 replies)", async () => {
    await seedLead({ phone: "221770001101", replies: 0 });
    expect(await countSilentLeadCandidates(params())).toBe(0);
  });

  it("does NOT list a shallow lead with a single reply (1 reply)", async () => {
    await seedLead({ phone: "221770001102", replies: 1 });
    expect(await countSilentLeadCandidates(params())).toBe(0);
  });

  it("sends one nudge on demand: MANUAL/SENT, journaled, one-shot", async () => {
    const c = await seedLead({ phone: "221770001002", name: "Fatou", replies: 2 });

    const result = await sendManualLeadNudge(c.id, "reception", log);
    expect(result.status).toBe("sent");

    const texts = mock.waTextsTo("221770001002");
    expect(texts).toHaveLength(1);
    expect(texts[0]).toContain("L'Invitée");
    expect(texts[0]).toContain("Fatou");

    const row = await nudgeRow(c.id);
    expect(row.arm).toBe("MANUAL");
    expect(row.outcome).toBe("SENT");
    expect(row.sent_at).not.toBeNull();
    expect(row.wa_message_id).toMatch(/^wamid\./);
    expect(row.detail).toBe("manual:reception");

    // journaled so Awa has context when they reply
    const turns = await pool.query(
      `select count(*)::int as n from conversations
        where client_id = $1 and role = 'assistant' and content like '%L''Invitée%'
          and wa_message_id is not null`,
      [c.id],
    );
    expect(turns.rows[0].n).toBe(1);

    // one-shot: the lead is gone from the list and re-send is refused
    expect((await silentLeadCandidates(params())).map((r) => r.client_id)).not.toContain(c.id);
    const again = await sendManualLeadNudge(c.id, "reception", log);
    expect(again.status).toBe("gone");
    expect(mock.waTextsTo("221770001002")).toHaveLength(1);
  });

  it("refuses to send (status=gone) when a reply lands before the click (race)", async () => {
    const c = await seedLead({ phone: "221770001003", replies: 2 });
    // The lead replies between page load and the reception clicking Send.
    await pool.query(
      `insert into conversations (client_id, role, content) values ($1, 'user', 'oui le matin')`,
      [c.id],
    );
    const result = await sendManualLeadNudge(c.id, "reception", log);
    expect(result.status).toBe("gone");
    expect(mock.waTextsTo("221770001003")).toHaveLength(0);
    expect(await nudgeRow(c.id)).toBeUndefined();
  });

  it("skip records a one-shot dismissal and drops the lead off the list", async () => {
    const c = await seedLead({ phone: "221770001004", replies: 2 });
    const result = await skipLeadNudge(c.id, "reception");
    expect(result.status).toBe("skipped");

    const row = await nudgeRow(c.id);
    expect(row.outcome).toBe("SUPPRESSED");
    expect(row.arm).toBe("MANUAL");
    expect(row.detail).toBe("manual_skip:reception");
    expect(mock.waTextsTo("221770001004")).toHaveLength(0);

    // gone from the list; a later send is refused
    expect((await silentLeadCandidates(params())).map((r) => r.client_id)).not.toContain(c.id);
    expect((await sendManualLeadNudge(c.id, "reception", log)).status).toBe("gone");
  });

  it("excludes a lead already in the payment funnel (EXPIRED plan order)", async () => {
    const c = await seedLead({ phone: "221770001005", replies: 2 });
    await pool.query(
      `insert into pending_plan_orders (client_id, plan_id, plan_name, amount_xof, status, payment_link)
       values ($1, 'plan-invitee', 'L''Invitée — Clé 3 séances', 30000, 'EXPIRED', 'https://pay.wave.com/x')`,
      [c.id],
    );
    expect((await silentLeadCandidates(params())).map((r) => r.client_id)).not.toContain(c.id);
    // and a direct send is refused too
    expect((await sendManualLeadNudge(c.id, "reception", log)).status).toBe("gone");
  });

  it("still lists an old client with prior history who clicks the ad (trigger anchoring)", async () => {
    const c = await seedLead({ phone: "221770001006", priorHistory: true, replies: 2 });
    expect((await silentLeadCandidates(params())).map((r) => r.client_id)).toContain(c.id);
  });

  it("does not list a lead under an open handoff, and a send is refused", async () => {
    const c = await seedLead({ phone: "221770001007", replies: 2 });
    await pool.query(`insert into handoffs (client_id, status) values ($1, 'OPEN')`, [c.id]);
    expect((await silentLeadCandidates(params())).map((r) => r.client_id)).not.toContain(c.id);
    expect((await sendManualLeadNudge(c.id, "reception", log)).status).toBe("gone");
  });

  it("flips SENT→FAILED on an async Meta failure (delivery-rate honesty)", async () => {
    const c = await seedLead({ phone: "221770001008", replies: 2 });
    await sendManualLeadNudge(c.id, "reception", log);
    const before = await nudgeRow(c.id);
    expect(before.outcome).toBe("SENT");

    const flipped = await markOutboundNudgeFailedByWamid(before.wa_message_id, "131047 re-engagement");
    expect(flipped).toBe(1);
    expect((await nudgeRow(c.id)).outcome).toBe("FAILED");
  });

  it("does not list a lead before the silence delay has elapsed", async () => {
    // Awa answered only 30 min ago — still a live conversation, not a stall.
    await seedLead({ phone: "221770001009", replies: 2, lastAssistantAgoMin: 30 });
    expect(await countSilentLeadCandidates(params())).toBe(0);
  });

  it("does not list a lead past the 24h window bound", async () => {
    // Last inbound ~23.8h ago — outside the free-text window.
    await seedLead({ phone: "221770001010", replies: 2, triggerAgoMin: 1500, lastAssistantAgoMin: 1400 });
    expect(await countSilentLeadCandidates(params())).toBe(0);
  });

  it("treats a fresh reply as un-stalling the lead (Awa now owes them)", async () => {
    const c = await seedLead({ phone: "221770001011", replies: 2 });
    // Lead just wrote again → last message is theirs, Awa hasn't answered.
    await pool.query(
      `insert into conversations (client_id, role, content) values ($1, 'user', 'une relance du lead')`,
      [c.id],
    );
    expect((await silentLeadCandidates(params())).map((r) => r.client_id)).not.toContain(c.id);
  });
});
