import { describe, expect, it } from "vitest";
import {
  classDedupKey,
  dakarDateStr,
  dueClassReminders,
  fixedDedupKey,
  isFixedScheduleDue,
  matchesPattern,
  normalizeName,
  renderMessage,
  type NotificationRule,
  type SlotWithName,
} from "../src/domain/notificationRules.js";

const baseRule: NotificationRule = {
  id: "r1",
  label: "Aquabikes à l'eau",
  kind: "class_reminder",
  enabled: true,
  class_pattern: "aquabike",
  lead_minutes: 15,
  suppress_gap_minutes: 15,
  recipient_kind: "phone",
  recipient_phone: "+224620955130",
  days_of_week: null,
  send_time: null,
  message_template: "L'aquabike de {start_time} — {booked_count} inscrits",
};

const slot = (over: Partial<SlotWithName>): SlotWithName => ({
  eventId: "e1",
  serviceId: "s1",
  serviceName: "Aquabike",
  startDate: "2026-07-15T10:00:00Z",
  endDate: "2026-07-15T10:45:00Z",
  openSpots: 2,
  totalSpots: 10,
  coach: "Awa",
  ...over,
});

describe("normalizeName / matchesPattern", () => {
  it("is accent- and case-insensitive and trims", () => {
    expect(normalizeName("  Aquabike Débutant ")).toBe("aquabike debutant");
    expect(matchesPattern("Aquabike Débutant", "aquabike")).toBe(true);
    expect(matchesPattern("AQUABIKE", "aquabIKE")).toBe(true);
    expect(matchesPattern("Aquabïke", "aquabike")).toBe(true); // diacritic in the name
  });

  it("empty/blank pattern matches every class", () => {
    expect(matchesPattern("Pilates", "")).toBe(true);
    expect(matchesPattern("Pilates", null)).toBe(true);
    expect(matchesPattern("Pilates", "   ")).toBe(true);
  });

  it("non-matching class returns false", () => {
    expect(matchesPattern("Pilates Reformer", "aquabike")).toBe(false);
  });

  it("an over-long pattern (>80 chars) degrades to match-all (fat-finger guard)", () => {
    expect(matchesPattern("Pilates", "x".repeat(81))).toBe(true);
  });
});

describe("dueClassReminders — due window", () => {
  it("fires exactly at start - lead and not a minute earlier", () => {
    const s = slot({});
    const rule = { ...baseRule, suppress_gap_minutes: null };
    // 15 min before → due
    expect(dueClassReminders(rule, [s], new Date("2026-07-15T09:45:00Z"))).toHaveLength(1);
    // 16 min before → not yet
    expect(dueClassReminders(rule, [s], new Date("2026-07-15T09:44:00Z"))).toHaveLength(0);
  });

  it("does not fire once the class has started", () => {
    const rule = { ...baseRule, suppress_gap_minutes: null };
    expect(dueClassReminders(rule, [slot({})], new Date("2026-07-15T10:00:00Z"))).toHaveLength(0);
    expect(dueClassReminders(rule, [slot({})], new Date("2026-07-15T10:05:00Z"))).toHaveLength(0);
  });

  it("ignores classes whose name doesn't match the pattern", () => {
    const s = slot({ serviceName: "Pilates" });
    expect(dueClassReminders(baseRule, [s], new Date("2026-07-15T09:45:00Z"))).toHaveLength(0);
  });
});

describe("dueClassReminders — back-to-back suppression", () => {
  const now = new Date("2026-07-15T09:55:00Z"); // 5 min before the 10:00 class

  it("suppresses a class chained right after another matching class", () => {
    const first = slot({ eventId: "e1", startDate: "2026-07-15T09:00:00Z", endDate: "2026-07-15T09:45:00Z" });
    const second = slot({ eventId: "e2", startDate: "2026-07-15T10:00:00Z", endDate: "2026-07-15T10:45:00Z" });
    // Only the second is inside the lead window at 09:55; it should be suppressed
    // because the first ended at 09:45 (within the 15-min gap before 10:00).
    const due = dueClassReminders(baseRule, [first, second], now);
    expect(due).toHaveLength(1);
    expect(due[0].slot.eventId).toBe("e2");
    expect(due[0].suppressed).toBe(true);
  });

  it("does NOT suppress when the preceding class ended outside the gap", () => {
    const first = slot({ eventId: "e1", startDate: "2026-07-15T08:00:00Z", endDate: "2026-07-15T08:45:00Z" });
    const second = slot({ eventId: "e2", startDate: "2026-07-15T10:00:00Z", endDate: "2026-07-15T10:45:00Z" });
    const due = dueClassReminders(baseRule, [first, second], now);
    expect(due).toHaveLength(1);
    expect(due[0].suppressed).toBe(false);
  });

  it("a non-matching class in the gap does not suppress", () => {
    const pilates = slot({ eventId: "p", serviceName: "Pilates", startDate: "2026-07-15T09:00:00Z", endDate: "2026-07-15T09:50:00Z" });
    const aqua = slot({ eventId: "e2", startDate: "2026-07-15T10:00:00Z", endDate: "2026-07-15T10:45:00Z" });
    const due = dueClassReminders(baseRule, [pilates, aqua], now);
    expect(due).toHaveLength(1);
    expect(due[0].suppressed).toBe(false);
  });

  it("suppresses via the log fallback when the preceding session isn't in the window", () => {
    const second = slot({ eventId: "e2", startDate: "2026-07-15T10:00:00Z", endDate: "2026-07-15T10:45:00Z" });
    // prior sent occurrence ended at 09:45 (within gap) — schedule no longer has it
    const priorEnds = [new Date("2026-07-15T09:45:00Z").getTime()];
    const due = dueClassReminders(baseRule, [second], now, priorEnds);
    expect(due[0].suppressed).toBe(true);
  });

  it("gap=null disables suppression entirely", () => {
    const first = slot({ eventId: "e1", startDate: "2026-07-15T09:00:00Z", endDate: "2026-07-15T09:45:00Z" });
    const second = slot({ eventId: "e2", startDate: "2026-07-15T10:00:00Z", endDate: "2026-07-15T10:45:00Z" });
    const rule = { ...baseRule, suppress_gap_minutes: null };
    const due = dueClassReminders(rule, [first, second], now);
    expect(due.every((d) => !d.suppressed)).toBe(true);
  });
});

describe("isFixedScheduleDue", () => {
  // 2026-07-18 is a Saturday (getUTCDay() === 6).
  const rule: NotificationRule = {
    ...baseRule,
    kind: "fixed_schedule",
    class_pattern: null,
    lead_minutes: null,
    suppress_gap_minutes: null,
    days_of_week: "6",
    send_time: "10:00",
    message_template: "Mettre les vélos à l'eau",
  };

  it("is due on the right weekday at/after the time", () => {
    expect(isFixedScheduleDue(rule, new Date("2026-07-18T10:00:00Z"))).toBe(true);
    expect(isFixedScheduleDue(rule, new Date("2026-07-18T14:00:00Z"))).toBe(true); // late boot, same day
  });

  it("is not due before the time, or on another weekday", () => {
    expect(isFixedScheduleDue(rule, new Date("2026-07-18T09:59:00Z"))).toBe(false);
    expect(isFixedScheduleDue(rule, new Date("2026-07-17T12:00:00Z"))).toBe(false); // Friday
  });

  it("handles multi-day CSV and rejects malformed time/days", () => {
    const multi = { ...rule, days_of_week: "1,3,6" };
    expect(isFixedScheduleDue(multi, new Date("2026-07-15T10:30:00Z"))).toBe(true); // Wed
    expect(isFixedScheduleDue({ ...rule, send_time: "" }, new Date("2026-07-18T10:00:00Z"))).toBe(false);
    expect(isFixedScheduleDue({ ...rule, days_of_week: "" }, new Date("2026-07-18T10:00:00Z"))).toBe(false);
  });
});

describe("renderMessage", () => {
  it("replaces known placeholders and leaves unknown ones visible", () => {
    const out = renderMessage("Cours {class_name} à {start_time} : {booked_count} inscrits {oops}", {
      class_name: "Aquabike",
      start_time: "10:00",
      booked_count: "8",
    });
    expect(out).toBe("Cours Aquabike à 10:00 : 8 inscrits {oops}");
  });

  it("shows '?' for an unknown headcount when the sweep passes it", () => {
    const out = renderMessage("{booked_count} inscrits", { booked_count: "?" });
    expect(out).toBe("? inscrits");
  });

  it("leaves a template with no placeholders untouched", () => {
    expect(renderMessage("Mettre les vélos à l'eau", {})).toBe("Mettre les vélos à l'eau");
  });
});

describe("dedup keys", () => {
  it("are stable and distinct per occurrence", () => {
    expect(classDedupKey("r1", "e1")).toBe("rule:r1:event:e1");
    expect(fixedDedupKey("r1", "2026-07-18")).toBe("rule:r1:day:2026-07-18");
    expect(dakarDateStr(new Date("2026-07-18T23:30:00Z"))).toBe("2026-07-18");
  });
});
