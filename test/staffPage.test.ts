import { describe, expect, it } from "vitest";
import {
  copyEmployeeWeek,
  renderStaffPlanning,
  type StaffGridCells,
} from "../src/admin/staffPage.js";
import type {
  PlanningStaff,
  StaffSchedule,
} from "../src/domain/staffPlanningRepo.js";

describe("staff weekly copy", () => {
  it("replaces the target week exactly, including rest days", () => {
    const cells: StaffGridCells = {
      "source:0": { s: 480, e: 1020 },
      "source:2": { s: 600, e: 1080 },
      "target:0": { s: 540, e: 900 },
      "target:1": { s: 540, e: 900 },
      "other:4": { s: 720, e: 900 },
    };

    expect(copyEmployeeWeek(cells, "source", "target")).toBe(true);
    expect(cells).toEqual({
      "source:0": { s: 480, e: 1020 },
      "source:2": { s: 600, e: 1080 },
      "target:0": { s: 480, e: 1020 },
      "target:2": { s: 600, e: 1080 },
      "other:4": { s: 720, e: 900 },
    });

    cells["source:0"].s = 300;
    expect(cells["target:0"].s).toBe(480);
  });

  it("copies an empty week as seven rest days and rejects self-copy", () => {
    const cells: StaffGridCells = {
      "target:0": { s: 480, e: 1020 },
      "target:6": { s: 600, e: 900 },
    };

    expect(copyEmployeeWeek(cells, "empty", "target")).toBe(true);
    expect(cells).toEqual({});
    expect(copyEmployeeWeek(cells, "target", "target")).toBe(false);
  });
});

describe("staff weekly copy UI", () => {
  it("renders an accessible per-employee copy flow without leaking names into HTML", () => {
    const schedule: StaffSchedule = {
      id: "schedule-1",
      name: "Semaine type",
      status: "draft",
      created_by: "owner",
      created_at: new Date("2026-07-20T00:00:00Z"),
      updated_at: new Date("2026-07-20T00:00:00Z"),
    };
    const staff: PlanningStaff[] = [
      { id: "source", name: "Awa <source>", phone: "", role: "accueil" },
      { id: "target", name: "Fatou", phone: "", role: "bar" },
    ];

    const html = renderStaffPlanning({
      schedules: [schedule],
      current: schedule,
      shifts: [],
      staff,
      banner: "",
    });

    expect(html).toContain("Copier depuis…");
    expect(html).toContain('id="copyweek"');
    expect(html).toContain('aria-labelledby="copyweektitle"');
    expect(html).toContain("Remplacer la semaine");
    expect(html).toContain("jours de repos compris");
    expect(html).toContain("copyEmployeeWeek(ST.cells, sourceId, targetId)");
    expect(html).toContain('ev.key!=="Escape"');
    expect(html).not.toContain("Awa <source>");
  });
});
