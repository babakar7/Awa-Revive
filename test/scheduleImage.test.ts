import { describe, expect, it } from "vitest";
import {
  buildWeeklyGrid,
  renderScheduleImage,
  scheduleText,
  WEEKDAYS_FR,
} from "../src/lib/scheduleImage.js";

const services = [
  { id: "svc-pilates", name: "Pilates Fusion", durationMinutes: 50 },
  { id: "svc-yoga", name: "Yoga Flow", durationMinutes: 60 },
];

describe("buildWeeklyGrid", () => {
  it("maps ISO starts to Monday-first weekdays and HH:MM times", () => {
    // 2026-07-13 is a Monday, 2026-07-19 a Sunday (Dakar == UTC).
    const grid = buildWeeklyGrid(
      [
        { serviceId: "svc-pilates", startDate: "2026-07-13T10:00:00Z" },
        { serviceId: "svc-yoga", startDate: "2026-07-19T09:30:00Z" },
      ],
      services,
    );
    expect(grid).toEqual([
      { weekday: 0, time: "10:00", className: "Pilates Fusion", durationMinutes: 50 },
      { weekday: 6, time: "09:30", className: "Yoga Flow", durationMinutes: 60 },
    ]);
  });

  it("collapses the same class/weekday/time recurring on different dates", () => {
    const grid = buildWeeklyGrid(
      [
        { serviceId: "svc-pilates", startDate: "2026-07-13T10:00:00Z" },
        { serviceId: "svc-pilates", startDate: "2026-07-20T10:00:00Z" }, // Monday again
      ],
      services,
    );
    expect(grid).toHaveLength(1);
  });

  it("keeps two different classes at the same weekday/time", () => {
    const grid = buildWeeklyGrid(
      [
        { serviceId: "svc-pilates", startDate: "2026-07-13T10:00:00Z" },
        { serviceId: "svc-yoga", startDate: "2026-07-13T10:00:00Z" },
      ],
      services,
    );
    expect(grid).toHaveLength(2);
  });

  it("sorts by weekday, then time, then class name", () => {
    const grid = buildWeeklyGrid(
      [
        { serviceId: "svc-yoga", startDate: "2026-07-14T18:00:00Z" }, // Tue 18:00
        { serviceId: "svc-pilates", startDate: "2026-07-14T08:00:00Z" }, // Tue 08:00
        { serviceId: "svc-pilates", startDate: "2026-07-13T12:00:00Z" }, // Mon 12:00
      ],
      services,
    );
    expect(grid.map((e) => `${e.weekday} ${e.time}`)).toEqual(["0 12:00", "1 08:00", "1 18:00"]);
  });

  it("skips unknown services and unparseable dates", () => {
    const grid = buildWeeklyGrid(
      [
        { serviceId: "svc-ghost", startDate: "2026-07-13T10:00:00Z" },
        { serviceId: "svc-pilates", startDate: "not-a-date" },
      ],
      services,
    );
    expect(grid).toEqual([]);
  });
});

describe("scheduleText", () => {
  it("groups by day with French labels and durations", () => {
    const text = scheduleText([
      { weekday: 0, time: "10:00", className: "Pilates Fusion", durationMinutes: 50 },
      { weekday: 0, time: "18:00", className: "Yoga Flow", durationMinutes: null },
      { weekday: 5, time: "09:00", className: "Yoga Flow", durationMinutes: 60 },
    ]);
    expect(text).toBe(
      ["*Lundi*", "  10:00 — Pilates Fusion (50 min)", "  18:00 — Yoga Flow", "*Samedi*", "  09:00 — Yoga Flow (60 min)"].join(
        "\n",
      ),
    );
  });

  it("has a label for all seven weekdays", () => {
    expect(WEEKDAYS_FR).toHaveLength(7);
  });
});

describe("renderScheduleImage", () => {
  it("renders a non-trivial PNG (magic bytes)", () => {
    const png = renderScheduleImage([
      { weekday: 0, time: "10:00", className: "Pilates Fusion", durationMinutes: 50 },
      { weekday: 3, time: "18:30", className: "Yoga Flow", durationMinutes: 60 },
    ]);
    expect(png.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    expect(png.length).toBeGreaterThan(2000);
  });

  it("throws on an empty schedule instead of rendering a blank image", () => {
    expect(() => renderScheduleImage([])).toThrow();
  });
});
