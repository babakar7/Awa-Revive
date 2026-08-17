/**
 * Pure rule logic for the empty-class auto-cancellation engine (no I/O —
 * unit-tested, same posture as notificationRules / renewalNudgeCandidates). The
 * sweep (autoCancelSweep.ts) pulls the Wix schedule + DB rows and feeds them
 * here; these functions decide WHICH occurrence is in its cancellation window,
 * whether it counts as empty, and whether the 15-minute empty timer must reset.
 * Nothing here talks to Wix, the DB, or WhatsApp.
 *
 * Dakar == UTC year-round (see config.TIMEZONE) — the whole codebase relies on
 * it, so time-of-day / weekday math is done in UTC and equals local Dakar time.
 * See [[wix-eligibility-index-broken-per-beneficiary]] is unrelated; this is
 * purely schedule/clock math.
 */

/** How long an occurrence must stay continuously empty before it can be cancelled. */
export const EMPTY_REQUIRED_MS = 15 * 60_000;

/**
 * Max gap between two successful "still empty" observations. A longer gap
 * (worker restart / Railway deploy — every push redeploys) is NOT proof of
 * continuous emptiness, so the 15-minute timer restarts. Babakar's refinement
 * (17/08/2026): a single fresh observation after a deploy is insufficient.
 */
export const OBSERVATION_GAP_MAX_MS = 2 * 60_000;

/**
 * Classes starting at or before this Dakar time-of-day (09:15 inclusive) are
 * decided the previous evening; later classes use the 3-hour daytime cutoff.
 */
export const MORNING_CUTOFF_MINUTES = 9 * 60 + 15; // 09:15

/** Morning classes become eligible at 23:00 the previous Dakar day. */
export const MORNING_ELIGIBILITY_HOUR = 23;

/** Daytime classes become eligible 3 hours before start. */
export const DAYTIME_CUTOFF_MS = 3 * 60 * 60_000;

/** Default minimum notice before start below which we never auto-cancel
 *  (Babakar 17/08/2026: 120 min). Configurable via env. */
export const DEFAULT_MIN_NOTICE_MINUTES = 120;

/** A durable auto-cancel rule (mirrors the auto_cancel_rules table). */
export interface AutoCancelRule {
  id: string;
  label: string;
  enabled: boolean;
  /** Exact Wix service id this rule targets (never a class name — catalogue is live). */
  service_id: string;
  /** Eligible weekdays, JS getUTCDay convention: 0=Sunday … 6=Saturday. Empty = every day. */
  weekdays: number[];
  /** Inclusive start-of-day-minutes range the class start must fall in. null = any. */
  start_min_from: number | null;
  start_min_to: number | null;
}

/** A concrete occurrence observed from Wix, normalized for the engine. */
export interface OccurrenceObservation {
  /** Short Calendar V3 event id (slot.eventId) — the cancellation identifier. */
  eventId: string;
  /** Long availability session id (slot.sessionId) — the booking-path lock key. */
  sessionId: string;
  serviceId: string;
  startIso: string;
  /**
   * Confirmed participant count from Calendar V3 capacity data, or null when
   * Wix did not expose a valid total+remaining (capacity unknown → NOT empty).
   */
  participantCount: number | null;
  /** Calendar V3 status, uppercased (CONFIRMED / CANCELLED / …). */
  status: string;
}

/** Minutes since Dakar midnight for an ISO instant (Dakar == UTC). */
export function dakarMinutesOfDay(startIso: string): number {
  const d = new Date(startIso);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
}

/** JS getUTCDay weekday (0=Sun … 6=Sat) for an ISO instant (Dakar == UTC). */
export function dakarWeekday(startIso: string): number {
  return new Date(startIso).getUTCDay();
}

/** True when the class starts at or before 09:15 Dakar (the morning rule). */
export function isMorningClass(startIso: string): boolean {
  return dakarMinutesOfDay(startIso) <= MORNING_CUTOFF_MINUTES;
}

/**
 * When this occurrence first becomes eligible for cancellation checks.
 * Morning (≤09:15): 23:00 the previous Dakar calendar day.
 * Daytime: start − 3h.
 */
export function eligibilityStart(startIso: string): Date {
  const start = new Date(startIso);
  if (isMorningClass(startIso)) {
    // 23:00 the previous Dakar day. Dakar == UTC, so build from UTC parts.
    const prev = new Date(start.getTime());
    prev.setUTCDate(prev.getUTCDate() - 1);
    prev.setUTCHours(MORNING_ELIGIBILITY_HOUR, 0, 0, 0);
    return prev;
  }
  return new Date(start.getTime() - DAYTIME_CUTOFF_MS);
}

/** Latest instant an auto-cancel may still fire: start − minNotice. */
export function windowEnd(startIso: string, minNoticeMinutes: number): Date {
  return new Date(new Date(startIso).getTime() - minNoticeMinutes * 60_000);
}

/**
 * Is `now` inside the occurrence's cancellation window? True iff we are at/after
 * the eligibility cutoff and at/before start − minNotice (and thus before start).
 * A class first becoming empty after windowEnd can never accumulate the required
 * 15 empty minutes before the min-notice floor, so it is left untouched.
 */
export function isWithinWindow(
  startIso: string,
  now: Date,
  minNoticeMinutes: number,
): boolean {
  const nowMs = now.getTime();
  return (
    nowMs >= eligibilityStart(startIso).getTime() &&
    nowMs <= windowEnd(startIso, minNoticeMinutes).getTime()
  );
}

/** Does the occurrence's service / weekday / start-time match the rule? */
export function matchesRule(rule: AutoCancelRule, occ: { serviceId: string; startIso: string }): boolean {
  if (rule.service_id !== occ.serviceId) return false;
  if (rule.weekdays.length > 0 && !rule.weekdays.includes(dakarWeekday(occ.startIso))) {
    return false;
  }
  const mod = dakarMinutesOfDay(occ.startIso);
  if (rule.start_min_from != null && mod < rule.start_min_from) return false;
  if (rule.start_min_to != null && mod > rule.start_min_to) return false;
  return true;
}

/**
 * Is this occurrence empty? Empty = Wix exposed a valid capacity AND exactly
 * zero confirmed participants. Capacity unknown (participantCount === null) is
 * NOT empty — fail-closed (we never cancel on missing data).
 */
export function isEmpty(occ: { participantCount: number | null }): boolean {
  return occ.participantCount === 0;
}

/**
 * Given the ledger's remembered first-empty / last-observed timestamps and a
 * fresh observation, decide the new empty-timer state. Returns the timestamp
 * from which continuous emptiness is now counted (`firstEmptyAt`), or null when
 * the occurrence is not currently empty (timer cleared).
 *
 * The timer RESETS to `now` (as if freshly empty) when:
 *   - the previous observation was non-empty or absent, OR
 *   - an active (unexpired) local payment attempt protects the slot, OR
 *   - the gap since the last successful observation exceeds 2 minutes
 *     (a worker/deploy blind spot is never counted as observed emptiness).
 */
export function nextEmptyTimer(args: {
  now: Date;
  isCurrentlyEmpty: boolean;
  hasActivePayment: boolean;
  priorFirstEmptyAt: Date | null;
  priorLastObservedAt: Date | null;
}): Date | null {
  const { now, isCurrentlyEmpty, hasActivePayment, priorFirstEmptyAt, priorLastObservedAt } = args;
  if (!isCurrentlyEmpty || hasActivePayment) return null;
  if (priorFirstEmptyAt == null) return now;
  if (priorLastObservedAt == null) return now;
  const gap = now.getTime() - priorLastObservedAt.getTime();
  if (gap > OBSERVATION_GAP_MAX_MS) return now; // deploy/restart blind spot → restart timer
  return priorFirstEmptyAt;
}

/** Has the occurrence been continuously empty for the required 15 minutes? */
export function isEmptyLongEnough(firstEmptyAt: Date | null, now: Date): boolean {
  if (firstEmptyAt == null) return false;
  return now.getTime() - firstEmptyAt.getTime() >= EMPTY_REQUIRED_MS;
}

/** Recipient-scoped dedup key for one cancellation notification. */
export function cancelNotifyDedupKey(eventId: string, phoneDigits: string): string {
  return `autocancel:notify:${eventId}:${phoneDigits}`;
}

/** Dedup key for the "cannot resolve recipients" configuration alert (one/occurrence). */
export function cancelConfigAlertDedupKey(eventId: string): string {
  return `autocancel:config:${eventId}`;
}
