import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { migrate, pool } from "../../src/db/index.js";
import * as commitments from "../../src/domain/commitments.js";
import { makeFetchMock, seedClient, truncateAll, inHours, type FetchMock } from "./helpers.js";

/**
 * Multi-session commitment domain layer against real Postgres: idempotent
 * creation, server-owned progression (idempotent under duplicate webhooks),
 * expired-then-paid audit trail, reselection, abandonment ordering, and expiry.
 */

let mock: FetchMock;

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
});

// ---------- local seed helpers ----------

async function insertCommitment(
  clientId: string,
  opts: Partial<{ serviceId: string; count: number; status: string; expiresAt: string }> = {},
): Promise<string> {
  const res = await pool.query(
    `insert into multi_session_commitments
       (client_id, service_id, service_name, requested_count, status, expires_at)
     values ($1, $2, $3, $4, $5, $6) returning id`,
    [
      clientId,
      opts.serviceId ?? "svc_1",
      "Pilates Reformer",
      opts.count ?? 2,
      opts.status ?? "ACTIVE",
      opts.expiresAt ?? inHours(24 * 7),
    ],
  );
  return res.rows[0].id;
}

async function insertItem(
  commitmentId: string,
  position: number,
  opts: Partial<{ eventId: string; slotStart: string; intent: string }> = {},
): Promise<string> {
  const res = await pool.query(
    `insert into multi_session_commitment_items
       (commitment_id, position, event_id, slot_start, intent_status)
     values ($1, $2, $3, $4, $5) returning id`,
    [
      commitmentId,
      position,
      opts.eventId ?? `ev_${position}`,
      opts.slotStart ?? inHours(24 * position),
      opts.intent ?? "PLANNED",
    ],
  );
  return res.rows[0].id;
}

async function insertAttempt(
  clientId: string,
  commitmentItemId: string | null,
  status: string,
): Promise<string> {
  const res = await pool.query(
    `insert into pending_bookings
       (client_id, service_id, service_name, event_id, slot_start, amount_xof, status, commitment_item_id)
     values ($1, 'svc_1', 'Pilates Reformer', 'ev_x', $2, 15000, $3, $4) returning id`,
    [clientId, inHours(48), status, commitmentItemId],
  );
  return res.rows[0].id;
}

const itemState = (snap: commitments.CommitmentSnapshot, position: number) =>
  snap.items.find((i) => i.position === position)?.effective_state;

// ---------- tests ----------

describe("startCommitment idempotency", () => {
  it("returns the existing plan on an identical retry and rejects a different one", async () => {
    const client = await seedClient();
    const slots = [
      { eventId: "ev_a", slotStart: inHours(24) },
      { eventId: "ev_b", slotStart: inHours(48) },
    ];
    const first = await commitments.startCommitment({
      clientId: client.id,
      serviceId: "svc_1",
      serviceName: "Pilates Reformer",
      requestedCount: 2,
      slots,
    });
    expect(first.outcome).toBe("created");
    const firstId = first.outcome !== "conflict" ? first.snapshot.commitment.id : "";

    // Same plan again (model/transport retry) → same commitment, no duplicate.
    const retry = await commitments.startCommitment({
      clientId: client.id,
      serviceId: "svc_1",
      serviceName: "Pilates Reformer",
      requestedCount: 2,
      slots,
    });
    expect(retry.outcome).toBe("existing");
    expect(retry.outcome !== "conflict" ? retry.snapshot.commitment.id : "").toBe(firstId);

    // A different plan while one is active → conflict (must abandon first).
    const different = await commitments.startCommitment({
      clientId: client.id,
      serviceId: "svc_1",
      serviceName: "Pilates Reformer",
      requestedCount: 3,
      slots: [...slots, { eventId: "ev_c", slotStart: inHours(72) }],
    });
    expect(different.outcome).toBe("conflict");

    const active = await pool.query(
      `select count(*)::int as n from multi_session_commitments where client_id=$1 and status='ACTIVE'`,
      [client.id],
    );
    expect(active.rows[0].n).toBe(1);
  });
});

describe("advanceOnBooking progression", () => {
  it("advances only on BOOKED, is idempotent under duplicates, and completes at N", async () => {
    const client = await seedClient();
    const commitmentId = await insertCommitment(client.id, { count: 2 });
    const item1 = await insertItem(commitmentId, 1);
    const item2 = await insertItem(commitmentId, 2);

    // Session 1 booked.
    const b1 = await insertAttempt(client.id, item1, "BOOKED");
    const p1 = await commitments.advanceOnBooking(b1);
    expect(p1).toMatchObject({ booked_count: 1, requested_count: 2, is_complete: false });

    // Duplicate webhook for the same booking → still 1/2 (COUNT, not increment).
    const dup = await commitments.advanceOnBooking(b1);
    expect(dup).toMatchObject({ booked_count: 1, is_complete: false });

    // Session 2 booked → 2/2, commitment COMPLETED.
    const b2 = await insertAttempt(client.id, item2, "BOOKED");
    const p2 = await commitments.advanceOnBooking(b2);
    expect(p2).toMatchObject({ booked_count: 2, is_complete: true });

    const row = await pool.query(`select status from multi_session_commitments where id=$1`, [commitmentId]);
    expect(row.rows[0].status).toBe("COMPLETED");
  });

  it("returns null for a standalone booking (no commitment)", async () => {
    const client = await seedClient();
    const standalone = await insertAttempt(client.id, null, "BOOKED");
    expect(await commitments.advanceOnBooking(standalone)).toBeNull();
  });
});

describe("expired-then-paid replacement", () => {
  it("keeps the full attempt history and derives BOOKED from the successful attempt", async () => {
    const client = await seedClient();
    const commitmentId = await insertCommitment(client.id, { count: 1 });
    const item = await insertItem(commitmentId, 1);

    // First link expired unused, second link paid + booked.
    await insertAttempt(client.id, item, "EXPIRED");
    const paid = await insertAttempt(client.id, item, "BOOKED");
    await commitments.advanceOnBooking(paid);

    const snap = (await commitments.commitmentSnapshot(commitmentId))!;
    expect(itemState(snap, 1)).toBe("BOOKED");
    expect(snap.booked_count).toBe(1);

    // Audit trail: both attempts still on file.
    const attempts = await pool.query(
      `select count(*)::int as n from pending_bookings where commitment_item_id=$1`,
      [item],
    );
    expect(attempts.rows[0].n).toBe(2);
  });

  it("the DB blocks a second BLOCKING attempt on the same item", async () => {
    const client = await seedClient();
    const commitmentId = await insertCommitment(client.id, { count: 1 });
    const item = await insertItem(commitmentId, 1);
    await insertAttempt(client.id, item, "AWAITING_PAYMENT");
    await expect(insertAttempt(client.id, item, "DRAFT")).rejects.toThrow();
  });
});

describe("reselection", () => {
  it("re-points a NEEDS_RESELECTION item to a new slot and marks it PLANNED", async () => {
    const client = await seedClient();
    const commitmentId = await insertCommitment(client.id, { count: 1 });
    const item = await insertItem(commitmentId, 1, { intent: "NEEDS_RESELECTION", eventId: "ev_old" });

    await commitments.reselectItemSlot(item, "ev_new", inHours(96));
    const snap = (await commitments.commitmentSnapshot(commitmentId))!;
    const it = snap.items[0];
    expect(it.intent_status).toBe("PLANNED");
    expect(it.event_id).toBe("ev_new");
    expect(itemState(snap, 1)).toBe("PLANNED");
  });
});

describe("abandonment", () => {
  it("cancels unbooked items and expires their links, keeps booked ones", async () => {
    const client = await seedClient();
    const commitmentId = await insertCommitment(client.id, { count: 2 });
    const item1 = await insertItem(commitmentId, 1);
    const item2 = await insertItem(commitmentId, 2);
    await insertAttempt(client.id, item1, "BOOKED");
    const link2 = await insertAttempt(client.id, item2, "AWAITING_PAYMENT");

    const result = await commitments.abandonCommitment(client.id, commitmentId);
    expect(result).toBe("closed");

    const c = await pool.query(`select status from multi_session_commitments where id=$1`, [commitmentId]);
    expect(c.rows[0].status).toBe("ABANDONED");

    const items = await pool.query(
      `select position, intent_status from multi_session_commitment_items where commitment_id=$1 order by position`,
      [commitmentId],
    );
    expect(items.rows[0].intent_status).toBe("PLANNED"); // item1 kept (its attempt is BOOKED)
    expect(items.rows[1].intent_status).toBe("CANCELLED"); // item2 cancelled

    const link = await pool.query(`select status from pending_bookings where id=$1`, [link2]);
    expect(link.rows[0].status).toBe("EXPIRED"); // its live link was expired first
  });

  it("defers closure while a session is PAID awaiting fulfillment", async () => {
    const client = await seedClient();
    const commitmentId = await insertCommitment(client.id, { count: 2 });
    const item1 = await insertItem(commitmentId, 1);
    await insertItem(commitmentId, 2);
    await insertAttempt(client.id, item1, "PAID");

    const result = await commitments.abandonCommitment(client.id, commitmentId);
    expect(result).toBe("deferred");
    const c = await pool.query(`select status from multi_session_commitments where id=$1`, [commitmentId]);
    expect(c.rows[0].status).toBe("ACTIVE"); // untouched
  });
});

describe("expiry sweep", () => {
  it("closes an inactive commitment and cancels its unbooked items", async () => {
    const client = await seedClient();
    const commitmentId = await insertCommitment(client.id, { count: 2, expiresAt: inHours(-1) });
    const item1 = await insertItem(commitmentId, 1);
    await insertItem(commitmentId, 2, { intent: "PLANNED", slotStart: inHours(72) });
    await insertAttempt(client.id, item1, "BOOKED");

    const closed = await commitments.expireStaleCommitments();
    expect(closed).toBe(1);

    const c = await pool.query(`select status from multi_session_commitments where id=$1`, [commitmentId]);
    expect(c.rows[0].status).toBe("EXPIRED");
    const items = await pool.query(
      `select intent_status from multi_session_commitment_items where commitment_id=$1 order by position`,
      [commitmentId],
    );
    expect(items.rows[0].intent_status).toBe("PLANNED"); // booked session kept
    expect(items.rows[1].intent_status).toBe("CANCELLED"); // unbooked cancelled
  });

  it("expires a commitment whose remaining sessions are all in the past", async () => {
    const client = await seedClient();
    const commitmentId = await insertCommitment(client.id, { count: 1, expiresAt: inHours(24 * 7) });
    await insertItem(commitmentId, 1, { intent: "PLANNED", slotStart: inHours(-2) });

    const closed = await commitments.expireStaleCommitments();
    expect(closed).toBe(1);
    const c = await pool.query(`select status from multi_session_commitments where id=$1`, [commitmentId]);
    expect(c.rows[0].status).toBe("EXPIRED");
  });

  it("keeps a commitment alive while a session awaits reselection", async () => {
    const client = await seedClient();
    const commitmentId = await insertCommitment(client.id, { count: 1, expiresAt: inHours(24) });
    await insertItem(commitmentId, 1, { intent: "NEEDS_RESELECTION", slotStart: inHours(-2) });

    const closed = await commitments.expireStaleCommitments();
    expect(closed).toBe(0);
    const c = await pool.query(`select status from multi_session_commitments where id=$1`, [commitmentId]);
    expect(c.rows[0].status).toBe("ACTIVE");
  });
});
