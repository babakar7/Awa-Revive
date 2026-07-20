import type { PoolClient } from "pg";
import { pool } from "../db/index.js";
import {
  computePaymentTotals,
  monthBounds,
  monthIsClosed,
  storedMonthKey,
  tariffFromJson,
  tariffFromProfile,
  type CoachTariff,
  type EligibleCourse,
} from "./coachPaymentRules.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class CoachPaymentError extends Error {}

export interface CoachPaymentProfile {
  id: string;
  slug: string;
  display_name: string;
  wix_resource_id: string | null;
  email: string | null;
  formula_type: "monthly_ratio" | "per_session";
  base_amount_xof: number | null;
  base_session_count: number | null;
  per_session_xof: number | null;
  enabled: boolean;
  created_at: Date;
  updated_at: Date;
}

export interface CoachPaymentStatement {
  id: string;
  coach_profile_id: string;
  month: string | Date;
  version: number;
  revises_statement_id: string | null;
  is_current: boolean;
  status: "draft" | "validated" | "paid";
  coach_name_snapshot: string;
  coach_email_snapshot: string | null;
  wix_resource_id_snapshot: string | null;
  tariff_json: unknown;
  sync_status: "pending" | "ok" | "failed" | "unlinked";
  sync_error: string | null;
  synced_at: Date | null;
  course_count: number;
  base_total_xof: number;
  adjustment_total_xof: number;
  total_xof: number;
  validated_at: Date | null;
  validated_by: string | null;
  paid_at: Date | null;
  paid_by: string | null;
  created_by: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface CoachPaymentCourse {
  id: string;
  statement_id: string;
  source: "wix" | "manual";
  wix_event_id: string | null;
  service_id: string | null;
  service_name: string;
  starts_at: Date;
  ends_at: Date | null;
  coach_resource_id: string | null;
  coach_name: string | null;
  included: boolean;
  manual_reason: string | null;
  raw_snapshot: unknown;
  created_at: Date;
}

export interface CoachPaymentAdjustment {
  id: string;
  statement_id: string;
  kind: "bonus" | "deduction";
  amount_xof: number;
  reason: string;
  created_at: Date;
}

export interface CoachPaymentSendLog {
  id: string;
  statement_id: string;
  recipient_email: string;
  status: "success" | "error";
  error: string | null;
  sent_by: string | null;
  attempted_at: Date;
}

export interface StatementDetail {
  statement: CoachPaymentStatement;
  profile: CoachPaymentProfile;
  courses: CoachPaymentCourse[];
  adjustments: CoachPaymentAdjustment[];
  sends: CoachPaymentSendLog[];
  versions: CoachPaymentStatement[];
}

function validUuid(id: string): boolean {
  return UUID_RE.test(String(id));
}

export async function listProfiles(): Promise<CoachPaymentProfile[]> {
  const result = await pool.query(
    `select * from coach_payment_profiles where enabled order by display_name`,
  );
  return result.rows as CoachPaymentProfile[];
}

export async function findProfile(id: string): Promise<CoachPaymentProfile | null> {
  if (!validUuid(id)) return null;
  const result = await pool.query(`select * from coach_payment_profiles where id=$1`, [id]);
  return (result.rows[0] as CoachPaymentProfile) ?? null;
}

export async function updateProfile(
  id: string,
  input: {
    displayName: string;
    wixResourceId: string | null;
    email: string | null;
    tariff: CoachTariff;
  },
): Promise<CoachPaymentProfile | null> {
  if (!validUuid(id)) return null;
  const tariff = input.tariff;
  const result = await pool.query(
    `update coach_payment_profiles
        set display_name=$2, wix_resource_id=$3, email=$4,
            formula_type=$5, base_amount_xof=$6, base_session_count=$7,
            per_session_xof=$8, updated_at=now()
      where id=$1 returning *`,
    [
      id,
      input.displayName,
      input.wixResourceId,
      input.email,
      tariff.type,
      tariff.type === "monthly_ratio" ? tariff.baseAmountXof : null,
      tariff.type === "monthly_ratio" ? tariff.baseSessionCount : null,
      tariff.type === "per_session" ? tariff.perSessionXof : null,
    ],
  );
  return (result.rows[0] as CoachPaymentProfile) ?? null;
}

export async function rememberProfileEmail(profileId: string, email: string): Promise<void> {
  await pool.query(
    `update coach_payment_profiles set email=$2, updated_at=now() where id=$1`,
    [profileId, email],
  );
}

export async function listCurrentStatements(month: string): Promise<CoachPaymentStatement[]> {
  const result = await pool.query(
    `select * from coach_payment_statements where month=$1 and is_current order by coach_name_snapshot`,
    [`${month}-01`],
  );
  return result.rows as CoachPaymentStatement[];
}

export async function findCurrentStatement(
  profileId: string,
  month: string,
): Promise<CoachPaymentStatement | null> {
  if (!validUuid(profileId)) return null;
  const result = await pool.query(
    `select * from coach_payment_statements
      where coach_profile_id=$1 and month=$2 and is_current limit 1`,
    [profileId, `${month}-01`],
  );
  return (result.rows[0] as CoachPaymentStatement) ?? null;
}

async function recalculate(client: PoolClient, statementId: string): Promise<CoachPaymentStatement> {
  const locked = await client.query(
    `select * from coach_payment_statements where id=$1 for update`,
    [statementId],
  );
  const statement = locked.rows[0] as CoachPaymentStatement | undefined;
  if (!statement) throw new CoachPaymentError("État introuvable");
  if (statement.status !== "draft") throw new CoachPaymentError("Un état validé est immuable");
  const [courseResult, adjustmentResult] = await Promise.all([
    client.query(
      `select count(*)::int as count from coach_payment_courses where statement_id=$1 and included`,
      [statementId],
    ),
    client.query(
      `select kind, amount_xof from coach_payment_adjustments where statement_id=$1`,
      [statementId],
    ),
  ]);
  const totals = computePaymentTotals(
    Number(courseResult.rows[0].count),
    tariffFromJson(statement.tariff_json),
    adjustmentResult.rows,
  );
  const updated = await client.query(
    `update coach_payment_statements
        set course_count=$2, base_total_xof=$3, adjustment_total_xof=$4,
            total_xof=$5, updated_at=now()
      where id=$1 returning *`,
    [
      statementId,
      totals.courseCount,
      totals.baseTotalXof,
      totals.adjustmentTotalXof,
      totals.totalXof,
    ],
  );
  return updated.rows[0] as CoachPaymentStatement;
}

async function transaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const value = await fn(client);
    await client.query("commit");
    return value;
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

async function insertCourses(
  client: PoolClient,
  statementId: string,
  courses: EligibleCourse[],
  includedByEvent = new Map<string, boolean>(),
): Promise<void> {
  for (const course of courses) {
    await client.query(
      `insert into coach_payment_courses
        (statement_id, source, wix_event_id, service_id, service_name, starts_at,
         ends_at, coach_resource_id, coach_name, included, raw_snapshot)
       values ($1,'wix',$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        statementId,
        course.wixEventId,
        course.serviceId,
        course.serviceName,
        course.startsAt,
        course.endsAt,
        course.coachResourceId,
        course.coachName,
        includedByEvent.get(course.wixEventId) ?? true,
        JSON.stringify(course.raw),
      ],
    );
  }
}

export async function createDraft(input: {
  profile: CoachPaymentProfile;
  month: string;
  courses: EligibleCourse[];
  syncStatus: "ok" | "failed" | "unlinked";
  syncError?: string | null;
  createdBy: string | null;
}): Promise<CoachPaymentStatement> {
  return transaction(async (client) => {
    // Lock the logical coach/month key even when no row exists yet. This turns
    // concurrent double-clicks into one draft instead of one 500 unique error.
    await client.query(`select pg_advisory_xact_lock(hashtext($1))`, [
      `coach-payment:${input.profile.id}:${input.month}`,
    ]);
    const existing = await client.query(
      `select * from coach_payment_statements
        where coach_profile_id=$1 and month=$2 and is_current for update`,
      [input.profile.id, `${input.month}-01`],
    );
    if (existing.rows[0]) return existing.rows[0] as CoachPaymentStatement;
    const versionResult = await client.query(
      `select coalesce(max(version),0)::int + 1 as version
         from coach_payment_statements where coach_profile_id=$1 and month=$2`,
      [input.profile.id, `${input.month}-01`],
    );
    const tariff = tariffFromProfile(input.profile);
    const inserted = await client.query(
      `insert into coach_payment_statements
        (coach_profile_id, month, version, coach_name_snapshot, coach_email_snapshot,
         wix_resource_id_snapshot, tariff_json, sync_status, sync_error, synced_at, created_by)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,case when $8='ok' then now() else null end,$10)
       returning *`,
      [
        input.profile.id,
        `${input.month}-01`,
        Number(versionResult.rows[0].version),
        input.profile.display_name,
        input.profile.email,
        input.profile.wix_resource_id,
        JSON.stringify(tariff),
        input.syncStatus,
        input.syncError ?? null,
        input.createdBy,
      ],
    );
    const statement = inserted.rows[0] as CoachPaymentStatement;
    await insertCourses(client, statement.id, input.courses);
    return recalculate(client, statement.id);
  });
}

/** Refresh editable identity/resource fields from the current profile before a
 * Wix sync. Once validated this is refused, preserving the document snapshot. */
export async function refreshDraftProfileSnapshot(
  statementId: string,
  profile: CoachPaymentProfile,
): Promise<boolean> {
  if (!validUuid(statementId)) return false;
  const result = await pool.query(
    `update coach_payment_statements
        set coach_name_snapshot=$2, coach_email_snapshot=$3,
            wix_resource_id_snapshot=$4,
            sync_status=case when $4::text is null then 'unlinked' else 'pending' end,
            sync_error=case when $4::text is null then 'Aucune ressource Wix associée à cette coach' else null end,
            updated_at=now()
      where id=$1 and status='draft' returning id`,
    [statementId, profile.display_name, profile.email, profile.wix_resource_id],
  );
  return Boolean(result.rowCount);
}

export async function replaceWixSnapshot(
  statementId: string,
  courses: EligibleCourse[],
): Promise<CoachPaymentStatement> {
  if (!validUuid(statementId)) throw new CoachPaymentError("État introuvable");
  return transaction(async (client) => {
    const statementResult = await client.query(
      `select * from coach_payment_statements where id=$1 for update`,
      [statementId],
    );
    const statement = statementResult.rows[0] as CoachPaymentStatement | undefined;
    if (!statement) throw new CoachPaymentError("État introuvable");
    if (statement.status !== "draft") throw new CoachPaymentError("Un état validé est immuable");
    const old = await client.query(
      `select wix_event_id, included from coach_payment_courses
        where statement_id=$1 and source='wix'`,
      [statementId],
    );
    const included = new Map<string, boolean>(
      old.rows.filter((r) => r.wix_event_id).map((r) => [String(r.wix_event_id), Boolean(r.included)]),
    );
    await client.query(
      `delete from coach_payment_courses where statement_id=$1 and source='wix'`,
      [statementId],
    );
    await insertCourses(client, statementId, courses, included);
    await client.query(
      `update coach_payment_statements
          set sync_status='ok', sync_error=null, synced_at=now(), updated_at=now()
        where id=$1`,
      [statementId],
    );
    return recalculate(client, statementId);
  });
}

export async function recordSyncFailure(statementId: string, error: string): Promise<void> {
  if (!validUuid(statementId)) return;
  await pool.query(
    `update coach_payment_statements
        set sync_status='failed', sync_error=$2, updated_at=now()
      where id=$1 and status='draft'`,
    [statementId, error.slice(0, 500)],
  );
}

export async function getStatementDetail(id: string): Promise<StatementDetail | null> {
  if (!validUuid(id)) return null;
  const statementResult = await pool.query(
    `select * from coach_payment_statements where id=$1`,
    [id],
  );
  const statement = statementResult.rows[0] as CoachPaymentStatement | undefined;
  if (!statement) return null;
  const [profile, courses, adjustments, sends, versions] = await Promise.all([
    pool.query(`select * from coach_payment_profiles where id=$1`, [statement.coach_profile_id]),
    pool.query(
      `select * from coach_payment_courses where statement_id=$1 order by starts_at, created_at`,
      [id],
    ),
    pool.query(
      `select * from coach_payment_adjustments where statement_id=$1 order by created_at`,
      [id],
    ),
    pool.query(
      `select * from coach_payment_send_log where statement_id=$1 order by attempted_at desc`,
      [id],
    ),
    pool.query(
      `select * from coach_payment_statements
        where coach_profile_id=$1 and month=$2 order by version desc`,
      [statement.coach_profile_id, statement.month],
    ),
  ]);
  return {
    statement,
    profile: profile.rows[0] as CoachPaymentProfile,
    courses: courses.rows as CoachPaymentCourse[],
    adjustments: adjustments.rows as CoachPaymentAdjustment[],
    sends: sends.rows as CoachPaymentSendLog[],
    versions: versions.rows as CoachPaymentStatement[],
  };
}

export async function toggleCourse(statementId: string, courseId: string): Promise<boolean> {
  if (!validUuid(statementId) || !validUuid(courseId)) return false;
  return transaction(async (client) => {
    const changed = await client.query(
      `update coach_payment_courses c set included=not c.included
        from coach_payment_statements s
       where c.id=$2 and c.statement_id=$1 and s.id=c.statement_id and s.status='draft'
       returning c.id`,
      [statementId, courseId],
    );
    if (!changed.rowCount) return false;
    await recalculate(client, statementId);
    return true;
  });
}

export async function addManualCourse(input: {
  statementId: string;
  serviceName: string;
  startsAt: Date;
  reason: string;
}): Promise<void> {
  if (!validUuid(input.statementId)) throw new CoachPaymentError("État introuvable");
  await transaction(async (client) => {
    const inserted = await client.query(
      `insert into coach_payment_courses
        (statement_id, source, service_name, starts_at, included, manual_reason)
       select id, 'manual', $2, $3, true, $4
         from coach_payment_statements where id=$1 and status='draft'
       returning id`,
      [input.statementId, input.serviceName, input.startsAt, input.reason],
    );
    if (!inserted.rowCount) throw new CoachPaymentError("Un état validé est immuable");
    await recalculate(client, input.statementId);
  });
}

export async function addAdjustment(input: {
  statementId: string;
  kind: "bonus" | "deduction";
  amountXof: number;
  reason: string;
}): Promise<void> {
  if (!validUuid(input.statementId)) throw new CoachPaymentError("État introuvable");
  await transaction(async (client) => {
    const inserted = await client.query(
      `insert into coach_payment_adjustments (statement_id, kind, amount_xof, reason)
       select id, $2, $3, $4 from coach_payment_statements
        where id=$1 and status='draft' returning id`,
      [input.statementId, input.kind, input.amountXof, input.reason],
    );
    if (!inserted.rowCount) throw new CoachPaymentError("Un état validé est immuable");
    const updated = await recalculate(client, input.statementId);
    if (updated.total_xof < 0) throw new CoachPaymentError("Le total final ne peut pas être négatif");
  });
}

export async function removeAdjustment(statementId: string, adjustmentId: string): Promise<boolean> {
  if (!validUuid(statementId) || !validUuid(adjustmentId)) return false;
  return transaction(async (client) => {
    const removed = await client.query(
      `delete from coach_payment_adjustments a using coach_payment_statements s
        where a.id=$2 and a.statement_id=$1 and s.id=a.statement_id and s.status='draft'
        returning a.id`,
      [statementId, adjustmentId],
    );
    if (!removed.rowCount) return false;
    await recalculate(client, statementId);
    return true;
  });
}

export async function updateDraftTariff(statementId: string, tariff: CoachTariff): Promise<void> {
  if (!validUuid(statementId)) throw new CoachPaymentError("État introuvable");
  await transaction(async (client) => {
    const changed = await client.query(
      `update coach_payment_statements set tariff_json=$2, updated_at=now()
        where id=$1 and status='draft' returning id`,
      [statementId, JSON.stringify(tariff)],
    );
    if (!changed.rowCount) throw new CoachPaymentError("Un état validé est immuable");
    const updated = await recalculate(client, statementId);
    if (updated.total_xof < 0) throw new CoachPaymentError("Le total final ne peut pas être négatif");
  });
}

export async function validateStatement(
  id: string,
  validatedBy: string | null,
  now = new Date(),
): Promise<CoachPaymentStatement> {
  if (!validUuid(id)) throw new CoachPaymentError("État introuvable");
  return transaction(async (client) => {
    const current = await recalculate(client, id);
    const month = storedMonthKey(current.month);
    if (!monthIsClosed(month, now)) {
      throw new CoachPaymentError("La validation est possible uniquement après la fin du mois civil à Dakar");
    }
    if (!current.wix_resource_id_snapshot || current.sync_status !== "ok") {
      throw new CoachPaymentError("Validation bloquée : la synchronisation Wix doit réussir et la coach doit être associée");
    }
    if (!current.synced_at || current.synced_at.getTime() < monthBounds(month).end.getTime()) {
      throw new CoachPaymentError("Validation bloquée : resynchronise Wix après la clôture du mois");
    }
    if (current.total_xof < 0) throw new CoachPaymentError("Le total final ne peut pas être négatif");
    const updated = await client.query(
      `update coach_payment_statements
          set status='validated', validated_at=$2, validated_by=$3, updated_at=now()
        where id=$1 and status='draft' returning *`,
      [id, now, validatedBy],
    );
    if (!updated.rows[0]) throw new CoachPaymentError("Cet état n'est plus un brouillon");
    return updated.rows[0] as CoachPaymentStatement;
  });
}

export async function createCorrection(
  sourceId: string,
  createdBy: string | null,
): Promise<CoachPaymentStatement> {
  if (!validUuid(sourceId)) throw new CoachPaymentError("État introuvable");
  return transaction(async (client) => {
    const sourceResult = await client.query(
      `select * from coach_payment_statements where id=$1 for update`,
      [sourceId],
    );
    const source = sourceResult.rows[0] as CoachPaymentStatement | undefined;
    if (!source) throw new CoachPaymentError("État introuvable");
    if (!source.is_current || !["validated", "paid"].includes(source.status)) {
      throw new CoachPaymentError("Seule la dernière version validée peut être corrigée");
    }
    await client.query(`update coach_payment_statements set is_current=false where id=$1`, [sourceId]);
    const inserted = await client.query(
      `insert into coach_payment_statements
        (coach_profile_id, month, version, revises_statement_id, is_current, status,
         coach_name_snapshot, coach_email_snapshot, wix_resource_id_snapshot,
         tariff_json, sync_status, sync_error, synced_at, course_count,
         base_total_xof, adjustment_total_xof, total_xof, created_by)
       values ($1,$2,$3,$4,true,'draft',$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
       returning *`,
      [
        source.coach_profile_id,
        source.month,
        source.version + 1,
        source.id,
        source.coach_name_snapshot,
        source.coach_email_snapshot,
        source.wix_resource_id_snapshot,
        JSON.stringify(source.tariff_json),
        source.sync_status,
        source.sync_error,
        source.synced_at,
        source.course_count,
        source.base_total_xof,
        source.adjustment_total_xof,
        source.total_xof,
        createdBy,
      ],
    );
    const copy = inserted.rows[0] as CoachPaymentStatement;
    await client.query(
      `insert into coach_payment_courses
        (statement_id, source, wix_event_id, service_id, service_name, starts_at,
         ends_at, coach_resource_id, coach_name, included, manual_reason, raw_snapshot)
       select $2, source, wix_event_id, service_id, service_name, starts_at,
              ends_at, coach_resource_id, coach_name, included, manual_reason, raw_snapshot
         from coach_payment_courses where statement_id=$1`,
      [source.id, copy.id],
    );
    await client.query(
      `insert into coach_payment_adjustments (statement_id, kind, amount_xof, reason)
       select $2, kind, amount_xof, reason
         from coach_payment_adjustments where statement_id=$1`,
      [source.id, copy.id],
    );
    return recalculate(client, copy.id);
  });
}

export async function markPaid(
  id: string,
  paidAt: Date,
  paidBy: string | null,
): Promise<boolean> {
  if (!validUuid(id) || Number.isNaN(paidAt.getTime())) return false;
  const result = await pool.query(
    `update coach_payment_statements
        set status='paid', paid_at=$2, paid_by=$3, updated_at=now()
      where id=$1 and status='validated' returning id`,
    [id, paidAt, paidBy],
  );
  return Boolean(result.rowCount);
}

export async function recordSend(input: {
  statementId: string;
  recipientEmail: string;
  status: "success" | "error";
  error?: string | null;
  sentBy: string | null;
}): Promise<void> {
  await pool.query(
    `insert into coach_payment_send_log
      (statement_id, recipient_email, status, error, sent_by)
     values ($1,$2,$3,$4,$5)`,
    [input.statementId, input.recipientEmail, input.status, input.error?.slice(0, 500) ?? null, input.sentBy],
  );
}
