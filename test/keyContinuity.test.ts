import { describe, expect, it } from "vitest";
import {
  keyPurchaseContinuityDecision,
  selectLegacyContinuityOrder,
} from "../src/domain/keyContinuity.js";

const at = new Date("2026-07-27T12:00:00Z");
const order = (id: string, planId: string, endDate: string) => ({
  id,
  planId,
  planName: planId,
  startDate: "2026-07-01T00:00:00Z",
  endDate,
  buyer: { contactId: "contact-1", memberId: "member-1" },
});

describe("legacy Key continuity", () => {
  it("ignores a later Aquafitness expiry and selects the legacy Reformer order", () => {
    const selected = selectLegacyContinuityOrder({
      orders: [
        order("reformer", "legacy-reformer", "2026-08-01T00:00:00Z"),
        order("aqua", "aquafitness", "2026-09-01T00:00:00Z"),
      ],
      legacyPlanIds: new Set(["legacy-reformer"]),
      contactId: "contact-1",
      at,
    });
    expect(selected?.id).toBe("reformer");
  });

  it("uses the latest expiry when several legacy Reformer orders overlap", () => {
    const selected = selectLegacyContinuityOrder({
      orders: [
        order("early", "legacy-1", "2026-08-01T00:00:00Z"),
        order("late", "legacy-2", "2026-08-15T00:00:00Z"),
      ],
      legacyPlanIds: new Set(["legacy-1", "legacy-2"]),
      memberId: "member-1",
      at,
    });
    expect(selected?.id).toBe("late");
  });

  it("can resolve a source covering a historical webhook purchase date", () => {
    const selected = selectLegacyContinuityOrder({
      orders: [order("ended", "legacy-1", "2026-07-28T00:00:00Z")],
      legacyPlanIds: new Set(["legacy-1"]),
      contactId: "contact-1",
      at: new Date("2026-07-27T18:00:00Z"),
    });
    expect(selected?.id).toBe("ended");
  });

  it("gives Awa and the counter one deterministic continuity decision", () => {
    const source = {
      kind: "LEGACY_REFORMER" as const,
      orderId: "legacy",
      planId: "legacy-plan",
      planName: "2x Reformer",
      expiresAt: new Date("2026-08-10T00:00:00Z"),
      remaining: 3,
      previousKeyId: null,
    };
    expect(
      keyPurchaseContinuityDecision({
        newKeyType: "RESIDENTE",
        purchasedAt: at,
        source,
      }),
    ).toMatchObject({
      startsAt: source.expiresAt,
      invitationCount: 2,
      sourceKind: "LEGACY_REFORMER",
      sourceOrderId: "legacy",
      sourcePlanId: "legacy-plan",
      sourceRemaining: 3,
    });
  });
});
