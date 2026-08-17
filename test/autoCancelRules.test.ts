import { describe, expect, it } from "vitest";
import {
  cancelConfigAlertDedupKey,
  cancelNotifyDedupKey,
  dakarWeekday,
  eligibilityStart,
  isEmpty,
  isEmptyLongEnough,
  isMorningClass,
  isWithinWindow,
  matchesRule,
  nextEmptyTimer,
  planningWeekdayOf,
  windowEnd,
  type AutoCancelRule,
} from "../src/domain/autoCancelRules.js";

// Dakar == UTC year-round; all ISO instants below are effectively local Dakar.

const rule = (over: Partial<AutoCancelRule> = {}): AutoCancelRule => ({
  id: "r1",
  label: "test",
  enabled: true,
  service_ids: ["svc-1"],
  weekdays: [],
  start_min_from: null,
  start_min_to: null,
  alert_opener: false,
  ...over,
});

describe("cutoff calculation", () => {
  it("treats 09:15 as a morning class (inclusive boundary)", () => {
    expect(isMorningClass("2026-08-24T09:15:00.000Z")).toBe(true);
    expect(isMorningClass("2026-08-24T09:16:00.000Z")).toBe(false);
    expect(isMorningClass("2026-08-24T07:00:00.000Z")).toBe(true);
  });

  it("morning class becomes eligible at 23:00 the previous day", () => {
    // 07:00 on the 24th → eligible from 23:00 on the 23rd.
    expect(eligibilityStart("2026-08-24T07:00:00.000Z").toISOString()).toBe(
      "2026-08-23T23:00:00.000Z",
    );
  });

  it("morning class just after midnight still points to the previous evening", () => {
    // 09:15 on the 1st → 23:00 on the previous day (crossing the month boundary).
    expect(eligibilityStart("2026-09-01T09:15:00.000Z").toISOString()).toBe(
      "2026-08-31T23:00:00.000Z",
    );
  });

  it("daytime class becomes eligible 3 hours before start", () => {
    expect(eligibilityStart("2026-08-24T18:00:00.000Z").toISOString()).toBe(
      "2026-08-24T15:00:00.000Z",
    );
  });

  it("window ends at start minus the min-notice", () => {
    expect(windowEnd("2026-08-24T18:00:00.000Z", 120).toISOString()).toBe(
      "2026-08-24T16:00:00.000Z",
    );
  });
});

describe("cancellation window", () => {
  it("a daytime class is in-window between start-3h and start-2h", () => {
    const start = "2026-08-24T18:00:00.000Z";
    // start-2h30 → in window
    expect(isWithinWindow(start, new Date("2026-08-24T15:30:00.000Z"), 120)).toBe(true);
    // start-3h05 (before eligibility) → out
    expect(isWithinWindow(start, new Date("2026-08-24T14:55:00.000Z"), 120)).toBe(false);
    // start-1h55 (past the 2h floor) → out
    expect(isWithinWindow(start, new Date("2026-08-24T16:05:00.000Z"), 120)).toBe(false);
  });

  it("a morning class is in-window from 23:00 the night before to start-2h", () => {
    const start = "2026-08-24T07:00:00.000Z";
    expect(isWithinWindow(start, new Date("2026-08-23T23:30:00.000Z"), 120)).toBe(true);
    expect(isWithinWindow(start, new Date("2026-08-24T04:30:00.000Z"), 120)).toBe(true);
    expect(isWithinWindow(start, new Date("2026-08-24T05:30:00.000Z"), 120)).toBe(false); // past floor
  });
});

describe("rule matching", () => {
  it("matches service id, weekday and start-time range", () => {
    // 2026-08-24 is a Monday → getUTCDay 1.
    expect(dakarWeekday("2026-08-24T09:00:00.000Z")).toBe(1);
    const r = rule({ weekdays: [1], start_min_from: 8 * 60, start_min_to: 10 * 60 });
    expect(matchesRule(r, { serviceId: "svc-1", startIso: "2026-08-24T09:00:00.000Z" })).toBe(true);
    // wrong service
    expect(matchesRule(r, { serviceId: "svc-2", startIso: "2026-08-24T09:00:00.000Z" })).toBe(false);
    // wrong weekday (Tuesday)
    expect(matchesRule(r, { serviceId: "svc-1", startIso: "2026-08-25T09:00:00.000Z" })).toBe(false);
    // outside time range (11:00)
    expect(matchesRule(r, { serviceId: "svc-1", startIso: "2026-08-24T11:00:00.000Z" })).toBe(false);
  });

  it("empty weekdays = every day, null time range = any hour", () => {
    const r = rule();
    expect(matchesRule(r, { serviceId: "svc-1", startIso: "2026-08-25T22:00:00.000Z" })).toBe(true);
  });

  it("planningWeekdayOf maps to the staff-grid Monday=0 convention", () => {
    // 2026-08-24 is a Monday → getUTCDay 1 → planning 0.
    expect(planningWeekdayOf("2026-08-24T07:00:00.000Z")).toBe(0);
    // Sunday 2026-08-23 → getUTCDay 0 → planning 6.
    expect(planningWeekdayOf("2026-08-23T07:00:00.000Z")).toBe(6);
    // Saturday 2026-08-22 → getUTCDay 6 → planning 5.
    expect(planningWeekdayOf("2026-08-22T07:00:00.000Z")).toBe(5);
  });

  it("matches ANY of several targeted services (multi-service rule)", () => {
    const r = rule({ service_ids: ["reformer-foundation", "reformer-intense", "reformer-sculpt"] });
    expect(matchesRule(r, { serviceId: "reformer-intense", startIso: "2026-08-24T09:00:00.000Z" })).toBe(true);
    expect(matchesRule(r, { serviceId: "reformer-sculpt", startIso: "2026-08-24T09:00:00.000Z" })).toBe(true);
    expect(matchesRule(r, { serviceId: "aquabike", startIso: "2026-08-24T09:00:00.000Z" })).toBe(false);
  });
});

describe("emptiness", () => {
  it("empty only when exactly zero confirmed participants", () => {
    expect(isEmpty({ participantCount: 0 })).toBe(true);
    expect(isEmpty({ participantCount: 1 })).toBe(false);
  });
  it("unknown capacity is NOT empty (fail-closed)", () => {
    expect(isEmpty({ participantCount: null })).toBe(false);
  });
});

describe("empty-timer continuity", () => {
  const now = new Date("2026-08-24T15:30:00.000Z");

  it("starts the timer when first observed empty", () => {
    expect(
      nextEmptyTimer({ now, isCurrentlyEmpty: true, hasActivePayment: false, priorFirstEmptyAt: null, priorLastObservedAt: null }),
    ).toEqual(now);
  });

  it("keeps the original start while observations stay continuous", () => {
    const first = new Date("2026-08-24T15:20:00.000Z");
    const last = new Date("2026-08-24T15:29:00.000Z"); // 1 min ago
    expect(
      nextEmptyTimer({ now, isCurrentlyEmpty: true, hasActivePayment: false, priorFirstEmptyAt: first, priorLastObservedAt: last }),
    ).toEqual(first);
  });

  it("restarts the timer after an observation gap > 2 min (deploy/restart)", () => {
    const first = new Date("2026-08-24T15:10:00.000Z");
    const last = new Date("2026-08-24T15:26:00.000Z"); // 4 min ago
    expect(
      nextEmptyTimer({ now, isCurrentlyEmpty: true, hasActivePayment: false, priorFirstEmptyAt: first, priorLastObservedAt: last }),
    ).toEqual(now);
  });

  it("clears the timer when not empty or a payment is active", () => {
    const first = new Date("2026-08-24T15:20:00.000Z");
    expect(
      nextEmptyTimer({ now, isCurrentlyEmpty: false, hasActivePayment: false, priorFirstEmptyAt: first, priorLastObservedAt: first }),
    ).toBeNull();
    expect(
      nextEmptyTimer({ now, isCurrentlyEmpty: true, hasActivePayment: true, priorFirstEmptyAt: first, priorLastObservedAt: first }),
    ).toBeNull();
  });

  it("requires a full 15 minutes of continuous emptiness", () => {
    const start = new Date("2026-08-24T15:16:00.000Z"); // 14 min ago
    expect(isEmptyLongEnough(start, now)).toBe(false);
    const start2 = new Date("2026-08-24T15:15:00.000Z"); // exactly 15 min ago
    expect(isEmptyLongEnough(start2, now)).toBe(true);
    expect(isEmptyLongEnough(null, now)).toBe(false);
  });
});

describe("dedup keys", () => {
  it("notice key is per (occurrence, phone)", () => {
    expect(cancelNotifyDedupKey("ev1", "221771112233")).toBe("autocancel:notify:ev1:221771112233");
    expect(cancelNotifyDedupKey("ev1", "221770000000")).not.toBe(
      cancelNotifyDedupKey("ev1", "221771112233"),
    );
  });
  it("config-alert key is one per occurrence", () => {
    expect(cancelConfigAlertDedupKey("ev1")).toBe("autocancel:config:ev1");
  });
});
