import { pool } from "../db/index.js";
import { recordOpsEvent } from "./opsEvents.js";
import { ACCUEIL_CHANNEL } from "./kitchenTicketRules.js";
import {
  cleanFirstName,
  formatShortCode,
  nextFreeSeq,
  type Position,
} from "./serviceSessionRules.js";
import { getArea } from "./serviceAreaRepo.js";

/**
 * SQL for on-site service sessions. A session is a group seated in an area; it
 * carries the short code (unique among OPEN sessions), an optional diagram
 * position, and a first name. INVARIANTS enforced here in SQL:
 *  - the short code is allocated as the smallest free number among open sessions
 *    of that area (reused after a close) — the partial unique index is the race
 *    guard, so open() retries on a 23505;
 *  - close() is atomic and REFUSED while any kitchen ticket of the session is
 *    still open (NEW/PREPARING/READY) — never a silent swallow of a live order.
 * No amount is stored: the POS is the only ledger. Every mutation records an
 * ops_event on the accueil channel so reception phones update live.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The joined shape the board + SSE payloads use (area denormalized in). */
export interface OpenSession {
  id: string;
  area_id: string;
  area_code: string;
  area_name: string;
  short_code: string;
  seq: number;
  diagram_version: number | null;
  pos_x: number | null;
  pos_y: number | null;
  first_name: string | null;
  opened_by: string | null;
  opened_at: Date | string;
}

const SELECT_OPEN = `
  select s.id, s.area_id, a.code as area_code, a.name as area_name, s.short_code,
         s.seq, s.diagram_version, s.pos_x, s.pos_y, s.first_name, s.opened_by, s.opened_at
    from service_sessions s
    join service_areas a on a.id = s.area_id`;

async function emitSession(kind: "session_new" | "session_update", s: OpenSession): Promise<void> {
  await recordOpsEvent(ACCUEIL_CHANNEL, kind, s);
}

export async function listOpenSessions(): Promise<OpenSession[]> {
  const res = await pool.query(`${SELECT_OPEN} where s.status = 'OPEN' order by s.opened_at asc`);
  return res.rows as OpenSession[];
}

export async function getOpenSession(id: string): Promise<OpenSession | null> {
  if (!UUID_RE.test(String(id))) return null;
  const res = await pool.query(`${SELECT_OPEN} where s.id = $1 and s.status = 'OPEN'`, [id]);
  return (res.rows[0] as OpenSession) ?? null;
}

/** Seqs currently taken by open sessions of an area (input to nextFreeSeq). */
async function usedSeqs(areaId: string): Promise<number[]> {
  const res = await pool.query(
    `select seq from service_sessions where area_id = $1 and status = 'OPEN'`,
    [areaId],
  );
  return res.rows.map((r: any) => Number(r.seq));
}

export interface OpenSessionInput {
  areaId: string;
  firstName?: string | null;
  position?: Position | null;
  openedBy?: string | null;
}

/**
 * Open a session in an area. Allocates the smallest free short code among that
 * area's open sessions, freezing the area's current diagram_version. Retries on a
 * unique-code race (two phones opening the same area at once). Returns the joined
 * OpenSession or null if the area is unknown/inactive.
 */
export async function openSession(input: OpenSessionInput): Promise<OpenSession | null> {
  const area = await getArea(input.areaId);
  if (!area || !area.active) return null;
  const firstName = cleanFirstName(input.firstName);
  const pos = input.position ?? null;
  const openedBy = input.openedBy ? String(input.openedBy).slice(0, 60) : null;

  for (let attempt = 0; attempt < 6; attempt++) {
    const seq = nextFreeSeq(await usedSeqs(area.id));
    const shortCode = formatShortCode(area.code, seq);
    try {
      const inserted = await pool.query(
        `insert into service_sessions
           (area_id, short_code, seq, diagram_version, pos_x, pos_y, first_name, opened_by)
         values ($1, $2, $3, $4, $5, $6, $7, $8)
         returning id`,
        [area.id, shortCode, seq, area.diagram_version, pos?.x ?? null, pos?.y ?? null, firstName, openedBy],
      );
      const id = inserted.rows[0].id as string;
      const session = await getOpenSession(id);
      if (session) await emitSession("session_new", session);
      return session;
    } catch (err: any) {
      // 23505 = unique_violation on idx_service_sessions_open_code → retry with a
      // fresh seq (another phone grabbed this code between our read and insert).
      if (err?.code === "23505") continue;
      throw err;
    }
  }
  return null;
}

/** Set/clear the diagram position of an open session. Emits session_update. */
export async function setSessionPosition(id: string, pos: Position | null): Promise<OpenSession | null> {
  if (!UUID_RE.test(String(id))) return null;
  const res = await pool.query(
    `update service_sessions set pos_x = $2, pos_y = $3
      where id = $1 and status = 'OPEN' returning id`,
    [id, pos?.x ?? null, pos?.y ?? null],
  );
  if (!res.rowCount) return null;
  const session = await getOpenSession(id);
  if (session) await emitSession("session_update", session);
  return session;
}

export type CloseResult =
  | { ok: true }
  | { ok: false; reason: "not_open" | "open_tickets" };

/**
 * Close a session — atomic and refused while any of its kitchen tickets is still
 * open. The NOT EXISTS makes the check-and-close one statement (no TOCTOU). On a
 * 0-row result we read the session to return a precise reason. Emits session_closed.
 */
export async function closeSession(id: string, closedBy: string | null): Promise<CloseResult> {
  if (!UUID_RE.test(String(id))) return { ok: false, reason: "not_open" };
  const res = await pool.query(
    `update service_sessions
        set status = 'CLOSED', closed_at = now(), closed_by = $2
      where id = $1 and status = 'OPEN'
        and not exists (
          select 1 from kitchen_tickets k
           where k.session_id = service_sessions.id
             and k.status in ('NEW','PREPARING','READY'))
      returning id`,
    [id, closedBy ? String(closedBy).slice(0, 60) : null],
  );
  if (res.rowCount) {
    await recordOpsEvent(ACCUEIL_CHANNEL, "session_closed", { id });
    return { ok: true };
  }
  // Distinguish "already closed / unknown" from "still has open tickets".
  const still = await pool.query(
    `select 1 from service_sessions where id = $1 and status = 'OPEN'`,
    [id],
  );
  return { ok: false, reason: still.rowCount ? "open_tickets" : "not_open" };
}
