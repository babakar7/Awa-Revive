import type { WixCalendarEvent, WixService } from "../lib/wix.js";

export const DAKAR_TIMEZONE = "Africa/Dakar";

export type CoachTariff =
  | { type: "monthly_ratio"; baseAmountXof: number; baseSessionCount: number }
  | { type: "per_session"; perSessionXof: number };

export const HOLIDAY_MARKUP_RATE = 0.5;

export interface PaymentTotals {
  courseCount: number;
  baseTotalXof: number;
  holidayCourseCount: number;
  holidayBonusXof: number;
  adjustmentTotalXof: number;
  totalXof: number;
}

export interface EligibleCourse {
  wixEventId: string;
  serviceId: string | null;
  serviceName: string;
  startsAt: Date;
  endsAt: Date;
  participantCount: number | null;
  wixStatus: string;
  coachResourceId: string;
  coachName: string;
  raw: unknown;
}

export type CoachPaymentUiStatus =
  | "À préparer"
  | "Association Wix requise"
  | "Erreur Wix"
  | "Brouillon en cours"
  | "À resynchroniser"
  | "À corriger"
  | "Prêt à valider"
  | "Validé"
  | "Payé";

export type CoachPaymentBlocker =
  | "statement_missing"
  | "month_open"
  | "coach_unlinked"
  | "sync_after_close_missing"
  | "negative_total";

export interface CoachPaymentState {
  status: CoachPaymentUiStatus;
  canValidate: boolean;
  blockers: CoachPaymentBlocker[];
}

interface StateStatement {
  status: "draft" | "validated" | "paid";
  sync_status: "pending" | "ok" | "failed" | "unlinked";
  synced_at: Date | string | null;
  total_xof: number;
}

/** One source of truth for the cockpit, statement checklist and validate CTA. */
export function coachPaymentState(args: {
  month: string;
  statement: StateStatement | null | undefined;
  coachLinked: boolean;
  now?: Date;
}): CoachPaymentState {
  if (!args.statement) {
    return { status: "À préparer", canValidate: false, blockers: ["statement_missing"] };
  }

  const statement = args.statement;
  if (statement.status === "paid") {
    return { status: "Payé", canValidate: false, blockers: [] };
  }
  if (statement.status === "validated") {
    return { status: "Validé", canValidate: false, blockers: [] };
  }

  const closed = monthIsClosed(args.month, args.now ?? new Date());
  const syncedAfterClose =
    statement.sync_status === "ok" &&
    Boolean(
      statement.synced_at &&
        new Date(statement.synced_at).getTime() >= monthBounds(args.month).end.getTime(),
    );
  const blockers: CoachPaymentBlocker[] = [];
  if (!closed) blockers.push("month_open");
  if (!args.coachLinked) blockers.push("coach_unlinked");
  if (!syncedAfterClose) blockers.push("sync_after_close_missing");
  if (statement.total_xof < 0) blockers.push("negative_total");

  let status: CoachPaymentUiStatus;
  if (!args.coachLinked) {
    status = "Association Wix requise";
  } else if (statement.sync_status === "failed") {
    status = "Erreur Wix";
  } else if (!closed) {
    status = "Brouillon en cours";
  } else if (statement.sync_status === "ok" && !syncedAfterClose) {
    status = "À resynchroniser";
  } else if (statement.total_xof < 0) {
    status = "À corriger";
  } else if (blockers.length === 0) {
    status = "Prêt à valider";
  } else {
    status = "Brouillon en cours";
  }
  return { status, canValidate: blockers.length === 0, blockers };
}

interface BucketCourse {
  source: "wix" | "manual";
  service_name: string;
  included: boolean;
  wix_status?: string | null;
  participant_count?: number | null;
  manual_decision?: boolean;
}

export interface CoachPaymentCourseBuckets {
  manual: number;
  mat: number;
  reformer: number;
  otherWix: number;
  total: number;
}

/** Included courses are partitioned exactly once, with Mat taking precedence. */
export function coachPaymentCourseBuckets(courses: BucketCourse[]): CoachPaymentCourseBuckets {
  const buckets = { manual: 0, mat: 0, reformer: 0, otherWix: 0, total: 0 };
  for (const course of courses) {
    if (!course.included) continue;
    buckets.total += 1;
    if (course.source === "manual") {
      buckets.manual += 1;
      continue;
    }
    const name = normalizeSearch(course.service_name);
    if (name.includes("pilates mat") || name.includes("mat pilates")) {
      buckets.mat += 1;
    } else if (name.includes("reformer")) {
      buckets.reformer += 1;
    } else {
      buckets.otherWix += 1;
    }
  }
  return buckets;
}

export function coachPaymentCourseNeedsReview(course: BucketCourse): boolean {
  return (
    (course.source === "wix" && course.wix_status === "CANCELLED") ||
    (course.source === "wix" && course.wix_status !== "CANCELLED" && course.participant_count === 0) ||
    (Boolean(course.manual_decision) && !course.included)
  );
}

export function normalizeSearch(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("fr")
    .trim();
}

export function parseMonthKey(raw: string): string | null {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(raw)) return null;
  const year = Number(raw.slice(0, 4));
  return year >= 2020 && year <= 2100 ? raw : null;
}

/** Dakar is UTC+0 year-round; explicit UTC construction avoids host TZ drift. */
export function monthBounds(month: string): { start: Date; end: Date } {
  const parsed = parseMonthKey(month);
  if (!parsed) throw new Error("Mois invalide (format attendu : AAAA-MM)");
  const [year, oneBasedMonth] = parsed.split("-").map(Number);
  return {
    start: new Date(Date.UTC(year, oneBasedMonth - 1, 1, 0, 0, 0)),
    end: new Date(Date.UTC(year, oneBasedMonth, 1, 0, 0, 0)),
  };
}

export function currentMonthKey(now = new Date()): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** Normalize PostgreSQL DATE values (driver/config may return string or Date). */
export function storedMonthKey(value: string | Date): string {
  if (value instanceof Date) return currentMonthKey(value);
  const text = String(value);
  const direct = text.match(/^(\d{4}-(?:0[1-9]|1[0-2]))/);
  if (direct) return direct[1];
  const parsed = new Date(text);
  if (!Number.isNaN(parsed.getTime())) return currentMonthKey(parsed);
  throw new Error("Mois enregistré invalide");
}

export function monthIsClosed(month: string, now = new Date()): boolean {
  return now.getTime() >= monthBounds(month).end.getTime();
}

export function calendarLocalBounds(month: string): { fromLocalDate: string; toLocalDate: string } {
  const { start, end } = monthBounds(month);
  const local = (d: Date) => d.toISOString().slice(0, 19);
  return { fromLocalDate: local(start), toLocalDate: local(end) };
}

/** Calendar V3 local dates have no offset. They are requested in Dakar (UTC). */
export function calendarDate(value: string): Date | null {
  const text = value.trim();
  if (!text) return null;
  const hasZone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(text);
  const date = new Date(hasZone ? text : `${text}Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function tariffFromProfile(profile: {
  formula_type: string;
  base_amount_xof: number | null;
  base_session_count: number | null;
  per_session_xof: number | null;
}): CoachTariff {
  if (profile.formula_type === "monthly_ratio") {
    const baseAmountXof = Number(profile.base_amount_xof);
    const baseSessionCount = Number(profile.base_session_count);
    if (!Number.isInteger(baseAmountXof) || baseAmountXof < 0 || !Number.isInteger(baseSessionCount) || baseSessionCount <= 0) {
      throw new Error("Tarif mensuel incomplet");
    }
    return { type: "monthly_ratio", baseAmountXof, baseSessionCount };
  }
  if (profile.formula_type === "per_session") {
    const perSessionXof = Number(profile.per_session_xof);
    if (!Number.isInteger(perSessionXof) || perSessionXof < 0) {
      throw new Error("Tarif par cours incomplet");
    }
    return { type: "per_session", perSessionXof };
  }
  throw new Error("Type de tarif inconnu");
}

export function tariffFromJson(raw: unknown): CoachTariff {
  const value = (raw ?? {}) as Record<string, unknown>;
  if (value.type === "monthly_ratio") {
    return tariffFromProfile({
      formula_type: "monthly_ratio",
      base_amount_xof: Number(value.baseAmountXof),
      base_session_count: Number(value.baseSessionCount),
      per_session_xof: null,
    });
  }
  return tariffFromProfile({
    formula_type: String(value.type ?? ""),
    base_amount_xof: null,
    base_session_count: null,
    per_session_xof: Number(value.perSessionXof),
  });
}

export function computeBaseTotal(courseCount: number, tariff: CoachTariff): number {
  if (!Number.isInteger(courseCount) || courseCount < 0) throw new Error("Nombre de cours invalide");
  return tariff.type === "monthly_ratio"
    ? Math.round((courseCount * tariff.baseAmountXof) / tariff.baseSessionCount)
    : courseCount * tariff.perSessionXof;
}

/** Rounded once on the aggregate: per-course amounts are never displayed, so
 * rounding each course separately would only introduce drift. */
export function computeHolidayBonus(holidayCourseCount: number, tariff: CoachTariff): number {
  if (!Number.isInteger(holidayCourseCount) || holidayCourseCount < 0) {
    throw new Error("Nombre de cours fériés invalide");
  }
  return tariff.type === "monthly_ratio"
    ? Math.round((holidayCourseCount * tariff.baseAmountXof * HOLIDAY_MARKUP_RATE) / tariff.baseSessionCount)
    : Math.round(holidayCourseCount * tariff.perSessionXof * HOLIDAY_MARKUP_RATE);
}

export function computePaymentTotals(
  courseCount: number,
  tariff: CoachTariff,
  adjustments: Array<{ kind: string; amount_xof: number }>,
  holidayCourseCount = 0,
): PaymentTotals {
  const baseTotalXof = computeBaseTotal(courseCount, tariff);
  if (!Number.isInteger(holidayCourseCount) || holidayCourseCount < 0 || holidayCourseCount > courseCount) {
    throw new Error("Nombre de cours fériés invalide");
  }
  const holidayBonusXof = computeHolidayBonus(holidayCourseCount, tariff);
  const adjustmentTotalXof = adjustments.reduce((sum, a) => {
    const amount = Number(a.amount_xof);
    if (!Number.isInteger(amount) || amount <= 0) throw new Error("Montant d'ajustement invalide");
    if (a.kind !== "bonus" && a.kind !== "deduction") throw new Error("Type d'ajustement invalide");
    return sum + (a.kind === "bonus" ? amount : -amount);
  }, 0);
  return {
    courseCount,
    baseTotalXof,
    holidayCourseCount,
    holidayBonusXof,
    adjustmentTotalXof,
    totalXof: baseTotalXof + holidayBonusXof + adjustmentTotalXof,
  };
}

export function isCoachPaymentServiceName(name: string): boolean {
  const normalized = normalizeSearch(name);
  return normalized.includes("reformer") ||
    normalized.includes("pilates mat") ||
    normalized.includes("mat pilates") ||
    // Séances privées (Wix appointment type) — paid at the same per-class rate.
    (normalized.includes("seance") && normalized.includes("prive"));
}

export function coachPaymentServices(services: WixService[]): WixService[] {
  return services.filter((service) => isCoachPaymentServiceName(service.name));
}

/** Strict, deterministic filtering before anything becomes a payroll line. */
export function selectEligibleCoachPaymentEvents(args: {
  events: WixCalendarEvent[];
  services: WixService[];
  coachResourceId: string;
  month: string;
  now?: Date;
}): EligibleCourse[] {
  const now = args.now ?? new Date();
  const { start, end } = monthBounds(args.month);
  const matches = coachPaymentServices(args.services);
  const serviceIds = new Set(matches.map((s) => s.id));
  const serviceNames = new Set(matches.map((s) => normalizeSearch(s.name)));
  const seen = new Set<string>();
  const result: EligibleCourse[] = [];

  for (const event of args.events) {
    if (seen.has(event.id)) continue;
    seen.add(event.id);
    if (event.status !== "CONFIRMED" && event.status !== "CANCELLED") continue;
    if (!event.resources.some((r) => r.id === args.coachResourceId)) continue;
    const serviceMatches = event.serviceId
      ? serviceIds.has(event.serviceId)
      : serviceNames.has(normalizeSearch(event.serviceName)) ||
        isCoachPaymentServiceName(event.serviceName) ||
        isCoachPaymentServiceName(event.title);
    if (!serviceMatches) continue;
    const startsAt = calendarDate(event.startDate);
    const endsAt = calendarDate(event.endDate);
    if (!startsAt || !endsAt) continue;
    if (startsAt < start || startsAt >= end || endsAt > end || endsAt > now) continue;
    const resource = event.resources.find((r) => r.id === args.coachResourceId)!;
    result.push({
      wixEventId: event.id,
      serviceId: event.serviceId,
      serviceName: event.serviceName || event.title || "Pilates",
      startsAt,
      endsAt,
      participantCount: event.participantCount,
      wixStatus: event.status,
      coachResourceId: resource.id,
      coachName: resource.name,
      raw: event.raw,
    });
  }
  return result.sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());
}

export function validateManualCourseDate(month: string, startsAt: Date, now = new Date()): string | null {
  if (Number.isNaN(startsAt.getTime())) return "Date du cours invalide";
  const { start, end } = monthBounds(month);
  if (startsAt < start || startsAt >= end) return "Le cours manuel doit appartenir au mois de l'état";
  if (startsAt > now) return "Un cours futur ne peut pas être ajouté";
  return null;
}

export function tariffLabel(tariff: CoachTariff): string {
  return tariff.type === "monthly_ratio"
    ? `arrondi(nombre de cours × ${tariff.baseAmountXof.toLocaleString("fr-FR")} ÷ ${tariff.baseSessionCount}) FCFA`
    : `nombre de cours × ${tariff.perSessionXof.toLocaleString("fr-FR")} FCFA`;
}
