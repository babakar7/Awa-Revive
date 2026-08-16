import { pool } from "../db/index.js";
import { canonicalPhoneKey } from "../lib/phoneKey.js";
import {
  getWixAttendanceBookingSnapshots,
  listWixAttendanceRecords,
  type WixAttendanceBookingSnapshot,
} from "../lib/wix.js";
import { syncWixBookings } from "./wixBookingSync.js";

export type AttendancePeriod = "all" | "month" | "30" | "90" | "year";

export interface AttendanceSyncState {
  last_started_at: Date | null;
  last_succeeded_at: Date | null;
  last_error: string | null;
  record_count: number;
}

export interface AttendanceLeader {
  key: string;
  wix_contact_ids: string[];
  client_name: string;
  client_phone: string | null;
  session_count: number;
  marked_attended_count: number;
  last_attended_at: Date | null;
  duplicate_profiles: number;
}

export interface AttendanceSession {
  service_name: string;
  session_start: Date | null;
  marked_attended: boolean;
}

export interface AttendanceDetail {
  session_count: number;
  marked_attended_count: number;
  last_attended_at: Date | null;
  by_service: Array<{ service_name: string; attended_count: number }>;
  sessions: AttendanceSession[];
}

function phoneKey(value: string | null | undefined): string | null {
  return canonicalPhoneKey(value);
}

function dateForPeriod(period: AttendancePeriod): Date | null {
  const now = new Date();
  if (period === "all") return null;
  if (period === "30" || period === "90") {
    return new Date(now.getTime() - Number(period) * 86_400_000);
  }
  if (period === "month") return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  return new Date(Date.UTC(now.getUTCFullYear(), 0, 1));
}

export function parseAttendancePeriod(raw: unknown): AttendancePeriod {
  return raw === "month" || raw === "30" || raw === "90" || raw === "year" ? raw : "all";
}

async function upsertAttendanceRows(
  rows: Array<{
    attendanceId: string;
    bookingId: string;
    eventId: string | null;
    status: string;
    numberOfAttendees: number;
    snapshot?: WixAttendanceBookingSnapshot;
  }>,
): Promise<void> {
  for (const row of rows) {
    const snapshot = row.snapshot;
    const session = snapshot?.sessionStart ? new Date(snapshot.sessionStart) : null;
    await pool.query(
      `insert into wix_attendance_records
        (attendance_id, booking_id, wix_contact_id, client_name, client_phone, client_phone_key,
         service_id, service_name, event_id, session_start, status, number_of_attendees, synced_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,now())
       on conflict (attendance_id) do update set
         booking_id=excluded.booking_id,
         wix_contact_id=coalesce(excluded.wix_contact_id, wix_attendance_records.wix_contact_id),
         client_name=coalesce(excluded.client_name, wix_attendance_records.client_name),
         client_phone=coalesce(excluded.client_phone, wix_attendance_records.client_phone),
         client_phone_key=coalesce(excluded.client_phone_key, wix_attendance_records.client_phone_key),
         service_id=coalesce(excluded.service_id, wix_attendance_records.service_id),
         service_name=coalesce(excluded.service_name, wix_attendance_records.service_name),
         event_id=coalesce(excluded.event_id, wix_attendance_records.event_id),
         session_start=coalesce(excluded.session_start, wix_attendance_records.session_start),
         status=excluded.status,
         number_of_attendees=excluded.number_of_attendees,
         synced_at=now()`,
      [
        row.attendanceId,
        row.bookingId,
        snapshot?.contactId ?? null,
        snapshot?.clientName ?? null,
        snapshot?.clientPhone ?? null,
        phoneKey(snapshot?.clientPhone),
        snapshot?.serviceId ?? null,
        snapshot?.serviceName ?? null,
        row.eventId,
        session && !Number.isNaN(session.getTime()) ? session : null,
        row.status,
        row.numberOfAttendees,
      ],
    );
  }
}

/**
 * Refresh the Wix attendance MARKS (ATTENDED/NOT_ATTENDED) into
 * wix_attendance_records. Full-replace is fine here — the table is small and
 * marks can be corrected in Wix. Called by the general booking sync on full
 * passes; the booking rows themselves live in wix_booking_records now.
 */
export async function refreshAttendanceMarks(startedAt: Date): Promise<void> {
  const attendance = await listWixAttendanceRecords();
  const snapshots = await getWixAttendanceBookingSnapshots([
    ...new Set(attendance.map((row) => row.bookingId)),
  ]);
  const byBooking = new Map(snapshots.map((snapshot) => [snapshot.bookingId, snapshot]));
  await upsertAttendanceRows(
    attendance.map((row) => ({
      attendanceId: row.id,
      bookingId: row.bookingId,
      eventId: row.eventId,
      status: row.status,
      numberOfAttendees: row.numberOfAttendees,
      snapshot: byBooking.get(row.bookingId),
    })),
  );
  await pool.query(`delete from wix_attendance_records where synced_at < $1`, [startedAt]);
}

/**
 * Kept as the stable entry point (boot + 5-min loop + tests) now that it
 * delegates to the general Wix booking/plan-order mirror. Returns the same
 * shape callers expect; recordCount is the live booking count.
 */
export async function syncAttendanceLeaderboard(force = false): Promise<{
  ran: boolean;
  recordCount: number;
}> {
  const result = await syncWixBookings({}, force);
  return { ran: result.ran, recordCount: result.bookingCount };
}

export async function attendanceSyncState(): Promise<AttendanceSyncState> {
  const row = (await pool.query(`select * from wix_attendance_sync_state where singleton=true`)).rows[0];
  return row as AttendanceSyncState;
}

function attendanceWhere(period: AttendancePeriod, params: unknown[]): string {
  const since = dateForPeriod(period);
  if (!since) return "";
  params.push(since);
  return `and (r.session_start is null or r.session_start >= $${params.length})`;
}

export async function attendanceLeaders(args: {
  period: AttendancePeriod;
  page?: number;
  pageSize?: number;
}): Promise<{ rows: AttendanceLeader[]; total: number }> {
  const page = Math.max(1, Math.trunc(args.page ?? 1));
  const pageSize = Math.min(100, Math.max(10, Math.trunc(args.pageSize ?? 50)));
  const params: unknown[] = [];
  const periodWhere = attendanceWhere(args.period, params);
  params.push(pageSize, (page - 1) * pageSize);
  const res = await pool.query(
    `with sessions as (
       select r.*,
         case when a.status='ATTENDED' then 1 else 0 end as marked_attended,
         case when coalesce(r.client_phone_key, '') <> '' then 'phone:' || r.client_phone_key
              else 'contact:' || coalesce(r.wix_contact_id, r.booking_id) end as client_key
       from wix_booking_records r
       left join wix_attendance_records a on a.booking_id=r.booking_id
       where true
         and (r.status is null or r.status = 'CONFIRMED')
         and r.invalidated_at is null
         and (r.session_start is null or r.session_start <= now())
         ${periodWhere}
         and not exists (
           select 1 from clients c
            where c.is_test=true
              and regexp_replace(c.wa_phone, '\\D', '', 'g') = r.client_phone_key
         )
     ), ranked as (
       select client_key as key,
              array_remove(array_agg(distinct wix_contact_id), null) as wix_contact_ids,
              coalesce((array_agg(client_name order by session_start desc nulls last))[1], 'Client Wix') as client_name,
              max(client_phone) as client_phone,
              count(*)::int as session_count,
              sum(marked_attended)::int as marked_attended_count,
              max(session_start) as last_attended_at,
              count(distinct wix_contact_id)::int as duplicate_profiles
         from sessions
        group by client_key
     )
     select *, count(*) over()::int as total_count
       from ranked
      order by session_count desc, last_attended_at desc nulls last, client_name asc
      limit $${params.length - 1} offset $${params.length}`,
    params,
  );
  return {
    rows: res.rows.map(({ total_count: _total, ...row }) => row as AttendanceLeader),
    total: res.rows[0]?.total_count ?? 0,
  };
}

export async function attendanceDetail(args: {
  period: AttendancePeriod;
  wixContactId: string;
  phone: string | null;
}): Promise<AttendanceDetail> {
  const params: unknown[] = [args.wixContactId];
  const key = phoneKey(args.phone);
  const identity = key
    ? `(r.client_phone_key=$2 or r.wix_contact_id=$1)`
    : `r.wix_contact_id=$1`;
  if (key) params.push(key);
  const periodWhere = attendanceWhere(args.period, params);
  const base = `(r.status is null or r.status = 'CONFIRMED') and r.invalidated_at is null
    and (r.session_start is null or r.session_start <= now()) and ${identity} ${periodWhere}`;
  const [summary, services, sessions] = await Promise.all([
    pool.query(
      `select count(*)::int as session_count,
              count(a.attendance_id) filter (where a.status='ATTENDED')::int as marked_attended_count,
              max(r.session_start) as last_attended_at
         from wix_booking_records r
         left join wix_attendance_records a on a.booking_id=r.booking_id
        where ${base}`,
      params,
    ),
    pool.query(
      `select coalesce(r.service_name, 'Cours') as service_name, count(*)::int as attended_count
         from wix_booking_records r
         left join wix_attendance_records a on a.booking_id=r.booking_id
        where ${base}
        group by coalesce(r.service_name, 'Cours') order by attended_count desc, service_name asc`,
      params,
    ),
    pool.query(
      `select coalesce(r.service_name, 'Cours') as service_name, r.session_start,
              (a.status='ATTENDED') as marked_attended
         from wix_booking_records r
         left join wix_attendance_records a on a.booking_id=r.booking_id
        where ${base}
        order by r.session_start desc nulls last limit 12`,
      params,
    ),
  ]);
  return {
    session_count: summary.rows[0]?.session_count ?? 0,
    marked_attended_count: summary.rows[0]?.marked_attended_count ?? 0,
    last_attended_at: summary.rows[0]?.last_attended_at ?? null,
    by_service: services.rows,
    sessions: sessions.rows,
  };
}
