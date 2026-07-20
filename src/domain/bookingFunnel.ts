import crypto from "node:crypto";
import { pool } from "../db/index.js";

export const BOOKING_FUNNEL_STAGES = [
  "availability_requested",
  "slots_shown",
  "no_availability",
  "slot_selected",
  "payment_link_created",
  "payment_confirmed",
  "booked",
  "expired",
  "recovery_sent",
  "handoff",
  "technical_failure",
] as const;

export type BookingFunnelStage = (typeof BOOKING_FUNNEL_STAGES)[number];
export type BookingJourneyStatus = "open" | "booked" | "handed_off" | "failed" | "inactive";

export const BOOKING_FAILURE_CODES = [
  "no_availability",
  "slot_already_started",
  "slot_unavailable",
  "group_capacity",
  "payment_method_unavailable",
  "payment_provider_error",
  "payment_verification_failed",
  "wix_booking_failed",
  "membership_not_eligible",
  "membership_balance_insufficient",
  "membership_booking_failed",
  "client_account_not_found",
  "client_notification_failed",
  "unknown",
] as const;

export type BookingFailureCode = (typeof BOOKING_FAILURE_CODES)[number];

export interface BookingFunnelEvent {
  id?: number;
  journey_id: string;
  client_id: string;
  booking_id: string | null;
  stage: BookingFunnelStage;
  payment_method: string | null;
  failure_code: BookingFailureCode | null;
  metadata_json: Record<string, unknown>;
  idempotency_key: string | null;
  is_excluded: boolean;
  occurred_at: Date;
}

export interface BookingJourneyCandidate {
  id: string;
  status: BookingJourneyStatus;
  last_event_at: Date;
  booking_ids?: string[];
}

const TERMINAL_STATUS: Partial<Record<BookingFunnelStage, BookingJourneyStatus>> = {
  booked: "booked",
  handoff: "handed_off",
  technical_failure: "failed",
};

const FAILURE_ALIASES: Record<string, BookingFailureCode> = {
  no_slots: "no_availability",
  empty_availability: "no_availability",
  slot_full: "slot_unavailable",
  not_enough_spots: "slot_unavailable",
  class_started: "slot_already_started",
  group_too_large: "group_capacity",
  orange_money_unavailable: "payment_method_unavailable",
  maxit_unavailable: "payment_method_unavailable",
  payment_failed: "payment_provider_error",
  technical: "wix_booking_failed",
  slot_taken: "slot_unavailable",
  not_eligible: "membership_not_eligible",
  not_enough_sessions: "membership_balance_insufficient",
  no_matching_contact: "client_account_not_found",
};

export function normalizeBookingFailureCode(raw: unknown): BookingFailureCode {
  const value = String(raw ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  if ((BOOKING_FAILURE_CODES as readonly string[]).includes(value)) {
    return value as BookingFailureCode;
  }
  if (FAILURE_ALIASES[value]) return FAILURE_ALIASES[value];
  if (value.includes("wix") || value.includes("booking")) return "wix_booking_failed";
  if (value.includes("verify") || value.includes("signature")) return "payment_verification_failed";
  if (value.includes("payment") || value.includes("checkout") || value.includes("qr")) {
    return "payment_provider_error";
  }
  if (value.includes("notify") || value.includes("whatsapp")) return "client_notification_failed";
  return "unknown";
}

/** Team/test clients remain observable for debugging but never enter commercial metrics. */
export function shouldExcludeBookingFunnelClient(isTest: boolean): boolean {
  return isTest;
}

/** Defense in depth: analytics metadata can never retain conversational/link content. */
export function sanitizeBookingFunnelMetadata(
  value: Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (!value) return {};
  const forbidden = /(link|url|transcript|content|message|body|text|phone|email)/i;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key, item]) => !forbidden.test(key) && item !== undefined)
      .slice(0, 20)
      .map(([key, item]) => {
        if (typeof item === "string") return [key, item.slice(0, 160)];
        if (typeof item === "number" || typeof item === "boolean" || item === null) return [key, item];
        if (Array.isArray(item)) return [key, item.slice(0, 20).map((v) => String(v).slice(0, 80))];
        return [key, String(item).slice(0, 160)];
      }),
  );
}

export function isDuplicateFunnelEvent(existingKeys: readonly string[], key?: string | null): boolean {
  return !!key && existingKeys.includes(key);
}

/** Pure counterpart of the DB correlation rule, used to lock its semantics in tests. */
export function selectJourneyCandidate(
  candidates: readonly BookingJourneyCandidate[],
  args: { bookingId?: string | null; occurredAt: Date; inactivityHours?: number },
): BookingJourneyCandidate | null {
  if (args.bookingId) {
    const bookingMatch = candidates.find((j) => j.booking_ids?.includes(args.bookingId!));
    if (bookingMatch) return bookingMatch;
  }
  const cutoff = args.occurredAt.getTime() - (args.inactivityHours ?? 24) * 3_600_000;
  return (
    candidates
      .filter((j) => j.status === "open" && new Date(j.last_event_at).getTime() >= cutoff)
      .sort((a, b) => new Date(b.last_event_at).getTime() - new Date(a.last_event_at).getTime())[0] ?? null
  );
}

export async function recordBookingFunnelEvent(args: {
  clientId: string;
  stage: BookingFunnelStage;
  bookingId?: string | null;
  paymentMethod?: string | null;
  failureCode?: string | BookingFailureCode | null;
  metadata?: Record<string, unknown>;
  idempotencyKey?: string | null;
  occurredAt?: Date;
  /** Handoffs should close a booking journey but never invent one. */
  allowCreateJourney?: boolean;
}): Promise<string | null> {
  const db = await pool.connect();
  const occurredAt = args.occurredAt ?? new Date();
  const key = args.idempotencyKey ?? crypto.randomUUID();
  try {
    await db.query("begin");
    await db.query(`select pg_advisory_xact_lock(hashtext($1))`, [args.clientId]);

    const duplicate = await db.query(
      `select journey_id from booking_funnel_events where idempotency_key = $1`,
      [key],
    );
    if (duplicate.rows[0]) {
      await db.query("commit");
      return duplicate.rows[0].journey_id;
    }

    const clientResult = await db.query(`select is_test from clients where id = $1`, [args.clientId]);
    if (!clientResult.rows[0]) {
      await db.query("rollback");
      return null;
    }
    const excluded = shouldExcludeBookingFunnelClient(!!clientResult.rows[0].is_test);

    await db.query(
      `update booking_funnel_journeys
          set status='inactive', closed_at=last_event_at
        where client_id=$1 and status='open'
          and last_event_at < $2::timestamptz - interval '24 hours'`,
      [args.clientId, occurredAt],
    );

    let journeyId: string | null = null;
    if (args.bookingId) {
      const byBooking = await db.query(
        `select journey_id from booking_funnel_events
          where client_id=$1 and booking_id=$2
          order by occurred_at desc limit 1`,
        [args.clientId, args.bookingId],
      );
      journeyId = byBooking.rows[0]?.journey_id ?? null;
    }
    if (!journeyId) {
      const open = await db.query(
        `select id from booking_funnel_journeys
          where client_id=$1 and status='open'
            and last_event_at >= $2::timestamptz - interval '24 hours'
          order by last_event_at desc limit 1 for update`,
        [args.clientId, occurredAt],
      );
      journeyId = open.rows[0]?.id ?? null;
    }
    if (!journeyId && args.allowCreateJourney === false) {
      await db.query("commit");
      return null;
    }
    if (!journeyId) {
      const created = await db.query(
        `insert into booking_funnel_journeys
           (client_id, is_excluded, payment_method, started_at, last_event_at)
         values ($1,$2,$3,$4,$4) returning id`,
        [args.clientId, excluded, args.paymentMethod ?? null, occurredAt],
      );
      journeyId = created.rows[0].id;
    }

    const failureCode = args.failureCode ? normalizeBookingFailureCode(args.failureCode) : null;
    await db.query(
      `insert into booking_funnel_events
         (journey_id, client_id, booking_id, stage, payment_method, failure_code,
          metadata_json, idempotency_key, is_excluded, occurred_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        journeyId,
        args.clientId,
        args.bookingId ?? null,
        args.stage,
        args.paymentMethod ?? null,
        failureCode,
        JSON.stringify(sanitizeBookingFunnelMetadata(args.metadata)),
        key,
        excluded,
        occurredAt,
      ],
    );

    const terminalStatus = TERMINAL_STATUS[args.stage];
    await db.query(
      `update booking_funnel_journeys
          set last_event_at=greatest(last_event_at,$2),
              payment_method=coalesce($3,payment_method),
              status=coalesce($4,status),
              closed_at=case when $4::text is null then closed_at else $2 end,
              terminal_stage=case when $4::text is null then terminal_stage else $5 end,
              is_excluded=is_excluded or $6
        where id=$1`,
      [journeyId, occurredAt, args.paymentMethod ?? null, terminalStatus ?? null, args.stage, excluded],
    );
    await db.query("commit");
    return journeyId;
  } catch (error) {
    await db.query("rollback").catch(() => {});
    throw error;
  } finally {
    db.release();
  }
}

export async function closeInactiveBookingJourneys(): Promise<number> {
  const result = await pool.query(
    `update booking_funnel_journeys
        set status='inactive', closed_at=last_event_at
      where status='open' and last_event_at < now() - interval '24 hours'`,
  );
  return result.rowCount ?? 0;
}

export interface FunnelStageMetric {
  stage: BookingFunnelStage;
  journeys: number;
  rateFromPrevious: number | null;
}

export interface PaymentMethodMetric {
  method: string;
  links: number;
  confirmed: number;
  booked: number;
  linkToBookedRate: number | null;
}

export interface BookingConversionMetrics {
  journeys: number;
  stages: FunnelStageMetric[];
  overallConversion: number | null;
  paymentLinkToBooked: number | null;
  paymentMethods: PaymentMethodMetric[];
  expiryRecovery: { expired: number; recoverySent: number; recoveredBookings: number; recoveryRate: number | null };
  failures: Array<{ code: string; count: number }>;
}

const CONVERSION_STAGES: BookingFunnelStage[] = [
  "availability_requested",
  "slots_shown",
  "slot_selected",
  "payment_link_created",
  "payment_confirmed",
  "booked",
];

export function calculateBookingConversion(
  events: readonly BookingFunnelEvent[],
  journeyIds?: ReadonlySet<string>,
): BookingConversionMetrics {
  const included = events.filter((e) => !e.is_excluded && (!journeyIds || journeyIds.has(e.journey_id)));
  const allJourneys = new Set(included.map((e) => e.journey_id));
  const idsByStage = new Map<BookingFunnelStage, Set<string>>();
  for (const stage of BOOKING_FUNNEL_STAGES) idsByStage.set(stage, new Set());
  for (const event of included) idsByStage.get(event.stage)!.add(event.journey_id);

  let previous = 0;
  const stages = CONVERSION_STAGES.map((stage) => {
    const journeys = idsByStage.get(stage)!.size;
    const metric = {
      stage,
      journeys,
      rateFromPrevious: previous > 0 ? Math.round((journeys * 1000) / previous) / 10 : null,
    };
    previous = journeys;
    return metric;
  });
  const availability = idsByStage.get("availability_requested")!.size;
  const linkIds = idsByStage.get("payment_link_created")!;
  const bookedIds = idsByStage.get("booked")!;
  const bookedAfterLink = [...linkIds].filter((id) => bookedIds.has(id)).length;
  const bookedAfterAvailability = [...idsByStage.get("availability_requested")!].filter((id) =>
    bookedIds.has(id),
  ).length;

  const methods = new Map<string, { links: Set<string>; confirmed: Set<string>; booked: Set<string> }>();
  for (const event of included) {
    if (!event.payment_method) continue;
    const metric = methods.get(event.payment_method) ?? {
      links: new Set<string>(), confirmed: new Set<string>(), booked: new Set<string>(),
    };
    if (event.stage === "payment_link_created") metric.links.add(event.journey_id);
    if (event.stage === "payment_confirmed") metric.confirmed.add(event.journey_id);
    if (event.stage === "booked") metric.booked.add(event.journey_id);
    methods.set(event.payment_method, metric);
  }
  const paymentMethods = [...methods.entries()]
    .map(([method, metric]) => ({
      method,
      links: metric.links.size,
      confirmed: metric.confirmed.size,
      booked: metric.booked.size,
      linkToBookedRate: metric.links.size
        ? Math.round((([...metric.links].filter((id) => metric.booked.has(id)).length * 1000) / metric.links.size)) / 10
        : null,
    }))
    .sort((a, b) => b.links - a.links || a.method.localeCompare(b.method));

  const expiredIds = idsByStage.get("expired")!;
  const recoveryIds = idsByStage.get("recovery_sent")!;
  const recoveryAt = new Map<string, number>();
  const bookedAt = new Map<string, number>();
  for (const event of included) {
    const at = new Date(event.occurred_at).getTime();
    if (event.stage === "recovery_sent") {
      recoveryAt.set(event.journey_id, Math.min(recoveryAt.get(event.journey_id) ?? Infinity, at));
    }
    if (event.stage === "booked") {
      bookedAt.set(event.journey_id, Math.min(bookedAt.get(event.journey_id) ?? Infinity, at));
    }
  }
  const recoveredBookings = [...recoveryIds].filter(
    (id) => (bookedAt.get(id) ?? -Infinity) >= (recoveryAt.get(id) ?? Infinity),
  ).length;
  const failureCounts = new Map<string, number>();
  for (const event of included) {
    if (event.failure_code) failureCounts.set(event.failure_code, (failureCounts.get(event.failure_code) ?? 0) + 1);
  }

  return {
    journeys: allJourneys.size,
    stages,
    overallConversion: availability
      ? Math.round((bookedAfterAvailability * 1000) / availability) / 10
      : null,
    paymentLinkToBooked: linkIds.size ? Math.round((bookedAfterLink * 1000) / linkIds.size) / 10 : null,
    paymentMethods,
    expiryRecovery: {
      expired: expiredIds.size,
      recoverySent: recoveryIds.size,
      recoveredBookings,
      recoveryRate: recoveryIds.size ? Math.round((recoveredBookings * 1000) / recoveryIds.size) / 10 : null,
    },
    failures: [...failureCounts.entries()]
      .map(([code, count]) => ({ code, count }))
      .sort((a, b) => b.count - a.count || a.code.localeCompare(b.code)),
  };
}

export interface ConversionIncident {
  booking_id: string;
  client_id: string;
  client_name: string | null;
  service_name: string;
  status: string;
  payment_method: string;
  amount_xof: number;
  updated_at: Date;
}

export interface ConversionFailureRow {
  client_id: string;
  client_name: string | null;
  stage: BookingFunnelStage;
  failure_code: string;
  occurred_at: Date;
}

export interface BookingConversionDashboard {
  sevenDays: BookingConversionMetrics;
  thirtyDays: BookingConversionMetrics;
  incidents: ConversionIncident[];
  recentFailures: ConversionFailureRow[];
}

export async function bookingConversionDashboard(): Promise<BookingConversionDashboard> {
  await closeInactiveBookingJourneys();
  const [journeys, eventRows, incidents, recentFailures] = await Promise.all([
    pool.query(
      `select id, started_at from booking_funnel_journeys j
        where j.started_at >= now() - interval '30 days'
          and not j.is_excluded
          and not exists (select 1 from clients c where c.id=j.client_id and c.is_test)`,
    ),
    pool.query(
      `select e.* from booking_funnel_events e
        join booking_funnel_journeys j on j.id=e.journey_id
       where j.started_at >= now() - interval '30 days'
         and not e.is_excluded and not j.is_excluded
         and not exists (select 1 from clients c where c.id=e.client_id and c.is_test)
       order by e.occurred_at`,
    ),
    pool.query(
      `select b.id as booking_id, b.client_id, c.name as client_name, b.service_name,
              b.status, b.payment_method, b.amount_xof, b.updated_at
         from pending_bookings b join clients c on c.id=b.client_id
        where b.status in ('PAID','REFUND_NEEDED') and not c.is_test
        order by (b.status='PAID') desc, b.updated_at asc limit 50`,
    ),
    pool.query(
      `select e.client_id, c.name as client_name, e.stage, e.failure_code, e.occurred_at
         from booking_funnel_events e join clients c on c.id=e.client_id
        where e.failure_code is not null and e.occurred_at >= now() - interval '30 days'
          and not e.is_excluded and not c.is_test
        order by e.occurred_at desc limit 30`,
    ),
  ]);
  const events = eventRows.rows.map((row) => ({ ...row, occurred_at: new Date(row.occurred_at) })) as BookingFunnelEvent[];
  const now = Date.now();
  const ids30 = new Set(journeys.rows.map((j) => j.id as string));
  const ids7 = new Set(
    journeys.rows
      .filter((j) => new Date(j.started_at).getTime() >= now - 7 * 86_400_000)
      .map((j) => j.id as string),
  );
  return {
    sevenDays: calculateBookingConversion(events, ids7),
    thirtyDays: calculateBookingConversion(events, ids30),
    incidents: incidents.rows,
    recentFailures: recentFailures.rows,
  };
}
