import { describe, expect, it } from "vitest";
import {
  selectEligibleBenefit,
  type EligibleBenefit,
} from "../src/lib/wix.js";

const benefit = (
  planId: string,
  orderId: string,
  poolId: string,
): EligibleBenefit => ({
  poolId,
  benefitKey: `benefit-${poolId}`,
  memberId: "member-1",
  planName: "Duplicate display name",
  planId,
  orderId,
  available: 1,
});

describe("selectEligibleBenefit", () => {
  it("does not depend on pool ordering", () => {
    const subscription = benefit("mat-sub", "order-sub", "pool-sub");
    const bonus = benefit("bonus-plan", "order-bonus", "pool-bonus");
    expect(
      selectEligibleBenefit([subscription, bonus], {
        planId: "bonus-plan",
        orderId: "order-bonus",
      })?.poolId,
    ).toBe("pool-bonus");
    expect(
      selectEligibleBenefit([bonus, subscription], {
        planId: "bonus-plan",
        orderId: "order-bonus",
      })?.poolId,
    ).toBe("pool-bonus");
  });

  it("selects the exact order when two same-plan pools exist", () => {
    const active = benefit("key-plan", "active-order", "pool-active");
    const scheduled = benefit("key-plan", "scheduled-order", "pool-scheduled");
    expect(
      selectEligibleBenefit([scheduled, active], {
        planId: "key-plan",
        orderId: "active-order",
      })?.poolId,
    ).toBe("pool-active");
    expect(selectEligibleBenefit([active, scheduled], { planId: "key-plan" })).toBeNull();
  });
});
