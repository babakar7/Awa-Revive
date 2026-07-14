import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { pool, migrate } from "../../src/db/index.js";
import { escalateStaleLinkRequests } from "../../src/domain/linkRequests.js";
import { seedClient, truncateAll } from "./helpers.js";

/**
 * The stale-link-request sweep must NOT escalate an orphan AWAITING request
 * when the client already has a linked account (prod 13/07 — Alicia: her
 * account WAS created, a duplicate request still got queued to reception with a
 * misleading "vérification jamais aboutie"). Such orphans are auto-DISMISSED;
 * genuinely unresolved requests still escalate.
 */

const STALE = "now() - interval '40 minutes'"; // > STALE_AFTER_MINUTES (30)

async function seedRequest(
  clientId: string,
  status: string,
  stale: boolean,
  emailsSent = 0,
): Promise<string> {
  const res = await pool.query(
    `insert into link_requests (client_id, status, emails_sent, updated_at)
     values ($1, $2, $3, ${stale ? STALE : "now()"})
     returning id`,
    [clientId, status, emailsSent],
  );
  return res.rows[0].id;
}

const statusOf = async (id: string): Promise<string> =>
  (await pool.query(`select status from link_requests where id = $1`, [id])).rows[0].status;

const detailOf = async (id: string): Promise<string> =>
  (await pool.query(`select detail from link_requests where id = $1`, [id])).rows[0].detail;

beforeAll(async () => {
  await migrate();
});

afterAll(async () => {
  await pool.end();
});

beforeEach(async () => {
  await truncateAll();
});

describe("escalateStaleLinkRequests — already-linked guard", () => {
  it("auto-dismisses a stale orphan when the client is already VERIFIED", async () => {
    const client = await seedClient({ wa_phone: "221771111111" });
    const orphan = await seedRequest(client.id, "AWAITING_EMAIL", true);
    await seedRequest(client.id, "VERIFIED", false); // account already sorted

    await escalateStaleLinkRequests();

    expect(await statusOf(orphan)).toBe("DISMISSED");
  });

  it("still escalates a stale request when the client is NOT linked", async () => {
    const client = await seedClient({ wa_phone: "221772222222" });
    const pending = await seedRequest(client.id, "AWAITING_CODE", true);

    await escalateStaleLinkRequests();

    expect(await statusOf(pending)).toBe("NEEDS_RECEPTION");
  });

  it("leaves a fresh (non-stale) request untouched even if it is an orphan", async () => {
    const client = await seedClient({ wa_phone: "221773333333" });
    const fresh = await seedRequest(client.id, "AWAITING_EMAIL", false);
    await seedRequest(client.id, "LINKED", false);

    await escalateStaleLinkRequests();

    expect(await statusOf(fresh)).toBe("AWAITING_EMAIL");
  });

  it("detail says 'jamais démarré' when no code was ever sent (emails_sent = 0)", async () => {
    // Prod 14/07 Rama: an email was given but no code sent — the escalation
    // must not claim the verification was attempted-and-failed.
    const client = await seedClient({ wa_phone: "221774444444" });
    const pending = await seedRequest(client.id, "AWAITING_EMAIL", true, 0);

    await escalateStaleLinkRequests();

    expect(await detailOf(pending)).toContain("jamais démarré");
  });

  it("detail says 'jamais terminée' when a code was sent but never confirmed", async () => {
    const client = await seedClient({ wa_phone: "221775555555" });
    const pending = await seedRequest(client.id, "AWAITING_CODE", true, 1);

    await escalateStaleLinkRequests();

    expect(await detailOf(pending)).toContain("jamais terminée");
  });
});
