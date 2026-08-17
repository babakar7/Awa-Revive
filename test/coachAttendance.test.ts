import { describe, expect, it } from "vitest";
import {
  classifyCourses,
  classifyEventAttendance,
  unavailableAttendance,
  type EventAttendanceInput,
} from "../src/domain/coachAttendance.js";
import type {
  WixEventAttendanceRecord,
  WixEventBooking,
} from "../src/lib/wix.js";

function booking(bookingId: string, participants = 1, status = "CONFIRMED"): WixEventBooking {
  return { bookingId, eventId: "evt", status, numberOfParticipants: participants };
}
function attendance(
  bookingId: string,
  status: string,
  numberOfAttendees = 1,
): WixEventAttendanceRecord {
  return { bookingId, eventId: "evt", status, numberOfAttendees };
}

function classify(partial: Partial<EventAttendanceInput>) {
  return classifyEventAttendance({
    participantCount: partial.participantCount ?? null,
    bookings: partial.bookings ?? [],
    attendance: partial.attendance ?? [],
  });
}

describe("classifyEventAttendance", () => {
  it("empty: zero confirmed booking and capacity 0 → auto-excludable", () => {
    const v = classify({ participantCount: 0, bookings: [], attendance: [] });
    expect(v.category).toBe("empty");
    expect(v.autoExcludable).toBe(true);
    expect(v.reason).toBe("Aucune réservation");
  });

  it("all_no_show: two confirmed bookings both NOT_ATTENDED, capacity consistent → auto-excludable", () => {
    const v = classify({
      participantCount: 2,
      bookings: [booking("b1"), booking("b2")],
      attendance: [attendance("b1", "NOT_ATTENDED", 0), attendance("b2", "NOT_ATTENDED", 0)],
    });
    expect(v.category).toBe("all_no_show");
    expect(v.autoExcludable).toBe(true);
    expect(v.noShowCount).toBe(2);
    expect(v.attendedCount).toBe(0);
  });

  it("attended: one ATTENDED, one NOT_ATTENDED → paid, not auto-excludable", () => {
    const v = classify({
      participantCount: 2,
      bookings: [booking("b1"), booking("b2")],
      attendance: [attendance("b1", "ATTENDED", 1), attendance("b2", "NOT_ATTENDED", 0)],
    });
    expect(v.category).toBe("attended");
    expect(v.autoExcludable).toBe(false);
    expect(v.attendedCount).toBe(1);
    expect(v.noShowCount).toBe(1);
  });

  it("NOT_ATTENDED counts by booking status even when numberOfAttendees is 0", () => {
    const v = classify({
      participantCount: 1,
      bookings: [booking("b1")],
      attendance: [attendance("b1", "NOT_ATTENDED", 0)],
    });
    expect(v.category).toBe("all_no_show");
    expect(v.noShowCount).toBe(1);
  });

  it("incomplete: a confirmed booking has no attendance record at all", () => {
    const v = classify({
      participantCount: 2,
      bookings: [booking("b1"), booking("b2")],
      attendance: [attendance("b1", "NOT_ATTENDED", 0)],
    });
    expect(v.category).toBe("incomplete");
    expect(v.autoExcludable).toBe(false);
  });

  it("incomplete: capacity null even if all marked NOT_ATTENDED (no auto-exclusion)", () => {
    const v = classify({
      participantCount: null,
      bookings: [booking("b1")],
      attendance: [attendance("b1", "NOT_ATTENDED", 0)],
    });
    expect(v.category).toBe("incomplete");
  });

  it("incomplete: capacity diverges from booked participants", () => {
    const v = classify({
      participantCount: 3, // calendar says 3, only 1 confirmed participant booked
      bookings: [booking("b1", 1)],
      attendance: [attendance("b1", "NOT_ATTENDED", 0)],
    });
    expect(v.category).toBe("incomplete");
  });

  it("incomplete: zero bookings but positive capacity is a divergence, not empty", () => {
    const v = classify({ participantCount: 2, bookings: [], attendance: [] });
    expect(v.category).toBe("incomplete");
  });

  it("incomplete: contradictory duplicate records for the same booking", () => {
    const v = classify({
      participantCount: 1,
      bookings: [booking("b1")],
      attendance: [attendance("b1", "ATTENDED", 0), attendance("b1", "NOT_ATTENDED", 0)],
    });
    // No ATTENDED with attendees>0, and the booking is not cleanly no-show.
    expect(v.category).toBe("incomplete");
  });

  it("cancelled bookings are ignored when building coverage", () => {
    const v = classify({
      participantCount: 1,
      bookings: [booking("b1", 1, "CONFIRMED"), booking("b2", 1, "CANCELED")],
      attendance: [attendance("b1", "NOT_ATTENDED", 0), attendance("b2", "NOT_ATTENDED", 0)],
    });
    // Only b1 is confirmed; capacity 1 matches; all confirmed no-show.
    expect(v.category).toBe("all_no_show");
    expect(v.confirmedBookingCount).toBe(1);
  });

  it("multi-participant booking: capacity must equal summed participants", () => {
    const v = classify({
      participantCount: 3,
      bookings: [booking("b1", 3)],
      attendance: [attendance("b1", "NOT_ATTENDED", 0)],
    });
    expect(v.category).toBe("all_no_show");
  });
});

describe("classifyCourses", () => {
  const base = { wixEventId: "e1", wixStatus: "CONFIRMED", participantCount: 0 };

  it("attaches a verdict to non-cancelled courses", () => {
    const [c] = classifyCourses([base], { bookings: [], attendance: [], available: true });
    expect(c.attendance?.category).toBe("empty");
  });

  it("leaves cancelled courses without a verdict (handled by wix_status path)", () => {
    const [c] = classifyCourses(
      [{ wixEventId: "e1", wixStatus: "CANCELLED", participantCount: null }],
      { bookings: [], attendance: [], available: true },
    );
    expect(c.attendance).toBeUndefined();
  });

  it("marks every non-cancelled course unavailable when a read failed", () => {
    const [c] = classifyCourses([{ ...base, participantCount: 5 }], {
      bookings: [],
      attendance: [],
      available: false,
    });
    expect(c.attendance?.category).toBe("unavailable");
    expect(c.attendance?.autoExcludable).toBe(false);
  });

  it("routes bookings/attendance to the right event by eventId", () => {
    const bookings: WixEventBooking[] = [
      { bookingId: "b1", eventId: "e1", status: "CONFIRMED", numberOfParticipants: 1 },
      { bookingId: "b2", eventId: "e2", status: "CONFIRMED", numberOfParticipants: 1 },
    ];
    const att: WixEventAttendanceRecord[] = [
      { bookingId: "b1", eventId: "e1", status: "ATTENDED", numberOfAttendees: 1 },
      { bookingId: "b2", eventId: "e2", status: "NOT_ATTENDED", numberOfAttendees: 0 },
    ];
    const result = classifyCourses(
      [
        { wixEventId: "e1", wixStatus: "CONFIRMED", participantCount: 1 },
        { wixEventId: "e2", wixStatus: "CONFIRMED", participantCount: 1 },
      ],
      { bookings, attendance: att, available: true },
    );
    expect(result[0].attendance?.category).toBe("attended");
    expect(result[1].attendance?.category).toBe("all_no_show");
  });
});

describe("unavailableAttendance", () => {
  it("is never auto-excludable", () => {
    expect(unavailableAttendance(3).autoExcludable).toBe(false);
    expect(unavailableAttendance(null).category).toBe("unavailable");
  });
});
