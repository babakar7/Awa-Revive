import { describe, it, expect } from "vitest";
import { canCloseSession, cleanFirstName } from "../src/domain/serviceSessionRules.js";

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
