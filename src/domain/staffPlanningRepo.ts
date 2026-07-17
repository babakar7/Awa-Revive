import { pool } from "../db/index.js";
import { PLANNING_ROLES, type GridShift } from "./staffPlanningRules.js";

/**
 * SQL for the staff planning. Scenarios (staff_schedules) each hold a full weekly
 * grid of staff_shifts. The "exactly one published" invariant is app-enforced by
 * a single CASE UPDATE (publishSchedule) — no partial unique index (its per-row
 * check can transiently fail mid-update). replaceShifts saves a whole grid as one
 * delete + one multi-VALUES insert (admin is the single writer; house style has
 * no transactions).
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface StaffSchedule {
  id: string;
  name: string;
  status: "draft" | "published";
  created_by: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface StaffShift {
  staff_id: string;
  weekday: number;
  start_min: number;
  end_min: number;
}

export interface PlanningStaff {
  id: string;
  name: string;
  phone: string;
  role: string;
}

// ---------- schedules ----------

export async function listSchedules(): Promise<StaffSchedule[]> {
  const res = await pool.query(
    `select * from staff_schedules order by (status='published') desc, updated_at desc`,
  );
  return res.rows as StaffSchedule[];
}

export async function getSchedule(id: string): Promise<StaffSchedule | null> {
  if (!UUID_RE.test(String(id))) return null;
  const res = await pool.query(`select * from staff_schedules where id=$1`, [id]);
  return (res.rows[0] as StaffSchedule) ?? null;
}

export async function getPublishedSchedule(): Promise<StaffSchedule | null> {
  const res = await pool.query(
    `select * from staff_schedules where status='published' order by updated_at desc limit 1`,
  );
  return (res.rows[0] as StaffSchedule) ?? null;
}

export async function createSchedule(name: string, createdBy: string | null): Promise<StaffSchedule> {
  const res = await pool.query(
    `insert into staff_schedules (name, status, created_by) values ($1, 'draft', $2) returning *`,
    [name, createdBy],
  );
  return res.rows[0] as StaffSchedule;
}

/** New draft copying every shift of a source schedule. */
export async function duplicateSchedule(
  sourceId: string,
  name: string,
  createdBy: string | null,
): Promise<StaffSchedule | null> {
  const source = await getSchedule(sourceId);
  if (!source) return null;
  const created = await createSchedule(name, createdBy);
  await pool.query(
    `insert into staff_shifts (schedule_id, staff_id, weekday, start_min, end_min)
     select $1, staff_id, weekday, start_min, end_min from staff_shifts where schedule_id=$2`,
    [created.id, sourceId],
  );
  return created;
}

export async function renameSchedule(id: string, name: string): Promise<void> {
  await pool.query(`update staff_schedules set name=$2, updated_at=now() where id=$1`, [id, name]);
}

/** Delete a DRAFT only (published is protected). Returns whether a row went. */
export async function deleteSchedule(id: string): Promise<boolean> {
  if (!UUID_RE.test(String(id))) return false;
  const res = await pool.query(`delete from staff_schedules where id=$1 and status='draft'`, [id]);
  return (res.rowCount ?? 0) > 0;
}

/**
 * Publish one schedule and demote every other in ONE statement (atomic, exactly
 * one published). Returns true iff the target ended up published.
 */
export async function publishSchedule(id: string): Promise<boolean> {
  if (!UUID_RE.test(String(id))) return false;
  const res = await pool.query(
    `update staff_schedules
        set status = case when id=$1 then 'published' else 'draft' end, updated_at=now()
      where id=$1 or status='published'
      returning id, status`,
    [id],
  );
  return res.rows.some((r: any) => r.id === id && r.status === "published");
}

// ---------- shifts ----------

export async function getShifts(scheduleId: string): Promise<StaffShift[]> {
  if (!UUID_RE.test(String(scheduleId))) return [];
  const res = await pool.query(
    `select staff_id, weekday, start_min, end_min from staff_shifts where schedule_id=$1`,
    [scheduleId],
  );
  return res.rows as StaffShift[];
}

/** Replace the whole grid of a schedule (delete all + insert the new set). */
export async function replaceShifts(scheduleId: string, shifts: GridShift[]): Promise<void> {
  await pool.query(`delete from staff_shifts where schedule_id=$1`, [scheduleId]);
  if (shifts.length === 0) {
    await pool.query(`update staff_schedules set updated_at=now() where id=$1`, [scheduleId]);
    return;
  }
  const values: string[] = [];
  const params: unknown[] = [scheduleId];
  shifts.forEach((s, i) => {
    const b = i * 4;
    values.push(`($1, $${b + 2}, $${b + 3}, $${b + 4}, $${b + 5})`);
    params.push(s.staff_id, s.weekday, s.start_min, s.end_min);
  });
  await pool.query(
    `insert into staff_shifts (schedule_id, staff_id, weekday, start_min, end_min) values ${values.join(", ")}`,
    params,
  );
  await pool.query(`update staff_schedules set updated_at=now() where id=$1`, [scheduleId]);
}

// ---------- staff ----------

/** Employees that belong to the planning (accueil / bar / entretien). */
export async function listPlanningStaff(): Promise<PlanningStaff[]> {
  const res = await pool.query(
    `select id, name, phone, role from staff_contacts where role = any($1) order by role, name`,
    [PLANNING_ROLES as unknown as string[]],
  );
  return res.rows as PlanningStaff[];
}
