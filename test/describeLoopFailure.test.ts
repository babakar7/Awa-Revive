import { describe, expect, it } from "vitest";
import { describeLoopFailure } from "../src/agent/index.js";

describe("describeLoopFailure", () => {
  it("marks a no-throw empty result (fallback without an exception)", () => {
    expect(describeLoopFailure(null)).toBe("aucune réponse produite (pas d'exception)");
  });

  it("prefixes an API status code when present (e.g. Anthropic 529 overloaded)", () => {
    const err = Object.assign(new Error("Overloaded"), { status: 529 });
    expect(describeLoopFailure(err)).toBe("529 — Overloaded");
  });

  it("uses the message for a plain Error, collapsed to one line and capped", () => {
    expect(describeLoopFailure(new Error("boom\n  at foo"))).toBe("boom at foo");
    const long = new Error("x".repeat(500));
    expect(describeLoopFailure(long).length).toBeLessThanOrEqual(200);
  });

  it("handles strings and unknown shapes without throwing", () => {
    expect(describeLoopFailure("network down")).toBe("network down");
    expect(describeLoopFailure({ weird: true })).toContain("weird");
  });
});
