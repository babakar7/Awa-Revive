import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { pool, migrate } from "../../src/db/index.js";
import { claimOrReclaim, finishLog } from "../../src/domain/notificationRepo.js";
import { truncateAll } from "./helpers.js";

/**
 * The claim-before-send dedup of the staff-notification sweep. Regression for a
 * prod bug (19/07): the unique index on dedup_key is PARTIAL (where dedup_key
 * is not null), so the INSERT's ON CONFLICT must repeat that predicate —
 * without it Postgres raises 42P10 on EVERY claim and no rule ever sends.
 */

const RULE_ID = "00000000-0000-4000-8000-000000000001";
const SLOT = { startDate: "2026-07-20T17:15:00Z", endDate: "2026-07-20T18:05:00Z" };

beforeAll(async () => {
  await migrate();
  await pool.query(
    `insert into notification_rules (id, label, kind, message_template)
     values ($1, 'test rule', 'class_reminder', 'x') on conflict (id) do nothing`,
    [RULE_ID],
  );
});

afterAll(async () => {
  await pool.end();
});

beforeEach(async () => {
  await pool.query(`delete from notification_log`);
});

describe("claimOrReclaim (notification dedup)", () => {
  it("claims a fresh key, then refuses the same key (no 42P10)", async () => {
    expect(await claimOrReclaim("k1", RULE_ID, SLOT)).toBe(true);
    // Second claim of the same occurrence: silently refused, NOT a DB error.
    expect(await claimOrReclaim("k1", RULE_ID, SLOT)).toBe(false);
    const rows = await pool.query(`select status from notification_log where dedup_key='k1'`);
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0].status).toBe("claimed");
  });

  it("does not conflict with reception/test log rows that have NULL dedup_key", async () => {
    await pool.query(
      `insert into notification_log (source, status) values ('reception','sent'), ('reception','sent')`,
    );
    expect(await claimOrReclaim("k2", RULE_ID, SLOT)).toBe(true);
  });

  it("reclaims a stuck claim after 2 minutes, not before", async () => {
    expect(await claimOrReclaim("k3", RULE_ID, SLOT)).toBe(true);
    expect(await claimOrReclaim("k3", RULE_ID, SLOT)).toBe(false);
    await pool.query(
      `update notification_log set created_at = now() - interval '3 minutes' where dedup_key='k3'`,
    );
    expect(await claimOrReclaim("k3", RULE_ID, SLOT)).toBe(true);
  });

  it("finishLog finalizes the claimed row", async () => {
    await claimOrReclaim("k4", RULE_ID, SLOT);
    await finishLog("k4", "sent", { recipientPhone: "+221770000000", body: "hello" });
    const r = await pool.query(
      `select status, recipient_phone from notification_log where dedup_key='k4'`,
    );
    expect(r.rows[0]).toMatchObject({ status: "sent", recipient_phone: "+221770000000" });
  });
});
