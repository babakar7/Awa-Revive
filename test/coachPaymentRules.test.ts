import { describe, expect, it } from "vitest";
import {
  computePaymentTotals,
  monthBounds,
  monthIsClosed,
  selectEligibleReformerEvents,
  validateManualCourseDate,
  type CoachTariff,
} from "../src/domain/coachPaymentRules.js";
import type { WixCalendarEvent, WixService } from "../src/lib/wix.js";

const yass: CoachTariff = { type: "monthly_ratio", baseAmountXof: 800_000, baseSessionCount: 84 };
const leslie: CoachTariff = { type: "per_session", perSessionXof: 9_000 };

describe("coach payment calculations", () => {
  it("applies Yass's rounded monthly ratio", () => {
    expect(computePaymentTotals(84, yass, []).totalXof).toBe(800_000);
    expect(computePaymentTotals(80, yass, []).totalXof).toBe(761_905);
    expect(computePaymentTotals(90, yass, []).totalXof).toBe(857_143);
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
    ).toEqual({ courseCount: 10, baseTotalXof: 90_000, adjustmentTotalXof: 10_500, totalXof: 100_500 });
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
    { id: "yoga-1", name: "Yoga", description: "", priceXof: null, durationMinutes: 60, maxParticipantsPerBooking: 1, pricingPlanIds: [], type: "CLASS" },
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
    resources: [{ id: "coach-yass", name: "Yass", type: "staff" }],
    raw: { snapshot: true },
    ...overrides,
  });

  it("keeps only finished, confirmed Reformer events assigned to the coach and deduplicates Wix ids", () => {
    const eligible = selectEligibleReformerEvents({
      services,
      coachResourceId: "coach-yass",
      month: "2026-06",
      now: new Date("2026-07-01T00:00:00Z"),
      events: [
        event(),
        event(),
        event({ id: "cancelled", status: "CANCELLED" }),
        event({ id: "future", startDate: "2026-06-30T23:30:00", endDate: "2026-07-01T00:20:00" }),
        event({ id: "wrong-service", serviceId: "yoga-1", serviceName: "Yoga", title: "Yoga" }),
        event({ id: "wrong-coach", resources: [{ id: "coach-leslie", name: "Leslie", type: "staff" }] }),
        event({ id: "wrong-month", startDate: "2026-07-01T00:00:00", endDate: "2026-07-01T00:50:00" }),
      ],
    });
    expect(eligible.map((e) => e.wixEventId)).toEqual(["event-1"]);
  });

  it("does not count an event that has not ended yet", () => {
    const eligible = selectEligibleReformerEvents({
      services,
      coachResourceId: "coach-yass",
      month: "2026-06",
      now: new Date("2026-06-10T10:30:00Z"),
      events: [event()],
    });
    expect(eligible).toHaveLength(0);
  });
});
