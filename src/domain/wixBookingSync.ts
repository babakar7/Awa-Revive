import { pool } from "../db/index.js";
import { canonicalPhoneKey } from "../lib/phoneKey.js";
import {
  getWixAttendanceBookingSnapshots,
  listWixAttendanceRecords,
  listWixBookingSnapshots,
  listWixPlanOrdersForMirror,
  type WixBookingSnapshot,
} from "../lib/wix.js";
import { refreshAttendanceMarks } from "./attendanceLeaderboard.js";

type Log = {
  info?: (obj: unknown, message?: string) => void;
  warn?: (obj: unknown, message?: string) => void;
};

const SYNC_LOCK = 8_337_201; // shared with the former attendance sync — same data.
const FULL_EVERY_MS = 7 * 86_400_000;
const INCREMENTAL_OVERLAP_MS = 3_600_000; // 1h watermark overlap
const BOOKINGS_MAX = 50_000;
const PLAN_ORDERS_MAX = 5_000;

/** Wix statuses that count as a live seat for the attendance leaderboard. */
export const CONFIRMED_BOOKING_STATUSES = ["CONFIRMED"];

export type BookingMatchBasis = "awa_booking" | "contact_id" | "phone";
export type PlanMatchBasis = "awa_order" | "contact_id" | "phone";

export interface MatchIndex {
  byPhoneKey: Map<string, string | null>; // null = ambiguous (≥2 clients)
  byContactId: Map<string, string>;
  byMemberId: Map<string, string>;
  byAwaBookingId: Map<string, string>;
  clientNames: Map<string, string>;
}

function normName(value: string | null | undefined): string {
  return String(value ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Do two names plausibly belong to the same person? Required before a
 * phone-only match, because one number can serve several clients (a child
 * books under the paying parent). Fail-closed: an unknown Wix-side name never
 * satisfies the check.
 */
export function namesCompatible(
  wixName: string | null | undefined,
  clientName: string | null | undefined,
): boolean {
  const a = normName(wixName);
  const b = normName(clientName);
  if (!a || !b) return false;
  if (a === b || a.includes(b) || b.includes(a)) return true;
  const at = new Set(a.split(" ").filter((t) => t.length >= 3));
  return b.split(" ").some((t) => t.length >= 3 && at.has(t));
}

export async function loadMatchIndex(): Promise<MatchIndex> {
  const [clients, contactLinks, memberLinks, awaBookings] = await Promise.all([
    pool.query(`select id, wa_phone, name from clients`),
    pool.query(
      `select wix_contact_id, client_id from key_registry
         where wix_contact_id is not null and client_id is not null
       union
       select linked_contact_id, client_id from link_requests
         where linked_contact_id is not null and client_id is not null`,
    ),
    pool.query(
      `select wix_member_id, client_id from key_registry
         where wix_member_id is not null and client_id is not null`,
    ),
    pool.query(
      `select wix_booking_id, client_id from pending_bookings where wix_booking_id is not null`,
    ),
  ]);
  const byPhoneKey = new Map<string, string | null>();
  const clientNames = new Map<string, string>();
  for (const row of clients.rows) {
    const id = String(row.id);
    if (row.name) clientNames.set(id, String(row.name));
    const key = canonicalPhoneKey(row.wa_phone);
    if (!key) continue;
    if (byPhoneKey.has(key) && byPhoneKey.get(key) !== id) byPhoneKey.set(key, null);
    else if (!byPhoneKey.has(key)) byPhoneKey.set(key, id);
  }
  const byContactId = new Map<string, string>();
  for (const row of contactLinks.rows) {
    if (row.wix_contact_id && row.client_id) {
      byContactId.set(String(row.wix_contact_id), String(row.client_id));
    }
  }
  const byMemberId = new Map<string, string>();
  for (const row of memberLinks.rows) {
    if (row.wix_member_id && row.client_id) {
      byMemberId.set(String(row.wix_member_id), String(row.client_id));
    }
  }
  const byAwaBookingId = new Map<string, string>();
  for (const row of awaBookings.rows) {
    if (row.wix_booking_id && row.client_id) {
      byAwaBookingId.set(String(row.wix_booking_id), String(row.client_id));
    }
  }
  return { byPhoneKey, byContactId, byMemberId, byAwaBookingId, clientNames };
}

export interface BookingMatch {
  clientId: string | null;
  basis: BookingMatchBasis | null;
}

/**
 * Evidence hierarchy for attaching a Wix booking to a local client:
 *   1. an Awa booking with the same wix_booking_id;
 *   2. a proven Wix contact→client link (Key / verified account link);
 *   3. a canonical phone unique to one client, with a compatible name.
 * Anything ambiguous stays unmatched — never guessed.
 */
export function matchBooking(snapshot: WixBookingSnapshot, index: MatchIndex): BookingMatch {
  const awa = index.byAwaBookingId.get(snapshot.bookingId);
  if (awa) return { clientId: awa, basis: "awa_booking" };
  if (snapshot.contactId) {
    const byContact = index.byContactId.get(snapshot.contactId);
    if (byContact) return { clientId: byContact, basis: "contact_id" };
  }
  const key = canonicalPhoneKey(snapshot.clientPhone);
  if (key) {
    const single = index.byPhoneKey.get(key);
    if (single && namesCompatible(snapshot.clientName, index.clientNames.get(single))) {
      return { clientId: single, basis: "phone" };
    }
  }
  return { clientId: null, basis: null };
}

export interface PlanMatch {
  clientId: string | null;
  basis: PlanMatchBasis | null;
}

export function matchPlanOrder(
  order: {
    contactId: string | null;
    memberId: string | null;
    buyerName: string | null;
    buyerPhone: string | null;
  },
  index: MatchIndex,
): PlanMatch {
  if (order.memberId) {
    const byMember = index.byMemberId.get(order.memberId);
    if (byMember) return { clientId: byMember, basis: "awa_order" };
  }
  if (order.contactId) {
    const byContact = index.byContactId.get(order.contactId);
    if (byContact) return { clientId: byContact, basis: "contact_id" };
  }
  const key = canonicalPhoneKey(order.buyerPhone);
  if (key) {
    const single = index.byPhoneKey.get(key);
    if (single && namesCompatible(order.buyerName, index.clientNames.get(single))) {
      return { clientId: single, basis: "phone" };
    }
  }
  return { clientId: null, basis: null };
}

// match_basis rank for the "never downgrade a match without stronger evidence"
// rule, encoded once and reused in the upsert CASE expressions.
function bookingRankSql(column: string): string {
  return `(case ${column} when 'awa_booking' then 3 when 'contact_id' then 2 when 'phone' then 1 else 0 end)`;
}
function planRankSql(column: string): string {
  return `(case ${column} when 'awa_order' then 3 when 'contact_id' then 2 when 'phone' then 1 else 0 end)`;
}

function toDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

async function upsertBookingRow(
  snapshot: WixBookingSnapshot,
  match: BookingMatch,
  startedAt: Date,
): Promise<void> {
  const session = toDate(snapshot.sessionStart);
  await pool.query(
    `insert into wix_booking_records
       (booking_id, wix_contact_id, client_name, client_phone, client_phone_key,
        service_id, service_name, session_start, status, payment_status,
        number_of_participants, created_date, updated_date, wix_order_id,
        benefit_transaction_id, matched_client_id, match_basis,
        synced_at, last_seen_at, invalidated_at, raw)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,
             now(), $18, null, $19)
     on conflict (booking_id) do update set
       wix_contact_id=coalesce(excluded.wix_contact_id, wix_booking_records.wix_contact_id),
       client_name=coalesce(excluded.client_name, wix_booking_records.client_name),
       client_phone=coalesce(excluded.client_phone, wix_booking_records.client_phone),
       client_phone_key=coalesce(excluded.client_phone_key, wix_booking_records.client_phone_key),
       service_id=coalesce(excluded.service_id, wix_booking_records.service_id),
       service_name=coalesce(excluded.service_name, wix_booking_records.service_name),
       session_start=coalesce(excluded.session_start, wix_booking_records.session_start),
       status=excluded.status,
       payment_status=coalesce(excluded.payment_status, wix_booking_records.payment_status),
       number_of_participants=coalesce(excluded.number_of_participants, wix_booking_records.number_of_participants),
       created_date=coalesce(wix_booking_records.created_date, excluded.created_date),
       updated_date=coalesce(excluded.updated_date, wix_booking_records.updated_date),
       wix_order_id=coalesce(excluded.wix_order_id, wix_booking_records.wix_order_id),
       benefit_transaction_id=coalesce(excluded.benefit_transaction_id, wix_booking_records.benefit_transaction_id),
       matched_client_id=case
         when excluded.matched_client_id is null then wix_booking_records.matched_client_id
         when wix_booking_records.matched_client_id is null then excluded.matched_client_id
         when ${bookingRankSql("excluded.match_basis")} >= ${bookingRankSql("wix_booking_records.match_basis")}
           then excluded.matched_client_id
         else wix_booking_records.matched_client_id end,
       match_basis=case
         when excluded.matched_client_id is null then wix_booking_records.match_basis
         when wix_booking_records.matched_client_id is null then excluded.match_basis
         when ${bookingRankSql("excluded.match_basis")} >= ${bookingRankSql("wix_booking_records.match_basis")}
           then excluded.match_basis
         else wix_booking_records.match_basis end,
       synced_at=now(),
       last_seen_at=$18,
       invalidated_at=null,
       raw=excluded.raw`,
    [
      snapshot.bookingId,
      snapshot.contactId,
      snapshot.clientName,
      snapshot.clientPhone,
      canonicalPhoneKey(snapshot.clientPhone),
      snapshot.serviceId,
      snapshot.serviceName,
      session,
      snapshot.status,
      snapshot.paymentStatus,
      snapshot.numberOfParticipants,
      toDate(snapshot.createdDate),
      toDate(snapshot.updatedDate),
      snapshot.wixOrderId,
      snapshot.benefitTransactionId,
      match.clientId,
      match.basis,
      startedAt,
      JSON.stringify(snapshot.raw ?? null),
    ],
  );
}

interface PlanOrderRow {
  orderId: string;
  planId: string | null;
  planName: string | null;
  memberId: string | null;
  contactId: string | null;
  buyerName: string | null;
  buyerPhone: string | null;
  amountXof: number | null;
  currency: string | null;
  paymentStatus: string | null;
  orderStatus: string | null;
  startDate: Date | null;
  endDate: Date | null;
  createdDate: Date | null;
  updatedDate: Date | null;
  wixPayOrderId: string | null;
  raw: unknown;
}

function pick(...candidates: unknown[]): string | null {
  for (const c of candidates) {
    const s = String(c ?? "").trim();
    if (s) return s;
  }
  return null;
}

export function planOrderRowFromWix(order: any): PlanOrderRow | null {
  const orderId = pick(order?.id, order?._id);
  if (!orderId) return null;
  const amountRaw = Number(
    order?.priceDetails?.total ??
      order?.priceDetails?.subtotal ??
      order?.pricing?.prices?.[0]?.price?.amount ??
      order?.price?.amount,
  );
  return {
    orderId,
    planId: pick(order?.planId),
    planName: pick(order?.planName),
    memberId: pick(order?.buyer?.memberId, order?.memberId),
    contactId: pick(order?.buyer?.contactId),
    buyerName: pick(order?.buyer?.fullName, order?.buyerName),
    buyerPhone: pick(order?.buyer?.phone),
    amountXof: Number.isFinite(amountRaw) && amountRaw > 0 ? Math.round(amountRaw) : null,
    currency: pick(order?.priceDetails?.currency, order?.pricing?.prices?.[0]?.price?.currency),
    paymentStatus: pick(order?.lastPaymentStatus, order?.paymentStatus),
    orderStatus: pick(order?.status),
    startDate: toDate(order?.startDate),
    endDate: toDate(order?.endDate),
    createdDate: toDate(order?.createdDate),
    updatedDate: toDate(order?.updatedDate ?? order?.createdDate),
    wixPayOrderId: pick(order?.wixPayOrderId),
    raw: order,
  };
}

async function upsertPlanOrderRow(
  row: PlanOrderRow,
  match: PlanMatch,
  startedAt: Date,
): Promise<void> {
  await pool.query(
    `insert into wix_plan_order_records
       (order_id, plan_id, plan_name, member_id, wix_contact_id, buyer_name,
        buyer_phone, buyer_phone_key, amount_xof, currency, payment_status,
        order_status, start_date, end_date, created_date, updated_date,
        wix_pay_order_id, matched_client_id, match_basis, last_seen_at,
        invalidated_at, raw, synced_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,null,$21,now())
     on conflict (order_id) do update set
       plan_id=coalesce(excluded.plan_id, wix_plan_order_records.plan_id),
       plan_name=coalesce(excluded.plan_name, wix_plan_order_records.plan_name),
       member_id=coalesce(excluded.member_id, wix_plan_order_records.member_id),
       wix_contact_id=coalesce(excluded.wix_contact_id, wix_plan_order_records.wix_contact_id),
       buyer_name=coalesce(excluded.buyer_name, wix_plan_order_records.buyer_name),
       buyer_phone=coalesce(excluded.buyer_phone, wix_plan_order_records.buyer_phone),
       buyer_phone_key=coalesce(excluded.buyer_phone_key, wix_plan_order_records.buyer_phone_key),
       amount_xof=coalesce(excluded.amount_xof, wix_plan_order_records.amount_xof),
       currency=coalesce(excluded.currency, wix_plan_order_records.currency),
       payment_status=coalesce(excluded.payment_status, wix_plan_order_records.payment_status),
       order_status=excluded.order_status,
       start_date=coalesce(excluded.start_date, wix_plan_order_records.start_date),
       end_date=coalesce(excluded.end_date, wix_plan_order_records.end_date),
       created_date=coalesce(wix_plan_order_records.created_date, excluded.created_date),
       updated_date=coalesce(excluded.updated_date, wix_plan_order_records.updated_date),
       wix_pay_order_id=coalesce(excluded.wix_pay_order_id, wix_plan_order_records.wix_pay_order_id),
       matched_client_id=case
         when excluded.matched_client_id is null then wix_plan_order_records.matched_client_id
         when wix_plan_order_records.matched_client_id is null then excluded.matched_client_id
         when ${planRankSql("excluded.match_basis")} >= ${planRankSql("wix_plan_order_records.match_basis")}
           then excluded.matched_client_id
         else wix_plan_order_records.matched_client_id end,
       match_basis=case
         when excluded.matched_client_id is null then wix_plan_order_records.match_basis
         when wix_plan_order_records.matched_client_id is null then excluded.match_basis
         when ${planRankSql("excluded.match_basis")} >= ${planRankSql("wix_plan_order_records.match_basis")}
           then excluded.match_basis
         else wix_plan_order_records.match_basis end,
       last_seen_at=$20,
       invalidated_at=null,
       raw=excluded.raw,
       synced_at=now()`,
    [
      row.orderId,
      row.planId,
      row.planName,
      row.memberId,
      row.contactId,
      row.buyerName,
      row.buyerPhone,
      canonicalPhoneKey(row.buyerPhone),
      row.amountXof,
      row.currency,
      row.paymentStatus,
      row.orderStatus,
      row.startDate,
      row.endDate,
      row.createdDate,
      row.updatedDate,
      row.wixPayOrderId,
      match.clientId,
      match.basis,
      startedAt,
      JSON.stringify(row.raw ?? null),
    ],
  );
}

/**
 * Immediate mirror upsert for a Pricing Plans "purchased" webhook. Tolerant
 * (never throws on a partial body) and guarded: a delayed webhook whose
 * updated_date is older than the stored row is ignored, so it can't overwrite a
 * fresher sync. Runs alongside — never in front of — the strict Key handler.
 */
export async function upsertPlanOrderFromWebhook(order: any): Promise<void> {
  const row = planOrderRowFromWix(order);
  if (!row) return;
  const index = await loadMatchIndex();
  const match = matchPlanOrder(
    { contactId: row.contactId, memberId: row.memberId, buyerName: row.buyerName, buyerPhone: row.buyerPhone },
    index,
  );
  await pool.query(
    `insert into wix_plan_order_records
       (order_id, plan_id, plan_name, member_id, wix_contact_id, buyer_name,
        buyer_phone, buyer_phone_key, amount_xof, currency, payment_status,
        order_status, start_date, end_date, created_date, updated_date,
        wix_pay_order_id, matched_client_id, match_basis, last_seen_at,
        invalidated_at, raw, synced_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,now(),null,$20,now())
     on conflict (order_id) do update set
       plan_id=coalesce(excluded.plan_id, wix_plan_order_records.plan_id),
       plan_name=coalesce(excluded.plan_name, wix_plan_order_records.plan_name),
       member_id=coalesce(excluded.member_id, wix_plan_order_records.member_id),
       wix_contact_id=coalesce(excluded.wix_contact_id, wix_plan_order_records.wix_contact_id),
       buyer_name=coalesce(excluded.buyer_name, wix_plan_order_records.buyer_name),
       buyer_phone=coalesce(excluded.buyer_phone, wix_plan_order_records.buyer_phone),
       buyer_phone_key=coalesce(excluded.buyer_phone_key, wix_plan_order_records.buyer_phone_key),
       amount_xof=coalesce(excluded.amount_xof, wix_plan_order_records.amount_xof),
       currency=coalesce(excluded.currency, wix_plan_order_records.currency),
       payment_status=coalesce(excluded.payment_status, wix_plan_order_records.payment_status),
       order_status=excluded.order_status,
       start_date=coalesce(excluded.start_date, wix_plan_order_records.start_date),
       end_date=coalesce(excluded.end_date, wix_plan_order_records.end_date),
       created_date=coalesce(wix_plan_order_records.created_date, excluded.created_date),
       updated_date=coalesce(excluded.updated_date, wix_plan_order_records.updated_date),
       wix_pay_order_id=coalesce(excluded.wix_pay_order_id, wix_plan_order_records.wix_pay_order_id),
       matched_client_id=case
         when excluded.matched_client_id is null then wix_plan_order_records.matched_client_id
         when wix_plan_order_records.matched_client_id is null then excluded.matched_client_id
         when ${planRankSql("excluded.match_basis")} >= ${planRankSql("wix_plan_order_records.match_basis")}
           then excluded.matched_client_id
         else wix_plan_order_records.matched_client_id end,
       match_basis=case
         when excluded.matched_client_id is null then wix_plan_order_records.match_basis
         when wix_plan_order_records.matched_client_id is null then excluded.match_basis
         when ${planRankSql("excluded.match_basis")} >= ${planRankSql("wix_plan_order_records.match_basis")}
           then excluded.match_basis
         else wix_plan_order_records.match_basis end,
       last_seen_at=now(),
       raw=excluded.raw,
       synced_at=now()
     where excluded.updated_date is null
        or wix_plan_order_records.updated_date is null
        or excluded.updated_date >= wix_plan_order_records.updated_date`,
    [
      row.orderId,
      row.planId,
      row.planName,
      row.memberId,
      row.contactId,
      row.buyerName,
      row.buyerPhone,
      canonicalPhoneKey(row.buyerPhone),
      row.amountXof,
      row.currency,
      row.paymentStatus,
      row.orderStatus,
      row.startDate,
      row.endDate,
      row.createdDate,
      row.updatedDate,
      row.wixPayOrderId,
      match.clientId,
      match.basis,
      JSON.stringify(row.raw ?? null),
    ],
  );
}

export interface WixBookingSyncResult {
  ran: boolean;
  full: boolean;
  bookingCount: number;
  planOrderCount: number;
  truncated: boolean;
}

/**
 * General Wix booking + pricing-plan mirror. Runs an incremental upsert every
 * tick (watermark + 1h overlap) and a full reconciliation weekly / on the
 * one-time backfill. Invalidation (tombstoning) happens ONLY after a complete,
 * non-truncated full scan; a cancellation is a status update, never a delete.
 * Attendance marks are refreshed on full passes so the leaderboard breakdown
 * stays current.
 */
export async function syncWixBookings(log: Log = {}, force = false): Promise<WixBookingSyncResult> {
  const db = await pool.connect();
  let locked = false;
  try {
    locked = Boolean((await db.query(`select pg_try_advisory_lock($1) as locked`, [SYNC_LOCK])).rows[0]?.locked);
    if (!locked) return { ran: false, full: false, bookingCount: 0, planOrderCount: 0, truncated: false };

    const state = (await db.query(`select * from wix_attendance_sync_state where singleton=true`)).rows[0] ?? {};
    const backfillPending = !state.backfill_completed_at;
    const fullDue =
      !state.last_full_reconciled_at ||
      Date.now() - new Date(state.last_full_reconciled_at).getTime() >= FULL_EVERY_MS;
    const full = force || backfillPending || fullDue;
    const startedAt = new Date();

    if (backfillPending && !state.backfill_started_at) {
      await db.query(
        `update wix_attendance_sync_state set backfill_started_at=now() where singleton=true`,
      );
    }
    await db.query(
      `update wix_attendance_sync_state set last_started_at=now(), last_error=null where singleton=true`,
    );

    const index = await loadMatchIndex();

    // ---- bookings ----
    const watermark = state.last_updated_date_seen ? new Date(state.last_updated_date_seen) : null;
    const bookingsPage = await listWixBookingSnapshots(
      full || !watermark
        ? { max: BOOKINGS_MAX }
        : { updatedAfter: new Date(watermark.getTime() - INCREMENTAL_OVERLAP_MS), max: BOOKINGS_MAX },
    );
    let maxUpdated = watermark ? watermark.getTime() : 0;
    for (const snapshot of bookingsPage.snapshots) {
      await upsertBookingRow(snapshot, matchBooking(snapshot, index), startedAt);
      const u = toDate(snapshot.updatedDate);
      if (u && u.getTime() > maxUpdated) maxUpdated = u.getTime();
    }

    // ---- pricing-plan orders (full passes only; they are not watermarked) ----
    let planPage: { orders: any[]; truncated: boolean } = { orders: [], truncated: false };
    if (full) {
      planPage = await listWixPlanOrdersForMirror(PLAN_ORDERS_MAX);
      for (const order of planPage.orders) {
        const row = planOrderRowFromWix(order);
        if (!row) continue;
        await upsertPlanOrderRow(
          row,
          matchPlanOrder(
            { contactId: row.contactId, memberId: row.memberId, buyerName: row.buyerName, buyerPhone: row.buyerPhone },
            index,
          ),
          startedAt,
        );
      }
    }

    const truncated = bookingsPage.truncated || planPage.truncated;

    // ---- invalidation: only a complete, non-truncated full scan may tombstone.
    if (full && !truncated) {
      await db.query(
        `update wix_booking_records set invalidated_at=now()
          where last_seen_at is not null and last_seen_at < $1 and invalidated_at is null`,
        [startedAt],
      );
      await db.query(
        `update wix_plan_order_records set invalidated_at=now()
          where last_seen_at is not null and last_seen_at < $1 and invalidated_at is null`,
        [startedAt],
      );
    }
    if (truncated) {
      await db.query(
        `update wix_attendance_sync_state set last_truncated_at=now() where singleton=true`,
      );
      log.warn?.({ bookings: bookingsPage.truncated, plans: planPage.truncated }, "Wix mirror scan truncated; invalidation skipped");
    }

    // ---- attendance marks (full passes) ----
    if (full) {
      try {
        await refreshAttendanceMarks(startedAt);
      } catch (error) {
        log.warn?.({ error }, "Attendance marks refresh failed; booking mirror kept");
      }
    }

    const counts = (
      await db.query(
        `select
           (select count(*) from wix_booking_records where invalidated_at is null) bookings,
           (select count(*) from wix_plan_order_records where invalidated_at is null) plans`,
      )
    ).rows[0];

    const backfillDone = backfillPending && full && !truncated;
    await db.query(
      `update wix_attendance_sync_state set
         last_succeeded_at=now(), last_incremental_at=now(), last_error=null,
         last_updated_date_seen=$1,
         last_full_reconciled_at=case when $2 then now() else last_full_reconciled_at end,
         backfill_completed_at=case when $3 then now() else backfill_completed_at end,
         booking_record_count=$4, plan_order_count=$5,
         record_count=$4
       where singleton=true`,
      [
        maxUpdated ? new Date(maxUpdated) : state.last_updated_date_seen ?? null,
        full && !truncated,
        backfillDone,
        Number(counts?.bookings ?? 0),
        Number(counts?.plans ?? 0),
      ],
    );
    log.info?.(
      { full, bookings: bookingsPage.snapshots.length, plans: planPage.orders.length, truncated },
      "Wix bookings mirror synced",
    );
    return {
      ran: true,
      full,
      bookingCount: Number(counts?.bookings ?? 0),
      planOrderCount: Number(counts?.plans ?? 0),
      truncated,
    };
  } catch (error) {
    await db
      .query(
        `update wix_attendance_sync_state set last_error=$1, last_incremental_error=$1 where singleton=true`,
        [String(error instanceof Error ? error.message : error).slice(0, 500)],
      )
      .catch(() => undefined);
    throw error;
  } finally {
    if (locked) {
      try {
        await db.query(`select pg_advisory_unlock($1)`, [SYNC_LOCK]);
      } catch {
        // session-level lock is released on disconnect as a fallback.
      }
    }
    db.release();
  }
}

// re-export the attendance readers so a caller can pull the marks list too.
export { listWixAttendanceRecords, getWixAttendanceBookingSnapshots };
