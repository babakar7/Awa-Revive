import { describe, expect, it } from "vitest";
import { isPlanSellableByAwa } from "../src/domain/planSaleGuard.js";

describe("isPlanSellableByAwa", () => {
  it("allows only explicitly configured plan ids", () => {
    expect(isPlanSellableByAwa("public-plan", ["public-plan"], true)).toBe(true);
    expect(isPlanSellableByAwa("hidden-key", ["public-plan"], true)).toBe(false);
  });

  it("fails closed in production when the allowlist is empty", () => {
    expect(isPlanSellableByAwa("any-plan", [], true)).toBe(false);
  });

  it("keeps local and unit-test development backwards compatible", () => {
    expect(isPlanSellableByAwa("any-plan", [], false)).toBe(true);
  });
});
