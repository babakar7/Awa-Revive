import { describe, expect, it } from "vitest";
import {
  buildEmployeeScheduleMessage,
  fmtDuration,
  fmtMin,
  parseTimeToMin,
  validateGridPayload,
  weeklyTotalMinutes,
  workedMinutes,
} from "../src/domain/staffPlanningRules.js";

describe("parseTimeToMin", () => {
  it("parses h and colon forms", () => {
    expect(parseTimeToMin("9h15")).toBe(555);
    expect(parseTimeToMin("09:15")).toBe(555);
    expect(parseTimeToMin("9:15")).toBe(555);
    expect(parseTimeToMin("19h35")).toBe(1175);
    expect(parseTimeToMin("8h")).toBe(480);
    expect(parseTimeToMin(" 8H00 ")).toBe(480);
  });
  it("rejects malformed / out of range", () => {
    expect(parseTimeToMin("25h00")).toBeNull();
    expect(parseTimeToMin("9h60")).toBeNull();
    expect(parseTimeToMin("")).toBeNull();
    expect(parseTimeToMin("abc")).toBeNull();
    expect(parseTimeToMin("24h30")).toBeNull(); // > 1440
  });
});

describe("fmtMin / fmtDuration", () => {
  it("formats clock times", () => {
    expect(fmtMin(555)).toBe("9h15");
    expect(fmtMin(480)).toBe("8h00");
    expect(fmtMin(1175)).toBe("19h35");
    expect(fmtMin(605)).toBe("10h05");
  });
  it("formats durations", () => {
    expect(fmtDuration(2365)).toBe("39h25");
    expect(fmtDuration(1985)).toBe("33h05");
    expect(fmtDuration(1080)).toBe("18h00");
  });
});

describe("workedMinutes — lunch break only deducted past 14h30", () => {
  it("no deduction when the shift ends at/before 14h30", () => {
    expect(workedMinutes(480, 810)).toBe(330); // 8h00–13h30 ends at break start
    expect(workedMinutes(555, 815)).toBe(260); // Sat 9h15–13h35 — the +5 min is KEPT
    expect(workedMinutes(555, 870)).toBe(315); // ends exactly at 14h30 → no lunch
  });
  it("deducts the overlap when the shift continues past 14h30", () => {
    expect(workedMinutes(555, 1175)).toBe(560); // full span: 620 − 60
    expect(workedMinutes(850, 1175)).toBe(305); // starts inside break: 325 − 20
    expect(workedMinutes(870, 1175)).toBe(305); // starts at break end: no deduction
    expect(workedMinutes(480, 1025)).toBe(485); // 8h00–17h05: 545 − 60
  });
});

// Seed shifts per employee (see schema seed). Weekly totals hand-computed.
const day = (start_min: number, end_min: number) => ({ start_min, end_min });
const SEED: Record<string, { start_min: number; end_min: number }[]> = {
  Meryl: [day(555, 1175), day(555, 1175), day(690, 1175), day(555, 1175), day(555, 815)],
  Ama: [day(555, 1080), day(555, 1080), day(690, 1080), day(555, 1080), day(555, 815)],
  Jacqueline: [day(600, 1175), day(600, 1175), day(690, 1175), day(600, 1175), day(555, 815)],
  Fatou: [day(480, 1025), day(480, 1025), day(630, 1025), day(480, 1025), day(480, 815)],
  Arame: [day(600, 1175), day(600, 1175), day(630, 1175), day(600, 1175), day(480, 815)],
};

describe("weeklyTotalMinutes matches the owner's sheet", () => {
  it("computes each profile", () => {
    expect(weeklyTotalMinutes(SEED.Meryl)).toBe(2365); // 39h25
    expect(weeklyTotalMinutes(SEED.Ama)).toBe(1985); // 33h05
    expect(weeklyTotalMinutes(SEED.Jacqueline)).toBe(2230); // 37h10
    expect(weeklyTotalMinutes(SEED.Fatou)).toBe(2125); // 35h25
    expect(weeklyTotalMinutes(SEED.Arame)).toBe(2365); // 39h25
  });
});

describe("validateGridPayload", () => {
  const known = new Set(["s1", "s2"]);
  it("accepts a clean grid and an all-repos grid", () => {
    expect(
      validateGridPayload(JSON.stringify({ shifts: [{ staff_id: "s1", weekday: 0, start_min: 555, end_min: 1175 }] }), known),
    ).toEqual({ shifts: [{ staff_id: "s1", weekday: 0, start_min: 555, end_min: 1175 }] });
    expect(validateGridPayload(JSON.stringify({ shifts: [] }), known)).toEqual({ shifts: [] });
  });
  it("rejects malformed payloads", () => {
    const bad = (s: unknown) => validateGridPayload(String(s), known);
    expect(bad("not json")).toHaveProperty("error");
    expect(bad(JSON.stringify({ shifts: [{ staff_id: "sX", weekday: 0, start_min: 1, end_min: 2 }] }))).toHaveProperty("error"); // unknown staff
    expect(bad(JSON.stringify({ shifts: [{ staff_id: "s1", weekday: 7, start_min: 1, end_min: 2 }] }))).toHaveProperty("error");
    expect(bad(JSON.stringify({ shifts: [{ staff_id: "s1", weekday: 0, start_min: 600, end_min: 600 }] }))).toHaveProperty("error"); // start>=end
    expect(bad(JSON.stringify({ shifts: [{ staff_id: "s1", weekday: 0, start_min: 0, end_min: 1500 }] }))).toHaveProperty("error"); // >1440
    expect(
      bad(JSON.stringify({ shifts: [
        { staff_id: "s1", weekday: 0, start_min: 1, end_min: 2 },
        { staff_id: "s1", weekday: 0, start_min: 3, end_min: 4 },
      ] })),
    ).toHaveProperty("error"); // duplicate cell
  });
});

describe("buildEmployeeScheduleMessage", () => {
  it("renders 7 days with repos and a break-deducted total", () => {
    const { subject, body } = buildEmployeeScheduleMessage("Planning actuel", "Meryl", [
      { weekday: 0, start_min: 555, end_min: 1175 },
      { weekday: 1, start_min: 555, end_min: 1175 },
      { weekday: 2, start_min: 690, end_min: 1175 },
      { weekday: 3, start_min: 555, end_min: 1175 },
      { weekday: 5, start_min: 555, end_min: 815 },
    ]);
    expect(subject).toBe("Ton planning Revive");
    expect(body).toContain("Meryl");
    expect(body).toContain("Lundi : 9h15 – 19h35");
    expect(body).toContain("Vendredi : repos");
    expect(body).toContain("Samedi : 9h15 – 13h35");
    expect(body).toContain("Dimanche : repos");
    expect(body).toContain("Total : 39h25 / semaine");
  });
});
