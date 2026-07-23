import { pool } from "../db/index.js";
import type { OpsEventKind } from "./kitchenTicketRules.js";

/**
 * Realtime event bus for the ops PWAs. Every event is BOTH appended to the
 * durable `ops_events` log (source of truth for reconnect catch-up via
 * Last-Event-ID) AND handed to the in-process listeners (the live SSE fan-out
 * registers one). The durable log is what makes a dropped SSE connection
 * self-heal: a device replays everything after the last id it saw. Fan-out to a
 * single Railway replica is intentional — see PROGRESS / the ops plan.
 */

export interface OpsEvent {
  id: number;
  channel: string;
  kind: OpsEventKind;
  payload: unknown;
}

type Listener = (event: OpsEvent) => void;
const listeners = new Set<Listener>();

/** Subscribe an in-process listener (the SSE layer). Returns an unsubscribe fn. */
export function onOpsEvent(fn: Listener): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** Append to the durable log, then notify live listeners. Never lets a
 *  subscriber error break the caller (the DB row is already committed). */
export async function recordOpsEvent(
  channel: string,
  kind: OpsEventKind,
  payload: unknown,
): Promise<OpsEvent> {
  const res = await pool.query(
    `insert into ops_events (channel, kind, payload_json) values ($1,$2,$3) returning id`,
    [channel, kind, JSON.stringify(payload ?? {})],
  );
  const event: OpsEvent = { id: Number(res.rows[0].id), channel, kind, payload };
  for (const fn of listeners) {
    try {
      fn(event);
    } catch {
      /* a subscriber must never break the emit */
    }
  }
  return event;
}

/** Replay events a reconnecting device missed (everything after `sinceId`). */
export async function opsEventsSince(
  channel: string,
  sinceId: number,
  limit = 200,
): Promise<OpsEvent[]> {
  const res = await pool.query(
    `select id, kind, payload_json from ops_events
      where channel = $1 and id > $2 order by id asc limit $3`,
    [channel, Number.isFinite(sinceId) ? sinceId : 0, limit],
  );
  return res.rows.map((r: any) => ({
    id: Number(r.id),
    channel,
    kind: r.kind as OpsEventKind,
    payload: r.payload_json,
  }));
}

/** Newest event id on a channel (a fresh device starts its cursor here so it
 *  only receives events from now on, not the whole history). */
export async function latestOpsEventId(channel: string): Promise<number> {
  const res = await pool.query(
    `select coalesce(max(id), 0) as id from ops_events where channel = $1`,
    [channel],
  );
  return Number(res.rows[0]?.id ?? 0);
}
