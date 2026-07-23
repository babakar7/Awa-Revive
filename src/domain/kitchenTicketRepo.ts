import { pool } from "../db/index.js";
import { extrasFromJson } from "../lib/cafeMenu.js";
import { recordOpsEvent } from "./opsEvents.js";
import {
  CUISINE_CHANNEL,
  isOpenStatus,
  type KitchenTicketStatus,
  type KitchenTicketSource,
  type KitchenTicketView,
} from "./kitchenTicketRules.js";
import type { DeliveryOrder } from "./deliveryRepo.js";

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
  ipad_ack_at: Date | null;
  fallback_due_at: Date | null;
  fallback_claimed_at: Date | null;
  ready_at: Date | null;
  completed_at: Date | null;
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
  };
}

async function emitTicket(kind: "ticket_new" | "ticket_update", t: KitchenTicket): Promise<void> {
  await recordOpsEvent(CUISINE_CHANNEL, kind, kitchenTicketView(t));
}
async function emitRemoved(t: KitchenTicket): Promise<void> {
  await recordOpsEvent(CUISINE_CHANNEL, "ticket_removed", { id: t.id, status: t.status });
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
      order.address,
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

/** First iPad ACK stops the WhatsApp fallback for this ticket (idempotent). */
export async function ackTicketDisplayed(id: string): Promise<boolean> {
  if (!UUID_RE.test(String(id))) return false;
  const res = await pool.query(
    `update kitchen_tickets set ipad_ack_at = now(), updated_at = now()
      where id = $1 and ipad_ack_at is null`,
    [id],
  );
  return (res.rowCount ?? 0) > 0;
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
     select 'DELIVERY', d.id, d.items_json, d.note, d.amount_xof, d.client_name, d.address,
            d.is_test, now() + make_interval(secs => $1)
       from delivery_orders d
       left join kitchen_tickets k on k.delivery_order_id = d.id
      where d.status = 'IN_KITCHEN' and d.activated_at is not null and k.id is null
     on conflict (delivery_order_id) where delivery_order_id is not null do nothing
     returning *`,
    [Math.max(0, graceSeconds)],
  );
  for (const row of created.rows as KitchenTicket[]) await emitTicket("ticket_new", row);

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
