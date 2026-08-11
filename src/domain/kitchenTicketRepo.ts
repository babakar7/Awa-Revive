import { pool } from "../db/index.js";
import { extrasFromJson, type ExtraLine } from "../lib/cafeMenu.js";
import { recordOpsEvent } from "./opsEvents.js";
import {
  ACCUEIL_CHANNEL,
  CUISINE_CHANNEL,
  isOpenStatus,
  type KitchenTicketStatus,
  type KitchenTicketSource,
  type KitchenTicketView,
} from "./kitchenTicketRules.js";
import type { DeliveryOrder } from "./deliveryRepo.js";
import { deliveryTicketSubheading } from "./deliveryRules.js";

/**
 * SQL for kitchen tickets. Same house style as deliveryRepo: every state change
 * is an atomic conditional UPDATE (…WHERE status=… RETURNING) so a double-tap on
 * the iPad, two devices, or a concurrent sweep can't double-act. Delivery tickets
 * are a PROJECTION of delivery_orders: created at activation, driven to
 * COMPLETED/CANCELLED when the source order leaves the kitchen. The reconcile
 * pass is the durable backstop (a crash between activation and ticket insert is
 * healed on the next sweep — the unique index on delivery_order_id makes every
 * create idempotent). Every mutation records an ops_event so connected iPads
 * update live; the durable log also powers reconnect catch-up.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface KitchenTicket {
  id: string;
  source: KitchenTicketSource;
  delivery_order_id: string | null;
  client_request_id: string | null;
  items_json: unknown;
  note: string | null;
  amount_xof: number;
  heading: string;
  subheading: string | null;
  status: KitchenTicketStatus;
  claimed_by: string | null;
  claimed_at: Date | null;
  cancel_reason: string | null;
  is_test: boolean;
  /** TABLE order the guest wants packaged to-go (still seated at a spot). */
  takeaway: boolean;
  /** Set when the accueil escalates a TABLE order as urgent (NULL = normal). */
  urgent_at: Date | null;
  ipad_ack_at: Date | null;
  fallback_due_at: Date | null;
  fallback_claimed_at: Date | null;
  ready_at: Date | null;
  completed_at: Date | null;
  session_id: string | null;
  serve_by: string | null;
  serve_claimed_at: Date | null;
  serve_escalated_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

/** Row → the compact shape the PWA and SSE payloads use. */
export function kitchenTicketView(t: KitchenTicket): KitchenTicketView {
  return {
    id: t.id,
    source: t.source,
    status: t.status,
    items: extrasFromJson(t.items_json),
    note: t.note,
    amount_xof: t.amount_xof,
    is_test: t.is_test,
    claimed_by: t.claimed_by,
    heading: t.heading,
    subheading: t.subheading,
    created_at: t.created_at,
    ready_at: t.ready_at,
    ipad_ack_at: t.ipad_ack_at,
    serve_by: t.serve_by,
    session_id: t.session_id,
    takeaway: t.takeaway,
    urgent: t.urgent_at != null,
  };
}

/**
 * Every ticket event feeds BOTH realtime boards: the kitchen iPad (cuisine) and
 * the reception phones (accueil). Two durable rows (one per channel) so each
 * device replays only its own channel on reconnect. The accueil board ignores
 * the transitions it doesn't care about; the cuisine board ignores session events.
 */
async function emitTicket(kind: "ticket_new" | "ticket_update", t: KitchenTicket): Promise<void> {
  const view = kitchenTicketView(t);
  await recordOpsEvent(CUISINE_CHANNEL, kind, view);
  await recordOpsEvent(ACCUEIL_CHANNEL, kind, view);
}
async function emitRemoved(t: KitchenTicket): Promise<void> {
  const payload = { id: t.id, status: t.status };
  await recordOpsEvent(CUISINE_CHANNEL, "ticket_removed", payload);
  await recordOpsEvent(ACCUEIL_CHANNEL, "ticket_removed", payload);
}

// ---------- create (delivery → ticket) ----------

/**
 * Insert a NEW kitchen ticket for a delivery order, idempotent on
 * delivery_order_id (a retry/sweep never creates a second). `graceSeconds` sets
 * the WhatsApp-fallback deadline (no iPad ack by then → the legacy kitchen ticket
 * is sent). Returns the ticket and whether it was freshly created (only then is
 * a ticket_new event emitted).
 */
export async function createDeliveryTicket(
  order: DeliveryOrder,
  graceSeconds: number,
): Promise<{ ticket: KitchenTicket; created: boolean }> {
  const res = await pool.query(
    `insert into kitchen_tickets
       (source, delivery_order_id, items_json, note, amount_xof, heading, subheading,
        is_test, fallback_due_at)
     values ('DELIVERY', $1, $2, $3, $4, $5, $6, $7, now() + make_interval(secs => $8))
     on conflict (delivery_order_id) where delivery_order_id is not null do nothing
     returning *`,
    [
      order.id,
      JSON.stringify(extrasFromJson(order.items_json)),
      order.note,
      order.amount_xof,
      order.client_name,
      deliveryTicketSubheading(order),
      order.is_test,
      Math.max(0, graceSeconds),
    ],
  );
  const inserted = res.rows[0] as KitchenTicket | undefined;
  if (inserted) {
    await emitTicket("ticket_new", inserted);
    return { ticket: inserted, created: true };
  }
  const existing = await ticketByDeliveryOrder(order.id);
  return { ticket: existing as KitchenTicket, created: false };
}

/** Refresh the live iPad projection after an operational contact edit. */
export async function refreshDeliveryTicketContact(
  order: DeliveryOrder,
): Promise<KitchenTicket | null> {
  if (!UUID_RE.test(String(order.id))) return null;
  const res = await pool.query(
    `update kitchen_tickets
        set heading=$2, subheading=$3, updated_at=now()
      where delivery_order_id=$1 and status in ('NEW','PREPARING','READY')
      returning *`,
    [order.id, order.client_name, deliveryTicketSubheading(order)],
  );
  const ticket = (res.rows[0] as KitchenTicket) ?? null;
  if (ticket) await emitTicket("ticket_update", ticket);
  return ticket;
}

// ---------- create (on-site session → TABLE ticket) ----------

export interface TableTicketInput {
  sessionId: string;
  /** Frozen card labels: heading = short code (C-24), subheading = area · prénom. */
  heading: string;
  subheading: string;
  /** Server-priced lines (computeExtras output) — never trust a client total. */
  lines: ExtraLine[];
  amountXof: number;
  note: string | null;
  /** Idempotency key per phone send: a replay returns the existing ticket. */
  clientRequestId: string;
  isTest: boolean;
  /** Guest is seated but wants this order packaged to-go (absent/false = sur place). */
  takeaway?: boolean;
}

/**
 * Insert a NEW kitchen ticket for an on-site order, idempotent on
 * client_request_id (a double-tap or a reconnect replay returns the existing
 * ticket, never a second). No delivery order, no WhatsApp fallback (reception is
 * on-site) — fallback_due_at stays NULL. Emits ticket_new only on a fresh insert.
 */
export async function createTableTicket(
  input: TableTicketInput,
): Promise<{ ticket: KitchenTicket; created: boolean }> {
  const res = await pool.query(
    `insert into kitchen_tickets
       (source, session_id, client_request_id, items_json, note, amount_xof,
        heading, subheading, is_test, takeaway)
     values ('TABLE', $1, $2, $3, $4, $5, $6, $7, $8, $9)
     on conflict (client_request_id) where client_request_id is not null do nothing
     returning *`,
    [
      input.sessionId,
      input.clientRequestId,
      JSON.stringify(input.lines),
      input.note,
      input.amountXof,
      input.heading,
      input.subheading,
      input.isTest,
      input.takeaway ?? false,
    ],
  );
  const inserted = res.rows[0] as KitchenTicket | undefined;
  if (inserted) {
    await emitTicket("ticket_new", inserted);
    return { ticket: inserted, created: true };
  }
  const existing = await ticketByClientRequest(input.clientRequestId);
  return { ticket: existing as KitchenTicket, created: false };
}

export interface BarTicketInput {
  /** Stable `bar:cafe:<uuid>` or `bar:booking:<uuid>` source key. */
  sourceKey: string;
  heading: string;
  subheading: string | null;
  lines: ExtraLine[];
  amountXof: number;
  note: string | null;
  isTest: boolean;
  /** Web order to be packaged to-go (kitchen wraps it). Absent/false = comptoir. */
  takeaway?: boolean;
}

/**
 * Project a verified paid Awa bar order onto the kitchen iPad. The source key is
 * unique, so webhook retries and reconciliation can never create two tickets.
 * BAR has no WhatsApp fallback: the durable iPad event is the normal alert.
 */
export async function createBarTicket(
  input: BarTicketInput,
): Promise<{ ticket: KitchenTicket; created: boolean }> {
  const res = await pool.query(
    `insert into kitchen_tickets
       (source, client_request_id, items_json, note, amount_xof,
        heading, subheading, is_test, takeaway)
     values ('BAR', $1, $2, $3, $4, $5, $6, $7, $8)
     on conflict (client_request_id) where client_request_id is not null do nothing
     returning *`,
    [
      input.sourceKey,
      JSON.stringify(input.lines),
      input.note,
      input.amountXof,
      input.heading,
      input.subheading,
      input.isTest,
      input.takeaway ?? false,
    ],
  );
  const inserted = res.rows[0] as KitchenTicket | undefined;
  if (inserted) {
    await emitTicket("ticket_new", inserted);
    return { ticket: inserted, created: true };
  }
  const existing = await ticketByClientRequest(input.sourceKey);
  if (!existing) throw new Error(`BAR ticket source key missing after conflict: ${input.sourceKey}`);
  return { ticket: existing, created: false };
}

async function ticketByClientRequest(clientRequestId: string): Promise<KitchenTicket | null> {
  const res = await pool.query(
    `select * from kitchen_tickets where client_request_id = $1`,
    [clientRequestId],
  );
  return (res.rows[0] as KitchenTicket) ?? null;
}

// ---------- accueil transitions (reception phones, TABLE tickets) ----------

/**
 * "Je prends" — an accueil server atomically claims a READY table ticket to carry
 * it out. The `serve_by is null` guard makes two phones racing resolve to a single
 * winner (the loser gets null). Does NOT change status (the ticket is still READY,
 * now shown as taken). Emits ticket_update.
 */
export async function claimTableServe(id: string, by: string | null): Promise<KitchenTicket | null> {
  if (!UUID_RE.test(String(id))) return null;
  const res = await pool.query(
    `update kitchen_tickets
        set serve_by = $2, serve_claimed_at = now(), updated_at = now()
      where id = $1 and source = 'TABLE' and status = 'READY' and serve_by is null
      returning *`,
    [id, by],
  );
  const ticket = (res.rows[0] as KitchenTicket) ?? null;
  if (ticket) await emitTicket("ticket_update", ticket);
  return ticket;
}

/**
 * Accueil escalates (or de-escalates) an on-site order as urgent — a client who
 * has waited too long / is getting impatient. Sets/clears `urgent_at`; the kitchen
 * board sorts urgent tickets to the top and announces them. Only affects an OPEN
 * TABLE ticket. Idempotent. Emits ticket_update (fan-out to both boards).
 */
export async function setTicketUrgent(id: string, urgent: boolean, _by: string | null): Promise<KitchenTicket | null> {
  if (!UUID_RE.test(String(id))) return null;
  const res = await pool.query(
    `update kitchen_tickets
        set urgent_at = ${urgent ? "now()" : "null"}, updated_at = now()
      where id = $1 and source = 'TABLE' and status in ('NEW','PREPARING','READY')
      returning *`,
    [id],
  );
  const ticket = (res.rows[0] as KitchenTicket) ?? null;
  if (ticket) await emitTicket("ticket_update", ticket);
  return ticket;
}

/**
 * "Servie" — a READY table ticket is served and leaves both boards (COMPLETED).
 * Idempotent (a second tap finds no READY row). Records the server if the ticket
 * was never claimed. Emits ticket_removed.
 */
export async function serveTableTicket(id: string, by: string | null): Promise<KitchenTicket | null> {
  if (!UUID_RE.test(String(id))) return null;
  const res = await pool.query(
    `update kitchen_tickets
        set status = 'COMPLETED', completed_at = now(),
            serve_by = coalesce(serve_by, $2),
            serve_claimed_at = coalesce(serve_claimed_at, now()),
            updated_at = now()
      where id = $1 and source = 'TABLE' and status = 'READY'
      returning *`,
    [id, by],
  );
  const ticket = (res.rows[0] as KitchenTicket) ?? null;
  if (ticket) await emitRemoved(ticket);
  return ticket;
}

/**
 * Accueil cancels an on-site order (mistake, client left) from any open state.
 * Leaves both boards (CANCELLED). Emits ticket_removed.
 */
export async function cancelTableTicket(id: string, reason: string | null): Promise<KitchenTicket | null> {
  if (!UUID_RE.test(String(id))) return null;
  const res = await pool.query(
    `update kitchen_tickets
        set status = 'CANCELLED', cancel_reason = $2, updated_at = now()
      where id = $1 and source = 'TABLE' and status in ('NEW','PREPARING','READY')
      returning *`,
    [id, reason],
  );
  const ticket = (res.rows[0] as KitchenTicket) ?? null;
  if (ticket) await emitRemoved(ticket);
  return ticket;
}

/**
 * Self-cleaning board: a TABLE/BAR ticket still open hours after creation was in
 * reality long handled — served, forgotten, or the client left — and nobody ever
 * tapped « Servie »/« Terminée » (an 08/08 session sat on the kitchen iPad for two
 * days). Mark it ready (if it never was) and COMPLETED so it leaves both boards;
 * the empty-session sweep can then free its table. DELIVERY tickets are excluded
 * on purpose: their lifecycle is driven by the delivery order, and a stale
 * in-kitchen delivery is an incident to surface, never to hide. Emits
 * ticket_removed per closed row.
 */
export async function autoCloseStaleTickets(maxAgeMinutes: number): Promise<KitchenTicket[]> {
  const res = await pool.query(
    `update kitchen_tickets
        set status = 'COMPLETED', completed_at = now(),
            ready_at = coalesce(ready_at, now()),
            serve_by = coalesce(serve_by, 'auto'),
            updated_at = now()
      where source in ('TABLE','BAR') and status in ('NEW','PREPARING','READY')
        and created_at < now() - make_interval(mins => $1)
      returning *`,
    [Math.max(1, Math.floor(maxAgeMinutes))],
  );
  const rows = res.rows as KitchenTicket[];
  for (const row of rows) await emitRemoved(row);
  return rows;
}

/**
 * Atomically claim TABLE tickets that have been READY but UN-TAKEN (no serve_by)
 * for longer than the threshold, for owner escalation. The `serve_escalated_at IS
 * NULL` guard means each ticket escalates exactly once even if the sweep overlaps.
 * Returns the freshly claimed tickets to notify about.
 */
export async function claimStaleServeEscalations(thresholdSeconds: number): Promise<KitchenTicket[]> {
  const res = await pool.query(
    `update kitchen_tickets
        set serve_escalated_at = now(), updated_at = now()
      where source = 'TABLE' and status = 'READY'
        and serve_by is null and serve_escalated_at is null
        and ready_at is not null and ready_at < now() - make_interval(secs => $1)
      returning *`,
    [Math.max(0, thresholdSeconds)],
  );
  return res.rows as KitchenTicket[];
}

/** Open kitchen tickets (NEW/PREPARING/READY) of one session, oldest first. */
export async function ticketsForSession(sessionId: string): Promise<KitchenTicket[]> {
  if (!UUID_RE.test(String(sessionId))) return [];
  const res = await pool.query(
    `select * from kitchen_tickets
      where session_id = $1 and status in ('NEW','PREPARING','READY')
      order by created_at asc`,
    [sessionId],
  );
  return res.rows as KitchenTicket[];
}

// ---------- cuisine transitions (iPad) ----------

const ADVANCE_FROM: Record<"PREPARING" | "READY", KitchenTicketStatus[]> = {
  PREPARING: ["NEW"],
  READY: ["NEW", "PREPARING"],
};

/**
 * Cuisine advances a ticket (NEW → PREPARING → READY). Atomic: the WHERE clause
 * enforces the allowed source states, so a stale tap or a double-tap returns null
 * (idempotent). Setting READY stamps ready_at. Emits ticket_update on success.
 */
export async function advanceTicketByCuisine(
  id: string,
  to: "PREPARING" | "READY",
  by: string | null,
): Promise<KitchenTicket | null> {
  if (!UUID_RE.test(String(id))) return null;
  const froms = ADVANCE_FROM[to];
  if (!froms) return null;
  const res = await pool.query(
    `update kitchen_tickets
        set status = $2,
            ready_at = case when $2 = 'READY' then now() else ready_at end,
            claimed_by = coalesce(claimed_by, $3),
            updated_at = now()
      where id = $1 and status = any($4)
      returning *`,
    [id, to, by, froms],
  );
  const ticket = (res.rows[0] as KitchenTicket) ?? null;
  if (ticket) await emitTicket("ticket_update", ticket);
  return ticket;
}

/** A paid BAR order leaves the kitchen board only after the kitchen taps Done. */
export async function completeBarTicket(
  id: string,
  by: string | null,
): Promise<KitchenTicket | null> {
  if (!UUID_RE.test(String(id))) return null;
  const res = await pool.query(
    `update kitchen_tickets
        set status='COMPLETED', completed_at=now(),
            claimed_by=coalesce(claimed_by,$2), updated_at=now()
      where id=$1 and source='BAR' and status='READY'
      returning *`,
    [id, by],
  );
  const ticket = (res.rows[0] as KitchenTicket) ?? null;
  if (ticket) await emitRemoved(ticket);
  return ticket;
}

/**
 * First iPad ACK stops the WhatsApp fallback for this ticket (idempotent). Also
 * marks the linked delivery's kitchen notification as done when it was still
 * merely 'pending' — the kitchen HAS been notified, via the iPad — so the board
 * reads honestly and the sweep stops considering it. The guard `= 'pending'`
 * never overrides a real WhatsApp outcome (sent/failed/partial), so PARALLEL
 * mode (where the WhatsApp already fired) is unaffected.
 */
export async function ackTicketDisplayed(id: string): Promise<boolean> {
  if (!UUID_RE.test(String(id))) return false;
  // One atomic statement. The guarded UPDATE (`ipad_ack_at is null`) decides the
  // FIRST ack: its RETURNING yields a row only then, so a repeated ack touches
  // nothing. The `notified` CTE still runs to completion — Postgres executes
  // every data-modifying WITH statement exactly once regardless of whether the
  // final query reads it — preserving the delivery 'pending' → 'sent' honesty the
  // WhatsApp fallback depends on. The final SELECT surfaces the first-ack row +
  // the ack timestamp for the realtime `ticket_ack`.
  const res = await pool.query(
    `with acked as (
       update kitchen_tickets set ipad_ack_at = now(), updated_at = now()
        where id = $1 and ipad_ack_at is null
        returning id, ipad_ack_at, delivery_order_id
     ),
     notified as (
       update delivery_orders d
          set kitchen_notify_status = 'sent',
              kitchen_notified_at = coalesce(kitchen_notified_at, now()),
              updated_at = now()
        where d.id in (select delivery_order_id from acked where delivery_order_id is not null)
          and d.kitchen_notify_status = 'pending'
        returning d.id
     )
     select id, ipad_ack_at from acked`,
    [id],
  );
  const row = res.rows[0] as { id: string; ipad_ack_at: Date } | undefined;
  if (row) {
    // First ack ONLY: tell both boards the tablet actually rendered this ticket,
    // exactly once. The reception board flips "Envoi à Cuisine…" → "Reçue par
    // Cuisine ✓" on this; a repeated ack updated no row so it never re-emits.
    const payload = { id: row.id, ipad_ack_at: row.ipad_ack_at };
    await recordOpsEvent(CUISINE_CHANNEL, "ticket_ack", payload);
    await recordOpsEvent(ACCUEIL_CHANNEL, "ticket_ack", payload);
    return true;
  }
  // Not the first ack: already-acked ticket (idempotent true) or unknown id (false).
  return await wasAcked(id);
}

async function wasAcked(id: string): Promise<boolean> {
  const res = await pool.query(
    `select 1 from kitchen_tickets where id = $1 and ipad_ack_at is not null`,
    [id],
  );
  return (res.rowCount ?? 0) > 0;
}

/**
 * Delivery order ids whose kitchen WhatsApp is UNLOCKED in fallback mode: the
 * ticket's fallback was claimed (iPad never acked in time) and the order still
 * needs a (re)send. This is the fallback-mode analogue of pendingKitchenNotifies
 * — the WhatsApp only flows once the grace window lapsed without an ack.
 */
export async function unlockedPendingKitchenOrderIds(): Promise<string[]> {
  const res = await pool.query(
    `select d.id from delivery_orders d
       join kitchen_tickets k on k.delivery_order_id = d.id
      where d.status = 'IN_KITCHEN' and d.activated_at is not null
        and k.fallback_claimed_at is not null
        and d.kitchen_notify_attempts < 3
        and ( d.kitchen_notify_status in ('pending','failed')
              or (d.kitchen_notify_status = 'claimed' and d.updated_at < now() - interval '2 minutes') )`,
  );
  return res.rows.map((r: any) => r.id as string);
}

// ---------- source-driven terminal transitions ----------

/** Delivery departed/delivered → its ticket is COMPLETED (leaves the board). */
export async function completeTicketForDelivery(orderId: string): Promise<KitchenTicket | null> {
  if (!UUID_RE.test(String(orderId))) return null;
  const res = await pool.query(
    `update kitchen_tickets
        set status = 'COMPLETED', completed_at = now(), updated_at = now()
      where delivery_order_id = $1 and status in ('NEW','PREPARING','READY')
      returning *`,
    [orderId],
  );
  const ticket = (res.rows[0] as KitchenTicket) ?? null;
  if (ticket) await emitRemoved(ticket);
  return ticket;
}

/** Delivery cancelled → its ticket is CANCELLED (leaves the board). */
export async function cancelTicketForDelivery(
  orderId: string,
  reason: string | null,
): Promise<KitchenTicket | null> {
  if (!UUID_RE.test(String(orderId))) return null;
  const res = await pool.query(
    `update kitchen_tickets
        set status = 'CANCELLED', cancel_reason = $2, updated_at = now()
      where delivery_order_id = $1 and status in ('NEW','PREPARING','READY')
      returning *`,
    [orderId, reason],
  );
  const ticket = (res.rows[0] as KitchenTicket) ?? null;
  if (ticket) await emitRemoved(ticket);
  return ticket;
}

// ---------- fallback (WhatsApp) claim ----------

/**
 * Atomically claim the WhatsApp fallback for one ticket: only if the iPad never
 * acked it, it wasn't already claimed, and its grace deadline has passed. The
 * claim (fallback_claimed_at) guarantees a single send even if the in-process
 * timer and the 60s sweep race. Returns the delivery order to notify, or null.
 */
export async function claimTicketFallback(
  id: string,
): Promise<{ ticketId: string; deliveryOrderId: string } | null> {
  if (!UUID_RE.test(String(id))) return null;
  const res = await pool.query(
    `update kitchen_tickets
        set fallback_claimed_at = now(), updated_at = now()
      where id = $1 and ipad_ack_at is null and fallback_claimed_at is null
        and fallback_due_at is not null and fallback_due_at <= now()
        and status in ('NEW','PREPARING','READY')
        and delivery_order_id is not null
      returning id, delivery_order_id`,
    [id],
  );
  const row = res.rows[0] as { id: string; delivery_order_id: string } | undefined;
  return row ? { ticketId: row.id, deliveryOrderId: row.delivery_order_id } : null;
}

/** Ticket ids whose WhatsApp fallback is due right now (sweep input). */
export async function dueFallbackTicketIds(): Promise<string[]> {
  const res = await pool.query(
    `select id from kitchen_tickets
      where ipad_ack_at is null and fallback_claimed_at is null
        and fallback_due_at is not null and fallback_due_at <= now()
        and status in ('NEW','PREPARING','READY')
        and delivery_order_id is not null`,
  );
  return res.rows.map((r: any) => r.id as string);
}

// ---------- reconcile (durable backstop) ----------

/**
 * Project delivery_orders onto kitchen tickets. Idempotent, safe to run every
 * sweep:
 *  1. create a NEW ticket for every ACTIVATED, IN_KITCHEN delivery still missing
 *     one (heals a crash between activation and ticket insert);
 *  2. COMPLETE tickets whose delivery has left the kitchen (departed/delivered);
 *  3. CANCEL tickets whose delivery was cancelled.
 * Emits the matching ops_events so live iPads reflect changes that originated
 * outside the iPad (a scheduled order activating, a departure from the admin
 * board). `graceSeconds` seeds the fallback deadline for freshly created rows.
 */
export async function reconcileDeliveryTickets(
  graceSeconds: number,
): Promise<{ created: number; completed: number; cancelled: number }> {
  const created = await pool.query(
    `insert into kitchen_tickets
       (source, delivery_order_id, items_json, note, amount_xof, heading, subheading,
        is_test, fallback_due_at)
     select 'DELIVERY', d.id, d.items_json, d.note, d.amount_xof, d.client_name,
            d.address || case
              when d.recipient_name is not null and d.recipient_phone is not null
                then ' · Remise à ' || d.recipient_name || ' (+' || d.recipient_phone || ')'
              else ' · Appeler ' || d.client_name || ' (+' || d.client_phone || ')'
            end,
            d.is_test, now() + make_interval(secs => $1)
       from delivery_orders d
       left join kitchen_tickets k on k.delivery_order_id = d.id
      where d.status = 'IN_KITCHEN' and d.activated_at is not null and k.id is null
     on conflict (delivery_order_id) where delivery_order_id is not null do nothing
     returning *`,
    [Math.max(0, graceSeconds)],
  );
  for (const row of created.rows as KitchenTicket[]) await emitTicket("ticket_new", row);

  const refreshed = await pool.query(
    `update kitchen_tickets k
        set heading=d.client_name,
            subheading=d.address || case
              when d.recipient_name is not null and d.recipient_phone is not null
                then ' · Remise à ' || d.recipient_name || ' (+' || d.recipient_phone || ')'
              else ' · Appeler ' || d.client_name || ' (+' || d.client_phone || ')'
            end,
            updated_at=now()
       from delivery_orders d
      where k.delivery_order_id=d.id
        and k.status in ('NEW','PREPARING','READY')
        and (
          k.heading is distinct from d.client_name
          or k.subheading is distinct from (
            d.address || case
              when d.recipient_name is not null and d.recipient_phone is not null
                then ' · Remise à ' || d.recipient_name || ' (+' || d.recipient_phone || ')'
              else ' · Appeler ' || d.client_name || ' (+' || d.client_phone || ')'
            end
          )
        )
     returning k.*`,
  );
  for (const row of refreshed.rows as KitchenTicket[]) await emitTicket("ticket_update", row);

  const completed = await pool.query(
    `update kitchen_tickets k
        set status = 'COMPLETED', completed_at = now(), updated_at = now()
       from delivery_orders d
      where k.delivery_order_id = d.id
        and k.status in ('NEW','PREPARING','READY')
        and d.status in ('OUT_FOR_DELIVERY','DELIVERED')
     returning k.*`,
  );
  for (const row of completed.rows as KitchenTicket[]) await emitRemoved(row);

  const cancelled = await pool.query(
    `update kitchen_tickets k
        set status = 'CANCELLED',
            cancel_reason = coalesce(k.cancel_reason, 'livraison annulée'),
            updated_at = now()
       from delivery_orders d
      where k.delivery_order_id = d.id
        and k.status in ('NEW','PREPARING','READY')
        and d.status = 'CANCELLED'
     returning k.*`,
  );
  for (const row of cancelled.rows as KitchenTicket[]) await emitRemoved(row);

  return {
    created: created.rowCount ?? 0,
    completed: completed.rowCount ?? 0,
    cancelled: cancelled.rowCount ?? 0,
  };
}

// ---------- reads ----------

export async function listOpenKitchenTickets(): Promise<KitchenTicket[]> {
  const res = await pool.query(
    `select * from kitchen_tickets
      where status in ('NEW','PREPARING','READY')
      order by created_at asc`,
  );
  return res.rows as KitchenTicket[];
}

export async function getKitchenTicket(id: string): Promise<KitchenTicket | null> {
  if (!UUID_RE.test(String(id))) return null;
  const res = await pool.query(`select * from kitchen_tickets where id = $1`, [id]);
  return (res.rows[0] as KitchenTicket) ?? null;
}

/** A ticket that already left the board — for the cuisine recent-history recall. */
export interface RecentClosedTicket extends KitchenTicketView {
  /** completed_at, else updated_at — when it left the board. */
  finished_at: Date | string;
  cancel_reason: string | null;
}

/**
 * Today's served/cancelled tickets, most recently gone first. READ-ONLY, bounded
 * to the current day and `limit` — a recall aid (re-check an instruction, a missed
 * announcement, a dispute), not reporting. Dakar = UTC+0 so `current_date` is local.
 */
export async function listRecentClosedTickets(limit = 30): Promise<RecentClosedTicket[]> {
  const cap = Math.min(80, Math.max(1, Math.floor(limit)));
  const res = await pool.query(
    `select * from kitchen_tickets
      where status in ('COMPLETED','CANCELLED')
        and coalesce(completed_at, updated_at)::date = current_date
      order by coalesce(completed_at, updated_at) desc
      limit $1`,
    [cap],
  );
  return (res.rows as KitchenTicket[]).map((t) => ({
    ...kitchenTicketView(t),
    finished_at: t.completed_at ?? t.updated_at,
    cancel_reason: t.cancel_reason,
  }));
}

/** Owner supervision KPIs (indicative — the POS remains the ledger). Today's
 *  counts + average prep time. Dakar is UTC+0 so the server `current_date`
 *  matches the local day. `avgPrepSecs` is null before any ticket is READY. */
export interface TicketStatsToday {
  totalToday: number;
  urgentToday: number;
  inProgress: number;
  avgPrepSecs: number | null;
}
export async function ticketStatsToday(): Promise<TicketStatsToday> {
  // Test tickets (is_test) are excluded from every aggregate: a create→instant-ready
  // test order would otherwise wreck the day's average prep time and inflate counts.
  const res = await pool.query(
    `select
       count(*) filter (where created_at::date = current_date)                          as total_today,
       count(*) filter (where created_at::date = current_date and urgent_at is not null) as urgent_today,
       count(*) filter (where status in ('NEW','PREPARING','READY'))                     as in_progress,
       avg(extract(epoch from (ready_at - created_at)))
         filter (where ready_at is not null and created_at::date = current_date)         as avg_prep_secs
     from kitchen_tickets
     where not is_test`,
  );
  const r = res.rows[0] ?? {};
  return {
    totalToday: Number(r.total_today ?? 0),
    urgentToday: Number(r.urgent_today ?? 0),
    inProgress: Number(r.in_progress ?? 0),
    avgPrepSecs: r.avg_prep_secs == null ? null : Number(r.avg_prep_secs),
  };
}

/**
 * Item ids ordered by how often they've SOLD over the last `days` (default 30),
 * most first — powers the "🔥 Populaires" section of the order pickers. One jsonb
 * scan over kitchen_tickets.items_json: cancelled/test tickets and "Supplément…"
 * add-ons are excluded (add-ons aren't standalone dishes). Memoized 5 min because
 * it's read on every board boot / menu.json and the ranking barely moves.
 */
let topCache: { ids: string[]; at: number } | null = null;
const TOP_TTL_MS = 5 * 60_000;
export async function topOrderedItemIds(days = 30, limit = 8): Promise<string[]> {
  if (topCache && Date.now() - topCache.at < TOP_TTL_MS) return topCache.ids.slice(0, limit);
  const res = await pool.query(
    `select l->>'id' as id, sum((l->>'qty')::int) as n
       from kitchen_tickets t,
            lateral jsonb_array_elements(t.items_json) l
      where t.created_at >= now() - ($1::int * interval '1 day')
        and t.status <> 'CANCELLED'
        and t.is_test = false
        and coalesce(l->>'id','') <> ''
        and l->>'name' not ilike 'suppl%'
      group by l->>'id'
      order by n desc
      limit 24`,
    [days],
  );
  const ids = res.rows.map((r) => String(r.id));
  topCache = { ids, at: Date.now() };
  return ids.slice(0, limit);
}

/** Test-only: drop the memoized ranking so a freshly-seeded DB isn't masked. */
export function __resetTopCache(): void {
  topCache = null;
}

export async function ticketByDeliveryOrder(orderId: string): Promise<KitchenTicket | null> {
  if (!UUID_RE.test(String(orderId))) return null;
  const res = await pool.query(
    `select * from kitchen_tickets where delivery_order_id = $1`,
    [orderId],
  );
  return (res.rows[0] as KitchenTicket) ?? null;
}

/** Whether a ticket is still on the kitchen board. */
export function ticketIsOpen(t: Pick<KitchenTicket, "status">): boolean {
  return isOpenStatus(t.status);
}
