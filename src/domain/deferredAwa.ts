import { pool } from "../db/index.js";

export type DeferredAwaStatus = "pending" | "processing" | "done" | "handled_by_human" | "failed";

export interface DeferredAwaMessage {
  id: string;
  client_id: string;
  wa_message_id: string;
  content: string;
  status: DeferredAwaStatus;
  attempts: number;
  lease_until: Date | null;
  created_at: Date;
}

const LEASE_SECONDS = 120;
const MAX_ATTEMPTS = 3;

/** Idempotently retain an inbound turn while a human owns the conversation. */
export async function deferInboundForAwa(args: {
  clientId: string;
  waMessageId: string;
  content: string;
}): Promise<void> {
  await pool.query(
    `insert into deferred_awa_messages (client_id, wa_message_id, content)
     values ($1,$2,$3)
     on conflict (wa_message_id) do nothing`,
    [args.clientId, args.waMessageId, args.content],
  );
}

/** A successful team message settles every older client message still waiting. */
export async function markDeferredHandledByHuman(clientId: string): Promise<number> {
  const result = await pool.query(
    `update deferred_awa_messages
        set status='handled_by_human', lease_until=null, processed_at=now(), updated_at=now()
      where client_id=$1 and status in ('pending','processing','failed')`,
    [clientId],
  );
  return result.rowCount ?? 0;
}

/** Clear the pause and exclusively lease messages newer than the last team reply. */
export async function resumeAndClaimDeferred(clientId: string): Promise<{
  resumed: boolean;
  messages: DeferredAwaMessage[];
}> {
  const db = await pool.connect();
  try {
    await db.query("begin");
    const client = await db.query(`select id from clients where id=$1 for update`, [clientId]);
    if ((client.rowCount ?? 0) === 0) {
      await db.query("rollback");
      return { resumed: false, messages: [] };
    }
    await db.query(
      `update clients
          set human_takeover_at=null, human_takeover_by=null, human_takeover_until=null,
              awa_disengaged_at=null, awa_disengaged_reason=null, awa_disengaged_until=null,
              awa_disengaged_kind=null, awa_no_intent_streak=0, awa_no_intent_last_at=null,
              updated_at=now()
        where id=$1`,
      [clientId],
    );
    const claimed = await db.query(
      `with last_human as (
         select coalesce(max(sent_at), max(created_at)) as at
           from admin_outbound_messages
          where client_id=$1 and status='sent'
       )
       update deferred_awa_messages d
          set status='processing', attempts=attempts+1,
              lease_until=now() + interval '${LEASE_SECONDS} seconds', updated_at=now()
        where d.client_id=$1
          and d.status in ('pending','failed')
          and d.attempts < ${MAX_ATTEMPTS}
          and d.created_at > coalesce((select at from last_human), '-infinity'::timestamptz)
        returning d.*`,
      [clientId],
    );
    await db.query("commit");
    return { resumed: true, messages: claimed.rows.sort((a, b) => +new Date(a.created_at) - +new Date(b.created_at)) };
  } catch (error) {
    await db.query("rollback");
    throw error;
  } finally {
    db.release();
  }
}

export async function markDeferredDone(id: string): Promise<void> {
  await pool.query(
    `update deferred_awa_messages
        set status='done', lease_until=null, processed_at=now(), updated_at=now(), last_error=null
      where id=$1 and status='processing'`,
    [id],
  );
}

/** A queued human reply may have settled a sweep-claimed batch before it runs. */
export async function deferredBatchStillProcessing(ids: string[]): Promise<boolean> {
  if (ids.length === 0) return false;
  const result = await pool.query(
    `select count(*)::int as count from deferred_awa_messages
      where id = any($1::uuid[]) and status='processing'`,
    [ids],
  );
  return Number(result.rows[0]?.count ?? 0) === ids.length;
}

/** Returns true when the terminal third failure needs a visible technical relay. */
export async function markDeferredFailed(id: string, error: unknown): Promise<boolean> {
  const detail = (error instanceof Error ? error.message : String(error)).replace(/\s+/g, " ").slice(0, 500);
  const result = await pool.query(
    `update deferred_awa_messages
        set status='failed', lease_until=null, last_error=$2, updated_at=now()
      where id=$1 and status='processing'
      returning attempts`,
    [id, detail],
  );
  return Number(result.rows[0]?.attempts ?? 0) >= MAX_ATTEMPTS;
}

/** Claim expired processing leases and retryable failures for the background sweep. */
export async function claimDeferredForSweep(limit = 20): Promise<DeferredAwaMessage[]> {
  const result = await pool.query(
    `with candidates as (
       select d.id from deferred_awa_messages d
       join clients c on c.id=d.client_id
        where d.attempts < ${MAX_ATTEMPTS}
          and (c.human_takeover_until is null or c.human_takeover_until <= now())
          and ((d.status='processing' and d.lease_until < now()) or d.status='failed')
        order by created_at
        for update skip locked
        limit $1
     )
     update deferred_awa_messages d
        set status='processing', attempts=attempts+1,
            lease_until=now() + interval '${LEASE_SECONDS} seconds', updated_at=now()
       from candidates c where d.id=c.id
       returning d.*`,
    [limit],
  );
  return result.rows;
}

/** Make exhausted rows visible to the technical-handoff worker after a crash. */
export async function exhaustedDeferredMessages(limit = 20): Promise<DeferredAwaMessage[]> {
  const result = await pool.query(
    `select d.* from deferred_awa_messages d
      where d.status='processing' and d.attempts >= ${MAX_ATTEMPTS} and d.lease_until < now()
      order by d.created_at limit $1`,
    [limit],
  );
  return result.rows;
}
