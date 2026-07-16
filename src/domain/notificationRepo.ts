import { pool } from "../db/index.js";
import { normalizeName, type NotificationRule, type SlotWithName } from "./notificationRules.js";

/**
 * DB layer for the staff-notification engine: rule/contact CRUD, the
 * claim-before-send guard (with a 2-min bail so an ops reminder is never lost
 * to a crash), and the notification_log writes. Read-only SQL for the admin
 * page lives in admin/queries.ts; everything that mutates state is here, same
 * split as the rest of the codebase.
 */

export type LogStatus = "claimed" | "sent" | "sent_template" | "failed" | "suppressed";

export interface StaffContact {
  id: string;
  name: string;
  phone: string;
  role: string;
  muted: boolean;
}

const RULE_COLUMNS = `id, label, kind, enabled, class_pattern, exclude_pattern, lead_minutes,
  suppress_gap_minutes, recipient_kind, recipient_phone, days_of_week, send_time,
  message_template, group_only`;

function rowToRule(r: any): NotificationRule {
  return {
    id: r.id,
    label: r.label,
    kind: r.kind,
    enabled: r.enabled,
    class_pattern: r.class_pattern,
    exclude_pattern: r.exclude_pattern,
    lead_minutes: r.lead_minutes,
    suppress_gap_minutes: r.suppress_gap_minutes,
    recipient_kind: r.recipient_kind,
    recipient_phone: r.recipient_phone,
    days_of_week: r.days_of_week,
    send_time: r.send_time,
    message_template: r.message_template,
    group_only: r.group_only,
  };
}

// ---------- rules ----------

export async function listEnabledRules(): Promise<NotificationRule[]> {
  const res = await pool.query(
    `select ${RULE_COLUMNS} from notification_rules where enabled = true order by created_at`,
  );
  return res.rows.map(rowToRule);
}

export interface RuleInput {
  label: string;
  kind: "class_reminder" | "fixed_schedule";
  class_pattern: string | null;
  exclude_pattern: string | null;
  lead_minutes: number | null;
  suppress_gap_minutes: number | null;
  recipient_kind: "phone" | "coach";
  recipient_phone: string | null;
  days_of_week: string | null;
  send_time: string | null;
  message_template: string;
  group_only: boolean;
}

export async function createRule(input: RuleInput): Promise<void> {
  await pool.query(
    `insert into notification_rules
       (label, kind, class_pattern, exclude_pattern, lead_minutes, suppress_gap_minutes,
        recipient_kind, recipient_phone, days_of_week, send_time, message_template, group_only)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [
      input.label,
      input.kind,
      input.class_pattern,
      input.exclude_pattern,
      input.lead_minutes,
      input.suppress_gap_minutes,
      input.recipient_kind,
      input.recipient_phone,
      input.days_of_week,
      input.send_time,
      input.message_template,
      input.group_only,
    ],
  );
}

export async function updateRule(id: string, input: RuleInput): Promise<void> {
  await pool.query(
    `update notification_rules set
       label=$2, kind=$3, class_pattern=$4, exclude_pattern=$5, lead_minutes=$6,
       suppress_gap_minutes=$7, recipient_kind=$8, recipient_phone=$9, days_of_week=$10,
       send_time=$11, message_template=$12, group_only=$13, updated_at=now()
     where id=$1`,
    [
      id,
      input.label,
      input.kind,
      input.class_pattern,
      input.exclude_pattern,
      input.lead_minutes,
      input.suppress_gap_minutes,
      input.recipient_kind,
      input.recipient_phone,
      input.days_of_week,
      input.send_time,
      input.message_template,
      input.group_only,
    ],
  );
}

export async function setRuleEnabled(id: string, enabled: boolean): Promise<void> {
  await pool.query(`update notification_rules set enabled=$2, updated_at=now() where id=$1`, [
    id,
    enabled,
  ]);
}

export async function deleteRule(id: string): Promise<void> {
  await pool.query(`delete from notification_rules where id=$1`, [id]);
}

export async function getRule(id: string): Promise<NotificationRule | null> {
  const res = await pool.query(`select ${RULE_COLUMNS} from notification_rules where id=$1`, [id]);
  return res.rows[0] ? rowToRule(res.rows[0]) : null;
}

// ---------- staff contacts ----------

export async function listStaffContacts(): Promise<StaffContact[]> {
  const res = await pool.query(
    `select id, name, phone, role, muted from staff_contacts order by role, name`,
  );
  return res.rows;
}

/** Digits-only key so "+224 620..." and "224620..." are the same number. */
export function phoneDigits(phone: string): string {
  return phone.replace(/\D/g, "");
}

export async function createContact(input: {
  name: string;
  phone: string;
  role: string;
  muted: boolean;
}): Promise<{ ok: boolean; error?: string }> {
  const digits = phoneDigits(input.phone);
  if (digits.length < 8) return { ok: false, error: "numéro invalide" };
  const existing = await pool.query(`select id, phone from staff_contacts`);
  if (existing.rows.some((r: any) => phoneDigits(r.phone) === digits)) {
    return { ok: false, error: "ce numéro est déjà dans le répertoire" };
  }
  await pool.query(
    `insert into staff_contacts (name, phone, role, muted) values ($1,$2,$3,$4)`,
    [input.name.trim(), input.phone.trim(), input.role.trim() || "staff", input.muted],
  );
  return { ok: true };
}

export async function deleteContact(id: string): Promise<void> {
  await pool.query(`delete from staff_contacts where id=$1`, [id]);
}

export async function setContactMuted(id: string, muted: boolean): Promise<void> {
  await pool.query(`update staff_contacts set muted=$2 where id=$1`, [id, muted]);
}

/** Resolve a coach's contact by name (accent/case/space-insensitive). */
export async function findStaffByName(name: string | null): Promise<StaffContact | null> {
  if (!name) return null;
  const target = normalizeName(name);
  const res = await pool.query(`select id, name, phone, role, muted from staff_contacts`);
  return res.rows.find((r: any) => normalizeName(r.name) === target) ?? null;
}

/** Is this phone number a muted contact? (guardian rules use a raw phone.) */
export async function isMutedPhone(phone: string): Promise<boolean> {
  const digits = phoneDigits(phone);
  const res = await pool.query(`select phone, muted from staff_contacts where muted = true`);
  return res.rows.some((r: any) => phoneDigits(r.phone) === digits);
}

// ---------- claim + log ----------

/**
 * Claim an occurrence for sending. Inserts a `claimed` row keyed by dedup_key;
 * if a row already exists, RECLAIMS it only when it's been stuck in `claimed`
 * for >2 min (a crash between claim and send). Returns true iff this caller now
 * owns the send. A row already `sent`/`failed`/`suppressed` is never reclaimed.
 */
export async function claimOrReclaim(
  dedupKey: string,
  ruleId: string,
  slot: { startDate: string; endDate: string } | null,
): Promise<boolean> {
  const eventStart = slot ? slot.startDate : null;
  const eventEnd = slot ? slot.endDate : null;
  const ins = await pool.query(
    `insert into notification_log (rule_id, source, dedup_key, event_start, event_end, status)
     values ($1, 'rule', $2, $3, $4, 'claimed')
     on conflict (dedup_key) do nothing`,
    [ruleId, dedupKey, eventStart, eventEnd],
  );
  if ((ins.rowCount ?? 0) > 0) return true;

  const reclaim = await pool.query(
    `update notification_log set created_at = now(), status = 'claimed', error = null
      where dedup_key = $1 and status = 'claimed' and created_at < now() - interval '2 minutes'`,
    [dedupKey],
  );
  return (reclaim.rowCount ?? 0) > 0;
}

/** Finalize a claimed row after the send attempt resolves. */
export async function finishLog(
  dedupKey: string,
  status: LogStatus,
  fields: { recipientPhone?: string | null; body?: string | null; error?: string | null },
): Promise<void> {
  await pool.query(
    `update notification_log
        set status = $2, recipient_phone = $3, body = $4, error = $5
      where dedup_key = $1`,
    [dedupKey, status, fields.recipientPhone ?? null, fields.body ?? null, fields.error ?? null],
  );
}

/**
 * Leave a claimed row in `claimed` after a transient send failure so the 2-min
 * bail retries it — but record the error for visibility. Used for non-131047
 * errors (network/5xx); hard failures go through finishLog('failed', …).
 */
export async function markRetryable(dedupKey: string, error: string): Promise<void> {
  await pool.query(`update notification_log set error = $2 where dedup_key = $1`, [dedupKey, error]);
}

/**
 * event_end (ms) of recent sent/suppressed occurrences of a rule — the log
 * fallback that keeps back-to-back suppression working when the Wix window no
 * longer contains the (already-started) preceding session.
 */
export async function recentRuleEventEnds(ruleId: string): Promise<number[]> {
  const res = await pool.query(
    `select event_end from notification_log
      where rule_id = $1 and status in ('sent','sent_template','suppressed')
        and event_end is not null and event_end > now() - interval '6 hours'`,
    [ruleId],
  );
  return res.rows.map((r: any) => new Date(r.event_end).getTime());
}

/**
 * Reception/café notification log entry (source='reception', no dedup key).
 * Best-effort: never throws to the fire-and-forget caller.
 */
export async function recordReceptionLog(
  recipientPhone: string,
  body: string,
  status: LogStatus,
  error: string | null,
): Promise<void> {
  try {
    await pool.query(
      `insert into notification_log (source, recipient_phone, body, status, error)
       values ('reception', $1, $2, $3, $4)`,
      [recipientPhone, body, status, error],
    );
  } catch {
    /* logging must never break a notification */
  }
}

/**
 * Delivery-order notification log entry (source='delivery', no dedup key). Same
 * best-effort contract as recordReceptionLog — never throws. The order is
 * referenced inside `body` (e.g. "[livraison abcd1234] …") so these are
 * auditable in /admin/notifications without a new column on the shared table.
 */
export async function recordDeliveryLog(
  recipientPhone: string,
  body: string,
  status: LogStatus,
  error: string | null,
  waMessageId: string | null = null,
): Promise<void> {
  try {
    await pool.query(
      `insert into notification_log (source, recipient_phone, body, status, error, wa_message_id)
       values ('delivery', $1, $2, $3, $4, $5)`,
      [recipientPhone, body, status, error, waMessageId],
    );
  } catch {
    /* logging must never break a notification */
  }
}

/**
 * The `statuses` webhook saw Meta drop a message it had accepted (200): flip the
 * matching log row from sent/sent_template → failed so the false "sent" doesn't
 * hide a miss. No-op if the wamid isn't one we logged. Never throws.
 */
export async function markLogFailedByWamid(waMessageId: string, error: string): Promise<number> {
  try {
    const res = await pool.query(
      `update notification_log set status = 'failed', error = $2
        where wa_message_id = $1 and status in ('sent','sent_template')`,
      [waMessageId, error.slice(0, 300)],
    );
    return res.rowCount ?? 0;
  } catch {
    return 0;
  }
}

/**
 * Invoice-send log entry (source='invoice', no dedup key). Same best-effort
 * contract as recordDeliveryLog — never throws. The invoice number is inside
 * `body` so these are auditable in /admin/notifications.
 */
export async function recordInvoiceLog(
  recipientPhone: string,
  body: string,
  status: LogStatus,
  error: string | null,
  waMessageId: string | null = null,
): Promise<void> {
  try {
    await pool.query(
      `insert into notification_log (source, recipient_phone, body, status, error, wa_message_id)
       values ('invoice', $1, $2, $3, $4, $5)`,
      [recipientPhone, body, status, error, waMessageId],
    );
  } catch {
    /* logging must never break an invoice send */
  }
}

/** Test-send log entry (source='test', dedup key test:<uuid> — never blocks a real claim). */
export async function recordTestLog(
  recipientPhone: string,
  body: string,
  status: LogStatus,
  error: string | null,
): Promise<void> {
  await pool.query(
    `insert into notification_log (source, dedup_key, recipient_phone, body, status, error)
     values ('test', 'test:' || gen_random_uuid()::text, $1, $2, $3, $4)`,
    [recipientPhone, body, status, error],
  );
}
