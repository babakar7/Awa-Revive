import { describe, expect, it } from "vitest";
import { findCoveringPlan } from "../src/agent/coverageGuard.js";

const SVC = "svc-reformer";
const PLAN = "plan-reformer-12";
const plans = (remaining: number | null) => [
  { planId: PLAN, plan: "La Résidente — Clé 12 séances", remaining },
];

describe("findCoveringPlan", () => {
  it("flags a plan that covers the service with enough sessions", () => {
    const c = findCoveringPlan(SVC, [PLAN], plans(5), 1);
    expect(c?.plan).toContain("Résidente");
    expect(c?.remaining).toBe(5);
  });

  it("does NOT flag when the plan does not cover this service", () => {
    expect(findCoveringPlan(SVC, ["plan-aquabike"], plans(5), 1)).toBeNull();
  });

  it("does NOT flag when the service has no connected plans", () => {
    expect(findCoveringPlan(SVC, [], plans(5), 1)).toBeNull();
    expect(findCoveringPlan(SVC, undefined, plans(5), 1)).toBeNull();
  });

  it("does NOT flag when balance is unknown (null) — avoid stranding", () => {
    expect(findCoveringPlan(SVC, [PLAN], plans(null), 1)).toBeNull();
  });

  it("does NOT flag when remaining < participants (overflow group can pay) — avoids the loop", () => {
    expect(findCoveringPlan(SVC, [PLAN], plans(1), 3)).toBeNull();
  });

  it("flags when remaining exactly equals participants", () => {
    expect(findCoveringPlan(SVC, [PLAN], plans(2), 2)?.remaining).toBe(2);
  });

  it("picks the first covering plan among several", () => {
    const multi = [
      { planId: "other", plan: "Aquafitness", remaining: 8 },
      { planId: PLAN, plan: "La Résidente", remaining: 4 },
    ];
    expect(findCoveringPlan(SVC, [PLAN], multi, 1)?.plan).toContain("Résidente");
  });
});
