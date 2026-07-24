import type { PoolClient } from "pg";
import { pool } from "../db/index.js";
import type { AdminRole } from "../admin/auth.js";
import type { Client } from "./repo.js";

export const RESOLUTION_OUTCOMES = [
  "resolved",
  "contacted",
  "no_response",
  "not_applicable",
] as const;

export type ResolutionOutcome = (typeof RESOLUTION_OUTCOMES)[number];

export const RESOLUTION_LABELS: Record<ResolutionOutcome, string> = {
  resolved: "Résolu",
  contacted: "Client contacté",
  no_response: "Sans réponse",
  not_applicable: "Non applicable",
};

export function parseResolutionOutcome(value: unknown): ResolutionOutcome | null {
  const raw = String(value ?? "");
  return RESOLUTION_OUTCOMES.includes(raw as ResolutionOutcome)
    ? (raw as ResolutionOutcome)
    : null;
}

export function cleanResolutionNote(value: unknown): string | null {
  const note = String(value ?? "").trim();
  return note ? note.slice(0, 500) : null;
}

export function isHumanTakeoverActive(
  client: Pick<Client, "human_takeover_until">,
  now = Date.now(),
): boolean {
  return Boolean(
    client.human_takeover_until && new Date(client.human_takeover_until).getTime() > now,
  );
}

/**
 * True while Awa has disengaged from a non-serious/suggestive contact and must
 * stay silent. Mirrors isHumanTakeoverActive, but the two are distinct states:
 * takeover = a human is replying; disengaged = nobody replies, Awa stopped.
 */
export function isAwaDisengaged(
  client: Pick<Client, "awa_disengaged_until">,
  now = Date.now(),
): boolean {
  return Boolean(
    client.awa_disengaged_until && new Date(client.awa_disengaged_until).getTime() > now,
  );
}

async function writeAudit(
  db: Pick<PoolClient, "query"> | typeof pool,
  identity: { username: string; role: AdminRole },
  action: string,
  targetType?: string,
  targetId?: string,
  detail: Record<string, unknown> = {},
): Promise<void> {
  await db.query(
    `insert into admin_audit_log
       (admin_user, admin_role, action, target_type, target_id, detail_json)
     values ($1,$2,$3,$4,$5,$6::jsonb)`,
    [identity.username, identity.role, action, targetType ?? null, targetId ?? null, JSON.stringify(detail)],
  );
}

export async function recordAdminAudit(
  identity: { username: string; role: AdminRole },
  action: string,
  targetType?: string,
  targetId?: string,
  detail: Record<string, unknown> = {},
): Promise<void> {
  await writeAudit(pool, identity, action, targetType, targetId, detail);
}

async function resolveFollowUp(
  table: "handoffs" | "conversation_reviews",
  id: string,
  identity: { username: string; role: AdminRole },
  outcome: ResolutionOutcome,
  note: string | null,
): Promise<boolean> {
  const db = await pool.connect();
  try {
    await db.query("begin");
    const updated = await db.query(
      `update ${table}
          set status = 'DONE', done_by = $2, done_at = now(),
              resolution_outcome = $3, resolution_note = $4
        where id = $1 and status = 'OPEN'`,
      [id, identity.username, outcome, note],
    );
    if ((updated.rowCount ?? 0) > 0) {
      await writeAudit(db, identity, "follow_up.resolved", table, id, { outcome, note });
    }
    await db.query("commit");
    return (updated.rowCount ?? 0) > 0;
  } catch (error) {
    await db.query("rollback");
    throw error;
  } finally {
    db.release();
  }
}

export const resolveHandoff = (
  id: string,
  identity: { username: string; role: AdminRole },
  outcome: ResolutionOutcome,
  note: string | null,
) => resolveFollowUp("handoffs", id, identity, outcome, note);

export const resolveReview = (
  id: string,
  identity: { username: string; role: AdminRole },
  outcome: ResolutionOutcome,
  note: string | null,
) => resolveFollowUp("conversation_reviews", id, identity, outcome, note);

export async function startHumanTakeover(
  clientId: string,
  identity: { username: string; role: AdminRole },
  hours = 12,
): Promise<boolean> {
  const db = await pool.connect();
  try {
    await db.query("begin");
    const updated = await db.query(
      `update clients
          set human_takeover_at = now(), human_takeover_by = $2,
              human_takeover_until = now() + ($3 * interval '1 hour'), updated_at = now()
        where id = $1`,
      [clientId, identity.username, hours],
    );
    if ((updated.rowCount ?? 0) > 0) {
      await writeAudit(db, identity, "conversation.takeover_started", "client", clientId, { hours });
    }
    await db.query("commit");
    return (updated.rowCount ?? 0) > 0;
  } catch (error) {
    await db.query("rollback");
    throw error;
  } finally {
    db.release();
  }
}

export async function startAwaDisengage(
  clientId: string,
  identity: { username: string; role: AdminRole },
  hours = 24,
): Promise<boolean> {
  const db = await pool.connect();
  try {
    await db.query("begin");
    const updated = await db.query(
      `update clients
          set awa_disengaged_at = now(),
              awa_disengaged_reason = 'Mis en pause manuellement (contact non sérieux)',
              awa_disengaged_until = now() + ($2 * interval '1 hour'), updated_at = now()
        where id = $1`,
      [clientId, hours],
    );
    if ((updated.rowCount ?? 0) > 0) {
      await writeAudit(db, identity, "conversation.disengaged", "client", clientId, { hours });
    }
    await db.query("commit");
    return (updated.rowCount ?? 0) > 0;
  } catch (error) {
    await db.query("rollback");
    throw error;
  } finally {
    db.release();
  }
}

export async function resumeAwa(
  clientId: string,
  identity: { username: string; role: AdminRole },
): Promise<boolean> {
  const db = await pool.connect();
  try {
    await db.query("begin");
    // One "Rendre à Awa" lifts EITHER pause reason (human takeover or Awa's own
    // disengagement) — clear both so the button always fully re-arms Awa.
    const updated = await db.query(
      `update clients
          set human_takeover_at = null, human_takeover_by = null,
              human_takeover_until = null, awa_disengaged_at = null,
              awa_disengaged_reason = null, awa_disengaged_until = null,
              updated_at = now()
        where id = $1`,
      [clientId],
    );
    if ((updated.rowCount ?? 0) > 0) {
      await writeAudit(db, identity, "conversation.takeover_ended", "client", clientId);
    }
    await db.query("commit");
    return (updated.rowCount ?? 0) > 0;
  } catch (error) {
    await db.query("rollback");
    throw error;
  } finally {
    db.release();
  }
}

export async function lastClientMessageAt(clientId: string): Promise<Date | null> {
  const result = await pool.query(
    `select max(created_at) as at from conversations where client_id = $1 and role = 'user'`,
    [clientId],
  );
  return result.rows[0]?.at ?? null;
}

export function isWithinWhatsAppWindow(lastClientMessage: Date | null, now = Date.now()): boolean {
  return Boolean(lastClientMessage && now - new Date(lastClientMessage).getTime() < 24 * 3_600_000);
}

export interface AdminOutboundMessage {
  id: string;
  request_key: string;
  client_id: string;
  body: string;
  sent_by: string;
  status: "pending" | "sent" | "failed";
  wa_message_id: string | null;
  error: string | null;
  created_at: Date;
  sent_at: Date | null;
}

export async function claimAdminOutbound(args: {
  requestKey: string;
  clientId: string;
  body: string;
  sentBy: string;
}): Promise<AdminOutboundMessage | null> {
  const result = await pool.query(
    `insert into admin_outbound_messages (request_key, client_id, body, sent_by)
     values ($1,$2,$3,$4)
     on conflict (request_key) do nothing
     returning *`,
    [args.requestKey, args.clientId, args.body, args.sentBy],
  );
  return result.rows[0] ?? null;
}

export async function markAdminOutboundSent(id: string, waMessageId: string | null): Promise<void> {
  await pool.query(
    `update admin_outbound_messages
        set status = 'sent', wa_message_id = $2, sent_at = now(), error = null
      where id = $1 and status = 'pending'`,
    [id, waMessageId],
  );
}

export async function markAdminOutboundFailed(id: string, error: unknown): Promise<void> {
  await pool.query(
    `update admin_outbound_messages
        set status = 'failed', error = $2
      where id = $1 and status = 'pending'`,
    [id, String(error).slice(0, 500)],
  );
}

export interface AdminAuditRow {
  id: number;
  admin_user: string;
  admin_role: AdminRole;
  action: string;
  target_type: string | null;
  target_id: string | null;
  detail_json: Record<string, unknown>;
  created_at: Date;
}

export async function listAdminAudit(limit = 100): Promise<AdminAuditRow[]> {
  const result = await pool.query(
    `select * from admin_audit_log order by created_at desc limit $1`,
    [Math.min(Math.max(limit, 1), 250)],
  );
  return result.rows;
}
