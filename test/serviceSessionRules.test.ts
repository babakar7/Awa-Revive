import { describe, it, expect } from "vitest";
import {
  pad2,
  formatShortCode,
  nextFreeSeq,
  parsePosition,
  canCloseSession,
  cleanFirstName,
} from "../src/domain/serviceSessionRules.js";

describe("short code arithmetic", () => {
  it("zero-pads to two digits", () => {
    expect(pad2(1)).toBe("01");
    expect(pad2(24)).toBe("24");
    expect(pad2(100)).toBe("100");
  });

  it("formats an area code + seq", () => {
    expect(formatShortCode("C", 24)).toBe("C-24");
    expect(formatShortCode("t", 8)).toBe("T-08");
    expect(formatShortCode(" p ", 3)).toBe("P-03");
  });
});

describe("nextFreeSeq", () => {
  it("starts at 1 when nothing is used", () => {
    expect(nextFreeSeq([])).toBe(1);
  });

  it("returns the smallest free number (fills gaps → reuse after close)", () => {
    expect(nextFreeSeq([1, 2, 3])).toBe(4);
    expect(nextFreeSeq([1, 3])).toBe(2);
    expect(nextFreeSeq([2, 3])).toBe(1);
  });

  it("ignores non-integers and duplicates", () => {
    expect(nextFreeSeq([1, 1, NaN as unknown as number, 2])).toBe(3);
  });

  it("caps at max when everything below is taken", () => {
    const used = Array.from({ length: 98 }, (_, i) => i + 1); // 1..98
    expect(nextFreeSeq(used, 99)).toBe(99);
  });
});

describe("parsePosition", () => {
  it("accepts proportional coordinates in [0,1]", () => {
    expect(parsePosition(0, 0)).toEqual({ x: 0, y: 0 });
    expect(parsePosition(0.5, 0.25)).toEqual({ x: 0.5, y: 0.25 });
    expect(parsePosition(1, 1)).toEqual({ x: 1, y: 1 });
  });

  it("parses numeric strings", () => {
    expect(parsePosition("0.3", "0.7")).toEqual({ x: 0.3, y: 0.7 });
  });

  it("rejects out-of-range or missing coordinates", () => {
    expect(parsePosition(-0.1, 0.5)).toBeNull();
    expect(parsePosition(0.5, 1.2)).toBeNull();
    expect(parsePosition(0.5, undefined)).toBeNull();
    expect(parsePosition("abc", 0.5)).toBeNull();
  });
});

describe("canCloseSession", () => {
  it("allows closing with no open ticket", () => {
    expect(canCloseSession(0)).toBe(true);
  });
  it("refuses closing with an open ticket", () => {
    expect(canCloseSession(1)).toBe(false);
    expect(canCloseSession(3)).toBe(false);
  });
});

describe("cleanFirstName", () => {
  it("trims, collapses spaces, caps length", () => {
    expect(cleanFirstName("  Awa  ")).toBe("Awa");
    expect(cleanFirstName("Awa   B")).toBe("Awa B");
    expect(cleanFirstName("")).toBeNull();
    expect(cleanFirstName(null)).toBeNull();
    expect(cleanFirstName("x".repeat(50))).toHaveLength(40);
  });
});
