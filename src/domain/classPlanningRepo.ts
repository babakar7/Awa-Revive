import { pool } from "../db/index.js";
import type { GridSlot } from "./classPlanningRules.js";

/**
 * SQL for the class planning sandbox. Mirrors staffPlanningRepo: scenarios
 * (class_plan_schedules) each hold a full weekly grid of class_plan_slots, the
 * "exactly one published" invariant is app-enforced by a single CASE UPDATE, and
 * a whole grid is saved as one delete + one multi-VALUES insert. Difference: the
 * grid is REPLACED inside a transaction — this page is open to the whole team, so
 * a failed or concurrent save must never leave a half-written (empty) grid.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ClassPlanSchedule {
  id: string;
  name: string;
  status: "draft" | "published";
  created_by: string | null;
  created_at: Date;
  updated_at: Date;
}

export type ClassPlanSlot = GridSlot;

// ---------- schedules ----------

export async function listSchedules(): Promise<ClassPlanSchedule[]> {
  const res = await pool.query(
    `select * from class_plan_schedules order by (status='published') desc, updated_at desc`,
  );
  return res.rows as ClassPlanSchedule[];
}

export async function getSchedule(id: string): Promise<ClassPlanSchedule | null> {
  if (!UUID_RE.test(String(id))) return null;
  const res = await pool.query(`select * from class_plan_schedules where id=$1`, [id]);
  return (res.rows[0] as ClassPlanSchedule) ?? null;
}

export async function createSchedule(name: string, createdBy: string | null): Promise<ClassPlanSchedule> {
  const res = await pool.query(
    `insert into class_plan_schedules (name, status, created_by) values ($1, 'draft', $2) returning *`,
    [name, createdBy],
  );
  return res.rows[0] as ClassPlanSchedule;
}

/** New draft copying every slot of a source schedule. */
export async function duplicateSchedule(
  sourceId: string,
  name: string,
  createdBy: string | null,
): Promise<ClassPlanSchedule | null> {
  const source = await getSchedule(sourceId);
  if (!source) return null;
  const created = await createSchedule(name, createdBy);
  await pool.query(
    `insert into class_plan_slots
       (schedule_id, weekday, start_min, duration_min, coach_name, class_name, coach_wix_id, class_wix_id)
     select $1, weekday, start_min, duration_min, coach_name, class_name, coach_wix_id, class_wix_id
       from class_plan_slots where schedule_id=$2`,
    [created.id, sourceId],
  );
  return created;
}

export async function renameSchedule(id: string, name: string): Promise<void> {
  await pool.query(`update class_plan_schedules set name=$2, updated_at=now() where id=$1`, [id, name]);
}

/** Delete a DRAFT only (published is protected). Returns whether a row went. */
export async function deleteSchedule(id: string): Promise<boolean> {
  if (!UUID_RE.test(String(id))) return false;
  const res = await pool.query(`delete from class_plan_schedules where id=$1 and status='draft'`, [id]);
  return (res.rowCount ?? 0) > 0;
}

/**
 * Publish one schedule and demote every other in ONE statement (atomic, exactly
 * one published). Returns true iff the target ended up published.
 */
export async function publishSchedule(id: string): Promise<boolean> {
  if (!UUID_RE.test(String(id))) return false;
  const res = await pool.query(
    `update class_plan_schedules
        set status = case when id=$1 then 'published' else 'draft' end, updated_at=now()
      where id=$1 or status='published'
      returning id, status`,
    [id],
  );
  return res.rows.some((r: any) => r.id === id && r.status === "published");
}

// ---------- slots ----------

export async function getSlots(scheduleId: string): Promise<ClassPlanSlot[]> {
  if (!UUID_RE.test(String(scheduleId))) return [];
  const res = await pool.query(
    `select weekday, start_min, duration_min, coach_name, class_name, coach_wix_id, class_wix_id
       from class_plan_slots where schedule_id=$1 order by weekday, start_min, coach_name`,
    [scheduleId],
  );
  return res.rows as ClassPlanSlot[];
}

/**
 * Replace the whole grid of a schedule (delete all + insert the new set), in a
 * transaction so a concurrent or failed save can't leave the grid empty. Each
 * slot tuple carries the shared schedule_id ($1) + 7 own columns → 8 per row.
 */
export async function replaceSlots(scheduleId: string, slots: GridSlot[]): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query(`delete from class_plan_slots where schedule_id=$1`, [scheduleId]);
    if (slots.length > 0) {
      const values: string[] = [];
      const params: unknown[] = [scheduleId];
      slots.forEach((s, i) => {
        const b = i * 7;
        values.push(`($1, $${b + 2}, $${b + 3}, $${b + 4}, $${b + 5}, $${b + 6}, $${b + 7}, $${b + 8})`);
        params.push(s.weekday, s.start_min, s.duration_min, s.coach_name, s.class_name, s.coach_wix_id, s.class_wix_id);
      });
      await client.query(
        `insert into class_plan_slots
           (schedule_id, weekday, start_min, duration_min, coach_name, class_name, coach_wix_id, class_wix_id)
         values ${values.join(", ")}`,
        params,
      );
    }
    await client.query(`update class_plan_schedules set updated_at=now() where id=$1`, [scheduleId]);
    await client.query("commit");
  } catch (e) {
    await client.query("rollback").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}
