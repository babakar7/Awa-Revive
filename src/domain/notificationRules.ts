/**
 * Pure rule logic for the staff-notification engine (no I/O — unit-tested,
 * same posture as renewalNudgeCandidates). The sweep (notificationSweep.ts)
 * pulls the Wix schedule + DB rows and feeds them here; these functions decide
 * WHAT is due, WHO is suppressed, and HOW the message reads. Nothing here talks
 * to Wix, the DB, or WhatsApp.
 *
 * Dakar == UTC year-round (see config.TIMEZONE) — the whole codebase relies on
 * it, so day-of-week / HH:MM math is done in UTC and equals local Dakar time.
 */

/** A rule row (mirrors the notification_rules table). */
export interface NotificationRule {
  id: string;
  label: string;
  kind: "class_reminder" | "fixed_schedule";
  enabled: boolean;
  /** Exact Wix service target. When set, it takes precedence over name filters. */
  service_id: string | null;
  class_pattern: string | null;
  /** Substring to EXCLUDE (e.g. "reformer") — matched slots are dropped. */
  exclude_pattern: string | null;
  lead_minutes: number | null;
  suppress_gap_minutes: number | null;
  recipient_kind: "phone" | "coach";
  recipient_phone: string | null;
  days_of_week: string | null;
  send_time: string | null;
  message_template: string;
  /** class_reminder only: restrict to group classes (skip 1-on-1 appointments). */
  group_only: boolean;
}

/** A Wix availability slot enriched with its service name (the sweep joins it). */
export interface SlotWithName {
  eventId: string;
  serviceId: string;
  serviceName: string;
  startDate: string; // ISO
  endDate: string; // ISO
  openSpots: number;
  totalSpots: number; // 0 when Wix doesn't expose capacity → booked_count = "?"
  coach: string | null;
  coachId: string | null;
  /**
   * Is this a group class (Wix type CLASS/COURSE) vs a 1-on-1 appointment? The
   * sweep sets it from the service type; only an explicit APPOINTMENT is false,
   * so an unknown type stays a group (never silently dropped by group_only).
   */
  isGroup: boolean;
}

/** Footer appended to EVERY staff send (never typed into a rule template). */
export const STAFF_FOOTER = "Message automatique d'Awa — merci de ne pas répondre.";

const MAX_PATTERN_LEN = 80;

/**
 * Normalize a name for accent- and case-insensitive substring matching:
 * NFD-strip diacritics, lowercase, collapse whitespace, trim. Used both for
 * class-pattern matching and coach-name resolution ("Awa " vs "awa").
 */
export function normalizeName(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Substring match only — NO user regex (ReDoS-proof and simpler for the owner:
 * "aquabike" is all they type). Empty/blank pattern = matches every class.
 * Patterns longer than 80 chars are treated as blank (fat-finger guard).
 */
export function matchesPattern(serviceName: string, pattern: string | null): boolean {
  const p = (pattern ?? "").trim();
  if (p === "" || p.length > MAX_PATTERN_LEN) return true;
  return normalizeName(serviceName).includes(normalizeName(p));
}

/**
 * Should this class be EXCLUDED by a rule's exclude_pattern? Empty/blank pattern
 * excludes nothing (the opposite default of matchesPattern). Same substring,
 * accent/case-insensitive matching — e.g. "reformer" drops "Pilates Reformer".
 */
export function excludes(serviceName: string, pattern: string | null): boolean {
  const p = (pattern ?? "").trim();
  if (p === "" || p.length > MAX_PATTERN_LEN) return false;
  return normalizeName(serviceName).includes(normalizeName(p));
}

/**
 * Exact service selection wins over the legacy name-pattern mode. Service ids
 * come from the live Wix catalogue selected in /admin/notifications; matching
 * by id keeps the rule stable if the course is renamed.
 */
export function matchesRuleService(rule: NotificationRule, slot: SlotWithName): boolean {
  const serviceId = rule.service_id?.trim();
  if (serviceId) return slot.serviceId === serviceId;
  return (
    matchesPattern(slot.serviceName, rule.class_pattern) &&
    !excludes(slot.serviceName, rule.exclude_pattern)
  );
}

/** One due class occurrence for a rule (to send, or suppressed with a reason). */
export interface DueClassReminder {
  slot: SlotWithName;
  suppressed: boolean;
  suppressReason: string | null;
}

/**
 * Class occurrences of `rule` that are due right now. Due = we're inside the
 * lead window [start - lead, start). Back-to-back suppression: if another
 * matching class ended within [start - gap, start] (bikes already in the
 * water), the follow-on reminder is suppressed. `priorEndsMs` carries the
 * event_end (ms) of earlier sent/suppressed occurrences of THIS rule, so the
 * chain still breaks when the Wix window no longer includes the preceding,
 * already-started session (the log fallback).
 *
 * Suppressed occurrences are still returned so the sweep claims + logs them —
 * otherwise they'd be re-evaluated every minute forever.
 */
export function dueClassReminders(
  rule: NotificationRule,
  slots: SlotWithName[],
  now: Date,
  priorEndsMs: number[] = [],
): DueClassReminder[] {
  const lead = (rule.lead_minutes ?? 0) * 60_000;
  const gap = (rule.suppress_gap_minutes ?? 0) * 60_000;
  const nowMs = now.getTime();
  const matching = slots.filter(
    (s) =>
      matchesRuleService(rule, s) &&
      (!rule.group_only || s.isGroup),
  );
  const out: DueClassReminder[] = [];

  for (const slot of matching) {
    const start = new Date(slot.startDate).getTime();
    if (Number.isNaN(start)) continue;
    // Inside the lead window and not yet started.
    if (!(nowMs >= start - lead && nowMs < start)) continue;

    let suppressed = false;
    if (gap > 0) {
      // Chaining is per-recipient: for a coach rule, only the SAME coach's
      // preceding class chains (coach A's class must not suppress coach B's);
      // for a phone rule, every matching class shares the one recipient.
      const key = chainKeyFor(rule, slot);
      const windowStart = start - gap;
      const endedInGap = (endMs: number) =>
        !Number.isNaN(endMs) && endMs <= start && endMs >= windowStart;
      const fromSchedule = matching.some(
        (other) =>
          other !== slot &&
          chainKeyFor(rule, other) === key &&
          endedInGap(new Date(other.endDate).getTime()),
      );
      // Log fallback only for phone rules (single recipient) — a rule-wide list
      // of prior ends can't tell coaches apart, and coach leads are long enough
      // that the preceding session is still in the schedule window anyway.
      const fromLog = key === "" && priorEndsMs.some((endMs) => endedInGap(endMs));
      suppressed = fromSchedule || fromLog;
    }
    out.push({
      slot,
      suppressed,
      suppressReason: suppressed ? "cours enchaîné (dos à dos)" : null,
    });
  }
  return out;
}

/**
 * The chaining/suppression key for a slot under a rule: for a coach rule, the
 * coach's identity (id, else normalized name) — so only that coach's classes
 * chain; for a phone rule, "" (all matching classes go to the same number).
 */
export function chainKeyFor(rule: NotificationRule, slot: SlotWithName): string {
  if (rule.recipient_kind === "coach") {
    return slot.coachId ?? normalizeName(slot.coach ?? "");
  }
  return "";
}

/**
 * The consecutive block a due reminder should cover, starting at `firstSlot`:
 * same chain key (same coach for a coach rule), each class starting within the
 * rule's gap of the previous one's end. Returns [firstSlot] when gap is off or
 * nothing follows. Lets one message list a whole back-to-back block instead of
 * pinging the coach once per class.
 */
export function buildChain(
  rule: NotificationRule,
  slots: SlotWithName[],
  firstSlot: SlotWithName,
): SlotWithName[] {
  const gap = (rule.suppress_gap_minutes ?? 0) * 60_000;
  if (gap <= 0) return [firstSlot];
  const key = chainKeyFor(rule, firstSlot);
  const firstStart = new Date(firstSlot.startDate).getTime();
  const forward = slots
    .filter(
      (s) =>
        matchesRuleService(rule, s) &&
        (!rule.group_only || s.isGroup) &&
        chainKeyFor(rule, s) === key &&
        new Date(s.startDate).getTime() >= firstStart,
    )
    .sort((a, b) => new Date(a.startDate).getTime() - new Date(b.startDate).getTime());

  const chain: SlotWithName[] = [];
  let last: SlotWithName | null = null;
  for (const s of forward) {
    if (last === null) {
      chain.push(s);
      last = s;
      continue;
    }
    const sStart = new Date(s.startDate).getTime();
    const lastEnd = new Date(last.endDate).getTime();
    if (sStart >= lastEnd && sStart - lastEnd <= gap) {
      chain.push(s);
      last = s;
    } else {
      break;
    }
  }
  return chain.length > 0 ? chain : [firstSlot];
}

/**
 * Is a fixed_schedule rule due at `now`? True when today's weekday is in
 * days_of_week AND the local time has reached send_time. The per-day dedup key
 * makes it fire once; a late boot still fires the same day (never the next).
 */
export function isFixedScheduleDue(rule: NotificationRule, now: Date): boolean {
  const days = (rule.days_of_week ?? "")
    .split(",")
    .map((s) => parseInt(s.trim(), 10))
    .filter((n) => Number.isInteger(n) && n >= 0 && n <= 6);
  if (days.length === 0) return false;
  if (!days.includes(now.getUTCDay())) return false;

  const m = (rule.send_time ?? "").match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return false;
  const h = parseInt(m[1], 10);
  const min = parseInt(m[2], 10);
  if (h > 23 || min > 59) return false;

  const nowMins = now.getUTCHours() * 60 + now.getUTCMinutes();
  return nowMins >= h * 60 + min;
}

/**
 * Fill {placeholders} in a rule message. Provided keys are replaced; any
 * {unknown} placeholder is left visible so the owner spots the typo in the
 * admin test-send. Values are plain strings (the sweep pre-formats times in
 * Dakar and passes "?" for an unknown headcount).
 */
export function renderMessage(template: string, vars: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (whole, key) =>
    Object.prototype.hasOwnProperty.call(vars, key) ? vars[key] : whole,
  );
}

/** Deterministic YYYY-MM-DD for `now` in Dakar (== UTC). */
export function dakarDateStr(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/** Claim key for a class occurrence: one send per (rule, class event). */
export function classDedupKey(ruleId: string, eventId: string): string {
  return `rule:${ruleId}:event:${eventId}`;
}

/** Claim key for a fixed rule: one send per (rule, local day). */
export function fixedDedupKey(ruleId: string, dateStr: string): string {
  return `rule:${ruleId}:day:${dateStr}`;
}
