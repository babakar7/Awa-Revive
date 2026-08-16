import type pg from "pg";
import { config } from "../config.js";
import { pool } from "../db/index.js";

export const PAYMENT_METHODS = [
  "wave",
  "orange_money",
  "maxit",
  "cash",
  "card",
  "other",
] as const;
export type LedgerPaymentMethod = (typeof PAYMENT_METHODS)[number];
export type LedgerMovementType = "payment" | "refund";

export interface LedgerMovement {
  origin: "awa" | "wix" | "manual";
  movementType: LedgerMovementType;
  sourceKind: string;
  sourceId: string;
  providerTxId: string | null;
  clientName: string | null;
  clientPhone: string | null;
  label: string;
  amountXof: number;
  method: LedgerPaymentMethod | null;
  methodOrigin: "local" | "provider" | "tag";
  occurredAt: Date;
  dateEstimated: boolean;
  targetId: string | null;
  excludedReason: string | null;
}

export interface LedgerFilters {
  from: Date;
  to: Date;
  method?: string;
  source?: string;
  type?: string;
  /** Free-text search over client name, phone and label (see filterSql). */
  q?: string;
}

export interface MethodTotal {
  day: string | null;
  method: string;
  grossXof: number;
  refundsXof: number;
  netXof: number;
  movementCount: number;
}

export interface BookingByServiceDate {
  bookingId: string;
  /** Local client id when known; null for an unmatched Wix-manual booking. */
  clientId: string | null;
  clientName: string | null;
  clientPhone: string | null;
  serviceName: string;
  slotStart: Date;
  participants: number;
  amountXof: number;
  paymentMethod: string;
  paidAt: Date | null;
  /** 'awa' = booked through Awa; 'wix' = made directly in Wix (reception). */
  source: "awa" | "wix";
  /** Exact plan name for a subscription-paid booking, else null. */
  planName: string | null;
  /** Stable grouping key (client id, or a Wix identity when unmatched). */
  groupKey: string;
  /** Correlated Wix payment movement id, so the row can be requalified in
   *  place. Null for Awa rows and unmatched Wix payments. */
  movementId: string | null;
  /** True when the correlated Wix movement is tagged 'exclu' — shown as
   *  "Exclu", never falling back to a provider method or "À qualifier". */
  paymentExcluded: boolean;
}

/**
 * Free-text search fragment shared by the ledger filter and the booking view.
 * Matches client name / phone / label with ILIKE (wildcards escaped), plus a
 * digit-normalized phone match when the query carries ≥6 digits (the team
 * types numbers with spaces, e.g. "77 829 95 95"). Appends to `values` and
 * returns the ` and (...)` clause, or "" when `q` is blank.
 */
function searchClause(
  q: string | undefined,
  values: unknown[],
  startParam: number,
  columns: { name: string; phone: string; label?: string },
): string {
  const trimmed = (q ?? "").trim();
  if (!trimmed) return "";
  const like = `%${trimmed.replace(/[\\%_]/g, "\\$&")}%`;
  values.push(like);
  const likeIdx = startParam + values.length - 1;
  const parts = [`${columns.name} ilike $${likeIdx}`, `${columns.phone} ilike $${likeIdx}`];
  if (columns.label) parts.push(`${columns.label} ilike $${likeIdx}`);
  const digits = trimmed.replace(/\D/g, "");
  if (digits.length >= 6) {
    values.push(`%${digits}%`);
    parts.push(`regexp_replace(coalesce(${columns.phone},''),'\\D','','g') like $${startParam + values.length - 1}`);
  }
  return ` and (${parts.join(" or ")})`;
}

const FINAL_WIX_STATUSES = ["APPROVED", "SUCCESSFUL", "COMPLETED", "SUCCEEDED"];

// Keep this projection in one place: list, CSV and totals must agree. The
// first paid movement remains visible after a later refund/status transition.
const LEDGER_CTE = `
with latest_tags as (
  select distinct on (target_id) target_id, method, created_at, id
    from payment_method_tag_events
   where target_kind='wix'
   order by target_id, created_at desc, id desc
), ledger as (
  select 'awa'::text origin, 'payment'::text movement_type,
         'booking'::text source_kind, b.id::text source_id, null::text provider_tx_id,
         c.name::text client_name, c.wa_phone::text client_phone,
         b.service_name::text label, b.amount_xof::integer amount_xof,
         b.payment_method::text method, 'local'::text method_origin,
         coalesce(b.paid_at,b.updated_at)::timestamptz occurred_at,
         (b.paid_at is null)::boolean date_estimated, null::uuid target_id,
         null::text excluded_reason
    from pending_bookings b join clients c on c.id=b.client_id
   where not c.is_test and b.amount_xof>0 and b.payment_method<>'membership'
     and (b.paid_at is not null or b.status in ('BOOKED','CANCELLED','REFUND_NEEDED','REFUNDED'))
  union all
  select 'awa','refund','booking',b.id::text,null,c.name,c.wa_phone,
         'Remboursement — '||b.service_name,-b.refund_amount_xof,
         b.payment_method,'local',b.refunded_at,false,null,null
    from pending_bookings b join clients c on c.id=b.client_id
   where not c.is_test and b.refunded_at is not null and b.refund_amount_xof>0
  union all
  select 'awa','payment','plan',p.id::text,null,c.name,c.wa_phone,p.plan_name,
         p.amount_xof,p.payment_method,'local',p.paid_at,false,null,null
    from pending_plan_orders p join clients c on c.id=p.client_id
   where not c.is_test and p.paid_at is not null and p.amount_xof>0
  union all
  select 'awa','payment','cafe',o.id::text,null,c.name,c.wa_phone,
         coalesce(o.service_name,'Commande bar'),o.amount_xof,o.payment_method,'local',
         coalesce(o.paid_at,o.updated_at),(o.paid_at is null),null,null
    from pending_cafe_orders o join clients c on c.id=o.client_id
   where not c.is_test and o.amount_xof>0 and (o.paid_at is not null or o.status='PAID')
  union all
  select 'awa','payment','delivery',a.id::text,a.session_id,c.name,c.wa_phone,
         'Livraison — '||d.client_name,a.amount_xof,a.method,'local',
         coalesce(a.paid_at,a.updated_at),(a.paid_at is null),null,null
    from delivery_payment_attempts a
    join delivery_orders d on d.id=a.delivery_order_id
    join clients c on c.id=a.client_id
   where not c.is_test and not d.is_test and a.status in ('PAID','REFUND_NEEDED')
  union all
  select 'awa','payment','delivery',d.id::text,d.payment_ref,d.client_name,d.client_phone,
         'Livraison espèces',d.amount_xof,'cash','local',d.paid_at,false,null,null
    from delivery_orders d
   where not d.is_test and d.payment_status='PAID' and d.payment_method='cash'
     and d.paid_at is not null
  union all
  select 'manual',m.movement_type,coalesce(m.source_kind,'manual'),m.id::text,
         m.provider_reference,m.client_name,m.client_phone,m.label,m.amount_xof,
         m.method,'local',m.occurred_at,false,null,null
    from manual_payment_movements m
  union all
  select 'wix',w.movement_type,'wix_'||w.source,w.wix_order_id,w.wix_entry_id,
         w.buyer_name,w.buyer_phone,w.label,w.amount_xof,
         case when t.method='exclu' then null else coalesce(t.method,w.provider_method) end,
         case when t.method is not null then 'tag' else 'provider' end,
         w.occurred_at,false,w.id,
         case
           when t.method='exclu' then 'tag_exclu'
           when w.invalidated_at is not null then 'invalidated'
           -- Business decision (10/08/2026): Wix historically stored Revive's
           -- Senegal FCFA orders as XAF. Treat XAF at nominal 1:1 parity with
           -- XOF for this ledger, while preserving the raw currency on the
           -- durable Wix movement for audit.
           when upper(w.currency) not in ('XOF','XAF') then 'unsupported_currency'
           when not (upper(w.provider_status)=any($3::text[])) then 'not_final'
           else null
         end
    from wix_payment_movements w left join latest_tags t on t.target_id=w.id
)`;

function filterSql(filters: LedgerFilters, startParam = 4): { sql: string; values: unknown[] } {
  const values: unknown[] = [];
  const clauses: string[] = [];
  if (filters.method === "untagged") clauses.push("method is null");
  else if (filters.method) {
    values.push(filters.method);
    clauses.push(`method=$${startParam + values.length - 1}`);
  }
  if (filters.source) {
    values.push(filters.source);
    clauses.push(`source_kind=$${startParam + values.length - 1}`);
  }
  if (filters.type === "payment" || filters.type === "refund") {
    values.push(filters.type);
    clauses.push(`movement_type=$${startParam + values.length - 1}`);
  }
  let sql = clauses.length ? ` and ${clauses.join(" and ")}` : "";
  // The ledger CTE exposes client_name/client_phone/label on every row.
  sql += searchClause(filters.q, values, startParam, {
    name: "client_name",
    phone: "client_phone",
    label: "label",
  });
  return { sql, values };
}

function rowToMovement(row: any): LedgerMovement {
  return {
    origin: row.origin,
    movementType: row.movement_type,
    sourceKind: row.source_kind,
    sourceId: row.source_id,
    providerTxId: row.provider_tx_id,
    clientName: row.client_name,
    clientPhone: row.client_phone,
    label: row.label,
    amountXof: Number(row.amount_xof),
    method: row.method,
    methodOrigin: row.method_origin,
    occurredAt: new Date(row.occurred_at),
    dateEstimated: Boolean(row.date_estimated),
    targetId: row.target_id,
    excludedReason: row.excluded_reason,
  };
}

export async function movements(filters: LedgerFilters, limit = 300): Promise<LedgerMovement[]> {
  const extra = filterSql(filters);
  const res = await pool.query(
    `${LEDGER_CTE}
     select * from ledger
      where occurred_at >= $1 and occurred_at < $2${extra.sql}
      order by occurred_at desc, source_id desc limit $${4 + extra.values.length}`,
    [filters.from, filters.to, FINAL_WIX_STATUSES, ...extra.values, limit],
  );
  return res.rows.map(rowToMovement);
}

async function aggregate(filters: LedgerFilters, daily: boolean): Promise<MethodTotal[]> {
  const extra = filterSql(filters);
  const day = daily ? `(occurred_at at time zone 'Africa/Dakar')::date::text` : "null::text";
  const res = await pool.query(
    `${LEDGER_CTE}
     select ${day} as bucket_day, coalesce(method,'untagged') method,
            coalesce(sum(amount_xof) filter (where movement_type='payment'),0)::bigint gross_xof,
            coalesce(-sum(amount_xof) filter (where movement_type='refund'),0)::bigint refunds_xof,
            coalesce(sum(amount_xof),0)::bigint net_xof, count(*)::integer movement_count
       from ledger
      where occurred_at >= $1 and occurred_at < $2 and excluded_reason is null${extra.sql}
      group by ${daily ? "1,2" : "2"}
      order by ${daily ? "1 desc,2" : "2"}`,
    [filters.from, filters.to, FINAL_WIX_STATUSES, ...extra.values],
  );
  return res.rows.map((r) => ({
    day: r.bucket_day,
    method: r.method,
    grossXof: Number(r.gross_xof),
    refundsXof: Number(r.refunds_xof),
    netXof: Number(r.net_xof),
    movementCount: Number(r.movement_count),
  }));
}

export function dailyMethodTotals(filters: LedgerFilters): Promise<MethodTotal[]> {
  return aggregate(filters, true);
}

export function periodMethodTotals(filters: LedgerFilters): Promise<MethodTotal[]> {
  return aggregate(filters, false);
}

/** Confirmed Awa bookings selected by class date, independently of payment date. */
/**
 * Every confirmed STUDIO booking on a service date, Awa and Wix-manual unified.
 * A Wix booking already represented by an Awa booking (same wix_booking_id) is
 * shown once (the Awa row wins, it carries the real payment method). A
 * Wix-manual booking's payment is enriched from the correlated eCommerce
 * movement, joined only on an explicit order id — never guessed — and used for
 * display only; the accounting view still counts the movement exactly once.
 */
export async function bookingsByServiceDate(
  from: Date,
  to: Date,
  limit = 1_000,
  q?: string,
): Promise<BookingByServiceDate[]> {
  const params: unknown[] = [from, to, limit];
  // Search applies to the unified rows; $1/$2 are the inner date window, $3 the
  // limit, so search params start at $4.
  const outer = searchClause(q, params, 4, { name: "client_name", phone: "client_phone" });
  const res = await pool.query(
    `select * from (
       select b.id::text booking_id, b.client_id::text client_id,
              c.name client_name, c.wa_phone client_phone,
              b.service_name, b.slot_start, b.participants, b.amount_xof,
              b.payment_method, b.paid_at,
              'awa'::text source, b.membership_plan_name plan_name,
              b.client_id::text group_key,
              null::text movement_id, false payment_excluded,
              lower(coalesce(c.name,c.wa_phone)) sort_name
         from pending_bookings b
         join clients c on c.id=b.client_id
        where b.status='BOOKED' and not c.is_test
          and b.slot_start >= $1 and b.slot_start < $2
       union all
       select r.booking_id, r.matched_client_id::text,
              coalesce(cl.name, r.client_name), coalesce(cl.wa_phone, r.client_phone),
              coalesce(r.service_name, 'Cours'), r.session_start,
              coalesce(r.number_of_participants, 1),
              coalesce(mv.amount_xof, 0),
              coalesce(mv.method, case when r.payment_status='PAID' then 'wix_unreconciled' else '' end),
              mv.occurred_at,
              'wix'::text, null,
              coalesce(r.matched_client_id::text, 'wix:' || coalesce(r.wix_contact_id, r.booking_id)),
              mv.movement_id::text, coalesce(mv.payment_excluded, false),
              lower(coalesce(cl.name, r.client_name, r.booking_id))
         from wix_booking_records r
         left join clients cl on cl.id = r.matched_client_id
         left join lateral (
            select m.id movement_id,
                   case when t.method='exclu' then null else coalesce(t.method, m.provider_method) end method,
                   (t.method='exclu') payment_excluded,
                   m.amount_xof, m.occurred_at
              from wix_payment_movements m
              left join lateral (
                 select method from payment_method_tag_events
                  where target_kind='wix' and target_id=m.id
                  order by created_at desc, id desc limit 1
              ) t on true
             where m.movement_type='payment' and m.invalidated_at is null
               and ((r.wix_order_id is not null and m.wix_order_id = r.wix_order_id)
                    or r.booking_id = any(m.wix_booking_ids))
             order by m.occurred_at asc limit 1
         ) mv on true
        where r.status='CONFIRMED' and r.invalidated_at is null
          and r.session_start >= $1 and r.session_start < $2
          and not exists (select 1 from pending_bookings pb where pb.wix_booking_id = r.booking_id)
          and (cl.id is null or not cl.is_test)
     ) rows
     where true${outer}
     order by sort_name, group_key, slot_start, booking_id
     limit $3`,
    params,
  );
  return res.rows.map((row) => ({
    bookingId: row.booking_id,
    clientId: row.client_id ?? null,
    clientName: row.client_name,
    clientPhone: row.client_phone,
    serviceName: row.service_name,
    slotStart: new Date(row.slot_start),
    participants: Number(row.participants),
    amountXof: Number(row.amount_xof),
    paymentMethod: row.payment_method,
    paidAt: row.paid_at ? new Date(row.paid_at) : null,
    source: row.source,
    planName: row.plan_name,
    groupKey: row.group_key,
    movementId: row.movement_id ?? null,
    paymentExcluded: Boolean(row.payment_excluded),
  }));
}

export async function untaggedWixOffline(limit = 50): Promise<LedgerMovement[]> {
  const start = new Date(`${config.PAYMENTS_LEDGER_START_DATE}T00:00:00Z`);
  const res = await pool.query(
    `${LEDGER_CTE}
     select * from ledger
      where origin='wix' and method is null and excluded_reason is null
        and occurred_at >= $1 and occurred_at < $2 and target_id is not null
      order by occurred_at desc limit $4`,
    [start, new Date(), FINAL_WIX_STATUSES, limit],
  );
  return res.rows.map(rowToMovement);
}

export async function appendTagEvent(args: {
  targetId: string;
  method: string;
  note?: string;
  taggedBy: string;
}): Promise<void> {
  const method = args.method.trim().toLowerCase();
  if (![...PAYMENT_METHODS, "exclu"].includes(method as any)) throw new Error("Méthode invalide.");
  const current = await pool.query(
    `select method from payment_method_tag_events
      where target_kind='wix' and target_id=$1 order by created_at desc,id desc limit 1`,
    [args.targetId],
  );
  const note = String(args.note ?? "").trim();
  if ((method === "other" || method === "exclu" || current.rowCount) && !note) {
    throw new Error("Une note est obligatoire pour Autre, Exclu ou un changement de tag.");
  }
  const exists = await pool.query(`select 1 from wix_payment_movements where id=$1`, [args.targetId]);
  if (!exists.rowCount) throw new Error("Mouvement Wix introuvable.");
  await pool.query(
    `insert into payment_method_tag_events(target_kind,target_id,method,note,tagged_by)
     values ('wix',$1,$2,$3,$4)`,
    [args.targetId, method, note || null, args.taggedBy],
  );
}

export async function addManualMovement(args: {
  movementType: LedgerMovementType;
  occurredAt: Date;
  amountXof: number;
  method: LedgerPaymentMethod;
  label: string;
  providerReference?: string;
  sourceKind?: string;
  sourceId?: string;
  clientName?: string;
  clientPhone?: string;
  note: string;
  reversesMovementId?: string;
  createdBy: string;
  idempotencyKey: string;
}, db: pg.Pool | pg.PoolClient = pool): Promise<boolean> {
  if (!PAYMENT_METHODS.includes(args.method)) throw new Error("Méthode invalide.");
  if (!Number.isInteger(args.amountXof) || args.amountXof <= 0) throw new Error("Montant invalide.");
  if (!args.label.trim() || !args.note.trim()) throw new Error("Libellé et note sont obligatoires.");
  const signed = args.movementType === "refund" ? -args.amountXof : args.amountXof;
  const res = await db.query(
    `insert into manual_payment_movements
       (movement_type,occurred_at,amount_xof,method,label,provider_reference,
        source_kind,source_id,client_name,client_phone,note,reverses_movement_id,
        created_by,idempotency_key)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
     on conflict (idempotency_key) do nothing returning id`,
    [args.movementType,args.occurredAt,signed,args.method,args.label.trim(),
     args.providerReference?.trim() || null,args.sourceKind?.trim() || null,
     args.sourceId?.trim() || null,args.clientName?.trim() || null,
     args.clientPhone?.trim() || null,args.note.trim(),args.reversesMovementId || null,
     args.createdBy,args.idempotencyKey],
  );
  return Boolean(res.rowCount);
}

export async function excludedWixCounts(from: Date, to: Date): Promise<Record<string, number>> {
  const res = await pool.query(
    `${LEDGER_CTE} select excluded_reason, count(*)::integer count from ledger
      where origin='wix' and occurred_at >= $1 and occurred_at < $2
        and excluded_reason is not null group by excluded_reason`,
    [from, to, FINAL_WIX_STATUSES],
  );
  return Object.fromEntries(res.rows.map((r) => [r.excluded_reason, Number(r.count)]));
}

export function dakarDay(value: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Africa/Dakar", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(value);
}
