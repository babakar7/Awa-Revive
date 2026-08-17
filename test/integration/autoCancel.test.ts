import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { pool } from "../../src/db/index.js";
import * as acrepo from "../../src/domain/autoCancelRepo.js";
import { guardBooking, OccurrenceCancelledError, isSessionAutoCancelled } from "../../src/domain/autoCancelGuard.js";
import * as repo from "../../src/domain/repo.js";
import { truncateAll, seedClient } from "./helpers.js";

/**
 * Integration coverage for the empty-class auto-cancellation engine's DB layer:
 * rule CRUD + activation validation, the occurrence ledger, active-payment
 * protection, the shared occurrence advisory lock, and the booking-path guard.
 */

afterAll(async () => {
  await pool.end();
});

beforeEach(async () => {
  await truncateAll();
});

async function seedContact(
  name: string,
  phone: string,
  muted = false,
  role = "staff",
): Promise<string> {
  const res = await pool.query(
    `insert into staff_contacts (name, phone, muted, role) values ($1,$2,$3,$4) returning id`,
    [name, phone, muted, role],
  );
  return res.rows[0].id;
}

async function seedRule(over: Partial<acrepo.RuleInput> = {}): Promise<string> {
  await acrepo.createRule({
    label: over.label ?? "test",
    service_ids: over.service_ids ?? ["svc-1"],
    weekdays: over.weekdays ?? [],
    start_min_from: over.start_min_from ?? null,
    start_min_to: over.start_min_to ?? null,
    owner_contact_id: over.owner_contact_id ?? null,
    manager_contact_id: over.manager_contact_id ?? null,
    alert_opener: over.alert_opener ?? false,
    enabled: over.enabled ?? false,
  });
  const r = await pool.query(`select id from auto_cancel_rules where label = $1 order by created_at desc limit 1`, [
    over.label ?? "test",
  ]);
  return r.rows[0].id;
}

describe("auto-cancel rule CRUD + activation", () => {
  it("round-trips a rule; owner implicit, manager chosen, alert_opener flag persisted", async () => {
    const manager = await seedContact("Manager", "+221771112202");
    const id = await seedRule({
      label: "reformer matin",
      service_ids: ["reformer-foundation", "reformer-intense"],
      weekdays: [1, 2, 3],
      start_min_from: 7 * 60,
      start_min_to: 10 * 60,
      manager_contact_id: manager,
      alert_opener: true,
      enabled: true,
    });
    const rule = (await acrepo.getRule(id))!;
    expect(rule.service_ids).toEqual(["reformer-foundation", "reformer-intense"]);
    expect(rule.weekdays).toEqual([1, 2, 3]);
    expect(rule.start_min_from).toBe(420);
    expect(rule.alert_opener).toBe(true);
    // No owner contact was chosen; alert_opener never blocks activation.
    expect(acrepo.ownerRecipient()).not.toBeNull();
    expect(await acrepo.ruleActivationError(rule)).toBeNull();
  });

  it("blocks activation on missing / muted / owner-equal manager", async () => {
    const muted = await seedContact("Muted", "+221771112203", true);
    const ownerPhone = acrepo.ownerRecipient()!.phone;
    const clashing = await seedContact("Clash", ownerPhone);

    const noManager = (await acrepo.getRule(await seedRule({ label: "a" })))!;
    expect(await acrepo.ruleActivationError(noManager)).toMatch(/manager/);

    const mutedRule = (await acrepo.getRule(
      await seedRule({ label: "c", manager_contact_id: muted }),
    ))!;
    expect(await acrepo.ruleActivationError(mutedRule)).toMatch(/muet/);

    const clashRule = (await acrepo.getRule(
      await seedRule({ label: "d", manager_contact_id: clashing }),
    ))!;
    expect(await acrepo.ruleActivationError(clashRule)).toMatch(/différent de toi/);
  });
});

describe("openerForWeekday (accueil du planning publié)", () => {
  async function publishShifts(
    shifts: Array<{ staffId: string; weekday: number; start: number; end: number }>,
  ): Promise<void> {
    const sched = await pool.query(
      `insert into staff_schedules (name, status) values ('test', 'published') returning id`,
    );
    const scheduleId = sched.rows[0].id;
    for (const s of shifts) {
      await pool.query(
        `insert into staff_shifts (schedule_id, staff_id, weekday, start_min, end_min)
         values ($1,$2,$3,$4,$5)`,
        [scheduleId, s.staffId, s.weekday, s.start, s.end],
      );
    }
  }

  it("returns the earliest 'accueil' shift on that weekday", async () => {
    // Monday (planning weekday 0): Fatou opens at 06:45, Awa starts later at 09:00.
    const fatou = await seedContact("Fatou", "+221770001122", false, "accueil");
    const late = await seedContact("Awa", "+221770003344", false, "accueil");
    await publishShifts([
      { staffId: fatou, weekday: 0, start: 405, end: 900 }, // 06:45
      { staffId: late, weekday: 0, start: 540, end: 960 }, // 09:00
    ]);
    const opener = await acrepo.openerForWeekday(0);
    expect(opener?.name).toBe("Fatou");
  });

  it("ignores non-accueil roles, muted, and days with nobody; null without a schedule", async () => {
    expect(await acrepo.openerForWeekday(0)).toBeNull(); // no published schedule yet

    const barista = await seedContact("Bar", "+221770005566", false, "bar");
    const mutedAccueil = await seedContact("Muet", "+221770007788", true, "accueil");
    await publishShifts([
      { staffId: barista, weekday: 0, start: 400, end: 800 }, // earlier but bar
      { staffId: mutedAccueil, weekday: 0, start: 405, end: 800 }, // accueil but muted
    ]);
    expect(await acrepo.openerForWeekday(0)).toBeNull();
    expect(await acrepo.openerForWeekday(3)).toBeNull(); // nobody on Thursday
  });
});

describe("occurrence ledger", () => {
  it("records observations and never overwrites a terminal decision", async () => {
    const now = new Date();
    await acrepo.recordObservation({
      eventId: "ev-1",
      sessionId: "sess-1",
      ruleId: null,
      serviceId: "svc-1",
      startAt: now.toISOString(),
      firstEmptyAt: now,
      now,
    });
    let led = await acrepo.getLedger("ev-1");
    expect(led?.state).toBe("OBSERVING");
    expect(led?.first_empty_at).not.toBeNull();

    // Move to CANCELLED, then a later observation must not revert it.
    await acrepo.withOccurrenceLock("sess-1", async (c) => acrepo.markCancelledTx(c, "ev-1"));
    await acrepo.recordObservation({
      eventId: "ev-1",
      sessionId: "sess-1",
      ruleId: null,
      serviceId: "svc-1",
      startAt: now.toISOString(),
      firstEmptyAt: new Date(now.getTime() + 60_000),
      now: new Date(now.getTime() + 60_000),
    });
    led = await acrepo.getLedger("ev-1");
    expect(led?.state).toBe("CANCELLED");

    const bySession = await acrepo.getLedgerBySession("sess-1");
    expect(bySession?.state).toBe("CANCELLED");
  });
});

describe("active-payment protection", () => {
  it("sees an unexpired AWAITING_PAYMENT booking but not an expired one", async () => {
    const client = await seedClient();
    await pool.query(
      `insert into pending_bookings (client_id, service_id, service_name, event_id, slot_start, amount_xof, status, link_expires_at)
       values ($1,'svc-1','X','sess-live', now()+interval '3h', 5000, 'AWAITING_PAYMENT', now()+interval '10 min')`,
      [client.id],
    );
    await pool.query(
      `insert into pending_bookings (client_id, service_id, service_name, event_id, slot_start, amount_xof, status, link_expires_at)
       values ($1,'svc-1','X','sess-expired', now()+interval '3h', 5000, 'AWAITING_PAYMENT', now()-interval '1 min')`,
      [client.id],
    );
    expect(await acrepo.hasActivePaymentForSession("sess-live")).toBe(true);
    expect(await acrepo.hasActivePaymentForSession("sess-expired")).toBe(false);
    expect(await acrepo.hasActivePaymentForSession("sess-none")).toBe(false);
  });
});

describe("occurrence lock", () => {
  it("try-mode fails to acquire while another holder is mid-transaction", async () => {
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const p1 = acrepo.withOccurrenceLock("sess-lock", async () => {
      await held;
      return "held";
    });
    await new Promise((r) => setTimeout(r, 100));
    const tryResult = await acrepo.withOccurrenceLock("sess-lock", async () => "b", "try");
    expect(tryResult.acquired).toBe(false);
    release();
    await p1;
    // Once released, try-mode acquires again.
    const after = await acrepo.withOccurrenceLock("sess-lock", async () => "c", "try");
    expect(after).toEqual({ acquired: true, value: "c" });
  });
});

describe("booking-path guard", () => {
  it("rejects a create when the occurrence is CANCELLED and lets it through otherwise", async () => {
    const now = new Date();
    await acrepo.recordObservation({
      eventId: "ev-x",
      sessionId: "sess-x",
      ruleId: null,
      serviceId: "svc-1",
      startAt: now.toISOString(),
      firstEmptyAt: now,
      now,
    });
    await acrepo.withOccurrenceLock("sess-x", async (c) => acrepo.markCancelledTx(c, "ev-x"));

    expect(await isSessionAutoCancelled("sess-x")).toBe(true);
    let created = false;
    await expect(
      guardBooking("sess-x", async () => {
        created = true;
        return "booked";
      }),
    ).rejects.toBeInstanceOf(OccurrenceCancelledError);
    expect(created).toBe(false);

    // A clean session runs the create.
    const ok = await guardBooking("sess-clean", async () => "booked");
    expect(ok).toBe("booked");
  });
});

describe("slot-cache invalidation", () => {
  it("purge + exclusion hide an auto-cancelled occurrence from cached lookups", async () => {
    const client = await seedClient();
    await repo.cacheSlots(client.id, "svc-1", [
      { eventId: "sess-cache", slot: { sessionId: "sess-cache", serviceId: "svc-1" } },
    ]);
    expect(await repo.getCachedSlot(client.id, "sess-cache")).not.toBeNull();

    // Mark the session cancelled in the ledger → excluded even before purge.
    await acrepo.recordObservation({
      eventId: "ev-cache",
      sessionId: "sess-cache",
      ruleId: null,
      serviceId: "svc-1",
      startAt: new Date().toISOString(),
      firstEmptyAt: new Date(),
      now: new Date(),
    });
    await acrepo.withOccurrenceLock("sess-cache", async (c) => acrepo.markCancelledTx(c, "ev-cache"));
    expect(await repo.getCachedSlot(client.id, "sess-cache")).toBeNull();

    await acrepo.purgeSlotCacheForSession("sess-cache");
    const rows = await pool.query(`select 1 from slot_cache where event_id = 'sess-cache'`);
    expect(rows.rowCount).toBe(0);
  });
});

describe("global pause", () => {
  it("persists across reads", async () => {
    expect(await acrepo.isAutoCancelPaused()).toBe(false);
    await acrepo.setAutoCancelPaused(true);
    expect(await acrepo.isAutoCancelPaused()).toBe(true);
    await acrepo.setAutoCancelPaused(false);
    expect(await acrepo.isAutoCancelPaused()).toBe(false);
  });
});
