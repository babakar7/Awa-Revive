import { describe, expect, it } from "vitest";
import {
  isReformerOrMat,
  levelFromClassName,
  nextFullWeekBounds,
  slotsFromCalendarEvents,
  validateClassGridPayload,
} from "../src/domain/classPlanningRules.js";
import type { WixCalendarEvent } from "../src/lib/wix.js";

describe("levelFromClassName", () => {
  it("derives level from the name, accent/case-insensitive", () => {
    expect(levelFromClassName("Pilates Reformer (Foundation)")).toBe("foundation");
    expect(levelFromClassName("Pilates Reformer (Sculpt)")).toBe("sculpt");
    expect(levelFromClassName("PILATES REFORMER INTENSE")).toBe("intense");
    expect(levelFromClassName("Pilates Mat")).toBe("other");
    expect(levelFromClassName("Aquabike")).toBe("other");
  });
});

describe("isReformerOrMat", () => {
  it("keeps Reformer and Mat, rejects the rest", () => {
    expect(isReformerOrMat("Pilates Reformer (Sculpt)")).toBe(true);
    expect(isReformerOrMat("Pilates Mat")).toBe(true);
    expect(isReformerOrMat("MAT flow")).toBe(true);
    expect(isReformerOrMat("Aquabike (Intermédiaire)")).toBe(false);
    expect(isReformerOrMat("Bébé Nageur")).toBe(false);
    // "mat" must be a whole word, not a substring of "climat"/"format"
    expect(isReformerOrMat("Formation climat")).toBe(false);
  });
});

describe("validateClassGridPayload", () => {
  const ok = {
    slots: [
      { weekday: 0, start_min: 435, duration_min: 50, coach_name: "Leslie", class_name: "Pilates Reformer (Sculpt)" },
    ],
  };

  it("accepts a well-formed grid and defaults duration/ids", () => {
    const r = validateClassGridPayload(JSON.stringify({ slots: [{ weekday: 3, start_min: 1155, coach_name: "Yass", class_name: "Reformer" }] }));
    expect("slots" in r).toBe(true);
    if ("slots" in r) {
      expect(r.slots[0]).toMatchObject({ weekday: 3, start_min: 1155, duration_min: 50, coach_wix_id: null, class_wix_id: null });
    }
  });

  it("rejects invalid JSON, weekday, time, duration and empty names", () => {
    expect("error" in validateClassGridPayload("{")).toBe(true);
    expect("error" in validateClassGridPayload(JSON.stringify({ slots: [{ ...ok.slots[0], weekday: 7 }] }))).toBe(true);
    expect("error" in validateClassGridPayload(JSON.stringify({ slots: [{ ...ok.slots[0], start_min: 1500 }] }))).toBe(true);
    expect("error" in validateClassGridPayload(JSON.stringify({ slots: [{ ...ok.slots[0], duration_min: 5 }] }))).toBe(true);
    expect("error" in validateClassGridPayload(JSON.stringify({ slots: [{ ...ok.slots[0], coach_name: "  " }] }))).toBe(true);
    expect("error" in validateClassGridPayload(JSON.stringify({ slots: [{ ...ok.slots[0], class_name: "x".repeat(81) }] }))).toBe(true);
  });

  it("rejects two classes for the same coach at the same weekday+time", () => {
    const dup = { slots: [ok.slots[0], { ...ok.slots[0] }] };
    const r = validateClassGridPayload(JSON.stringify(dup));
    expect("error" in r).toBe(true);
  });

  it("allows the same time for DIFFERENT coaches (parallel rooms)", () => {
    const r = validateClassGridPayload(
      JSON.stringify({ slots: [ok.slots[0], { ...ok.slots[0], coach_name: "Alou", class_name: "Aquabike" }] }),
    );
    expect("slots" in r).toBe(true);
  });

  it("caps the number of slots", () => {
    const many = { slots: Array.from({ length: 121 }, (_, i) => ({ weekday: i % 7, start_min: i, duration_min: 50, coach_name: "C" + i, class_name: "Reformer" })) };
    expect("error" in validateClassGridPayload(JSON.stringify(many))).toBe(true);
  });
});

describe("nextFullWeekBounds", () => {
  it("returns the upcoming Monday 00:00 → the following Monday, exclusive", () => {
    // Tuesday 2026-08-11 → week of Mon 17 Aug .. Mon 24 Aug (exclusive).
    const b = nextFullWeekBounds(new Date("2026-08-11T09:00:00Z"));
    expect(b.fromLocalDate).toBe("2026-08-17T00:00:00");
    expect(b.toLocalDate).toBe("2026-08-24T00:00:00");
    expect(b.label).toBe("Semaine du 17/08");
  });

  it("on a Monday, targets the NEXT Monday (never today)", () => {
    // Monday 2026-08-17 → next week Mon 24 Aug.
    const b = nextFullWeekBounds(new Date("2026-08-17T06:00:00Z"));
    expect(b.fromLocalDate).toBe("2026-08-24T00:00:00");
    expect(b.toLocalDate).toBe("2026-08-31T00:00:00");
  });

  it("on a Sunday, targets the very next day", () => {
    // Sunday 2026-08-16 → Mon 17 Aug.
    const b = nextFullWeekBounds(new Date("2026-08-16T20:00:00Z"));
    expect(b.fromLocalDate).toBe("2026-08-17T00:00:00");
  });
});

describe("slotsFromCalendarEvents", () => {
  function ev(over: Partial<WixCalendarEvent>): WixCalendarEvent {
    return {
      id: "e1",
      serviceId: "svc1",
      serviceName: "Pilates Reformer (Sculpt)",
      title: "Pilates Reformer (Sculpt)",
      type: "CLASS",
      status: "CONFIRMED",
      startDate: "2026-08-17T09:15:00",
      endDate: "2026-08-17T10:05:00",
      participantCount: null,
      resources: [{ id: "r-coach", name: "Yass", type: "uuid-type" }],
      raw: {},
      ...over,
    };
  }

  it("maps local time to weekday 0=Monday and computes duration", () => {
    const [s] = slotsFromCalendarEvents([ev({})], new Set(["r-coach"]));
    expect(s).toMatchObject({
      weekday: 0, // Monday
      start_min: 555, // 9h15
      duration_min: 50,
      coach_name: "Yass",
      class_name: "Pilates Reformer (Sculpt)",
      coach_wix_id: "r-coach",
      class_wix_id: "svc1",
    });
  });

  it("prefers the resource whose id is a known staff resource", () => {
    const e = ev({ resources: [{ id: "room-1", name: "Salle", type: "t" }, { id: "r-coach", name: "Yass", type: "t" }] });
    const [s] = slotsFromCalendarEvents([e], new Set(["r-coach"]));
    expect(s.coach_name).toBe("Yass");
  });

  it("falls back to the first resource when none is a known staff id", () => {
    const e = ev({ resources: [{ id: "x", name: "Quelqu'un", type: "t" }] });
    const [s] = slotsFromCalendarEvents([e], new Set(["r-coach"]));
    expect(s.coach_name).toBe("Quelqu'un");
  });

  it("dedups events colliding on weekday+time+coach", () => {
    const out = slotsFromCalendarEvents([ev({ id: "a" }), ev({ id: "b" })], new Set(["r-coach"]));
    expect(out).toHaveLength(1);
  });
});
