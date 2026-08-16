import crypto from "node:crypto";
import { pool } from "../db/index.js";
import { normalizeConversationSearch } from "./conversationSearch.js";

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
  awa_disengaged_until: Date | null;
  awa_disengaged_kind: "manual" | "nonserious" | "no_intent" | null;
  matched_message?: string | null;
  matched_at?: Date | null;
  matched_source?: "client" | "awa" | "team" | null;
}

const SEARCH_TRANSLATIONS: Array<[string, string]> = [
  ["àáâãäåāăą", "aaaaaaaaa"],
  ["çćč", "ccc"],
  ["ďđð", "ddd"],
  ["èéêëēĕėęě", "eeeeeeeee"],
  ["ìíîïĩīĭįı", "iiiiiiiii"],
  ["ñńň", "nnn"],
  ["òóôõöøōŏő", "ooooooooo"],
  ["ŕř", "rr"],
  ["śşš", "sss"],
  ["ťţ", "tt"],
  ["ùúûüũūŭůűų", "uuuuuuuuuu"],
  ["ýÿ", "yy"],
  ["źżž", "zzz"],
  ["ł", "l"],
];

/** Keep this equivalent to conversationSearch.ts's fold for DB-side matching. */
function normalizedSearchSql(valueSql: string): string {
  let expression = `lower(coalesce(${valueSql}, ''))`;
  expression = `replace(replace(replace(replace(${expression}, 'œ', 'oe'), 'æ', 'ae'), 'ß', 'ss'), 'þ', 'th')`;
  for (const [from, to] of SEARCH_TRANSLATIONS) expression = `translate(${expression}, '${from}', '${to}')`;
  return `regexp_replace(${expression}, '[^a-z0-9]+', '', 'g')`;
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
            c.human_takeover_until, c.human_takeover_by, c.awa_disengaged_until,
            c.awa_disengaged_kind,
            m.created_at as last_message_at, m.content as last_message,
            ((select count(*) from conversations cc
                where cc.client_id = c.id and cc.role in ('user','assistant'))
             + (select count(*) from admin_outbound_messages am
                 where am.client_id = c.id))::int as message_count
       from clients c
       left join lateral (
         select visible.content, visible.created_at
           from (
             select cm.id, cm.content, cm.created_at
               from conversations cm
              where cm.client_id = c.id and cm.role in ('user','assistant')
             union all
             select am.id, am.body, am.created_at
               from admin_outbound_messages am
              where am.client_id = c.id
           ) visible
          order by visible.created_at desc, visible.id desc limit 1
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

type Queryable = {
  query: (text: string, values?: unknown[]) => Promise<{ rows: any[] }>;
};

export interface AdminConversationSuggestion {
  id: string;
  name: string | null;
  phone: string;
  preview: string | null;
  source: "client" | "awa" | "team" | null;
  matchedAt: Date | null;
}

export interface ConversationSuggestionResult {
  items: AdminConversationSuggestion[];
  total: number;
}

export interface ClientPageArgs {
  search?: string;
  page?: number;
  pageSize?: number;
  periodDays?: number | null;
}

async function queryClientsPage(args: ClientPageArgs, db: Queryable): Promise<PageResult<AdminClientRow>> {
  const page = Math.max(1, Math.trunc(args.page ?? 1));
  const pageSize = Math.min(100, Math.max(10, Math.trunc(args.pageSize ?? 30)));
  const terms = normalizeConversationSearch(args.search);
  const hasSearch = Boolean(args.search?.trim());
  const periodDays = args.periodDays && args.periodDays > 0 ? Math.trunc(args.periodDays) : null;
  const params: unknown[] = [terms, periodDays, pageSize, (page - 1) * pageSize, hasSearch];
  const identitySql = normalizedSearchSql(`concat_ws(' ', latest.name, latest.wa_phone)`);
  const messageSql = normalizedSearchSql("message.content");
  const coverageMessageSql = normalizedSearchSql("coverage_message.content");
  const result = await db.query(
    `with search_terms as (
       select unnest($1::text[]) as term
     ), latest as (
       select c.id, c.wa_phone, c.name, c.language, c.claimed_email, c.is_test,
              c.human_takeover_until, c.human_takeover_by, c.awa_disengaged_until,
              c.awa_disengaged_kind,
              m.created_at as last_message_at, m.content as last_message,
              ((select count(*) from conversations cc
                  where cc.client_id = c.id and cc.role in ('user','assistant'))
               + (select count(*) from admin_outbound_messages am
                   where am.client_id = c.id))::int as message_count
         from clients c
         left join lateral (
           select visible.content, visible.created_at
             from (
               select cm.id, cm.content, cm.created_at
                 from conversations cm
                where cm.client_id = c.id and cm.role in ('user','assistant')
               union all
               select am.id, am.body, am.created_at
                 from admin_outbound_messages am
                where am.client_id = c.id
             ) visible
            order by visible.created_at desc, visible.id desc limit 1
         ) m on true
     )
     select latest.*, matched.content as matched_message, matched.created_at as matched_at,
            matched.source as matched_source, count(*) over()::int as total_count
       from latest
       cross join lateral (select ${identitySql} as content) identity
       left join lateral (
         select message.content, message.created_at, message.source
           from (
             select cm.id, cm.content, cm.created_at,
                    case when cm.role = 'user' then 'client' else 'awa' end::text as source
               from conversations cm
              where cm.client_id = latest.id and cm.role in ('user','assistant')
             union all
             select am.id, am.body, am.created_at, 'team'::text as source
               from admin_outbound_messages am
              where am.client_id = latest.id
           ) message
           cross join lateral (
             select count(*)::int as score from search_terms st
              where ${messageSql} like '%' || st.term || '%'
           ) relevance
          where relevance.score > 0
            and ($2::int is null or message.created_at > now() - make_interval(days => $2::int))
          order by relevance.score desc, message.created_at desc, message.id desc
          limit 1
       ) matched on true
      where (
        not $5::boolean
        or (cardinality($1::text[]) > 0 and (select count(*)::int
              from search_terms st
             where identity.content like '%' || st.term || '%'
                or exists (
                  select 1
                    from (
                      select cm.content, cm.created_at
                        from conversations cm
                       where cm.client_id = latest.id and cm.role in ('user','assistant')
                      union all
                      select am.body, am.created_at
                        from admin_outbound_messages am
                       where am.client_id = latest.id
                    ) coverage_message
                   where ($2::int is null or coverage_message.created_at > now() - make_interval(days => $2::int))
                     and ${coverageMessageSql} like '%' || st.term || '%'
                )
           ) = cardinality($1::text[]))
      )
        and (
          $2::int is null
          or latest.last_message_at > now() - make_interval(days => $2::int)
          or matched.created_at is not null
        )
      order by last_message_at desc nulls last
      limit $3 offset $4`,
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

export async function listClientsPage(args: ClientPageArgs): Promise<PageResult<AdminClientRow>> {
  return queryClientsPage(args, pool);
}

async function withConversationSearchTimeout<T>(timeoutMs: number, work: (db: Queryable) => Promise<T>): Promise<T> {
  const db = await pool.connect();
  const safeTimeout = Math.min(10_000, Math.max(100, Math.trunc(timeoutMs)));
  try {
    await db.query("begin");
    await db.query("select set_config('statement_timeout', $1, true)", [`${safeTimeout}ms`]);
    const result = await work(db);
    await db.query("commit");
    return result;
  } catch (error) {
    await db.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    db.release();
  }
}

export async function listClientsPageWithTimeout(
  args: ClientPageArgs,
  timeoutMs = 2_500,
): Promise<PageResult<AdminClientRow>> {
  return withConversationSearchTimeout(timeoutMs, (db) => queryClientsPage(args, db));
}

async function queryConversationSuggestions(
  search: string,
  limit: number,
  db: Queryable,
): Promise<ConversationSuggestionResult> {
  const terms = normalizeConversationSearch(search);
  if (!terms.length) return { items: [], total: 0 };
  const safeLimit = Math.min(12, Math.max(1, Math.trunc(limit)));
  const identitySql = normalizedSearchSql(`concat_ws(' ', c.name, c.wa_phone)`);
  const conversationContentSql = normalizedSearchSql("cm.content");
  const teamContentSql = normalizedSearchSql("am.body");
  const result = await db.query(
    `with search_terms as (
       select unnest($1::text[]) as term
     ), client_search as materialized (
       select c.id, c.name, c.wa_phone, ${identitySql} as identity
         from clients c
     ), visible_messages as materialized (
       select cm.id::text as id, cm.client_id, cm.content, cm.created_at,
              case when cm.role = 'user' then 'client' else 'awa' end::text as source,
              ${conversationContentSql} as normalized_content
         from conversations cm
        where cm.role in ('user', 'assistant')
       union all
       select am.id::text, am.client_id, am.body, am.created_at, 'team'::text,
              ${teamContentSql}
         from admin_outbound_messages am
     ), term_matches as (
       select cs.id as client_id, st.term
         from client_search cs
         cross join search_terms st
        where cs.identity like '%' || st.term || '%'
       union
       select vm.client_id, st.term
         from visible_messages vm
         cross join search_terms st
        where vm.normalized_content like '%' || st.term || '%'
     ), eligible as (
       select client_id
         from term_matches
        group by client_id
       having count(distinct term) = (select count(*) from search_terms)
     ), scored_messages as (
       select vm.id, vm.client_id, vm.content, vm.created_at, vm.source,
              count(st.term)::int as score
         from visible_messages vm
         join eligible e on e.client_id = vm.client_id
         join search_terms st on vm.normalized_content like '%' || st.term || '%'
        group by vm.id, vm.client_id, vm.content, vm.created_at, vm.source
     ), best_message as (
       select distinct on (client_id) client_id, content, created_at, source
         from scored_messages
        order by client_id, score desc, created_at desc, id desc
     ), latest_message as (
       select distinct on (vm.client_id) vm.client_id, vm.content, vm.created_at, vm.source
         from visible_messages vm
         join eligible e on e.client_id = vm.client_id
        order by vm.client_id, vm.created_at desc, vm.id desc
     )
     select cs.id, cs.name, cs.wa_phone as phone,
            coalesce(bm.content, lm.content) as preview,
            coalesce(bm.source, lm.source) as source,
            coalesce(bm.created_at, lm.created_at) as matched_at,
            count(*) over()::int as total_count,
            lm.created_at as last_activity
       from eligible e
       join client_search cs on cs.id = e.client_id
       left join best_message bm on bm.client_id = e.client_id
       left join latest_message lm on lm.client_id = e.client_id
      order by lm.created_at desc nulls last, cs.id
      limit $2`,
    [terms, safeLimit],
  );
  return {
    total: result.rows[0]?.total_count ?? 0,
    items: result.rows.map((row) => ({
      id: row.id,
      name: row.name,
      phone: row.phone,
      preview: row.preview,
      source: row.source,
      matchedAt: row.matched_at,
    })),
  };
}

export async function listConversationSuggestionsWithTimeout(
  search: string,
  limit = 6,
  timeoutMs = 2_500,
): Promise<ConversationSuggestionResult> {
  return withConversationSearchTimeout(timeoutMs, (db) => queryConversationSuggestions(search, limit, db));
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
       coalesce((select sum(amount_xof) from pending_bookings,bounds where (status='BOOKED' or forfeited_at is not null) and payment_method<>'membership' and updated_at>=current_start),0)::int as booking_revenue,
       coalesce((select sum(amount_xof) from pending_plan_orders,bounds where status in ('PAID','ACTIVATED') and updated_at>=current_start),0)::int as plan_revenue,
       coalesce((select sum(amount_xof) from pending_cafe_orders,bounds where status='PAID' and updated_at>=current_start),0)::int as cafe_revenue,
       (coalesce((select sum(amount_xof) from pending_bookings,bounds where (status='BOOKED' or forfeited_at is not null) and payment_method<>'membership' and updated_at>=previous_start and updated_at<current_start),0)
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

// ---------- historique des commandes bar/restaurant (/admin/historique-commandes) ----------

/**
 * Historique unifié de TOUTES les commandes bar/restaurant, tous canaux :
 * sur place, à emporter, retrait, livraison. Il n'existe pas de table
 * « commandes » unique — la donnée vit dans trois tables. On normalise chacune
 * sur les mêmes colonnes puis on UNION, en évitant les doubles comptages :
 *
 *  1. kitchen_tickets : la file cuisine unifiée (depuis les iPads de service,
 *     ~fin juillet 2026). Couvre BAR / TABLE / DELIVERY. Le canal et le moyen de
 *     paiement d'un ticket BAR viennent de la commande cafe source, reliée par
 *     client_request_id = 'bar:cafe:<id>'. TABLE = salle (POS = source
 *     comptable, montant indicatif). DELIVERY est relié via delivery_order_id.
 *  2. delivery_orders SANS ticket cuisine : livraisons antérieures aux tickets
 *     (le ticket DELIVERY naît à l'activation, donc l'historique ancien n'en a
 *     pas). NOT EXISTS pour ne pas doubler le point 1.
 *  3. pending_cafe_orders PAYÉES sans ticket BAR ET sans livraison rattachée :
 *     commandes WhatsApp/web anciennes qui n'ont jamais produit de ticket.
 *
 * `channel` ∈ SUR_PLACE | A_EMPORTER | RETRAIT | LIVRAISON ; `status` normalisé
 * en COMPLETED | OPEN | CANCELLED. Montants = entiers XOF.
 */
const ORDER_HISTORY_BASE_CTE = `base as (
  select
    'kt:' || kt.id::text as id,
    kt.created_at,
    case
      when kt.source = 'DELIVERY' then 'LIVRAISON'
      when kt.source = 'TABLE' then 'SUR_PLACE'
      when pco.service_mode in ('SUR_PLACE','A_EMPORTER','RETRAIT','LIVRAISON') then pco.service_mode
      when kt.takeaway then 'A_EMPORTER'
      else 'RETRAIT'
    end as channel,
    case
      when kt.status = 'CANCELLED' then 'CANCELLED'
      when kt.source = 'DELIVERY' and d.status = 'CANCELLED' then 'CANCELLED'
      when kt.status = 'COMPLETED' then 'COMPLETED'
      else 'OPEN'
    end as status,
    kt.amount_xof,
    kt.heading,
    coalesce(nullif(kt.subheading, ''), ss.short_code) as detail,
    kt.items_json,
    pco.client_id,
    kt.is_test
  from kitchen_tickets kt
  left join delivery_orders d on d.id = kt.delivery_order_id
  left join pending_cafe_orders pco
    on pco.id = (case when kt.source = 'BAR' and kt.client_request_id like 'bar:cafe:%'
                      then substring(kt.client_request_id from 10) end)::uuid
  left join service_sessions ss on ss.id = kt.session_id
  union all
  select
    'do:' || d.id::text,
    d.created_at,
    'LIVRAISON',
    case d.status when 'DELIVERED' then 'COMPLETED' when 'CANCELLED' then 'CANCELLED' else 'OPEN' end,
    d.amount_xof,
    d.client_name,
    d.address,
    d.items_json,
    null::uuid,
    d.is_test
  from delivery_orders d
  where not exists (select 1 from kitchen_tickets kt where kt.delivery_order_id = d.id)
  union all
  select
    'co:' || pco.id::text,
    pco.created_at,
    case when pco.service_mode in ('SUR_PLACE','A_EMPORTER','RETRAIT','LIVRAISON') then pco.service_mode else 'RETRAIT' end,
    'COMPLETED',
    pco.amount_xof,
    coalesce(nullif(pco.customer_name, ''), cl.name, 'Client'),
    pco.service_name,
    pco.extras_json,
    pco.client_id,
    cl.is_test
  from pending_cafe_orders pco
  join clients cl on cl.id = pco.client_id
  where pco.status = 'PAID'
    and not exists (select 1 from kitchen_tickets kt where kt.client_request_id = 'bar:cafe:' || pco.id::text)
    and not exists (select 1 from delivery_orders d where d.source_cafe_order_id = pco.id)
)`;

export type OrderChannel = "SUR_PLACE" | "A_EMPORTER" | "RETRAIT" | "LIVRAISON";
export type OrderStatusNorm = "COMPLETED" | "OPEN" | "CANCELLED";
export type OrderPeriod = "today" | "7" | "30" | "all";

export interface OrderHistoryFilters {
  period: OrderPeriod;
  channel: OrderChannel | "all";
  status: OrderStatusNorm | "all";
  page: number;
}

export interface OrderHistoryRow {
  id: string;
  created_at: Date;
  channel: OrderChannel;
  status: OrderStatusNorm;
  amount_xof: number;
  heading: string;
  detail: string | null;
  items_json: unknown;
  client_id: string | null;
}

/** Current-window predicate (excludes tests) shared by list/channel/daily. */
function orderWindowClause(filters: OrderHistoryFilters, params: unknown[]): string {
  const conds = ["is_test = false"];
  if (filters.period === "today") conds.push("created_at >= current_date");
  else if (filters.period === "7" || filters.period === "30") {
    params.push(Number(filters.period));
    conds.push(`created_at > now() - make_interval(days => $${params.length}::int)`);
  }
  if (filters.channel !== "all") {
    params.push(filters.channel);
    conds.push(`channel = $${params.length}`);
  }
  return conds.join(" and ");
}

export async function listOrderHistory(
  filters: OrderHistoryFilters,
): Promise<PageResult<OrderHistoryRow>> {
  const page = Math.max(1, Math.trunc(filters.page || 1));
  const pageSize = 50;
  const params: unknown[] = [];
  const where = orderWindowClause(filters, params);
  const conds = [where];
  if (filters.status !== "all") {
    params.push(filters.status);
    conds.push(`status = $${params.length}`);
  }
  params.push(pageSize, (page - 1) * pageSize);
  const res = await pool.query(
    `with ${ORDER_HISTORY_BASE_CTE}
     select id, created_at, channel, status, amount_xof, heading, detail, items_json, client_id,
            count(*) over()::int as total_count
       from base
      where ${conds.join(" and ")}
      order by created_at desc
      limit $${params.length - 1} offset $${params.length}`,
    params,
  );
  const total = res.rows[0]?.total_count ?? 0;
  return {
    rows: res.rows.map(({ total_count: _t, ...row }) => row as OrderHistoryRow),
    page,
    pageSize,
    total,
    pages: Math.max(1, Math.ceil(total / pageSize)),
  };
}

export interface OrderHistoryStats {
  completed: number;
  cancelled: number;
  open: number;
  revenueXof: number;
  avgTicketXof: number;
  previousCompleted: number;
  previousRevenueXof: number;
  firstOrderAt: Date | null;
}

/** Top-line KPIs for the selected window plus the equal previous window. */
export async function orderHistoryStats(filters: OrderHistoryFilters): Promise<OrderHistoryStats> {
  // params: $1 period, $2 channel
  const res = await pool.query(
    `with ${ORDER_HISTORY_BASE_CTE},
     bounds as (
       select
         case when $1='today' then current_date::timestamptz
              when $1='7' then now() - make_interval(days=>7)
              when $1='30' then now() - make_interval(days=>30)
              else null end as cur_start,
         case when $1='today' then (current_date - 1)::timestamptz
              when $1='7' then now() - make_interval(days=>14)
              when $1='30' then now() - make_interval(days=>60)
              else null end as prev_start
     ),
     scoped as (
       select b.*, bd.cur_start
         from base b cross join bounds bd
        where b.is_test = false
          and ($2 = 'all' or b.channel = $2)
          and (bd.cur_start is null or b.created_at >= bd.prev_start)
     )
     select
       count(*) filter (where status='COMPLETED' and (cur_start is null or created_at >= cur_start))::int as completed,
       count(*) filter (where status='CANCELLED' and (cur_start is null or created_at >= cur_start))::int as cancelled,
       count(*) filter (where status='OPEN' and (cur_start is null or created_at >= cur_start))::int as open_count,
       coalesce(sum(amount_xof) filter (where status='COMPLETED' and (cur_start is null or created_at >= cur_start)),0)::int as revenue,
       coalesce(round(avg(amount_xof) filter (where status='COMPLETED' and amount_xof>0 and (cur_start is null or created_at >= cur_start))),0)::int as avg_ticket,
       count(*) filter (where status='COMPLETED' and cur_start is not null and created_at < cur_start)::int as prev_completed,
       coalesce(sum(amount_xof) filter (where status='COMPLETED' and cur_start is not null and created_at < cur_start),0)::int as prev_revenue,
       (select min(created_at) from base where is_test=false) as first_order_at
     from scoped`,
    [filters.period, filters.channel],
  );
  const r = res.rows[0] ?? {};
  return {
    completed: r.completed ?? 0,
    cancelled: r.cancelled ?? 0,
    open: r.open_count ?? 0,
    revenueXof: r.revenue ?? 0,
    avgTicketXof: r.avg_ticket ?? 0,
    previousCompleted: r.prev_completed ?? 0,
    previousRevenueXof: r.prev_revenue ?? 0,
    firstOrderAt: r.first_order_at ?? null,
  };
}

export interface OrderChannelRow {
  channel: OrderChannel;
  orders: number;
  revenueXof: number;
}

/** Completed-order revenue split by channel over the selected window. */
export async function orderHistoryByChannel(
  filters: OrderHistoryFilters,
): Promise<OrderChannelRow[]> {
  const params: unknown[] = [];
  const where = orderWindowClause(filters, params);
  const res = await pool.query(
    `with ${ORDER_HISTORY_BASE_CTE}
     select channel, count(*)::int as orders, coalesce(sum(amount_xof),0)::int as revenue
       from base
      where ${where} and status = 'COMPLETED'
      group by channel`,
    params,
  );
  const byChannel = new Map<string, OrderChannelRow>(
    res.rows.map((row: any) => [
      row.channel,
      { channel: row.channel, orders: row.orders, revenueXof: row.revenue },
    ]),
  );
  const order: OrderChannel[] = ["SUR_PLACE", "A_EMPORTER", "RETRAIT", "LIVRAISON"];
  return order.map(
    (channel) => byChannel.get(channel) ?? { channel, orders: 0, revenueXof: 0 },
  );
}

export interface OrderDailyPoint {
  day: string;
  orders: number;
  revenueXof: number;
}

/** Per-day completed orders + revenue for the CSS bar trend (period 7/30 only). */
export async function orderHistoryDaily(filters: OrderHistoryFilters): Promise<OrderDailyPoint[]> {
  if (filters.period !== "7" && filters.period !== "30") return [];
  const days = Number(filters.period);
  const params: unknown[] = [days];
  const channelClause = filters.channel === "all" ? "" : `and b.channel = $2`;
  if (filters.channel !== "all") params.push(filters.channel);
  const res = await pool.query(
    `with ${ORDER_HISTORY_BASE_CTE}
     select to_char(d::date, 'YYYY-MM-DD') as day,
            count(b.id) filter (where b.status='COMPLETED')::int as orders,
            coalesce(sum(b.amount_xof) filter (where b.status='COMPLETED'),0)::int as revenue
       from generate_series(current_date - ($1::int - 1), current_date, interval '1 day') d
       left join base b
         on b.is_test = false
        and b.created_at >= d and b.created_at < d + interval '1 day'
        ${channelClause}
      group by d order by d`,
    params,
  );
  return res.rows.map((row: any) => ({
    day: row.day,
    orders: row.orders,
    revenueXof: row.revenue,
  }));
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
