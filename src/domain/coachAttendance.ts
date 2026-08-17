/**
 * Attendance-based classification for coach payroll (chantier coach-attendance,
 * PROGRESS.md 17/08). A completed class is auto-excludable from a coach's pay
 * only when Wix proves it was not given: no confirmed reservation at all, or
 * every confirmed reservation explicitly marked NOT_ATTENDED. Anything doubtful
 * stays payable but flagged (fail-open on the coach's money, fail-closed on
 * validation — the failure to read attendance blocks validation upstream).
 *
 * This module is pure and deterministic: it turns live Wix reads (already
 * fetched) into a per-event verdict. The eventId filters both reads rely on are
 * verified live (scripts/probe-attendance-filters.ts). CRITICAL: the Bookings
 * Reader eventId filter returns bookings of ALL statuses, so coverage is built
 * from CONFIRMED bookings only — never trust the filter to pre-restrict status.
 */
import type { WixEventAttendanceRecord, WixEventBooking } from "../lib/wix.js";

/** Confirmed-status literal used by Wix bookings (note: Wix cancels as CANCELED). */
export const WIX_BOOKING_CONFIRMED = "CONFIRMED";

export type CourseAttendanceCategory =
  | "empty" // zero confirmed booking and capacity says nobody came
  | "all_no_show" // ≥1 confirmed booking, all explicitly NOT_ATTENDED, counts reconcile
  | "attended" // at least one confirmed booking marked ATTENDED
  | "incomplete" // missing/contradictory marking, unknown capacity, or divergence
  | "unavailable"; // a required Wix read failed — provisional data only

export interface CourseAttendance {
  category: CourseAttendanceCategory;
  /** Confirmed bookings on the event (cancelled bookings are ignored). */
  confirmedBookingCount: number;
  /** Sum of numberOfAttendees across ATTENDED records for confirmed bookings. */
  attendedCount: number;
  /** Count of confirmed bookings explicitly marked NOT_ATTENDED. */
  noShowCount: number;
  /** True when the category would drop the course from pay once enforcement is on. */
  autoExcludable: boolean;
  /** Human, French one-liner shown in the cockpit and the PDF. */
  reason: string;
}

export interface EventBookingInput {
  bookingId: string;
  /** Wix booking status (CONFIRMED / CANCELED / ...). */
  status: string;
  numberOfParticipants: number;
}

export interface EventAttendanceRecordInput {
  bookingId: string;
  /** ATTENDED / NOT_ATTENDED / other. */
  status: string;
  numberOfAttendees: number;
}

export interface EventAttendanceInput {
  /** Capacity-derived confirmed participants from Calendar V3 (may be null). */
  participantCount: number | null;
  bookings: EventBookingInput[];
  attendance: EventAttendanceRecordInput[];
}

const REASONS: Record<CourseAttendanceCategory, string> = {
  empty: "Aucune réservation",
  all_no_show: "Non-présentations uniquement",
  attended: "Présence confirmée",
  incomplete: "Présences incomplètes",
  unavailable: "Présences Wix indisponibles",
};

function verdict(
  category: CourseAttendanceCategory,
  parts: { confirmedBookingCount: number; attendedCount: number; noShowCount: number },
): CourseAttendance {
  return {
    category,
    confirmedBookingCount: parts.confirmedBookingCount,
    attendedCount: parts.attendedCount,
    noShowCount: parts.noShowCount,
    autoExcludable: category === "empty" || category === "all_no_show",
    reason: REASONS[category],
  };
}

/** Every course of a statement gets this verdict when the attendance/bookings
 * read failed: the calendar course stays visible and payable, but the sync is
 * marked failed upstream so validation is blocked. */
export function unavailableAttendance(participantCount: number | null): CourseAttendance {
  return verdict("unavailable", {
    confirmedBookingCount: 0,
    attendedCount: Math.max(0, participantCount ?? 0),
    noShowCount: 0,
  });
}

/**
 * Classify one non-cancelled event. Cancelled sessions are handled by the
 * existing wix_status path and never reach here.
 */
export function classifyEventAttendance(input: EventAttendanceInput): CourseAttendance {
  const confirmed = input.bookings.filter((b) => b.status === WIX_BOOKING_CONFIRMED);
  const confirmedIds = new Set(confirmed.map((b) => b.bookingId));

  // Group attendance records per confirmed booking; a booking can legitimately
  // carry a single record. Duplicates that disagree are a marking conflict.
  const byBooking = new Map<string, Set<string>>();
  const attendeesByBooking = new Map<string, number>();
  for (const rec of input.attendance) {
    if (!confirmedIds.has(rec.bookingId)) continue; // ignore attendance of cancelled bookings
    const set = byBooking.get(rec.bookingId) ?? new Set<string>();
    set.add(rec.status);
    byBooking.set(rec.bookingId, set);
    if (rec.status === "ATTENDED") {
      attendeesByBooking.set(
        rec.bookingId,
        (attendeesByBooking.get(rec.bookingId) ?? 0) + Math.max(0, rec.numberOfAttendees),
      );
    }
  }

  const attendedCount = [...attendeesByBooking.values()].reduce((a, b) => a + b, 0);
  const noShowCount = confirmed.filter((b) => {
    const statuses = byBooking.get(b.bookingId);
    return statuses ? statuses.has("NOT_ATTENDED") && !statuses.has("ATTENDED") : false;
  }).length;
  const parts = { confirmedBookingCount: confirmed.length, attendedCount, noShowCount };

  // 1. Anyone actually attended → the class was given → payable, no alert.
  if (attendedCount > 0) return verdict("attended", parts);

  // 2. No confirmed booking at all.
  if (confirmed.length === 0) {
    // Capacity must corroborate emptiness; unknown/positive capacity is a
    // Calendar/Bookings divergence → stay payable but flag it.
    return input.participantCount === 0
      ? verdict("empty", parts)
      : verdict("incomplete", parts);
  }

  // 3. Have confirmed bookings, none attended. Only a clean, fully-marked,
  //    capacity-consistent no-show set is auto-excludable.
  const everyBookingCleanlyNoShow = confirmed.every((b) => {
    const statuses = byBooking.get(b.bookingId);
    return Boolean(statuses) && statuses!.has("NOT_ATTENDED") && !statuses!.has("ATTENDED");
  });
  const bookedParticipants = confirmed.reduce(
    (sum, b) => sum + Math.max(0, b.numberOfParticipants),
    0,
  );
  const capacityConsistent =
    input.participantCount !== null && input.participantCount === bookedParticipants;

  if (everyBookingCleanlyNoShow && capacityConsistent) {
    return verdict("all_no_show", parts);
  }
  return verdict("incomplete", parts);
}

/** Minimal shape a course needs to receive an attendance verdict. */
export interface AttendanceClassifiable {
  wixEventId: string;
  wixStatus: string;
  participantCount: number | null;
}

/**
 * Attach an attendance verdict to each eligible course from the month's
 * per-event Wix reads. Cancelled courses keep no verdict — the existing
 * wix_status path handles them. Pass `available: false` when a required read
 * failed: every non-cancelled course then gets the `unavailable` verdict so the
 * calendar course stays visible while validation is blocked upstream.
 */
export function classifyCourses<T extends AttendanceClassifiable>(
  courses: T[],
  input: { bookings: WixEventBooking[]; attendance: WixEventAttendanceRecord[]; available: boolean },
): Array<T & { attendance?: CourseAttendance }> {
  const bookingsByEvent = new Map<string, EventBookingInput[]>();
  const attendanceByEvent = new Map<string, EventAttendanceRecordInput[]>();
  if (input.available) {
    for (const b of input.bookings) {
      if (!b.eventId) continue;
      const list = bookingsByEvent.get(b.eventId) ?? [];
      list.push({ bookingId: b.bookingId, status: b.status, numberOfParticipants: b.numberOfParticipants });
      bookingsByEvent.set(b.eventId, list);
    }
    for (const a of input.attendance) {
      if (!a.eventId) continue;
      const list = attendanceByEvent.get(a.eventId) ?? [];
      list.push({ bookingId: a.bookingId, status: a.status, numberOfAttendees: a.numberOfAttendees });
      attendanceByEvent.set(a.eventId, list);
    }
  }
  return courses.map((course) => {
    if (course.wixStatus === "CANCELLED") return { ...course };
    if (!input.available) {
      return { ...course, attendance: unavailableAttendance(course.participantCount) };
    }
    return {
      ...course,
      attendance: classifyEventAttendance({
        participantCount: course.participantCount,
        bookings: bookingsByEvent.get(course.wixEventId) ?? [],
        attendance: attendanceByEvent.get(course.wixEventId) ?? [],
      }),
    };
  });
}
