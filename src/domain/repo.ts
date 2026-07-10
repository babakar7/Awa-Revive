import crypto from "node:crypto";
import { pool } from "../db/index.js";
import { transition } from "./stateMachine.js";

export interface Client {
  id: string;
  wa_phone: string;
  name: string | null;
  language: string | null;
  email_prompted_at: Date | null;
  claimed_email: string | null;
}

export interface PendingBooking {
  id: string;
  client_id: string;
  service_id: string;
  service_name: string;
  event_id: string;
  slot_json: unknown;
  slot_start: Date;
  slot_end: Date | null;
  amount_xof: number;
  participants: number;
  status: string;
  wave_session_id: string | null;
  payment_link: string | null;
  link_expires_at: Date | null;
  wix_booking_id: string | null;
  payer_phone: string | null;
  payment_method: string;
  benefit_transaction_id: string | null;
  extras_json: unknown;
  extras_amount_xof: number;
  order_note: string | null;
  fulfilling_at: Date | null;
}

export interface Turn {
  role: string;
  content: string;
  created_at: Date;
}

// ---------- clients ----------

export async function upsertClient(waPhone: string): Promise<Client> {
  const res = await pool.query(
    `insert into clients (wa_phone) values ($1)
     on conflict (wa_phone) do update set updated_at = now()
     returning id, wa_phone, name, language, email_prompted_at, claimed_email`,
    [waPhone],
  );
  return res.rows[0];
}

/** One-shot flag: the "link your account" email question is asked at most once. */
export async function markEmailPrompted(clientId: string): Promise<void> {
  await pool.query(
    `update clients set email_prompted_at = now(), updated_at = now()
      where id = $1 and email_prompted_at is null`,
    [clientId],
  );
}

export async function saveClaimedEmail(clientId: string, email: string): Promise<void> {
  await pool.query(
    `update clients set claimed_email = $2, updated_at = now() where id = $1`,
    [clientId, email],
  );
}

export async function updateClientLanguage(clientId: string, language: string): Promise<void> {
  await pool.query(
    `update clients set language = $2, updated_at = now() where id = $1`,
    [clientId, language],
  );
}

export async function updateClientName(clientId: string, name: string): Promise<void> {
  await pool.query(
    `update clients set name = $2, updated_at = now() where id = $1 and (name is null or name <> $2)`,
    [clientId, name],
  );
}

// ---------- conversations ----------

export async function addTurn(
  clientId: string,
  role: "user" | "assistant" | "tool" | "system",
  content: string,
  waMessageId?: string,
): Promise<void> {
  await pool.query(
    `insert into conversations (client_id, role, content, wa_message_id) values ($1, $2, $3, $4)`,
    [clientId, role, content, waMessageId ?? null],
  );
}

export async function lastTurns(clientId: string, n = 20): Promise<Turn[]> {
  const res = await pool.query(
    `select role, content, created_at
       from (select role, content, created_at
               from conversations
              where client_id = $1 and role in ('user', 'assistant')
              order by created_at desc
              limit $2) t
      order by created_at asc`,
    [clientId, n],
  );
  return res.rows;
}

export async function recentTranscriptExcerpt(clientId: string, n = 6): Promise<string> {
  const turns = await lastTurns(clientId, n);
  return turns.map((t) => `${t.role}: ${t.content}`.slice(0, 300)).join("\n");
}

// ---------- webhook idempotency ----------

/**
 * Returns true if this webhook id was already processed (duplicate delivery).
 * Insert-and-check in one step: the row is recorded HERE, so callers that
 * dedupe before doing work (WhatsApp inbound) can never double-handle a
 * message. Not for flows that must stay retriable on failure — see
 * wasProcessed/markProcessed.
 */
export async function alreadyProcessed(id: string, source: string): Promise<boolean> {
  const res = await pool.query(
    `insert into processed_webhooks (id, source) values ($1, $2)
     on conflict (id) do nothing
     returning id`,
    [id, source],
  );
  return res.rowCount === 0;
}

/** Read-only idempotency check — does NOT record the id (see markProcessed). */
export async function wasProcessed(id: string): Promise<boolean> {
  const res = await pool.query(`select 1 from processed_webhooks where id = $1`, [id]);
  return (res.rowCount ?? 0) > 0;
}

/**
 * Record a webhook id as processed. Idempotent. Call this AFTER the work
 * completed successfully, so a transient failure leaves the id unrecorded and
 * the provider's retry can run the work again (the atomic state transitions
 * make re-processing a no-op once the booking is terminal).
 */
export async function markProcessed(id: string, source: string): Promise<void> {
  await pool.query(
    `insert into processed_webhooks (id, source) values ($1, $2)
     on conflict (id) do nothing`,
    [id, source],
  );
}

// ---------- pending bookings ----------

export async function createDraftBooking(args: {
  clientId: string;
  serviceId: string;
  serviceName: string;
  eventId: string;
  slotJson: unknown;
  slotStart: string;
  slotEnd: string | null;
  amountXof: number;
  participants: number;
  extrasJson?: unknown;
  extrasAmountXof?: number;
  orderNote?: string | null;
}): Promise<PendingBooking> {
  const res = await pool.query(
    `insert into pending_bookings
       (client_id, service_id, service_name, event_id, slot_json, slot_start, slot_end, amount_xof, participants,
        extras_json, extras_amount_xof, order_note, status)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'DRAFT')
     returning *`,
    [
      args.clientId,
      args.serviceId,
      args.serviceName,
      args.eventId,
      JSON.stringify(args.slotJson),
      args.slotStart,
      args.slotEnd,
      args.amountXof,
      args.participants,
      args.extrasJson ? JSON.stringify(args.extrasJson) : null,
      args.extrasAmountXof ?? 0,
      args.orderNote ?? null,
    ],
  );
  return res.rows[0];
}

export async function setAwaitingPayment(
  bookingId: string,
  waveSessionId: string,
  paymentLink: string,
  expiresAt: Date,
): Promise<PendingBooking | null> {
  return (await transition(pool, bookingId, "AWAITING_PAYMENT", {
    wave_session_id: waveSessionId,
    payment_link: paymentLink,
    link_expires_at: expiresAt,
  })) as PendingBooking | null;
}

export async function findBookingById(id: string): Promise<PendingBooking | null> {
  const res = await pool.query(`select * from pending_bookings where id = $1`, [id]);
  return res.rows[0] ?? null;
}

/**
 * Atomically claim a PAID-but-unfulfilled booking for fulfillment. Returns the
 * row if THIS caller won the claim, or null if the booking is already
 * fulfilled, terminal, or being fulfilled by someone else (a fresh lease).
 * This single conditional UPDATE is what makes it safe for a Wave webhook
 * retry and the reconciliation sweep to both try to fulfill — only one wins.
 */
export async function claimBookingForFulfillment(id: string): Promise<PendingBooking | null> {
  const res = await pool.query(
    `update pending_bookings
        set fulfilling_at = now(), updated_at = now()
      where id = $1 and status = 'PAID' and wix_booking_id is null
        and (fulfilling_at is null or fulfilling_at < now() - interval '2 minutes')
      returning *`,
    [id],
  );
  return res.rows[0] ?? null;
}

/**
 * PAID bookings that were never turned into a Wix booking and are past the
 * grace period — a crash between the PAID transition and the Wix booking
 * leaves these, and nothing else recovers them. Excludes rows under an active
 * fulfillment lease.
 */
export async function stuckPaidBookings(
  graceMinutes = 3,
  limit = 20,
): Promise<PendingBooking[]> {
  const res = await pool.query(
    `select * from pending_bookings
      where status = 'PAID' and wix_booking_id is null
        and updated_at < now() - make_interval(mins => $1)
        and (fulfilling_at is null or fulfilling_at < now() - interval '2 minutes')
      order by updated_at asc limit $2`,
    [graceMinutes, limit],
  );
  return res.rows;
}

/** One active AWAITING_PAYMENT per client (SPEC §6): expire any previous link. */
export async function expireActiveBookings(clientId: string): Promise<void> {
  await pool.query(
    `update pending_bookings
        set status = 'EXPIRED', updated_at = now()
      where client_id = $1 and status in ('DRAFT', 'AWAITING_PAYMENT')`,
    [clientId],
  );
}

/** TTL sweep — AWAITING_PAYMENT past link_expires_at → EXPIRED. */
export async function expireStaleBookings(): Promise<number> {
  const res = await pool.query(
    `update pending_bookings
        set status = 'EXPIRED', updated_at = now()
      where status = 'AWAITING_PAYMENT' and link_expires_at < now()`,
  );
  return res.rowCount ?? 0;
}

/**
 * EXPIRED links worth a one-shot "want a fresh link?" nudge. Deliberately
 * narrow so the nudge is never noise:
 *   - the link expired by TTL, recently (a link expired days ago on an idle
 *     conversation must stay silent — also protects against a deploy replaying
 *     the whole backlog);
 *   - the client has NOT moved on: no newer booking attempt of any status, no
 *     active plan-purchase link (expireActiveBookings marks replaced links
 *     EXPIRED with a future link_expires_at, so the recent-TTL window alone
 *     would eventually match them once their TTL passes), and no client
 *     message since the expiry (they re-engaged — Awa handles it in the
 *     conversation, a parallel nudge would be spam);
 *   - never nudged before (expiry_nudged_at is the one-shot flag).
 */
export async function expiredLinksToNudge(
  windowMinutes = 30,
  limit = 20,
): Promise<(PendingBooking & { wa_phone: string; language: string | null })[]> {
  const res = await pool.query(
    `select b.*, c.wa_phone, c.language
       from pending_bookings b
       join clients c on c.id = b.client_id
      where b.status = 'EXPIRED'
        and b.expiry_nudged_at is null
        and b.payment_link is not null
        and b.link_expires_at < now()
        and b.link_expires_at > now() - make_interval(mins => $1)
        and b.slot_start > now()
        and not exists (select 1 from pending_bookings n
                         where n.client_id = b.client_id and n.created_at > b.created_at)
        and not exists (select 1 from pending_plan_orders p
                         where p.client_id = b.client_id
                           and p.status in ('DRAFT', 'AWAITING_PAYMENT'))
        and not exists (select 1 from conversations m
                         where m.client_id = b.client_id and m.role = 'user'
                           and m.created_at > b.link_expires_at)
      order by b.link_expires_at asc
      limit $2`,
    [windowMinutes, limit],
  );
  return res.rows;
}

/**
 * Atomically claim the right to send the expiry nudge for one booking.
 * Returns false if another sweep already claimed it (one-shot guarantee).
 */
export async function claimExpiryNudge(bookingId: string): Promise<boolean> {
  const res = await pool.query(
    `update pending_bookings set expiry_nudged_at = now(), updated_at = now()
      where id = $1 and expiry_nudged_at is null`,
    [bookingId],
  );
  return (res.rowCount ?? 0) > 0;
}

export async function activeAwaitingPayment(clientId: string): Promise<PendingBooking | null> {
  const res = await pool.query(
    `select * from pending_bookings
      where client_id = $1 and status = 'AWAITING_PAYMENT' and link_expires_at > now()
      order by created_at desc limit 1`,
    [clientId],
  );
  return res.rows[0] ?? null;
}

/**
 * Recent payments of this client that could not be fulfilled (refund pending
 * or just processed) — injected into Awa's context so she NEVER denies a
 * payment the client actually made.
 */
export async function recentRefunds(clientId: string): Promise<PendingBooking[]> {
  const res = await pool.query(
    `select * from pending_bookings
      where client_id = $1 and status in ('REFUND_NEEDED', 'REFUNDED')
        and updated_at > now() - interval '48 hours'
      order by updated_at desc limit 3`,
    [clientId],
  );
  return res.rows;
}

export async function upcomingBooked(clientId: string): Promise<PendingBooking[]> {
  const res = await pool.query(
    `select * from pending_bookings
      where client_id = $1 and status = 'BOOKED' and slot_start > now()
      order by slot_start asc`,
    [clientId],
  );
  return res.rows;
}

export async function markCancelled(bookingId: string): Promise<void> {
  await transition(pool, bookingId, "CANCELLED");
}

/** Awa-initiated cancellation of a Wave-paid booking — a refund is now owed. */
export async function markRefundNeeded(bookingId: string): Promise<void> {
  await transition(pool, bookingId, "REFUND_NEEDED");
}

/**
 * Record a membership-paid booking. Inserted directly as BOOKED: the
 * "payment" is the plan credit, redeemed and validated by Wix's checkout
 * before this row is created — the payment-first invariant holds, the
 * verification just lives in Wix instead of Wave.
 */
export async function createMembershipBooking(args: {
  clientId: string;
  serviceId: string;
  serviceName: string;
  eventId: string;
  slotJson: unknown;
  slotStart: string;
  slotEnd: string | null;
  wixBookingId: string;
  benefitTransactionId?: string | null;
}): Promise<PendingBooking> {
  const res = await pool.query(
    `insert into pending_bookings
       (client_id, service_id, service_name, event_id, slot_json, slot_start, slot_end,
        amount_xof, participants, status, payment_method, wix_booking_id, benefit_transaction_id)
     values ($1, $2, $3, $4, $5, $6, $7, 0, 1, 'BOOKED', 'membership', $8, $9)
     returning *`,
    [
      args.clientId,
      args.serviceId,
      args.serviceName,
      args.eventId,
      JSON.stringify(args.slotJson),
      args.slotStart,
      args.slotEnd,
      args.wixBookingId,
      args.benefitTransactionId ?? null,
    ],
  );
  return res.rows[0];
}

/** One of this client's own bookings, by our booking id (for cancel_booking). */
export async function findClientBooking(
  clientId: string,
  bookingId: string,
): Promise<PendingBooking | null> {
  const res = await pool.query(
    `select * from pending_bookings where id = $1 and client_id = $2`,
    [bookingId, clientId],
  );
  return res.rows[0] ?? null;
}

/** All upcoming BOOKED rows across all clients — for the cancellation sweep. */
export async function allUpcomingBooked(): Promise<
  (PendingBooking & { wa_phone: string; language: string | null })[]
> {
  const res = await pool.query(
    `select b.*, c.wa_phone, c.language
       from pending_bookings b
       join clients c on c.id = b.client_id
      where b.status = 'BOOKED' and b.slot_start > now() and b.wix_booking_id is not null
      order by b.slot_start asc`,
  );
  return res.rows;
}

// ---------- plan orders (abonnements vendus par Awa) ----------

export interface PlanOrder {
  id: string;
  client_id: string;
  plan_id: string;
  plan_name: string;
  amount_xof: number;
  status: string;
  wave_session_id: string | null;
  payment_link: string | null;
  link_expires_at: Date | null;
  wix_order_id: string | null;
  member_id: string | null;
}

/**
 * Atomic conditional status update — same safety pattern as the bookings
 * state machine (duplicate Wave webhooks race on the PAID transition).
 */
async function transitionPlanOrder(
  id: string,
  to: string,
  fromStates: string[],
  extra: Record<string, unknown> = {},
): Promise<PlanOrder | null> {
  const extraKeys = Object.keys(extra);
  const setClauses = ["status = $2", "updated_at = now()"];
  const params: unknown[] = [id, to, fromStates];
  extraKeys.forEach((k, i) => {
    setClauses.push(`${k} = $${4 + i}`);
    params.push(extra[k]);
  });
  const res = await pool.query(
    `update pending_plan_orders set ${setClauses.join(", ")}
      where id = $1 and status = any($3) returning *`,
    params,
  );
  return res.rows[0] ?? null;
}

export async function createDraftPlanOrder(args: {
  clientId: string;
  planId: string;
  planName: string;
  amountXof: number;
  memberId: string | null;
}): Promise<PlanOrder> {
  const res = await pool.query(
    `insert into pending_plan_orders (client_id, plan_id, plan_name, amount_xof, member_id, status)
     values ($1, $2, $3, $4, $5, 'DRAFT') returning *`,
    [args.clientId, args.planId, args.planName, args.amountXof, args.memberId],
  );
  return res.rows[0];
}

export async function setPlanOrderAwaitingPayment(
  id: string,
  waveSessionId: string,
  paymentLink: string,
  expiresAt: Date,
): Promise<PlanOrder | null> {
  return transitionPlanOrder(id, "AWAITING_PAYMENT", ["DRAFT"], {
    wave_session_id: waveSessionId,
    payment_link: paymentLink,
    link_expires_at: expiresAt,
  });
}

export async function markPlanOrderPaid(id: string): Promise<PlanOrder | null> {
  return transitionPlanOrder(id, "PAID", ["AWAITING_PAYMENT", "EXPIRED"]);
}

export async function markPlanOrderActivated(
  id: string,
  wixOrderId: string,
): Promise<PlanOrder | null> {
  return transitionPlanOrder(id, "ACTIVATED", ["PAID"], { wix_order_id: wixOrderId });
}

export async function findPlanOrderById(id: string): Promise<PlanOrder | null> {
  const res = await pool.query(`select * from pending_plan_orders where id = $1`, [id]);
  return res.rows[0] ?? null;
}

/** One active plan payment link per client — expire any previous one. */
export async function expireActivePlanOrders(clientId: string): Promise<void> {
  await pool.query(
    `update pending_plan_orders set status = 'EXPIRED', updated_at = now()
      where client_id = $1 and status in ('DRAFT', 'AWAITING_PAYMENT')`,
    [clientId],
  );
}

/** TTL sweep — plan links past expiry → EXPIRED. */
export async function expireStalePlanOrders(): Promise<number> {
  const res = await pool.query(
    `update pending_plan_orders set status = 'EXPIRED', updated_at = now()
      where status = 'AWAITING_PAYMENT' and link_expires_at < now()`,
  );
  return res.rowCount ?? 0;
}

export async function activeAwaitingPlanOrder(clientId: string): Promise<PlanOrder | null> {
  const res = await pool.query(
    `select * from pending_plan_orders
      where client_id = $1 and status = 'AWAITING_PAYMENT' and link_expires_at > now()
      order by created_at desc limit 1`,
    [clientId],
  );
  return res.rows[0] ?? null;
}

// ---------- slot cache (server-side validation of model-provided event_ids) ----------

/**
 * Short deterministic alias for an event_id. WhatsApp interactive row ids are
 * capped at 200 chars while Wix event_ids can exceed 300 — the alias is what
 * present_options puts in clickable rows, and getCachedSlot resolves both.
 */
export function slotChoiceKey(eventId: string): string {
  return `slot_${crypto.createHash("sha256").update(eventId).digest("hex").slice(0, 32)}`;
}

export async function cacheSlots(
  clientId: string,
  serviceId: string,
  slots: { eventId: string; slot: unknown }[],
): Promise<void> {
  for (const s of slots) {
    await pool.query(
      `insert into slot_cache (client_id, event_id, service_id, slot_json, choice_key, cached_at)
       values ($1, $2, $3, $4, $5, now())
       on conflict (client_id, event_id)
       do update set slot_json = excluded.slot_json, service_id = excluded.service_id,
                     choice_key = excluded.choice_key, cached_at = now()`,
      [clientId, s.eventId, serviceId, JSON.stringify(s.slot), slotChoiceKey(s.eventId)],
    );
  }
}

/** Look up a served slot by its full event_id OR by its short choice_key. */
export async function getCachedSlot(
  clientId: string,
  eventIdOrKey: string,
): Promise<{ event_id: string; service_id: string; slot_json: unknown } | null> {
  const res = await pool.query(
    `select event_id, service_id, slot_json from slot_cache
      where client_id = $1 and (event_id = $2 or choice_key = $2)
        and cached_at > now() - interval '2 hours'`,
    [clientId, eventIdOrKey],
  );
  return res.rows[0] ?? null;
}

// ---------- handoffs ----------

export async function recordHandoff(clientId: string, reason: string): Promise<void> {
  const excerpt = await recentTranscriptExcerpt(clientId);
  await pool.query(
    `insert into handoffs (client_id, reason, transcript_excerpt) values ($1, $2, $3)`,
    [clientId, reason, excerpt],
  );
}
