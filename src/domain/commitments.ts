import type pg from "pg";
import { pool } from "../db/index.js";

/**
 * Multi-session commitments — a client who wants to pay for N à-la-carte
 * sessions (one payment link each). Persists the plan ACROSS payments, which
 * conversation history alone does not (documented failure "Amy Ndiaye": 3/5
 * paid, then silence — PROGRESS.md §6.9).
 *
 * Core invariants (see plan what-do-you-thinkg-nested-willow.md, Phase 1):
 *  - The SERVER advances progress, only on the shared BOOKED transition in
 *    fulfillment.ts — never Awa's wording.
 *  - Item payment state is NOT stored on the item; it is DERIVED from the
 *    attempts in pending_bookings (reversed FK commitment_item_id). Zero drift.
 *  - At most one BLOCKING attempt per item (DB partial unique index is the
 *    backstop; app checks under the per-client advisory lock are the first line).
 *  - Stored slots are INTENTIONS: revalidated against slot_cache + live Wix
 *    before every link. No capacity is held.
 */

/** Days of inactivity before an ACTIVE commitment expires. */
export const COMMITMENT_TTL_DAYS = 7;

/** Booking statuses that block a new attempt on the same item. */
export const BLOCKING_ATTEMPT_STATUSES = [
  "DRAFT",
  "AWAITING_PAYMENT",
  "PAID",
  "BOOKED",
  "REFUND_NEEDED",
] as const;

export type CommitmentStatus = "ACTIVE" | "COMPLETED" | "ABANDONED" | "EXPIRED";
export type ItemIntentStatus = "PLANNED" | "NEEDS_RESELECTION" | "CANCELLED";

/**
 * Effective per-item state, derived from its attempts (highest-precedence live
 * attempt wins) then falling back to the item's own intent. EXPIRED-only
 * attempts leave the item retryable — they do not cancel it.
 */
export type ItemEffectiveState =
  | "BOOKED"
  | "PAID_PENDING" // PAID (awaiting fulfillment) or REFUND_NEEDED — needs attention
  | "AWAITING" // a live DRAFT/AWAITING_PAYMENT link exists
  | "NEEDS_RESELECTION"
  | "PLANNED"
  | "CANCELLED";

export interface MultiSessionCommitment {
  id: string;
  client_id: string;
  service_id: string;
  service_name: string;
  requested_count: number;
  status: CommitmentStatus;
  expires_at: Date;
  created_at: Date;
  updated_at: Date;
}

export interface CommitmentItem {
  id: string;
  commitment_id: string;
  position: number;
  event_id: string;
  slot_start: Date;
  intent_status: ItemIntentStatus;
}

export interface CommitmentItemWithState extends CommitmentItem {
  effective_state: ItemEffectiveState;
}

export interface CommitmentSnapshot {
  commitment: MultiSessionCommitment;
  items: CommitmentItemWithState[];
  booked_count: number;
  /** Lowest-position item that can receive a new payment link (PLANNED / NEEDS_RESELECTION). */
  next_item: CommitmentItemWithState | null;
  /** True when every item is BOOKED (progress === requested_count). */
  is_complete: boolean;
}

/**
 * Pure derivation of an item's effective state — unit-tested in isolation.
 * Precedence: BOOKED → PAID/REFUND_NEEDED → AWAITING_PAYMENT/DRAFT → intent.
 * `attemptStatuses` = every pending_bookings.status linked to this item.
 */
export function deriveItemState(
  attemptStatuses: readonly string[],
  intentStatus: ItemIntentStatus,
): ItemEffectiveState {
  const has = (s: string) => attemptStatuses.includes(s);
  if (has("BOOKED")) return "BOOKED";
  if (has("PAID") || has("REFUND_NEEDED")) return "PAID_PENDING";
  if (has("AWAITING_PAYMENT") || has("DRAFT")) return "AWAITING";
  // Only EXPIRED/REFUNDED/CANCELLED attempts (or none) remain — the item is
  // retryable; its own intent decides.
  return intentStatus;
}

// ---------- advisory lock ----------

/**
 * Serialize start / abandon / reselect / link-item operations for one client
 * under a per-client transaction advisory lock (same pattern as bookingFunnel).
 * The DB partial unique indexes remain the final guard.
 */
export async function withClientLock<T>(
  clientId: string,
  fn: (tx: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const tx = await pool.connect();
  try {
    await tx.query("begin");
    await tx.query(`select pg_advisory_xact_lock(hashtext($1))`, [clientId]);
    const result = await fn(tx);
    await tx.query("commit");
    return result;
  } catch (err) {
    await tx.query("rollback").catch(() => {});
    throw err;
  } finally {
    tx.release();
  }
}

// ---------- reads ----------

/** The client's ACTIVE commitment, or null. Does NOT run expiry (see sweep). */
export async function activeCommitment(
  clientId: string,
  tx: pg.Pool | pg.PoolClient = pool,
): Promise<MultiSessionCommitment | null> {
  const res = await tx.query(
    `select * from multi_session_commitments
      where client_id = $1 and status = 'ACTIVE' limit 1`,
    [clientId],
  );
  return res.rows[0] ?? null;
}

export async function findCommitmentById(
  commitmentId: string,
  tx: pg.Pool | pg.PoolClient = pool,
): Promise<MultiSessionCommitment | null> {
  const res = await tx.query(`select * from multi_session_commitments where id = $1`, [commitmentId]);
  return res.rows[0] ?? null;
}

/**
 * Load a commitment with its items and each item's derived effective state,
 * plus progress and the next payable item.
 */
export async function commitmentSnapshot(
  commitmentId: string,
  tx: pg.Pool | pg.PoolClient = pool,
): Promise<CommitmentSnapshot | null> {
  const commitment = await findCommitmentById(commitmentId, tx);
  if (!commitment) return null;
  const res = await tx.query(
    `select i.*,
            coalesce(
              (select array_agg(pb.status)
                 from pending_bookings pb
                where pb.commitment_item_id = i.id),
              '{}') as attempt_statuses
       from multi_session_commitment_items i
      where i.commitment_id = $1
      order by i.position`,
    [commitmentId],
  );
  const items: CommitmentItemWithState[] = res.rows.map((r: any) => ({
    id: r.id,
    commitment_id: r.commitment_id,
    position: r.position,
    event_id: r.event_id,
    slot_start: r.slot_start,
    intent_status: r.intent_status,
    effective_state: deriveItemState(r.attempt_statuses ?? [], r.intent_status),
  }));
  const booked_count = items.filter((i) => i.effective_state === "BOOKED").length;
  const next_item =
    items.find(
      (i) => i.effective_state === "PLANNED" || i.effective_state === "NEEDS_RESELECTION",
    ) ?? null;
  return {
    commitment,
    items,
    booked_count,
    next_item,
    is_complete: booked_count >= commitment.requested_count,
  };
}

/** Active commitment + snapshot for a client, or null. */
export async function activeCommitmentSnapshot(
  clientId: string,
  tx: pg.Pool | pg.PoolClient = pool,
): Promise<CommitmentSnapshot | null> {
  const c = await activeCommitment(clientId, tx);
  if (!c) return null;
  return commitmentSnapshot(c.id, tx);
}

export async function getItem(
  commitmentItemId: string,
  tx: pg.Pool | pg.PoolClient = pool,
): Promise<CommitmentItem | null> {
  const res = await tx.query(
    `select * from multi_session_commitment_items where id = $1`,
    [commitmentItemId],
  );
  return res.rows[0] ?? null;
}

/**
 * Whether a settled attempt already blocks a NEW link for this item. Only
 * checks the states create_payment_link cannot clear on its own — DRAFT/
 * AWAITING_PAYMENT are expired by the one-active-link-per-client sweep just
 * before the new draft, so they never block here.
 */
export async function itemPaymentBlock(
  commitmentItemId: string,
  tx: pg.Pool | pg.PoolClient = pool,
): Promise<"booked" | "in_flight" | null> {
  const res = await tx.query(
    `select status from pending_bookings
      where commitment_item_id = $1 and status in ('PAID','BOOKED','REFUND_NEEDED')`,
    [commitmentItemId],
  );
  const statuses: string[] = res.rows.map((r: any) => r.status);
  if (statuses.includes("BOOKED")) return "booked";
  if (statuses.length > 0) return "in_flight";
  return null;
}

/** The commitment item a given booking belongs to (or null for standalone). */
export async function itemForBooking(
  bookingId: string,
  tx: pg.Pool | pg.PoolClient = pool,
): Promise<CommitmentItem | null> {
  const res = await tx.query(
    `select i.* from multi_session_commitment_items i
       join pending_bookings pb on pb.commitment_item_id = i.id
      where pb.id = $1`,
    [bookingId],
  );
  return res.rows[0] ?? null;
}

// ---------- creation (idempotent) ----------

export type StartCommitmentResult =
  | { outcome: "created" | "existing"; snapshot: CommitmentSnapshot }
  | { outcome: "conflict"; existing: CommitmentSnapshot };

/**
 * Start a commitment from a list of agreed, slot_cache-resolved slots (one per
 * requested session, in order). Idempotent under the per-client lock:
 *  - identical ACTIVE plan (same service, count, ordered event_ids) → return it;
 *  - a DIFFERENT plan while one is ACTIVE → { conflict } (caller must abandon);
 *  - otherwise create.
 * `slots` length must equal requestedCount (enforced by the caller/tool).
 */
export async function startCommitment(args: {
  clientId: string;
  serviceId: string;
  serviceName: string;
  requestedCount: number;
  slots: { eventId: string; slotStart: string }[];
}): Promise<StartCommitmentResult> {
  return withClientLock(args.clientId, async (tx) => {
    const existing = await activeCommitment(args.clientId, tx);
    if (existing) {
      const snap = (await commitmentSnapshot(existing.id, tx))!;
      const sameService = existing.service_id === args.serviceId;
      const sameCount = existing.requested_count === args.requestedCount;
      const sameSlots =
        snap.items.length === args.slots.length &&
        snap.items.every((it, i) => it.event_id === args.slots[i]?.eventId);
      if (sameService && sameCount && sameSlots) {
        return { outcome: "existing", snapshot: snap };
      }
      return { outcome: "conflict", existing: snap };
    }

    const commitmentRes = await tx.query(
      `insert into multi_session_commitments
         (client_id, service_id, service_name, requested_count, status, expires_at)
       values ($1, $2, $3, $4, 'ACTIVE', now() + ($5 || ' days')::interval)
       returning *`,
      [args.clientId, args.serviceId, args.serviceName, args.requestedCount, String(COMMITMENT_TTL_DAYS)],
    );
    const commitment: MultiSessionCommitment = commitmentRes.rows[0];
    for (let i = 0; i < args.slots.length; i++) {
      await tx.query(
        `insert into multi_session_commitment_items
           (commitment_id, position, event_id, slot_start, intent_status)
         values ($1, $2, $3, $4, 'PLANNED')`,
        [commitment.id, i + 1, args.slots[i].eventId, args.slots[i].slotStart],
      );
    }
    const snap = (await commitmentSnapshot(commitment.id, tx))!;
    return { outcome: "created", snapshot: snap };
  });
}

// ---------- item linking / reselection ----------

/**
 * Guarded lookup used by create_payment_link before it drafts a booking for a
 * commitment item. Returns the item if it can receive a new attempt, else a
 * structured reason (never a raw unique-index error).
 */
export async function claimItemForAttempt(
  commitmentItemId: string,
  tx: pg.Pool | pg.PoolClient,
): Promise<
  | { ok: true; item: CommitmentItem }
  | { ok: false; reason: "unknown_item" | "item_cancelled" | "attempt_in_flight" | "already_booked" }
> {
  const itemRes = await tx.query(
    `select * from multi_session_commitment_items where id = $1 for update`,
    [commitmentItemId],
  );
  const item: CommitmentItem | undefined = itemRes.rows[0];
  if (!item) return { ok: false, reason: "unknown_item" };
  if (item.intent_status === "CANCELLED") return { ok: false, reason: "item_cancelled" };
  const attemptsRes = await tx.query(
    `select status from pending_bookings where commitment_item_id = $1`,
    [commitmentItemId],
  );
  const statuses: string[] = attemptsRes.rows.map((r: any) => r.status);
  if (statuses.includes("BOOKED")) return { ok: false, reason: "already_booked" };
  if (statuses.some((s) => (BLOCKING_ATTEMPT_STATUSES as readonly string[]).includes(s))) {
    return { ok: false, reason: "attempt_in_flight" };
  }
  return { ok: true, item };
}

/** Update a NEEDS_RESELECTION (or PLANNED) item's agreed slot after revalidation. */
export async function reselectItemSlot(
  commitmentItemId: string,
  eventId: string,
  slotStart: string,
  tx: pg.Pool | pg.PoolClient = pool,
): Promise<void> {
  await tx.query(
    `update multi_session_commitment_items
        set event_id = $2, slot_start = $3, intent_status = 'PLANNED', updated_at = now()
      where id = $1`,
    [commitmentItemId, eventId, slotStart],
  );
}

/** Flag an item as needing a fresh slot (its agreed one went unavailable). */
export async function markItemNeedsReselection(
  commitmentItemId: string,
  tx: pg.Pool | pg.PoolClient = pool,
): Promise<void> {
  await tx.query(
    `update multi_session_commitment_items
        set intent_status = 'NEEDS_RESELECTION', updated_at = now()
      where id = $1 and intent_status <> 'CANCELLED'`,
    [commitmentItemId],
  );
}

// ---------- progression (server-owned, on BOOKED) ----------

export interface CommitmentProgress {
  commitment_id: string;
  service_name: string;
  requested_count: number;
  booked_count: number;
  is_complete: boolean;
}

/**
 * Called from fulfillment.ts right after a booking reaches BOOKED. Refreshes the
 * inactivity clock, marks the commitment COMPLETED when every session is booked,
 * and returns the progress used to build the client message. Returns null when
 * the booking is standalone (no commitment). Idempotent: re-running after a
 * duplicate webhook recomputes the same COUNT — never double-counts.
 */
export async function advanceOnBooking(bookingId: string): Promise<CommitmentProgress | null> {
  const item = await itemForBooking(bookingId);
  if (!item) return null;
  return withClientLockForCommitment(item.commitment_id, async (tx) => {
    const snap = await commitmentSnapshot(item.commitment_id, tx);
    if (!snap) return null;
    // Refresh inactivity TTL on confirmed progress.
    await tx.query(
      `update multi_session_commitments
          set expires_at = now() + ($2 || ' days')::interval, updated_at = now()
        where id = $1 and status = 'ACTIVE'`,
      [item.commitment_id, String(COMMITMENT_TTL_DAYS)],
    );
    if (snap.is_complete && snap.commitment.status === "ACTIVE") {
      await tx.query(
        `update multi_session_commitments set status = 'COMPLETED', updated_at = now()
          where id = $1 and status = 'ACTIVE'`,
        [item.commitment_id],
      );
    }
    return {
      commitment_id: snap.commitment.id,
      service_name: snap.commitment.service_name,
      requested_count: snap.commitment.requested_count,
      booked_count: snap.booked_count,
      is_complete: snap.is_complete,
    };
  });
}

/** Advisory lock keyed by the commitment's client (loads client_id first). */
async function withClientLockForCommitment<T>(
  commitmentId: string,
  fn: (tx: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const c = await findCommitmentById(commitmentId);
  if (!c) {
    // No client to key the lock on — run without it; caller handles null.
    const tx = await pool.connect();
    try {
      return await fn(tx);
    } finally {
      tx.release();
    }
  }
  return withClientLock(c.client_id, fn);
}

// ---------- abandonment & expiry ----------

export type CloseResult = "closed" | "deferred" | "noop";

/**
 * Close a commitment (ABANDONED or EXPIRED). ORDER MATTERS: expire the blocking
 * DRAFT/AWAITING_PAYMENT attempts of its unbooked items FIRST, then CANCEL those
 * items, then set the commitment status — so no active attempt outlives its item.
 * Deferred (no change) while any attempt is PAID awaiting fulfillment. Never
 * touches BOOKED or REFUND_NEEDED attempts.
 */
export async function closeCommitment(
  commitmentId: string,
  finalStatus: "ABANDONED" | "EXPIRED",
  tx: pg.PoolClient,
): Promise<CloseResult> {
  const commitment = await findCommitmentById(commitmentId, tx);
  if (!commitment || commitment.status !== "ACTIVE") return "noop";

  // A PAID attempt still awaiting fulfillment must settle (BOOKED or
  // REFUND_NEEDED) before we close — defer.
  const paidPending = await tx.query(
    `select 1 from pending_bookings pb
       join multi_session_commitment_items i on i.id = pb.commitment_item_id
      where i.commitment_id = $1 and pb.status = 'PAID' limit 1`,
    [commitmentId],
  );
  if ((paidPending.rowCount ?? 0) > 0) return "deferred";

  // 1. Expire blocking non-terminal attempts on unbooked items.
  await tx.query(
    `update pending_bookings pb
        set status = 'EXPIRED', updated_at = now()
       from multi_session_commitment_items i
      where pb.commitment_item_id = i.id and i.commitment_id = $1
        and pb.status in ('DRAFT','AWAITING_PAYMENT')`,
    [commitmentId],
  );
  // 2. Cancel items that never reached BOOKED. (BOOKED items keep their seat.)
  await tx.query(
    `update multi_session_commitment_items i
        set intent_status = 'CANCELLED', updated_at = now()
      where i.commitment_id = $1 and i.intent_status <> 'CANCELLED'
        and not exists (
          select 1 from pending_bookings pb
           where pb.commitment_item_id = i.id and pb.status = 'BOOKED')`,
    [commitmentId],
  );
  // 3. Close the commitment.
  await tx.query(
    `update multi_session_commitments set status = $2, updated_at = now()
      where id = $1 and status = 'ACTIVE'`,
    [commitmentId, finalStatus],
  );
  return "closed";
}

/** Explicit client abandon ("je préfère arrêter"). Under the per-client lock. */
export async function abandonCommitment(
  clientId: string,
  commitmentId: string,
): Promise<CloseResult> {
  return withClientLock(clientId, async (tx) => closeCommitment(commitmentId, "ABANDONED", tx));
}

/**
 * Sweep ACTIVE commitments that are due to expire and close them. Two triggers:
 *  - inactivity: now > expires_at;
 *  - all-dates-past: no unbooked PLANNED item still has a future slot AND no item
 *    is NEEDS_RESELECTION (those live on the inactivity clock instead).
 * Returns the number closed (deferred ones are retried next sweep).
 */
export async function expireStaleCommitments(): Promise<number> {
  const due = await pool.query(
    `select c.id, c.client_id
       from multi_session_commitments c
      where c.status = 'ACTIVE'
        and (
          c.expires_at < now()
          or (
            not exists (
              select 1 from multi_session_commitment_items i
               where i.commitment_id = c.id and i.intent_status = 'NEEDS_RESELECTION')
            and not exists (
              select 1 from multi_session_commitment_items i
               where i.commitment_id = c.id and i.intent_status = 'PLANNED'
                 and i.slot_start > now())
            and exists (
              select 1 from multi_session_commitment_items i
               where i.commitment_id = c.id and i.intent_status <> 'CANCELLED'
                 and not exists (
                   select 1 from pending_bookings pb
                    where pb.commitment_item_id = i.id and pb.status = 'BOOKED'))
          )
        )`,
  );
  let closed = 0;
  for (const row of due.rows) {
    const result = await withClientLock(row.client_id, async (tx) =>
      closeCommitment(row.id, "EXPIRED", tx),
    );
    if (result === "closed") closed++;
  }
  return closed;
}
