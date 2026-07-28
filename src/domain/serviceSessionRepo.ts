import { pool } from "../db/index.js";
import { extrasFromJson, type ExtraLine } from "../lib/cafeMenu.js";
import { recordOpsEvent } from "./opsEvents.js";
import { ACCUEIL_CHANNEL } from "./kitchenTicketRules.js";
import { cleanFirstName } from "./serviceSessionRules.js";
import { getArea } from "./serviceAreaRepo.js";
import { getSpot } from "./serviceSpotRepo.js";

/**
 * SQL for on-site service sessions. A session is a group seated at a FIXED spot
 * (one place per space). INVARIANTS enforced here in SQL:
 *  - at most one OPEN session per spot — the partial unique index is the race
 *    guard, so openSessionAtSpot() returns the existing session on a 23505;
 *  - close() is atomic and REFUSED while any kitchen ticket of the session is
 *    still open (NEW/PREPARING/READY) — never a silent swallow of a live order.
 * The short code IS the spot label; the position IS the spot's. No amount is
 * stored: the POS is the only ledger. Every mutation records an ops_event on the
 * accueil channel so reception phones update live.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The joined shape the board + SSE payloads use (area denormalized in). */
export interface OpenSession {
  id: string;
  area_id: string;
  area_code: string;
  area_name: string;
  spot_id: string | null;
  short_code: string;
  seq: number;
  diagram_version: number | null;
  pos_x: number | null;
  pos_y: number | null;
  first_name: string | null;
  opened_by: string | null;
  opened_at: Date | string;
  /** Indicative running subtotal (sum of the session's non-cancelled TABLE tickets,
   *  served ones included). The POS remains the ledger — this is a service aid. */
  total_xof: number;
}

// sum(integer) is bigint (→ string in pg); cast back to integer. Includes served
// tickets (the client can't recompute them — ticket_removed drops them locally).
const SESSION_TOTAL_SQL = `coalesce((
    select sum(k.amount_xof) from kitchen_tickets k
     where k.session_id = s.id and k.source = 'TABLE' and k.status <> 'CANCELLED'
  ), 0)::integer`;

const SELECT_OPEN = `
  select s.id, s.area_id, a.code as area_code, a.name as area_name, s.spot_id, s.short_code,
         s.seq, s.diagram_version, s.pos_x, s.pos_y, s.first_name, s.opened_by, s.opened_at,
         ${SESSION_TOTAL_SQL} as total_xof
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

export async function getOpenSessionBySpot(spotId: string): Promise<OpenSession | null> {
  if (!UUID_RE.test(String(spotId))) return null;
  const res = await pool.query(
    `${SELECT_OPEN} where s.spot_id = $1 and s.status = 'OPEN'`,
    [spotId],
  );
  return (res.rows[0] as OpenSession) ?? null;
}

/**
 * Re-emit an open session so reception boards refresh its live subtotal after a
 * ticket is added, served, or cancelled (the aggregate isn't in the ticket SSE).
 * No-op if the session is already closed (e.g. auto-closed on the last serve) —
 * `emitSession` is private, so callers go through this. Best-effort by design.
 */
export async function publishOpenSessionUpdate(sessionId: string | null): Promise<void> {
  if (!sessionId) return;
  const session = await getOpenSession(sessionId);
  if (session) await emitSession("session_update", session);
}

/** One served/cancelled line of a recently closed session (recent-history panel). */
export interface RecentSessionTicket {
  id: string;
  status: string;
  items: ExtraLine[];
  note: string | null;
  takeaway: boolean;
  created_at: Date | string;
  ready_at: Date | string | null;
  cancel_reason: string | null;
}
export interface RecentClosedSession {
  id: string;
  short_code: string;
  area_name: string;
  first_name: string | null;
  closed_at: Date | string;
  total_xof: number;
  tickets: RecentSessionTicket[];
}

/**
 * Today's closed sessions (most recent first) with their TABLE tickets and the
 * indicative subtotal — the "addition" a client asks for after their table was
 * auto-freed. READ-ONLY, bounded to the current day and `limit`; a service aid,
 * not reporting (the POS is the ledger). Dakar = UTC+0 so `current_date` is local.
 */
export async function listRecentClosedSessions(limit = 20): Promise<RecentClosedSession[]> {
  const cap = Math.min(50, Math.max(1, Math.floor(limit)));
  const res = await pool.query(
    `select s.id, s.short_code, a.name as area_name, s.first_name, s.closed_at,
            ${SESSION_TOTAL_SQL} as total_xof,
            coalesce((
              select json_agg(json_build_object(
                       'id', k.id, 'status', k.status, 'items', k.items_json,
                       'note', k.note, 'takeaway', k.takeaway, 'created_at', k.created_at,
                       'ready_at', k.ready_at, 'cancel_reason', k.cancel_reason
                     ) order by k.created_at)
                from kitchen_tickets k
               where k.session_id = s.id and k.source = 'TABLE'
            ), '[]'::json) as tickets
       from service_sessions s
       join service_areas a on a.id = s.area_id
      where s.status = 'CLOSED' and s.closed_at::date = current_date
      order by s.closed_at desc
      limit $1`,
    [cap],
  );
  return (res.rows as any[]).map((r) => ({
    id: r.id,
    short_code: r.short_code,
    area_name: r.area_name,
    first_name: r.first_name,
    closed_at: r.closed_at,
    total_xof: Number(r.total_xof ?? 0),
    tickets: (r.tickets as any[]).map((t) => ({
      id: t.id,
      status: t.status,
      items: extrasFromJson(t.items),
      note: t.note,
      takeaway: !!t.takeaway,
      created_at: t.created_at,
      ready_at: t.ready_at,
      cancel_reason: t.cancel_reason,
    })),
  }));
}

/**
 * Open a session at a FIXED spot (the primary flow): tap the real seat → an order
 * can be taken there. The session's short code IS the spot label, its position is
 * the spot's. At most one open session per spot — the partial unique index guards
 * the race; a tap on an already-occupied spot returns the EXISTING session
 * (idempotent, so the UI just opens that spot's order composer). Null if the spot
 * is unknown/inactive.
 */
export async function openSessionAtSpot(input: {
  spotId: string;
  firstName?: string | null;
  openedBy?: string | null;
}): Promise<OpenSession | null> {
  const spot = await getSpot(input.spotId);
  if (!spot || !spot.active) return null;
  const area = await getArea(spot.area_id);
  if (!area) return null;
  const firstName = cleanFirstName(input.firstName);
  const openedBy = input.openedBy ? String(input.openedBy).slice(0, 60) : null;
  try {
    const inserted = await pool.query(
      `insert into service_sessions
         (area_id, spot_id, short_code, seq, diagram_version, pos_x, pos_y, first_name, opened_by)
       values ($1, $2, $3, 0, $4, $5, $6, $7, $8)
       returning id`,
      [area.id, spot.id, spot.label, area.diagram_version, spot.pos_x, spot.pos_y, firstName, openedBy],
    );
    const session = await getOpenSession(inserted.rows[0].id as string);
    if (session) await emitSession("session_new", session);
    return session;
  } catch (err: any) {
    // 23505 = spot already occupied → return the existing open session (a second
    // tap on an occupied seat should land on its order composer, not error).
    if (err?.code === "23505") return getOpenSessionBySpot(spot.id);
    throw err;
  }
}

/**
 * Auto-close any OPEN session left with no open kitchen ticket (served/cancelled
 * all its orders, or an orphan from before auto-clear existed). A grace window
 * (default 30s) protects a session that was just opened whose first ticket is
 * still being inserted in the same request. Emits session_closed per closed row
 * so live boards free the spot. Safe to call on every board load. Returns count.
 */
export async function closeEmptyOpenSessions(graceSeconds = 30): Promise<number> {
  const res = await pool.query(
    `update service_sessions s
        set status = 'CLOSED', closed_at = now(), closed_by = 'auto'
      where s.status = 'OPEN'
        and s.opened_at < now() - make_interval(secs => $1)
        and not exists (
          select 1 from kitchen_tickets k
           where k.session_id = s.id and k.status in ('NEW','PREPARING','READY'))
      returning s.id`,
    [Math.max(0, graceSeconds)],
  );
  for (const row of res.rows as Array<{ id: string }>) {
    await recordOpsEvent(ACCUEIL_CHANNEL, "session_closed", { id: row.id });
  }
  return res.rowCount ?? 0;
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
