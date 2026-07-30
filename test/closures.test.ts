import { describe, expect, it } from "vitest";
import { isClosedAt, type StudioClosure } from "../src/domain/closuresRepo.js";

const closure = (from: string, to: string): StudioClosure => ({
  id: "c1",
  starts_at: new Date(from),
  ends_at: new Date(to),
  reason: "Maggal de Touba",
  note: null,
  enabled: true,
  created_by: null,
  updated_by: null,
  created_at: new Date("2026-07-30T00:00:00Z"),
  updated_at: new Date("2026-07-30T00:00:00Z"),
});

const MAGGAL = [closure("2026-08-03T00:00:00Z", "2026-08-04T00:00:00Z")];

describe("isClosedAt", () => {
  it("flags a class during the closure", () => {
    expect(isClosedAt(new Date("2026-08-03T10:15:00Z"), MAGGAL)?.reason).toBe("Maggal de Touba");
  });

  it("treats the start boundary as closed (inclusive)", () => {
    expect(isClosedAt(new Date("2026-08-03T00:00:00Z"), MAGGAL)).not.toBeNull();
  });

  it("treats a class starting exactly at ends_at as OPEN (half-open interval)", () => {
    expect(isClosedAt(new Date("2026-08-04T00:00:00Z"), MAGGAL)).toBeNull();
  });

  it("does not flag a class before the closure", () => {
    expect(isClosedAt(new Date("2026-08-02T23:59:00Z"), MAGGAL)).toBeNull();
  });

  it("does not flag a class after the closure", () => {
    expect(isClosedAt(new Date("2026-08-04T10:15:00Z"), MAGGAL)).toBeNull();
  });

  it("returns null with no closures", () => {
    expect(isClosedAt(new Date("2026-08-03T10:15:00Z"), [])).toBeNull();
  });

  it("matches within a half-day (afternoon-only) closure", () => {
    const afternoon = [closure("2026-08-05T13:00:00Z", "2026-08-05T20:00:00Z")];
    expect(isClosedAt(new Date("2026-08-05T10:15:00Z"), afternoon)).toBeNull(); // morning open
    expect(isClosedAt(new Date("2026-08-05T18:15:00Z"), afternoon)).not.toBeNull(); // evening closed
  });
});
