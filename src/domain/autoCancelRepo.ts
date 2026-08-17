import pg from "pg";
import { config } from "../config.js";
import { pool } from "../db/index.js";
import { phoneDigits } from "./notificationRepo.js";
import { getPublishedSchedule } from "./staffPlanningRepo.js";
import type { AutoCancelRule } from "./autoCancelRules.js";

type PoolClient = pg.PoolClient;

/**
 * DB layer for the empty-class auto-cancellation engine: rule/recipient CRUD,
 * the occurrence ledger (claim / timer reset / cancellation completion), the
 * active-payment lookup that protects a slot mid-checkout, and the shared
 * occurrence-level advisory lock that serializes the final Wix check + mutation
 * against every booking-creation path. Pure decision logic lives in
 * autoCancelRules.ts; delivery reuses notificationRepo (source='auto_cancel').
 */

// ---------- global pause (admin button) ----------

const PAUSED_KEY = "auto_cancel_paused";

export async function isAutoCancelPaused(): Promise<boolean> {
  const res = await pool.query(`select value from app_state where key = $1`, [PAUSED_KEY]);
  return res.rows[0]?.value === "1";
}

export async function setAutoCancelPaused(paused: boolean): Promise<void> {
  await pool.query(
    `insert into app_state (key, value) values ($1, $2)
     on conflict (key) do update set value = excluded.value, updated_at = now()`,
    [PAUSED_KEY, paused ? "1" : "0"],
  );
}

// ---------- rules ----------

export interface AutoCancelRuleRow extends AutoCancelRule {
  owner_contact_id: string | null;
  manager_contact_id: string | null;
  created_at: string;
  updated_at: string;
}

const RULE_COLUMNS = `id, label, enabled, service_id, service_ids, weekdays, start_min_from, start_min_to,
  owner_contact_id, manager_contact_id, alert_opener, created_at, updated_at`;

function rowToRule(r: any): AutoCancelRuleRow {
  // service_ids is the source of truth; fall back to a legacy single service_id.
  const ids: string[] =
    r.service_ids && r.service_ids.length > 0
      ? r.service_ids
      : r.service_id
        ? [r.service_id]
        : [];
  return {
    id: r.id,
    label: r.label,
    enabled: r.enabled,
    service_ids: ids,
    weekdays: (r.weekdays ?? []).map((n: any) => Number(n)),
    start_min_from: r.start_min_from,
    start_min_to: r.start_min_to,
    owner_contact_id: r.owner_contact_id,
    manager_contact_id: r.manager_contact_id,
    alert_opener: r.alert_opener === true,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

export async function listEnabledRules(): Promise<AutoCancelRuleRow[]> {
  const res = await pool.query(
    `select ${RULE_COLUMNS} from auto_cancel_rules where enabled = true order by created_at`,
  );
  return res.rows.map(rowToRule);
}

export async function listAllRules(): Promise<AutoCancelRuleRow[]> {
  const res = await pool.query(`select ${RULE_COLUMNS} from auto_cancel_rules order by created_at`);
  return res.rows.map(rowToRule);
}

export async function getRule(id: string): Promise<AutoCancelRuleRow | null> {
  const res = await pool.query(`select ${RULE_COLUMNS} from auto_cancel_rules where id = $1`, [id]);
  return res.rows[0] ? rowToRule(res.rows[0]) : null;
}

export interface RuleInput {
  label: string;
  service_ids: string[];
  weekdays: number[];
  start_min_from: number | null;
  start_min_to: number | null;
  owner_contact_id: string | null;
  manager_contact_id: string | null;
  alert_opener: boolean;
  enabled: boolean;
}

export async function createRule(input: RuleInput): Promise<void> {
  // service_id (legacy single) is left null; service_ids is authoritative.
  await pool.query(
    `insert into auto_cancel_rules
       (label, enabled, service_ids, weekdays, start_min_from, start_min_to,
        owner_contact_id, manager_contact_id, alert_opener)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [
      input.label,
      input.enabled,
      input.service_ids,
      input.weekdays,
      input.start_min_from,
      input.start_min_to,
      input.owner_contact_id,
      input.manager_contact_id,
      input.alert_opener,
    ],
  );
}

export async function updateRule(id: string, input: RuleInput): Promise<void> {
  // Saving from the UI migrates onto service_ids and clears the legacy single id.
  await pool.query(
    `update auto_cancel_rules set
       label=$2, enabled=$3, service_ids=$4, service_id=null, weekdays=$5, start_min_from=$6,
       start_min_to=$7, owner_contact_id=$8, manager_contact_id=$9, alert_opener=$10, updated_at=now()
     where id=$1`,
    [
      id,
      input.label,
      input.enabled,
      input.service_ids,
      input.weekdays,
      input.start_min_from,
      input.start_min_to,
      input.owner_contact_id,
      input.manager_contact_id,
      input.alert_opener,
    ],
  );
}

export async function setRuleEnabled(id: string, enabled: boolean): Promise<void> {
  await pool.query(`update auto_cancel_rules set enabled=$2, updated_at=now() where id=$1`, [
    id,
    enabled,
  ]);
}

export async function deleteRule(id: string): Promise<void> {
  await pool.query(`delete from auto_cancel_rules where id=$1`, [id]);
}

// ---------- recipient resolution ----------

export interface FixedContact {
  id: string;
  name: string;
  phone: string;
  muted: boolean;
}

/**
 * The « owner » recipient is always the studio owner (config.OWNER_PHONE) — never
 * a per-rule choice (Babakar: "le owner c'est moi par défaut"). Null only if
 * OWNER_PHONE is somehow unset/invalid.
 */
export function ownerRecipient(): { name: string; phone: string } | null {
  const phone = config.OWNER_PHONE;
  if (!phone || phoneDigits(phone).length < 8) return null;
  return { name: "Propriétaire", phone };
}

/** The rule's manager contact (the one fixed recipient still chosen per rule). */
export async function managerContactForRule(rule: AutoCancelRuleRow): Promise<FixedContact | null> {
  if (!rule.manager_contact_id) return null;
  const res = await pool.query(
    `select id, name, phone, muted from staff_contacts where id = $1`,
    [rule.manager_contact_id],
  );
  return (res.rows[0] as FixedContact) ?? null;
}

/**
 * The day's OPENER, resolved from the published staff planning: the « accueil »
 * employee whose shift starts earliest on `planningWeekday` (0=Monday…6=Sunday,
 * the staff_shifts convention). This is the person who comes to open the studio.
 * Null when no schedule is published, nobody at accueil that day, the opener is
 * muted, or has no valid phone. Used only for morning cancellations.
 */
export async function openerForWeekday(
  planningWeekday: number,
): Promise<{ name: string; phone: string } | null> {
  const published = await getPublishedSchedule();
  if (!published) return null;
  const res = await pool.query(
    `select c.name, c.phone
       from staff_shifts s
       join staff_contacts c on c.id = s.staff_id
      where s.schedule_id = $1 and s.weekday = $2
        and c.role = 'accueil' and c.muted = false
      order by s.start_min asc
      limit 1`,
    [published.id, planningWeekday],
  );
  const row = res.rows[0];
  if (!row || phoneDigits(row.phone).length < 8) return null;
  return { name: row.name, phone: row.phone };
}

/**
 * Activation gate (also used by the admin page to show a visible error rather
 * than a silent no-op). Recipients = the dynamic class coach (resolved live at
 * cancellation time) + the owner (config.OWNER_PHONE, implicit) + the rule's
 * manager, which must be active (unmuted), have a valid phone, and differ from
 * the owner's number.
 */
export async function ruleActivationError(rule: AutoCancelRuleRow): Promise<string | null> {
  if (rule.service_ids.length === 0) return "aucun cours sélectionné";
  const owner = ownerRecipient();
  if (!owner) return "numéro propriétaire non configuré (OWNER_PHONE)";
  if (!rule.manager_contact_id) return "choisis un manager (2ᵉ destinataire)";
  const manager = await managerContactForRule(rule);
  if (!manager) return "manager introuvable";
  if (manager.muted) return `manager en muet (${manager.name})`;
  if (phoneDigits(manager.phone).length < 8) return `numéro manager invalide (${manager.name})`;
  if (phoneDigits(manager.phone) === phoneDigits(owner.phone)) {
    return "le manager doit être différent de toi (propriétaire)";
  }
  return null;
}

// ---------- active-payment protection ----------

/**
 * Is an unexpired local payment attempt (Wave/OM link still live) holding this
 * availability session? A pending checkout must protect the slot from
 * auto-cancellation. Checks both class bookings and plan orders — both store
 * the availability session id in `event_id`.
 */
export async function hasActivePaymentForSession(sessionId: string): Promise<boolean> {
  const res = await pool.query(
    `select 1
       from pending_bookings
      where event_id = $1 and status = 'AWAITING_PAYMENT'
        and (link_expires_at is null or link_expires_at > now())
      union all
     select 1
       from pending_plan_orders
      where event_id = $1 and status = 'AWAITING_PAYMENT'
        and (link_expires_at is null or link_expires_at > now())
      limit 1`,
    [sessionId],
  );
  return (res.rowCount ?? 0) > 0;
}

// ---------- ledger ----------

export type LedgerState = "OBSERVING" | "CANCELLING" | "CANCELLED" | "FAILED";

export interface LedgerRow {
  event_id: string;
  session_id: string;
  rule_id: string | null;
  service_id: string | null;
  start_at: string | null;
  first_empty_at: string | null;
  last_observed_at: string | null;
  /** Sticky: when a participant/active payment was last seen (null = never). */
  last_protected_at: string | null;
  state: LedgerState;
  cancelled_at: string | null;
  error: string | null;
}

export async function getLedger(eventId: string): Promise<LedgerRow | null> {
  const res = await pool.query(`select * from auto_cancel_ledger where event_id = $1`, [eventId]);
  return (res.rows[0] as LedgerRow) ?? null;
}

/**
 * Ledger row for a booking-path guard, looked up by the availability session id.
 * Prefers a terminal/in-progress cancellation over a plain OBSERVING row so the
 * guard rejects as soon as a cancel is under way.
 */
export async function getLedgerBySession(sessionId: string): Promise<LedgerRow | null> {
  const res = await pool.query(
    `select * from auto_cancel_ledger where session_id = $1
      order by case state when 'CANCELLED' then 0 when 'CANCELLING' then 1
                          when 'FAILED' then 2 else 3 end
      limit 1`,
    [sessionId],
  );
  return (res.rows[0] as LedgerRow) ?? null;
}

/**
 * Record an observation and the (already-computed) empty-timer start. Only ever
 * touches an OBSERVING row (never overwrites a CANCELLING/CANCELLED/FAILED
 * decision). `firstEmptyAt` null clears the timer (occurrence not empty now).
 */
export async function recordObservation(args: {
  eventId: string;
  sessionId: string;
  ruleId: string | null;
  serviceId: string | null;
  startAt: string;
  firstEmptyAt: Date | null;
  now: Date;
  /** True when this observation saw a participant OR an active local payment.
   *  Sets the sticky last_protected_at, which is NEVER cleared afterwards. */
  protectedNow?: boolean;
}): Promise<void> {
  // last_protected_at is sticky: coalesce($8, existing) writes it the first
  // (and every) time a protection is seen, and keeps it forever otherwise.
  const protectedAt = args.protectedNow ? args.now.toISOString() : null;
  await pool.query(
    `insert into auto_cancel_ledger
       (event_id, session_id, rule_id, service_id, start_at, first_empty_at, last_observed_at, last_protected_at, state)
     values ($1,$2,$3,$4,$5,$6,$7,$8,'OBSERVING')
     on conflict (event_id) do update set
       session_id = excluded.session_id,
       rule_id = excluded.rule_id,
       service_id = excluded.service_id,
       start_at = excluded.start_at,
       first_empty_at = excluded.first_empty_at,
       last_observed_at = excluded.last_observed_at,
       last_protected_at = coalesce($8, auto_cancel_ledger.last_protected_at),
       updated_at = now()
     where auto_cancel_ledger.state = 'OBSERVING'`,
    [
      args.eventId,
      args.sessionId,
      args.ruleId,
      args.serviceId,
      args.startAt,
      args.firstEmptyAt ? args.firstEmptyAt.toISOString() : null,
      args.now.toISOString(),
      protectedAt,
    ],
  );
}

export async function markFailed(eventId: string, error: string): Promise<void> {
  await pool.query(
    `update auto_cancel_ledger set state='FAILED', error=$2, updated_at=now() where event_id=$1`,
    [eventId, error.slice(0, 500)],
  );
}

/**
 * CANCELLING rows stuck for longer than `olderThanMs` (a crash/deploy between
 * marking CANCELLING and confirming CANCELLED — every push redeploys). The
 * recovery pass re-checks Wix for each and finalizes or reverts to OBSERVING.
 */
export async function staleCancellingRows(olderThanMs: number): Promise<LedgerRow[]> {
  const res = await pool.query(
    `select * from auto_cancel_ledger
      where state = 'CANCELLING' and updated_at < now() - ($1 || ' milliseconds')::interval`,
    [String(olderThanMs)],
  );
  return res.rows as LedgerRow[];
}

/** Revert a stuck CANCELLING row to OBSERVING with a fresh (restarted) timer. */
export async function revertToObserving(eventId: string, now: Date): Promise<void> {
  await pool.query(
    `update auto_cancel_ledger
        set state='OBSERVING', first_empty_at=null, last_observed_at=$2, updated_at=now()
      where event_id=$1 and state='CANCELLING'`,
    [eventId, now.toISOString()],
  );
}

/** Finalize an occurrence to CANCELLED (non-transactional; the recovery pass and
 *  phase B both use it once Wix has confirmed the cancellation). */
export async function markCancelledByEvent(eventId: string): Promise<void> {
  await pool.query(
    `update auto_cancel_ledger set state='CANCELLED', cancelled_at=now(), error=null, updated_at=now()
      where event_id=$1`,
    [eventId],
  );
}

// ---------- shared occurrence lock (serialize cancel vs booking) ----------

function lockKey(sessionId: string): string {
  return `auto-cancel-occ:${sessionId}`;
}

/**
 * Run `fn` while holding the occurrence's advisory lock, keyed by the
 * availability session id (the id every booking path already has in hand). Uses
 * the transaction-scoped form — no session-level lock leak on the pooled
 * connection. `mode:"try"` returns { acquired:false } immediately when another
 * holder has it (the cancel engine skips that occurrence this tick); the default
 * blocks until the lock is free (booking paths, near-zero contention).
 *
 * IMPORTANT: `fn` runs inside a DB transaction that is committed on success and
 * rolled back on throw. Keep it to the final Wix check + mutation; the lock (and
 * the pooled connection) is held across those HTTP calls, so nothing heavier
 * belongs here.
 */
export async function withOccurrenceLock<T>(
  sessionId: string,
  fn: (client: PoolClient) => Promise<T>,
  mode: "try" | "wait" = "wait",
): Promise<{ acquired: true; value: T } | { acquired: false }> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    if (mode === "try") {
      const res = await client.query(`select pg_try_advisory_xact_lock(hashtext($1)) as locked`, [
        lockKey(sessionId),
      ]);
      if (!res.rows[0]?.locked) {
        await client.query("rollback");
        return { acquired: false };
      }
    } else {
      await client.query(`select pg_advisory_xact_lock(hashtext($1))`, [lockKey(sessionId)]);
    }
    const value = await fn(client);
    await client.query("commit");
    return { acquired: true, value };
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/** Read a ledger row on a specific (locked) transaction client. */
export async function getLedgerBySessionTx(
  client: PoolClient,
  sessionId: string,
): Promise<LedgerRow | null> {
  const res = await client.query(
    `select * from auto_cancel_ledger where session_id = $1
      order by case state when 'CANCELLED' then 0 when 'CANCELLING' then 1
                          when 'FAILED' then 2 else 3 end
      limit 1`,
    [sessionId],
  );
  return (res.rows[0] as LedgerRow) ?? null;
}

export async function getLedgerTx(client: PoolClient, eventId: string): Promise<LedgerRow | null> {
  const res = await client.query(`select * from auto_cancel_ledger where event_id = $1`, [eventId]);
  return (res.rows[0] as LedgerRow) ?? null;
}

export async function markCancellingTx(client: PoolClient, eventId: string): Promise<void> {
  await client.query(
    `update auto_cancel_ledger set state='CANCELLING', updated_at=now() where event_id=$1`,
    [eventId],
  );
}

export async function markCancelledTx(client: PoolClient, eventId: string): Promise<void> {
  await client.query(
    `update auto_cancel_ledger set state='CANCELLED', cancelled_at=now(), error=null, updated_at=now()
      where event_id=$1`,
    [eventId],
  );
}

/** Drop every cached slot row for an auto-cancelled availability session, so no
 *  client can resolve it after the fact (belt-and-suspenders with the exclusion
 *  in getCachedSlot). */
export async function purgeSlotCacheForSession(sessionId: string): Promise<void> {
  await pool.query(`delete from slot_cache where event_id = $1`, [sessionId]);
}

// ---------- admin journal ----------

export interface LedgerJournalRow extends LedgerRow {
  updated_at: string;
}

/** Recent ledger rows for the admin page (most recent activity first). */
export async function recentLedger(limit = 30): Promise<LedgerJournalRow[]> {
  const res = await pool.query(
    `select *, updated_at from auto_cancel_ledger
      order by coalesce(cancelled_at, updated_at) desc limit $1`,
    [limit],
  );
  return res.rows as LedgerJournalRow[];
}
