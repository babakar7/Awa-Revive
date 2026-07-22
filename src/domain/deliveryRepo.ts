import { pool } from "../db/index.js";
import { extrasFromJson, type ExtraLine } from "../lib/cafeMenu.js";
import {
  hashReadyToken,
  newReadyToken,
  type DeliveryStatus,
} from "./deliveryRules.js";

/**
 * SQL + claim primitives for delivery orders. All state changes are atomic
 * conditional UPDATEs (…WHERE status=… RETURNING) so concurrent sweeps, kitchen
 * taps, and admin clicks can't double-act. The kitchen/client notification
 * outcomes are tracked as small "outbox" statuses (pending → claimed → sent/…)
 * with an attempt cap so the 60-second sweep can retry after a crash between
 * commit and send. Pure logic (transitions, tokens, messages) lives in
 * deliveryRules; WhatsApp effects + the sweep in deliveryNotify.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_NOTIFY_ATTEMPTS = 3;

export type NotifyStatus =
  | "pending"
  | "claimed"
  | "sent"
  | "sent_template"
  | "partial"
  | "fallback_reception"
  | "failed";

export interface DeliveryOrder {
  id: string;
  client_name: string;
  client_phone: string;
  address: string;
  note: string | null;
  items_json: unknown;
  amount_xof: number;
  is_test: boolean;
  status: DeliveryStatus;
  sla_minutes: number;
  ready_token_hash: string;
  created_by: string | null;
  kitchen_notify_status: NotifyStatus;
  kitchen_notified_at: Date | null;
  kitchen_notify_attempts: number;
  created_notify_status: NotifyStatus; // the creation-confirmation ping
  created_notified_at: Date | null;
  created_notify_attempts: number;
  created_notify_wamid: string | null;
  route_notify_status: NotifyStatus; // the "out for delivery" ping
  route_notified_at: Date | null;
  route_notify_attempts: number;
  route_notify_wamid: string | null;
  alerted_at: Date | null; // SLA (not departed in time) alert, one-shot
  out_for_delivery_at: Date | null;
  out_for_delivery_by: string | null;
  delivered_at: Date | null;
  delivered_by: string | null;
  cancelled_at: Date | null;
  cancelled_by: string | null;
  created_at: Date;
  updated_at: Date;
}

/** Convenience: the frozen items snapshot as ExtraLine[]. */
export function orderItems(o: DeliveryOrder): ExtraLine[] {
  return extrasFromJson(o.items_json);
}

// ---------- create / read ----------

export interface CreateDeliveryInput {
  client_name: string;
  client_phone: string; // already normalized (wa_id digits)
  address: string;
  note: string | null;
  items: ExtraLine[];
  amount_xof: number;
  sla_minutes: number;
  created_by: string | null;
  is_test: boolean;
}

/** Insert an order (status IN_KITCHEN). Returns the row AND the cleartext token
 *  (the only moment it exists outside the client's WhatsApp — never stored). */
export async function createDeliveryOrder(
  input: CreateDeliveryInput,
): Promise<{ order: DeliveryOrder; token: string }> {
  const token = newReadyToken();
  const res = await pool.query(
    `insert into delivery_orders
       (client_name, client_phone, address, note, items_json, amount_xof,
        sla_minutes, ready_token_hash, created_by, is_test)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     returning *`,
    [
      input.client_name,
      input.client_phone,
      input.address,
      input.note,
      JSON.stringify(input.items),
      input.amount_xof,
      input.sla_minutes,
      hashReadyToken(token),
      input.created_by,
      input.is_test,
    ],
  );
  return { order: res.rows[0] as DeliveryOrder, token };
}

export async function findDeliveryOrder(id: string): Promise<DeliveryOrder | null> {
  if (!UUID_RE.test(String(id))) return null; // never 500 on a junk public URL
  const res = await pool.query(`select * from delivery_orders where id = $1`, [id]);
  return (res.rows[0] as DeliveryOrder) ?? null;
}

/**
 * Look up an order by its magic-link token (the public route has only the
 * token, no id — cleaner URL for the Meta button, and nothing enumerable). We
 * match on the stored HASH, so the cleartext token is never queried or logged.
 */
export async function findDeliveryOrderByToken(token: string): Promise<DeliveryOrder | null> {
  if (!token) return null;
  const res = await pool.query(`select * from delivery_orders where ready_token_hash = $1`, [
    hashReadyToken(String(token)),
  ]);
  return (res.rows[0] as DeliveryOrder) ?? null;
}

// ---------- status transitions (atomic) ----------

async function transition(
  id: string,
  fromStatuses: DeliveryStatus[],
  set: string,
  params: unknown[],
): Promise<DeliveryOrder | null> {
  if (!UUID_RE.test(String(id))) return null;
  const res = await pool.query(
    `update delivery_orders set ${set}, updated_at = now()
      where id = $1 and status = any($2) returning *`,
    [id, fromStatuses, ...params],
  );
  return (res.rows[0] as DeliveryOrder) ?? null;
}

/** IN_KITCHEN → OUT_FOR_DELIVERY. Null if already departed/closed (idempotent double-tap). */
export function markOutForDelivery(id: string, by: string): Promise<DeliveryOrder | null> {
  return transition(
    id,
    ["IN_KITCHEN"],
    "status='OUT_FOR_DELIVERY', out_for_delivery_at=now(), out_for_delivery_by=$3",
    [by],
  );
}

/** IN_KITCHEN|OUT_FOR_DELIVERY → DELIVERED (closing an order whose departure was
 *  never tapped is allowed — the client just never gets a route ping). */
export function markDelivered(id: string, by: string): Promise<DeliveryOrder | null> {
  return transition(
    id,
    ["IN_KITCHEN", "OUT_FOR_DELIVERY"],
    "status='DELIVERED', delivered_at=now(), delivered_by=$3",
    [by],
  );
}

export function markCancelled(id: string, by: string): Promise<DeliveryOrder | null> {
  return transition(
    id,
    ["IN_KITCHEN", "OUT_FOR_DELIVERY"],
    "status='CANCELLED', cancelled_at=now(), cancelled_by=$3",
    [by],
  );
}

/** Fresh token for an open order (invalidates the old magic link). Null if the
 *  order isn't IN_KITCHEN anymore. Returns the new cleartext token. */
export async function rotateReadyToken(id: string): Promise<string | null> {
  if (!UUID_RE.test(String(id))) return null;
  const token = newReadyToken();
  const res = await pool.query(
    `update delivery_orders
        set ready_token_hash = $2, kitchen_notify_status = 'pending', updated_at = now()
      where id = $1 and status = 'IN_KITCHEN' returning id`,
    [id, hashReadyToken(token)],
  );
  return (res.rowCount ?? 0) > 0 ? token : null;
}

// ---------- notification outbox (kitchen + client) ----------

/**
 * Claim the right to (re)attempt the kitchen notification for one order. Owns
 * the attempt (returns the row) when it's pending/failed, or a `claimed` row
 * stuck >2 min (crash between claim and send). Caps at MAX_NOTIFY_ATTEMPTS.
 * Called by BOTH the create route (immediate) and the sweep (retry).
 */
export async function claimKitchenNotify(id: string): Promise<DeliveryOrder | null> {
  const res = await pool.query(
    `update delivery_orders
        set kitchen_notify_status = 'claimed',
            kitchen_notify_attempts = kitchen_notify_attempts + 1,
            updated_at = now()
      where id = $1 and status = 'IN_KITCHEN'
        and kitchen_notify_attempts < $2
        and ( kitchen_notify_status in ('pending','failed')
              or (kitchen_notify_status = 'claimed' and updated_at < now() - interval '2 minutes') )
      returning *`,
    [id, MAX_NOTIFY_ATTEMPTS],
  );
  return (res.rows[0] as DeliveryOrder) ?? null;
}

export async function setKitchenNotifyOutcome(
  id: string,
  status: NotifyStatus,
  reachedKitchen: boolean,
): Promise<void> {
  await pool.query(
    `update delivery_orders
        set kitchen_notify_status = $2,
            kitchen_notified_at = case when $3 then now() else kitchen_notified_at end,
            updated_at = now()
      where id = $1`,
    [id, status, reachedKitchen],
  );
}

/**
 * The two client-facing pings share one claim/outcome/pending discipline; only
 * the tracking columns and the order-statuses in which each is (still) relevant
 * differ. Column names and status IN-lists come ONLY from this hardcoded
 * whitelist — never from input — so interpolating them into SQL is safe.
 *  - created: claimable while still open (a fast departure mustn't lose the
 *    confirmation); dropped if cancelled/delivered before it ever landed.
 *  - route: once OUT_FOR_DELIVERY (covers a depart→delivered within seconds).
 */
type ClientPing = "created" | "route";
const CLIENT_PING_COLS: Record<
  ClientPing,
  { status: string; at: string; attempts: string; wamid: string; claimIn: string; pendingIn: string }
> = {
  created: {
    status: "created_notify_status",
    at: "created_notified_at",
    attempts: "created_notify_attempts",
    wamid: "created_notify_wamid",
    claimIn: "('IN_KITCHEN','OUT_FOR_DELIVERY')",
    pendingIn: "('IN_KITCHEN','OUT_FOR_DELIVERY')",
  },
  route: {
    status: "route_notify_status",
    at: "route_notified_at",
    attempts: "route_notify_attempts",
    wamid: "route_notify_wamid",
    claimIn: "('OUT_FOR_DELIVERY','DELIVERED')",
    pendingIn: "('OUT_FOR_DELIVERY')",
  },
};

async function claimClientPing(id: string, kind: ClientPing): Promise<DeliveryOrder | null> {
  const c = CLIENT_PING_COLS[kind];
  const res = await pool.query(
    `update delivery_orders
        set ${c.status} = 'claimed',
            ${c.attempts} = ${c.attempts} + 1,
            ${c.wamid} = null,
            updated_at = now()
      where id = $1 and status in ${c.claimIn}
        and ${c.attempts} < $2
        and ( ${c.status} in ('pending','failed')
              or (${c.status} = 'claimed' and updated_at < now() - interval '2 minutes') )
      returning *`,
    [id, MAX_NOTIFY_ATTEMPTS],
  );
  return (res.rows[0] as DeliveryOrder) ?? null;
}

async function setClientPingOutcome(
  id: string,
  kind: ClientPing,
  status: NotifyStatus,
  waMessageId: string | null = null,
): Promise<void> {
  const c = CLIENT_PING_COLS[kind];
  await pool.query(
    `update delivery_orders
        set ${c.status} = $2,
            ${c.at} = case when $2 in ('sent','sent_template') then now() else ${c.at} end,
            ${c.wamid} = case when $2 in ('sent','sent_template') then $3 else null end,
            updated_at = now()
      where id = $1`,
    [id, status, waMessageId],
  );
}

async function pendingClientPings(kind: ClientPing): Promise<string[]> {
  const c = CLIENT_PING_COLS[kind];
  const res = await pool.query(
    `select id from delivery_orders
      where status in ${c.pendingIn} and ${c.attempts} < $1
        and ( ${c.status} in ('pending','failed')
              or (${c.status} = 'claimed' and updated_at < now() - interval '2 minutes') )`,
    [MAX_NOTIFY_ATTEMPTS],
  );
  return res.rows.map((r: any) => r.id as string);
}

// Named entry points (call sites stay explicit).
export const claimCreatedNotify = (id: string) => claimClientPing(id, "created");
export const claimRouteNotify = (id: string) => claimClientPing(id, "route");
export const setCreatedNotifyOutcome = (
  id: string,
  status: NotifyStatus,
  waMessageId: string | null = null,
) => setClientPingOutcome(id, "created", status, waMessageId);
export const setRouteNotifyOutcome = (
  id: string,
  status: NotifyStatus,
  waMessageId: string | null = null,
) => setClientPingOutcome(id, "route", status, waMessageId);

/**
 * Meta may accept free text with HTTP 200 and reject it asynchronously because
 * the 24h window is closed. Match the CURRENT wamid only, flip that ping back
 * to failed, and let the 60s sweep retry it (up to the normal attempt cap).
 */
export async function markClientPingFailedByWamid(waMessageId: string): Promise<number> {
  let changed = 0;
  for (const c of Object.values(CLIENT_PING_COLS)) {
    const res = await pool.query(
      `update delivery_orders
          set ${c.status} = 'failed', ${c.at} = null, ${c.wamid} = null, updated_at = now()
        where ${c.wamid} = $1 and ${c.status} in ('sent','sent_template')`,
      [waMessageId],
    );
    changed += res.rowCount ?? 0;
  }
  return changed;
}

/** Orders whose kitchen notification still needs a (re)attempt (sweep input). */
export async function pendingKitchenNotifies(): Promise<string[]> {
  const res = await pool.query(
    `select id from delivery_orders
      where status = 'IN_KITCHEN' and kitchen_notify_attempts < $1
        and ( kitchen_notify_status in ('pending','failed')
              or (kitchen_notify_status = 'claimed' and updated_at < now() - interval '2 minutes') )`,
    [MAX_NOTIFY_ATTEMPTS],
  );
  return res.rows.map((r: any) => r.id as string);
}

/** Orders whose creation-confirmation ping still needs a (re)attempt. */
export const pendingCreatedNotifies = () => pendingClientPings("created");
/** Orders whose "out for delivery" ping still needs a (re)attempt. */
export const pendingRouteNotifies = () => pendingClientPings("route");

/** One-shot SLA alert claim: IN_KITCHEN orders past their per-order deadline
 *  (i.e. never departed in time). */
export async function claimDeliverySlaAlerts(): Promise<DeliveryOrder[]> {
  const res = await pool.query(
    `update delivery_orders
        set alerted_at = now(), updated_at = now()
      where status = 'IN_KITCHEN' and alerted_at is null
        and created_at < now() - make_interval(mins => sla_minutes)
      returning *`,
  );
  return res.rows as DeliveryOrder[];
}

// ---------- admin board reads ----------

export async function listOpenDeliveryOrders(): Promise<DeliveryOrder[]> {
  const res = await pool.query(
    `select * from delivery_orders
      where status in ('IN_KITCHEN','OUT_FOR_DELIVERY') order by created_at asc`,
  );
  return res.rows as DeliveryOrder[];
}

export async function recentClosedDeliveryOrders(limit = 20): Promise<DeliveryOrder[]> {
  const res = await pool.query(
    `select * from delivery_orders where status in ('DELIVERED','CANCELLED')
      order by coalesce(delivered_at, cancelled_at, updated_at) desc limit $1`,
    [limit],
  );
  return res.rows as DeliveryOrder[];
}

export interface RecentDeliveryClient {
  client_name: string;
  client_phone: string;
  address: string;
}

/** Distinct past clients (latest name/address per phone) for the new-order form's
 *  "client récent" quick-fill — phone orders are usually repeat customers. */
export async function recentDeliveryClients(limit = 30): Promise<RecentDeliveryClient[]> {
  const res = await pool.query(
    `select client_name, client_phone, address from (
       select distinct on (client_phone) client_name, client_phone, address, created_at
         from delivery_orders where is_test = false order by client_phone, created_at desc
     ) t order by t.created_at desc limit $1`,
    [limit],
  );
  return res.rows as RecentDeliveryClient[];
}

export interface DeliveryStats {
  openCount: number;
  lateToday: number;
  /** Average creation → departure time over 30 days (the single prep+depart step). */
  avgPrepMinutes: number | null;
}

export async function deliveryStats(): Promise<DeliveryStats> {
  const res = await pool.query(
    `select
       count(*) filter (where status in ('IN_KITCHEN','OUT_FOR_DELIVERY')) as open_count,
       count(*) filter (where alerted_at is not null and alerted_at::date = now()::date) as late_today,
       avg(extract(epoch from (out_for_delivery_at - created_at)) / 60.0)
         filter (where out_for_delivery_at is not null and created_at > now() - interval '30 days') as avg_prep
     from delivery_orders
     where is_test = false`,
  );
  const r = res.rows[0];
  return {
    openCount: Number(r.open_count ?? 0),
    lateToday: Number(r.late_today ?? 0),
    avgPrepMinutes: r.avg_prep === null ? null : Number(r.avg_prep),
  };
}
