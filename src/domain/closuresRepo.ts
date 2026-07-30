import { pool } from "../db/index.js";

export interface StudioClosure {
  id: string;
  starts_at: Date;
  ends_at: Date;
  reason: string;
  note: string | null;
  enabled: boolean;
  created_by: string | null;
  updated_by: string | null;
  created_at: Date;
  updated_at: Date;
}

/** Enabled closures overlapping [from, to). Used for context + admin listing. */
export async function closuresInWindow(from: Date, to: Date): Promise<StudioClosure[]> {
  const res = await pool.query(
    `select * from studio_closures
      where enabled and starts_at < $2 and ends_at > $1
      order by starts_at asc`,
    [from, to],
  );
  return res.rows;
}

/** All closures (admin listing), newest window first. */
export async function listClosures(includeDisabled = true): Promise<StudioClosure[]> {
  const res = await pool.query(
    `select * from studio_closures ${includeDisabled ? "" : "where enabled"}
      order by starts_at desc`,
  );
  return res.rows;
}

/**
 * Is the instant `at` inside an enabled closure? Half-open [starts_at, ends_at):
 * a class starting exactly at ends_at is NOT closed. Pass a pre-loaded list to
 * avoid a query per slot when filtering availability.
 */
export function isClosedAt(at: Date, closures: StudioClosure[]): StudioClosure | null {
  const t = at.getTime();
  for (const c of closures) {
    if (t >= c.starts_at.getTime() && t < c.ends_at.getTime()) return c;
  }
  return null;
}

/** Single-query variant for the fulfillment/webhook path (one slot). */
export async function closureAt(at: Date): Promise<StudioClosure | null> {
  const res = await pool.query(
    `select * from studio_closures
      where enabled and starts_at <= $1 and ends_at > $1
      order by starts_at asc limit 1`,
    [at],
  );
  return res.rows[0] ?? null;
}

export async function createClosure(args: {
  startsAt: Date;
  endsAt: Date;
  reason: string;
  note?: string | null;
  createdBy?: string | null;
}): Promise<StudioClosure> {
  const res = await pool.query(
    `insert into studio_closures (starts_at, ends_at, reason, note, created_by, updated_by)
     values ($1, $2, $3, $4, $5, $5) returning *`,
    [args.startsAt, args.endsAt, args.reason, args.note ?? null, args.createdBy ?? null],
  );
  return res.rows[0];
}

export async function setClosureEnabled(
  id: string,
  enabled: boolean,
  updatedBy?: string | null,
): Promise<void> {
  await pool.query(
    `update studio_closures set enabled = $2, updated_by = $3, updated_at = now() where id = $1`,
    [id, enabled, updatedBy ?? null],
  );
}
