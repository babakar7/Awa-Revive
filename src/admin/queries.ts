import crypto from "node:crypto";
import { pool } from "../db/index.js";

/**
 * Read-only SQL for the admin dashboard. No business logic here — mutations
 * go through domain/stateMachine + domain/repo like everywhere else.
 */

export interface AdminClientRow {
  id: string;
  wa_phone: string;
  name: string | null;
  language: string | null;
  claimed_email: string | null;
  last_message_at: Date | null;
  last_message: string | null;
  message_count: number;
  is_test: boolean;
  human_takeover_until: Date | null;
  human_takeover_by: string | null;
}

export async function listClients(search?: string): Promise<AdminClientRow[]> {
  const params: unknown[] = [];
  let where = "";
  if (search && search.trim()) {
    params.push(`%${search.trim()}%`);
    where = `where c.name ilike $1 or c.wa_phone like $1`;
  }
  const res = await pool.query(
    `select c.id, c.wa_phone, c.name, c.language, c.claimed_email, c.is_test,
            c.human_takeover_until, c.human_takeover_by,
            m.created_at as last_message_at, m.content as last_message,
            (select count(*) from conversations cc
              where cc.client_id = c.id and cc.role in ('user','assistant'))::int as message_count
       from clients c
       left join lateral (
         select content, created_at from conversations
          where client_id = c.id and role in ('user','assistant')
          order by created_at desc limit 1
       ) m on true
       ${where}
      order by m.created_at desc nulls last
      limit 100`,
    params,
  );
  return res.rows;
}

export interface PageResult<T> {
  rows: T[];
  page: number;
  pageSize: number;
  total: number;
  pages: number;
}

export async function listClientsPage(args: {
  search?: string;
  page?: number;
  pageSize?: number;
  periodDays?: number | null;
}): Promise<PageResult<AdminClientRow>> {
  const page = Math.max(1, Math.trunc(args.page ?? 1));
  const pageSize = Math.min(100, Math.max(10, Math.trunc(args.pageSize ?? 30)));
  const params: unknown[] = [];
  const where: string[] = [];
  if (args.search?.trim()) {
    params.push(`%${args.search.trim()}%`);
    where.push(`(c.name ilike $${params.length} or c.wa_phone like $${params.length})`);
  }
  if (args.periodDays) {
    params.push(args.periodDays);
    where.push(`m.created_at > now() - make_interval(days => $${params.length}::int)`);
  }
  const clause = where.length ? `where ${where.join(" and ")}` : "";
  params.push(pageSize, (page - 1) * pageSize);
  const result = await pool.query(
    `with latest as (
       select c.id, c.wa_phone, c.name, c.language, c.claimed_email, c.is_test,
              c.human_takeover_until, c.human_takeover_by,
              m.created_at as last_message_at, m.content as last_message,
              (select count(*) from conversations cc
                where cc.client_id = c.id and cc.role in ('user','assistant'))::int as message_count
         from clients c
         left join lateral (
           select content, created_at from conversations
            where client_id = c.id and role in ('user','assistant')
            order by created_at desc limit 1
         ) m on true
         ${clause}
     )
     select *, count(*) over()::int as total_count
       from latest order by last_message_at desc nulls last
      limit $${params.length - 1} offset $${params.length}`,
    params,
  );
  const total = result.rows[0]?.total_count ?? 0;
  return {
    rows: result.rows.map(({ total_count: _total, ...row }) => row as AdminClientRow),
    page,
    pageSize,
    total,
    pages: Math.max(1, Math.ceil(total / pageSize)),
  };
}

export interface AdminTurn {
  role: string;
  content: string;
  created_at: Date;
  source?: "awa" | "admin";
  sent_by?: string | null;
  delivery_status?: "pending" | "sent" | "failed";
  error?: string | null;
  outbound_id?: string | null;
}

export async function getClient(clientId: string): Promise<any | null> {
  const res = await pool.query(`select * from clients where id = $1`, [clientId]);
  return res.rows[0] ?? null;
}

export async function getThread(clientId: string, limit = 200): Promise<AdminTurn[]> {
  const res = await pool.query(
    `select role, content, created_at, source, sent_by, delivery_status, error, outbound_id
       from (select * from (
               select role, content, created_at, 'awa'::text as source,
                      null::text as sent_by, 'sent'::text as delivery_status,
                      null::text as error, null::uuid as outbound_id
                 from conversations where client_id = $1
               union all
               select 'assistant'::text as role, body as content, created_at,
                      'admin'::text as source, sent_by, status as delivery_status, error, id as outbound_id
                 from admin_outbound_messages where client_id = $1
             ) history order by created_at desc limit $2) t
      order by created_at asc`,
    [clientId, limit],
  );
  return res.rows;
}

export interface ClientWorkspace {
  bookings: any[];
  plans: any[];
  cafeOrders: any[];
  deliveries: any[];
  handoffs: any[];
  reviews: any[];
  invoices: any[];
  quotes: any[];
  giftCards: any[];
}

export async function getClientWorkspace(clientId: string, phone: string): Promise<ClientWorkspace> {
  const digits = phone.replace(/\D/g, "");
  const matchPhone = `regexp_replace(coalesce(client_phone,''), '\\D', '', 'g') = $1`;
  const [bookings, plans, cafeOrders, deliveries, handoffs, reviewRows, invoices, quotes, giftCards] =
    await Promise.all([
      pool.query(`select * from pending_bookings where client_id=$1 order by created_at desc limit 20`, [clientId]),
      pool.query(`select * from pending_plan_orders where client_id=$1 order by created_at desc limit 20`, [clientId]),
      pool.query(`select * from pending_cafe_orders where client_id=$1 order by created_at desc limit 20`, [clientId]),
      pool.query(`select * from delivery_orders where regexp_replace(client_phone, '\\D', '', 'g')=$1 order by created_at desc limit 20`, [digits]),
      pool.query(`select * from handoffs where client_id=$1 order by created_at desc limit 20`, [clientId]),
      pool.query(`select * from conversation_reviews where client_id=$1 order by created_at desc limit 20`, [clientId]),
      pool.query(`select * from invoices where ${matchPhone} order by created_at desc limit 20`, [digits]),
      pool.query(`select * from quotes where ${matchPhone} order by created_at desc limit 20`, [digits]),
      pool.query(`select * from gift_cards where regexp_replace(coalesce(send_phone,''), '\\D', '', 'g')=$1 order by created_at desc limit 20`, [digits]),
    ]);
  return {
    bookings: bookings.rows,
    plans: plans.rows,
    cafeOrders: cafeOrders.rows,
    deliveries: deliveries.rows,
    handoffs: handoffs.rows,
    reviews: reviewRows.rows,
    invoices: invoices.rows,
    quotes: quotes.rows,
    giftCards: giftCards.rows,
  };
}

export type FollowUpSource = "handoff" | "review";
export interface AdminQueueItem {
  id: string;
  source: FollowUpSource;
  client_id: string;
  client_name: string | null;
  wa_phone: string;
  title: string;
  detail: string | null;
  suggested_action: string | null;
  priority: "high" | "normal";
  status: "OPEN" | "DONE";
  resolution_outcome: string | null;
  resolution_note: string | null;
  done_by: string | null;
  done_at: Date | null;
  created_at: Date;
}

export async function listFollowUpQueue(args: {
  source?: FollowUpSource | "all";
  status?: "OPEN" | "DONE";
  periodDays?: number | null;
  page?: number;
  pageSize?: number;
}): Promise<PageResult<AdminQueueItem>> {
  const page = Math.max(1, Math.trunc(args.page ?? 1));
  const pageSize = Math.min(100, Math.max(10, Math.trunc(args.pageSize ?? 30)));
  const source = args.source ?? "all";
  const status = args.status ?? "OPEN";
  const days = args.periodDays ?? null;
  const result = await pool.query(
    `with queue as (
       select h.id, 'handoff'::text as source, h.client_id, c.name as client_name,
              c.wa_phone, coalesce(h.reason,'Intervention humaine') as title,
              h.transcript_excerpt as detail, null::text as suggested_action,
              'normal'::text as priority, h.status, h.resolution_outcome,
              h.resolution_note, h.done_by, h.done_at, h.created_at
         from handoffs h join clients c on c.id=h.client_id
       union all
       select r.id, 'review'::text as source, r.client_id, c.name as client_name,
              c.wa_phone, coalesce(r.summary,'Conversation à reprendre') as title,
              r.need_category as detail, r.suggested_action,
              case when r.severity='severe' then 'high' else 'normal' end as priority,
              r.status, r.resolution_outcome, r.resolution_note,
              r.done_by, r.done_at, r.created_at
         from conversation_reviews r join clients c on c.id=r.client_id
     )
     select *, count(*) over()::int as total_count from queue
      where status=$1
        and ($2='all' or source=$2)
        and ($3::int is null or created_at > now() - make_interval(days => $3::int))
      order by (priority='high') desc, created_at asc
      limit $4 offset $5`,
    [status, source, days, pageSize, (page - 1) * pageSize],
  );
  const total = result.rows[0]?.total_count ?? 0;
  return {
    rows: result.rows.map(({ total_count: _total, ...row }) => row as AdminQueueItem),
    page,
    pageSize,
    total,
    pages: Math.max(1, Math.ceil(total / pageSize)),
  };
}

export async function listBookings(
  status?: string,
  limit = 100,
  period?: "today" | "7" | "30" | null,
): Promise<any[]> {
  const params: unknown[] = [limit];
  const conditions: string[] = [];
  if (status) {
    params.push(status);
    conditions.push(`b.status = $${params.length}`);
  }
  if (period === "today") conditions.push("b.updated_at >= current_date");
  else if (period === "7" || period === "30") {
    params.push(Number(period));
    conditions.push(`b.updated_at > now() - make_interval(days => $${params.length}::int)`);
  }
  const where = conditions.length ? `where ${conditions.join(" and ")}` : "";
  const res = await pool.query(
    `select b.*, c.name as client_name, c.wa_phone
       from pending_bookings b join clients c on c.id = b.client_id
       ${where}
      order by b.created_at desc limit $1`,
    params,
  );
  return res.rows;
}

/**
 * Commandes bar payées, rattachées à une résa. "today" = cours du jour
 * (c'est le moment où la commande doit être préparée), "upcoming" = cours à
 * venir. Dakar = UTC year-round, so current_date is the local business day.
 */
export async function listCafeOrders(): Promise<{ today: any[]; upcoming: any[] }> {
  const base = `
    select b.*, c.name as client_name, c.wa_phone
      from pending_bookings b join clients c on c.id = b.client_id
     where b.status = 'BOOKED' and b.extras_amount_xof > 0`;
  const [today, upcoming] = await Promise.all([
    pool.query(
      `${base} and b.slot_start >= current_date and b.slot_start < current_date + 1
       order by b.slot_start asc`,
    ),
    pool.query(
      `${base} and b.slot_start >= current_date + 1
       order by b.slot_start asc limit 50`,
    ),
  ]);
  return { today: today.rows, upcoming: upcoming.rows };
}

export async function listPlanOrders(
  status?: string,
  limit = 50,
  period?: "today" | "7" | "30" | null,
): Promise<any[]> {
  const params: unknown[] = [limit];
  const conditions: string[] = [];
  if (status) {
    params.push(status);
    conditions.push(`p.status = $${params.length}`);
  }
  if (period === "today") conditions.push("p.updated_at >= current_date");
  else if (period === "7" || period === "30") {
    params.push(Number(period));
    conditions.push(`p.updated_at > now() - make_interval(days => $${params.length}::int)`);
  }
  const where = conditions.length ? `where ${conditions.join(" and ")}` : "";
  const res = await pool.query(
    `select p.*, c.name as client_name, c.wa_phone
       from pending_plan_orders p join clients c on c.id = p.client_id
       ${where}
      order by p.created_at desc limit $1`,
    params,
  );
  return res.rows;
}

export async function listHandoffs(limit = 50): Promise<any[]> {
  const res = await pool.query(
    `select h.*, c.name as client_name, c.wa_phone
       from handoffs h join clients c on c.id = h.client_id
      order by (h.status = 'OPEN') desc, h.created_at desc limit $1`,
    [limit],
  );
  return res.rows;
}

/** Marque un handoff traité (bouton « ✅ Traité »). Renvoie false si déjà fait. */
export async function markHandoffDone(id: string, adminUser: string): Promise<boolean> {
  const res = await pool.query(
    `update handoffs set status = 'DONE', done_by = $2, done_at = now()
      where id = $1 and status = 'OPEN'`,
    [id, adminUser],
  );
  return (res.rowCount ?? 0) > 0;
}

/** Open items surfaced on the overview page. */
export async function pendingActions(): Promise<{
  refunds: any[];
  planActivations: any[];
  recentHandoffs: any[];
}> {
  const [refunds, planActivations, recentHandoffs] = await Promise.all([
    listBookings("REFUND_NEEDED", 20),
    listPlanOrders("PAID", 20),
    pool
      .query(
        `select h.*, c.name as client_name, c.wa_phone
           from handoffs h join clients c on c.id = h.client_id
          where h.created_at > now() - interval '7 days'
          order by h.created_at desc limit 15`,
      )
      .then((r) => r.rows),
  ]);
  return { refunds, planActivations, recentHandoffs };
}

export interface AdminStats {
  msgToday: number;
  msg7d: number;
  msg30d: number;
  activeClientsToday: number;
  activeClients7d: number;
  activeClients30d: number;
  bookingsToday: number;
  bookings7d: number;
  bookings30d: number;
  revenueToday: number;
  revenue7d: number;
  revenue30d: number;
  refundsPending: number;
  handoffsOpen: number;
}

export async function stats(): Promise<AdminStats> {
  // Dakar = UTC year-round, so current_date is the local business day.
  const res = await pool.query(`
    select
      (select count(*) from conversations where role = 'user' and created_at >= current_date)::int as msg_today,
      (select count(*) from conversations where role = 'user' and created_at > now() - interval '7 days')::int as msg_7d,
      (select count(*) from conversations where role = 'user' and created_at > now() - interval '30 days')::int as msg_30d,
      (select count(distinct client_id) from conversations where role = 'user' and created_at >= current_date)::int as clients_today,
      (select count(distinct client_id) from conversations where role = 'user' and created_at > now() - interval '7 days')::int as clients_7d,
      (select count(distinct client_id) from conversations where role = 'user' and created_at > now() - interval '30 days')::int as clients_30d,
      (select count(*) from pending_bookings where status = 'BOOKED' and updated_at >= current_date)::int as bookings_today,
      (select count(*) from pending_bookings where status = 'BOOKED' and updated_at > now() - interval '7 days')::int as bookings_7d,
      (select count(*) from pending_bookings where status = 'BOOKED' and updated_at > now() - interval '30 days')::int as bookings_30d,
      (coalesce((select sum(amount_xof) from pending_bookings
         where status = 'BOOKED' and payment_method <> 'membership' and updated_at >= current_date), 0)
       + coalesce((select sum(amount_xof) from pending_plan_orders
         where status in ('PAID','ACTIVATED') and updated_at >= current_date), 0)
       + coalesce((select sum(amount_xof) from pending_cafe_orders
         where status = 'PAID' and updated_at >= current_date), 0))::int as revenue_today,
      (coalesce((select sum(amount_xof) from pending_bookings
         where status = 'BOOKED' and payment_method <> 'membership' and updated_at > now() - interval '7 days'), 0)
       + coalesce((select sum(amount_xof) from pending_plan_orders
         where status in ('PAID','ACTIVATED') and updated_at > now() - interval '7 days'), 0)
       + coalesce((select sum(amount_xof) from pending_cafe_orders
         where status = 'PAID' and updated_at > now() - interval '7 days'), 0))::int as revenue_7d,
      (coalesce((select sum(amount_xof) from pending_bookings
         where status = 'BOOKED' and payment_method <> 'membership' and updated_at > now() - interval '30 days'), 0)
       + coalesce((select sum(amount_xof) from pending_plan_orders
         where status in ('PAID','ACTIVATED') and updated_at > now() - interval '30 days'), 0)
       + coalesce((select sum(amount_xof) from pending_cafe_orders
         where status = 'PAID' and updated_at > now() - interval '30 days'), 0))::int as revenue_30d,
      (select count(*) from pending_bookings where status = 'REFUND_NEEDED')::int as refunds_pending,
      (select count(*) from handoffs where status = 'OPEN')::int as handoffs_open
  `);
  const r = res.rows[0];
  return {
    msgToday: r.msg_today,
    msg7d: r.msg_7d,
    msg30d: r.msg_30d,
    activeClientsToday: r.clients_today,
    activeClients7d: r.clients_7d,
    activeClients30d: r.clients_30d,
    bookingsToday: r.bookings_today,
    bookings7d: r.bookings_7d,
    bookings30d: r.bookings_30d,
    revenueToday: r.revenue_today,
    revenue7d: r.revenue_7d,
    revenue30d: r.revenue_30d,
    refundsPending: r.refunds_pending,
    handoffsOpen: r.handoffs_open,
  };
}

export interface AdminReport {
  periodDays: 1 | 7 | 30;
  messages: number;
  previousMessages: number;
  activeClients: number;
  previousActiveClients: number;
  bookings: number;
  previousBookings: number;
  bookingRevenue: number;
  planRevenue: number;
  cafeRevenue: number;
  previousRevenue: number;
  openFollowUps: number;
  oldestFollowUpAt: Date | null;
  servedRate: number | null;
}

export async function adminReport(periodDays: 1 | 7 | 30): Promise<AdminReport> {
  const result = await pool.query(
    `with bounds as (
       select case when $1::int=1 then current_date::timestamptz else now() - make_interval(days=>$1::int) end as current_start,
              case when $1::int=1 then (current_date - 1)::timestamptz else now() - make_interval(days=>$1::int * 2) end as previous_start
     ), review_counts as (
       select count(*) filter (where outcome in ('resolved','handed_off'))::int as served,
              count(*) filter (where outcome <> 'dropoff')::int as considered
         from conversation_reviews, bounds where created_at >= current_start
     )
     select
       (select count(*) from conversations,bounds where role='user' and created_at>=current_start)::int as messages,
       (select count(*) from conversations,bounds where role='user' and created_at>=previous_start and created_at<current_start)::int as previous_messages,
       (select count(distinct client_id) from conversations,bounds where role='user' and created_at>=current_start)::int as active_clients,
       (select count(distinct client_id) from conversations,bounds where role='user' and created_at>=previous_start and created_at<current_start)::int as previous_active_clients,
       (select count(*) from pending_bookings,bounds where status='BOOKED' and updated_at>=current_start)::int as bookings,
       (select count(*) from pending_bookings,bounds where status='BOOKED' and updated_at>=previous_start and updated_at<current_start)::int as previous_bookings,
       coalesce((select sum(amount_xof) from pending_bookings,bounds where status='BOOKED' and payment_method<>'membership' and updated_at>=current_start),0)::int as booking_revenue,
       coalesce((select sum(amount_xof) from pending_plan_orders,bounds where status in ('PAID','ACTIVATED') and updated_at>=current_start),0)::int as plan_revenue,
       coalesce((select sum(amount_xof) from pending_cafe_orders,bounds where status='PAID' and updated_at>=current_start),0)::int as cafe_revenue,
       (coalesce((select sum(amount_xof) from pending_bookings,bounds where status='BOOKED' and payment_method<>'membership' and updated_at>=previous_start and updated_at<current_start),0)
        + coalesce((select sum(amount_xof) from pending_plan_orders,bounds where status in ('PAID','ACTIVATED') and updated_at>=previous_start and updated_at<current_start),0)
        + coalesce((select sum(amount_xof) from pending_cafe_orders,bounds where status='PAID' and updated_at>=previous_start and updated_at<current_start),0))::int as previous_revenue,
       ((select count(*) from handoffs where status='OPEN') + (select count(*) from conversation_reviews where status='OPEN'))::int as open_follow_ups,
       least((select min(created_at) from handoffs where status='OPEN'), (select min(created_at) from conversation_reviews where status='OPEN')) as oldest_follow_up_at,
       (select case when considered=0 then null else round(served*100.0/considered)::int end from review_counts) as served_rate`,
    [periodDays],
  );
  const row = result.rows[0];
  return {
    periodDays,
    messages: row.messages,
    previousMessages: row.previous_messages,
    activeClients: row.active_clients,
    previousActiveClients: row.previous_active_clients,
    bookings: row.bookings,
    previousBookings: row.previous_bookings,
    bookingRevenue: row.booking_revenue,
    planRevenue: row.plan_revenue,
    cafeRevenue: row.cafe_revenue,
    previousRevenue: row.previous_revenue,
    openFollowUps: row.open_follow_ups,
    oldestFollowUpAt: row.oldest_follow_up_at,
    servedRate: row.served_rate,
  };
}

// ---------- hygiène CRM : groupes de doublons marqués « traités » ----------

/**
 * Signature stable d'un groupe de doublons : hash des ids de fiches triés.
 * Si la composition du groupe change (fiche ajoutée/fusionnée/supprimée), la
 * signature change et le groupe réapparaît sur /admin/crm.
 */
export function duplicateGroupSignature(contactIds: string[]): string {
  return crypto
    .createHash("sha256")
    .update([...contactIds].sort().join(","))
    .digest("hex")
    .slice(0, 16);
}

/** Ensemble des groupes masqués, sous la forme "phoneKey|signature". */
export async function dismissedDuplicateGroups(): Promise<Set<string>> {
  const res = await pool.query(`select phone_key, group_signature from crm_dismissed_duplicates`);
  return new Set(res.rows.map((r: any) => `${r.phone_key}|${r.group_signature}`));
}

export async function dismissDuplicateGroup(
  phoneKey: string,
  signature: string,
  by: string,
): Promise<void> {
  await pool.query(
    `insert into crm_dismissed_duplicates (phone_key, group_signature, dismissed_by)
     values ($1, $2, $3) on conflict do nothing`,
    [phoneKey, signature, by],
  );
}

export async function restoreDuplicateGroup(phoneKey: string, signature: string): Promise<void> {
  await pool.query(
    `delete from crm_dismissed_duplicates where phone_key = $1 and group_signature = $2`,
    [phoneKey, signature],
  );
}

// ---------- profil WhatsApp Business (/admin/profile) ----------

export interface WhatsAppProfileRow {
  description: string | null;
  address: string | null;
  hours: string | null;
  updated_by: string | null;
  updated_at: Date | null;
}

/** Dernière copie enregistrée depuis /admin/profile, ou null si jamais éditée. */
export async function getLocalWhatsAppProfile(): Promise<WhatsAppProfileRow | null> {
  const res = await pool.query(
    `select description, address, hours, updated_by, updated_at from whatsapp_profile where id = 1`,
  );
  return res.rows[0] ?? null;
}

export async function saveLocalWhatsAppProfile(
  fields: { description: string; address: string; hours: string },
  by: string,
): Promise<void> {
  await pool.query(
    `insert into whatsapp_profile (id, description, address, hours, updated_by, updated_at)
     values (1, $1, $2, $3, $4, now())
     on conflict (id) do update set
       description = excluded.description,
       address = excluded.address,
       hours = excluded.hours,
       updated_by = excluded.updated_by,
       updated_at = now()`,
    [fields.description, fields.address, fields.hours, by],
  );
}

// ---------- notifications (/admin/notifications) — read-only ----------

export interface NotificationRuleRow {
  id: string;
  label: string;
  kind: string;
  enabled: boolean;
  service_id: string | null;
  class_pattern: string | null;
  exclude_pattern: string | null;
  lead_minutes: number | null;
  suppress_gap_minutes: number | null;
  recipient_kind: string;
  recipient_phone: string | null;
  days_of_week: string | null;
  send_time: string | null;
  message_template: string;
  group_only: boolean;
}

export async function listNotificationRules(): Promise<NotificationRuleRow[]> {
  const res = await pool.query(
    `select id, label, kind, enabled, service_id, class_pattern, exclude_pattern, lead_minutes,
            suppress_gap_minutes, recipient_kind, recipient_phone, days_of_week, send_time,
            message_template, group_only
       from notification_rules order by created_at`,
  );
  return res.rows;
}

export interface StaffContactRow {
  id: string;
  name: string;
  phone: string;
  role: string;
  muted: boolean;
}

export async function listStaffContacts(): Promise<StaffContactRow[]> {
  const res = await pool.query(
    `select id, name, phone, role, muted from staff_contacts order by role, name`,
  );
  return res.rows;
}

export interface NotificationLogRow {
  id: string;
  rule_id: string | null;
  source: string;
  recipient_phone: string | null;
  body: string | null;
  event_start: Date | null;
  status: string;
  error: string | null;
  created_at: Date;
}

export async function listNotificationLog(limit = 100): Promise<NotificationLogRow[]> {
  const res = await pool.query(
    `select id, rule_id, source, recipient_phone, body, event_start, status, error, created_at
       from notification_log
      where status <> 'claimed'
      order by created_at desc limit $1`,
    [limit],
  );
  return res.rows;
}

/** Most recent finished log line per rule, for the "last: sent 12 min ago" column. */
export async function lastLogPerRule(): Promise<
  Map<string, { status: string; error: string | null; created_at: Date }>
> {
  const res = await pool.query(
    `select distinct on (rule_id) rule_id, status, error, created_at
       from notification_log
      where rule_id is not null and status <> 'claimed'
      order by rule_id, created_at desc`,
  );
  const map = new Map<string, { status: string; error: string | null; created_at: Date }>();
  for (const r of res.rows) {
    map.set(r.rule_id, { status: r.status, error: r.error, created_at: r.created_at });
  }
  return map;
}
