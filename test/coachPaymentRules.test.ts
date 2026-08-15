import { describe, expect, it } from "vitest";
import {
  computeHolidayBonus,
  computePaymentTotals,
  isCoachPaymentServiceName,
  monthBounds,
  monthIsClosed,
  selectEligibleCoachPaymentEvents,
  validateManualCourseDate,
  type CoachTariff,
} from "../src/domain/coachPaymentRules.js";
import type { WixCalendarEvent, WixService } from "../src/lib/wix.js";

const yass: CoachTariff = { type: "per_session", perSessionXof: 9_500 };
const monthlyRatio: CoachTariff = { type: "monthly_ratio", baseAmountXof: 800_000, baseSessionCount: 84 };
const leslie: CoachTariff = { type: "per_session", perSessionXof: 9_000 };

describe("coach payment calculations", () => {
  it("applies Yass's 9,500 FCFA per-class rate", () => {
    expect(computePaymentTotals(83, yass, [])).toEqual({
      courseCount: 83,
      baseTotalXof: 788_500,
      holidayCourseCount: 0,
      holidayBonusXof: 0,
      adjustmentTotalXof: 0,
      totalXof: 788_500,
    });
  });

  it("still supports rounded monthly ratios for other profiles", () => {
    expect(computePaymentTotals(84, monthlyRatio, []).totalXof).toBe(800_000);
    expect(computePaymentTotals(80, monthlyRatio, []).totalXof).toBe(761_905);
    expect(computePaymentTotals(90, monthlyRatio, []).totalXof).toBe(857_143);
  });

  it("applies Leslie's per-class rate", () => {
    expect(computePaymentTotals(10, leslie, []).totalXof).toBe(90_000);
  });

  it("adds bonuses, subtracts deductions and keeps integer FCFA", () => {
    expect(
      computePaymentTotals(10, leslie, [
        { kind: "bonus", amount_xof: 12_500 },
        { kind: "deduction", amount_xof: 2_000 },
      ]),
    ).toEqual({
      courseCount: 10,
      baseTotalXof: 90_000,
      holidayCourseCount: 0,
      holidayBonusXof: 0,
      adjustmentTotalXof: 10_500,
      totalXof: 100_500,
    });
  });
});

describe("public-holiday +50% markup", () => {
  it("adds a 50% bonus per holiday course under a per-session tariff", () => {
    const totals = computePaymentTotals(10, leslie, [], 2);
    expect(totals.baseTotalXof).toBe(90_000);
    expect(totals.holidayCourseCount).toBe(2);
    expect(totals.holidayBonusXof).toBe(9_000);
    expect(totals.totalXof).toBe(99_000);
  });

  it("rounds the aggregate bonus once, not per course", () => {
    // 3 × 9 001 × 0.5 = 13 501.5 → 13 502 as a single rounding.
    const oddRate: CoachTariff = { type: "per_session", perSessionXof: 9_001 };
    expect(computeHolidayBonus(3, oddRate)).toBe(13_502);
    expect(computePaymentTotals(3, oddRate, [], 3).holidayBonusXof).toBe(13_502);
  });

  it("rounds the monthly-ratio bonus on the aggregate", () => {
    // 7 × 800 000 × 0.5 / 84 = 33 333.33 → 33 333 once (per-course would give 33 334).
    const totals = computePaymentTotals(7, monthlyRatio, [], 7);
    expect(totals.holidayBonusXof).toBe(33_333);
    expect(computeHolidayBonus(1, monthlyRatio)).toBe(4_762);
  });

  it("leaves totals unchanged when there is no holiday course", () => {
    const totals = computePaymentTotals(10, leslie, []);
    expect(totals.holidayCourseCount).toBe(0);
    expect(totals.holidayBonusXof).toBe(0);
    expect(totals.totalXof).toBe(90_000);
  });

  it("combines the holiday bonus with adjustments", () => {
    const totals = computePaymentTotals(10, leslie, [{ kind: "deduction", amount_xof: 5_000 }], 2);
    expect(totals.totalXof).toBe(90_000 + 9_000 - 5_000);
  });

  it("rejects a holiday count that is negative or exceeds the course count", () => {
    expect(() => computePaymentTotals(5, leslie, [], -1)).toThrow(/férié/i);
    expect(() => computePaymentTotals(5, leslie, [], 6)).toThrow(/férié/i);
  });
});

describe("Dakar civil-month boundaries", () => {
  it("uses inclusive month start and exclusive next-month start", () => {
    const bounds = monthBounds("2026-06");
    expect(bounds.start.toISOString()).toBe("2026-06-01T00:00:00.000Z");
    expect(bounds.end.toISOString()).toBe("2026-07-01T00:00:00.000Z");
    expect(monthIsClosed("2026-06", new Date("2026-06-30T23:59:59.999Z"))).toBe(false);
    expect(monthIsClosed("2026-06", new Date("2026-07-01T00:00:00.000Z"))).toBe(true);
  });

  it("rejects future and out-of-month manual sessions", () => {
    const now = new Date("2026-07-20T12:00:00Z");
    expect(validateManualCourseDate("2026-07", new Date("2026-07-20T11:00:00Z"), now)).toBeNull();
    expect(validateManualCourseDate("2026-07", new Date("2026-07-21T11:00:00Z"), now)).toMatch(/futur/i);
    expect(validateManualCourseDate("2026-07", new Date("2026-06-30T23:59:59Z"), now)).toMatch(/mois/i);
  });
});

describe("Calendar V3 event eligibility", () => {
  const services: WixService[] = [
    { id: "reformer-1", name: "Pilates Reformer", description: "", priceXof: null, durationMinutes: 50, maxParticipantsPerBooking: 1, pricingPlanIds: [], type: "CLASS" },
    { id: "mat-1", name: "Pilates Mat", description: "", priceXof: null, durationMinutes: 50, maxParticipantsPerBooking: 1, pricingPlanIds: [], type: "CLASS" },
    { id: "yoga-1", name: "Yoga", description: "", priceXof: null, durationMinutes: 60, maxParticipantsPerBooking: 1, pricingPlanIds: [], type: "CLASS" },
    { id: "privee-1", name: "Séance privée", description: "", priceXof: null, durationMinutes: 50, maxParticipantsPerBooking: 1, pricingPlanIds: [], type: "APPOINTMENT" },
  ];
  const event = (overrides: Partial<WixCalendarEvent> = {}): WixCalendarEvent => ({
    id: "event-1",
    serviceId: "reformer-1",
    serviceName: "Pilates Reformer",
    title: "Pilates Reformer",
    type: "CLASS",
    status: "CONFIRMED",
    startDate: "2026-06-10T10:00:00",
    endDate: "2026-06-10T10:50:00",
    participantCount: null,
    resources: [{ id: "coach-yass", name: "Yass", type: "staff" }],
    raw: { snapshot: true },
    ...overrides,
  });

  it("keeps finished confirmed and cancelled Reformer events assigned to the coach and deduplicates Wix ids", () => {
    const eligible = selectEligibleCoachPaymentEvents({
      services,
      coachResourceId: "coach-yass",
      month: "2026-06",
      now: new Date("2026-07-01T00:00:00Z"),
      events: [
        event(),
        event(),
        event({
          id: "cancelled",
          status: "CANCELLED",
          startDate: "2026-06-11T10:00:00",
          endDate: "2026-06-11T10:50:00",
        }),
        event({ id: "unknown-status", status: "PENDING" }),
        event({ id: "future", startDate: "2026-06-30T23:30:00", endDate: "2026-07-01T00:20:00" }),
        event({ id: "wrong-service", serviceId: "yoga-1", serviceName: "Yoga", title: "Yoga" }),
        event({ id: "wrong-coach", resources: [{ id: "coach-leslie", name: "Leslie", type: "staff" }] }),
        event({ id: "wrong-month", startDate: "2026-07-01T00:00:00", endDate: "2026-07-01T00:50:00" }),
      ],
    });
    expect(eligible.map((e) => [e.wixEventId, e.wixStatus])).toEqual([
      ["event-1", "CONFIRMED"],
      ["cancelled", "CANCELLED"],
    ]);
  });

  it("keeps an empty session included and carries its zero-participant flag", () => {
    const eligible = selectEligibleCoachPaymentEvents({
      services,
      coachResourceId: "coach-yass",
      month: "2026-06",
      now: new Date("2026-07-01T00:00:00Z"),
      events: [event({ participantCount: 0 })],
    });
    expect(eligible).toHaveLength(1);
    expect(eligible[0].participantCount).toBe(0);
  });

  it("does not count an event that has not ended yet", () => {
    const eligible = selectEligibleCoachPaymentEvents({
      services,
      coachResourceId: "coach-yass",
      month: "2026-06",
      now: new Date("2026-06-10T10:30:00Z"),
      events: [event()],
    });
    expect(eligible).toHaveLength(0);
  });

  it("counts Pilates Mat with exactly the same per-class tariff as Reformer", () => {
    const eligible = selectEligibleCoachPaymentEvents({
      services,
      coachResourceId: "coach-yass",
      month: "2026-06",
      now: new Date("2026-07-01T00:00:00Z"),
      events: [
        event(),
        event({
          id: "mat-event",
          serviceId: "mat-1",
          serviceName: "Pilates Mat",
          title: "Pilates Mat",
          startDate: "2026-06-11T10:00:00",
          endDate: "2026-06-11T10:50:00",
        }),
      ],
    });

    expect(eligible.map((course) => course.serviceName)).toEqual([
      "Pilates Reformer",
      "Pilates Mat",
    ]);
    expect(computePaymentTotals(eligible.length, yass, []).baseTotalXof).toBe(19_000);
  });

  it("counts a séance privée appointment at the same per-class tariff", () => {
    const eligible = selectEligibleCoachPaymentEvents({
      services,
      coachResourceId: "coach-yass",
      month: "2026-06",
      now: new Date("2026-07-01T00:00:00Z"),
      events: [
        event(),
        event({
          id: "privee-event",
          type: "APPOINTMENT",
          serviceId: "privee-1",
          serviceName: "Séance privée",
          title: "Séance privée",
          participantCount: 1,
          startDate: "2026-06-12T09:00:00",
          endDate: "2026-06-12T09:50:00",
        }),
      ],
    });

    expect(eligible.map((course) => course.serviceName)).toEqual([
      "Pilates Reformer",
      "Séance privée",
    ]);
    expect(computePaymentTotals(eligible.length, yass, []).baseTotalXof).toBe(19_000);
  });
});

describe("coach payment service name matching", () => {
  it("recognizes Reformer, Pilates Mat and private sessions", () => {
    expect(isCoachPaymentServiceName("Pilates Reformer")).toBe(true);
    expect(isCoachPaymentServiceName("Pilates Mat")).toBe(true);
    expect(isCoachPaymentServiceName("Séance privée")).toBe(true);
    expect(isCoachPaymentServiceName("Séances privées")).toBe(true);
    expect(isCoachPaymentServiceName("SEANCE PRIVEE")).toBe(true);
    expect(isCoachPaymentServiceName("Yoga")).toBe(false);
    expect(isCoachPaymentServiceName("Séance découverte")).toBe(false);
  });
});
