import { pool } from "../db/index.js";
import {
  getWixAttendanceBookingSnapshots,
  listWixAttendanceRecords,
  type WixAttendanceBookingSnapshot,
} from "../lib/wix.js";

const SYNC_LOCK = 8_337_201;
const STALE_AFTER_MS = 60 * 60 * 1_000;

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
  attended_count: number;
  last_attended_at: Date | null;
  duplicate_profiles: number;
}

export interface AttendanceSession {
  service_name: string;
  session_start: Date | null;
}

export interface AttendanceDetail {
  attended_count: number;
  last_attended_at: Date | null;
  by_service: Array<{ service_name: string; attended_count: number }>;
  sessions: AttendanceSession[];
}

function phoneKey(value: string | null | undefined): string | null {
  const digits = String(value ?? "").replace(/\D/g, "");
  return digits.length >= 8 ? digits : null;
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

/** Full, crash-safe Wix reconciliation. The advisory lock makes it safe on deploy overlap. */
export async function syncAttendanceLeaderboard(force = false): Promise<{
  ran: boolean;
  recordCount: number;
}> {
  const db = await pool.connect();
  try {
    const locked = (await db.query(`select pg_try_advisory_lock($1) as locked`, [SYNC_LOCK])).rows[0]
      ?.locked;
    if (!locked) return { ran: false, recordCount: 0 };
    const current = (await db.query(`select * from wix_attendance_sync_state where singleton=true`)).rows[0] as AttendanceSyncState;
    if (
      !force &&
      current?.last_succeeded_at &&
      Date.now() - new Date(current.last_succeeded_at).getTime() < STALE_AFTER_MS
    ) {
      return { ran: false, recordCount: current.record_count };
    }
    await db.query(
      `update wix_attendance_sync_state set last_started_at=now(), last_error=null where singleton=true`,
    );
    const startedAt = new Date();
    const attendance = await listWixAttendanceRecords();
    const snapshots = await getWixAttendanceBookingSnapshots(
      [...new Set(attendance.map((row) => row.bookingId))],
    );
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
    // Delete only after Wix pagination + booking enrichment completed without error.
    await db.query(`delete from wix_attendance_records where synced_at < $1`, [startedAt]);
    await db.query(
      `update wix_attendance_sync_state
          set last_succeeded_at=now(), last_error=null, record_count=$1
        where singleton=true`,
      [attendance.length],
    );
    return { ran: true, recordCount: attendance.length };
  } catch (error) {
    await db.query(
      `update wix_attendance_sync_state set last_error=$1 where singleton=true`,
      [String(error instanceof Error ? error.message : error).slice(0, 500)],
    );
    throw error;
  } finally {
    try {
      await db.query(`select pg_advisory_unlock($1)`, [SYNC_LOCK]);
    } catch {
      // Connection cleanup releases a session-level advisory lock as a fallback.
    }
    db.release();
  }
}

export async function attendanceSyncState(): Promise<AttendanceSyncState> {
  const row = (await pool.query(`select * from wix_attendance_sync_state where singleton=true`)).rows[0];
  return row as AttendanceSyncState;
}

function attendanceWhere(period: AttendancePeriod, params: unknown[]): string {
  const since = dateForPeriod(period);
  if (!since) return "";
  params.push(since);
  return `and (session_start is null or session_start >= $${params.length})`;
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
    `with attended as (
       select r.*,
         case when coalesce(r.client_phone_key, '') <> '' then 'phone:' || r.client_phone_key
              else 'contact:' || coalesce(r.wix_contact_id, r.attendance_id) end as client_key
       from wix_attendance_records r
       where r.status='ATTENDED'
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
              count(*)::int as attended_count,
              max(session_start) as last_attended_at,
              count(distinct wix_contact_id)::int as duplicate_profiles
         from attended
        group by client_key
     )
     select *, count(*) over()::int as total_count
       from ranked
      order by attended_count desc, last_attended_at desc nulls last, client_name asc
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
    ? `(client_phone_key=$2 or wix_contact_id=$1)`
    : `wix_contact_id=$1`;
  if (key) params.push(key);
  const periodWhere = attendanceWhere(args.period, params);
  const base = `status='ATTENDED' and (session_start is null or session_start <= now()) and ${identity} ${periodWhere}`;
  const [summary, services, sessions] = await Promise.all([
    pool.query(
      `select count(*)::int as attended_count, max(session_start) as last_attended_at
         from wix_attendance_records where ${base}`,
      params,
    ),
    pool.query(
      `select coalesce(service_name, 'Cours') as service_name, count(*)::int as attended_count
         from wix_attendance_records where ${base}
        group by coalesce(service_name, 'Cours') order by attended_count desc, service_name asc`,
      params,
    ),
    pool.query(
      `select coalesce(service_name, 'Cours') as service_name, session_start
         from wix_attendance_records where ${base}
        order by session_start desc nulls last limit 12`,
      params,
    ),
  ]);
  return {
    attended_count: summary.rows[0]?.attended_count ?? 0,
    last_attended_at: summary.rows[0]?.last_attended_at ?? null,
    by_service: services.rows,
    sessions: sessions.rows,
  };
}
