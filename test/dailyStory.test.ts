import { describe, expect, it } from "vitest";
import {
  buildStoryData,
  dateLabelFor,
  dayLabelFor,
  storyCaption,
  storyWindowOpen,
  tomorrowWindow,
} from "../src/domain/dailyStory.js";
import type { WixService, WixSlot, WixStaffResource } from "../src/lib/wix.js";

const svc = (id: string, name: string, type = "CLASS"): WixService => ({
  id,
  name,
  description: "",
  priceXof: null,
  durationMinutes: null,
  maxParticipantsPerBooking: 1,
  pricingPlanIds: [],
  type,
});

const slot = (over: Partial<WixSlot> & { serviceId: string; startDate: string }): WixSlot => ({
  eventId: `e_${over.startDate}`,
  endDate: over.startDate,
  openSpots: 3,
  totalSpots: 8,
  coach: null,
  coachId: null,
  raw: {},
  ...over,
});

const now = new Date("2026-07-20T18:00:00Z"); // → demain = 2026-07-21 (mardi)

describe("tomorrowWindow", () => {
  it("computes tomorrow's UTC day boundaries (Dakar == UTC)", () => {
    const w = tomorrowWindow(now);
    expect(w.dateISO).toBe("2026-07-21");
    expect(w.fromISO).toBe("2026-07-21T00:00:00.000Z");
    expect(w.toISO).toBe("2026-07-21T23:59:59.999Z");
  });

  it("rolls to the next day near midnight", () => {
    expect(tomorrowWindow(new Date("2026-07-20T23:59:00Z")).dateISO).toBe("2026-07-21");
    expect(tomorrowWindow(new Date("2026-07-20T00:01:00Z")).dateISO).toBe("2026-07-21");
  });
});

describe("date labels", () => {
  it("dayLabelFor is the uppercase French weekday", () => {
    expect(dayLabelFor("2026-07-21")).toBe("MARDI");
    expect(dayLabelFor("2026-07-25")).toBe("SAMEDI");
  });
  it("dateLabelFor is 'day month' in French", () => {
    expect(dateLabelFor("2026-07-21")).toBe("21 juillet");
    expect(dateLabelFor("2026-12-01")).toBe("1 décembre");
  });
  it("storyCaption is the short WhatsApp label", () => {
    expect(storyCaption("2026-07-21")).toBe("Story de demain — mardi 21/07");
  });
});

describe("storyWindowOpen", () => {
  it("opens from the start hour up to (not including) the 22h cutoff", () => {
    expect(storyWindowOpen(new Date("2026-07-20T17:59:00Z"), 18)).toBe(false);
    expect(storyWindowOpen(new Date("2026-07-20T18:00:00Z"), 18)).toBe(true);
    expect(storyWindowOpen(new Date("2026-07-20T21:59:00Z"), 18)).toBe(true);
    expect(storyWindowOpen(new Date("2026-07-20T22:00:00Z"), 18)).toBe(false);
  });
});

describe("buildStoryData", () => {
  const services = [
    svc("s_ref", "Reformer"),
    svc("s_aqua", "Aquabike"),
    svc("s_priv", "Séance Privée", "APPOINTMENT"),
    svc("s_unknown", "Mystery", ""),
  ];
  const staff: WixStaffResource[] = [{ id: "r_yves", name: "Yves", phone: null, email: null }];

  it("groups by class, orders classes by earliest slot, sorts slots by time", () => {
    const data = buildStoryData(
      [
        slot({ serviceId: "s_aqua", startDate: "2026-07-21T10:15:00Z", coach: "Yves" }),
        slot({ serviceId: "s_ref", startDate: "2026-07-21T09:15:00Z", coach: "Yass" }),
        slot({ serviceId: "s_ref", startDate: "2026-07-21T08:15:00Z", coach: "Yass" }),
      ],
      services,
      staff,
      now,
    );
    expect(data.dayLabel).toBe("MARDI");
    expect(data.classes.map((c) => c.name)).toEqual(["Reformer", "Aquabike"]);
    expect(data.classes[0].slots.map((s) => s.time)).toEqual(["08H15", "09H15"]);
    expect(data.classes[0].coach).toBe("Yass");
  });

  it("drops APPOINTMENT services but keeps unknown types", () => {
    const data = buildStoryData(
      [
        slot({ serviceId: "s_priv", startDate: "2026-07-21T09:00:00Z" }),
        slot({ serviceId: "s_unknown", startDate: "2026-07-21T11:00:00Z" }),
      ],
      services,
      staff,
      now,
    );
    expect(data.classes.map((c) => c.name)).toEqual(["Mystery"]);
  });

  it("resolves the coach from coachId via the staff directory when slot.coach is null", () => {
    const data = buildStoryData(
      [slot({ serviceId: "s_aqua", startDate: "2026-07-21T10:15:00Z", coach: null, coachId: "r_yves" })],
      services,
      staff,
      now,
    );
    expect(data.classes[0].coach).toBe("Yves");
  });

  it("formats time as HH'H'MM and carries spot counts through", () => {
    const data = buildStoryData(
      [slot({ serviceId: "s_aqua", startDate: "2026-07-21T07:05:00Z", openSpots: 0, totalSpots: 8 })],
      services,
      staff,
      now,
    );
    expect(data.classes[0].slots[0]).toEqual({ time: "07H05", openSpots: 0, totalSpots: 8 });
  });

  it("ignores slots whose service is not in the catalog", () => {
    const data = buildStoryData(
      [slot({ serviceId: "s_ghost", startDate: "2026-07-21T09:00:00Z" })],
      services,
      staff,
      now,
    );
    expect(data.classes).toEqual([]);
  });
});
