import { describe, expect, it } from "vitest";
import {
  keyPurchaseContinuityDecision,
  selectLegacyContinuityOrder,
} from "../src/domain/keyContinuity.js";
import type { KeyPlanMapping, KeyType } from "../src/domain/keyRules.js";

function mapping(type: KeyType, over: Partial<KeyPlanMapping> = {}): KeyPlanMapping {
  const reformer = {
    type,
    planId: `plan-${type}`,
    family: "REFORMER" as const,
    durationDays: 30,
    baseInvitations: type === "RESIDENTE" ? 1 : 0,
    continuityInvitation: true,
    invitation: {
      planId: "plan-invitation",
      serviceIds: ["svc-reformer"],
      slotRule: "CALM_SLOT_1230" as const,
      friendRule: "NEVER_REFORMER" as const,
    },
    bonus: { planId: "plan-bonus", serviceIds: ["svc-mat"], slotRule: "ANY_WEEKDAY_HOUR" as const },
  };
  return { ...reformer, ...over };
}

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
        mapping: mapping("RESIDENTE"),
        purchasedAt: at,
        source,
      }),
    ).toMatchObject({
      startsAt: source.expiresAt,
      earlyRenewal: true,
      invitationCount: 2,
      sourceKind: "LEGACY_REFORMER",
      sourceOrderId: "legacy",
      sourcePlanId: "legacy-plan",
      sourceRemaining: 3,
    });
  });
});

describe("keyPurchaseContinuityDecision — flat-1 plans & early flag", () => {
  const source = {
    kind: "KEY" as const,
    orderId: "prev",
    planId: "plan-prev",
    planName: "prev",
    expiresAt: new Date("2026-08-10T00:00:00Z"),
    remaining: 2,
    previousKeyId: "key-prev",
  };

  it("chains an early SUR_MESURE renewal but still grants exactly 1 invitation", () => {
    const decision = keyPurchaseContinuityDecision({
      mapping: mapping("SUR_MESURE", {
        baseInvitations: 1,
        continuityInvitation: false,
        bonus: null,
      }),
      purchasedAt: at,
      source,
    });
    expect(decision.startsAt).toEqual(source.expiresAt);
    expect(decision.earlyRenewal).toBe(true);
    expect(decision.invitationCount).toBe(1); // no continuity +1
  });

  it("an AQUABIKE renewal chains and grants exactly 1 invitation", () => {
    const decision = keyPurchaseContinuityDecision({
      mapping: mapping("AQUABIKE", {
        family: "AQUABIKE",
        baseInvitations: 1,
        continuityInvitation: false,
      }),
      purchasedAt: at,
      source,
    });
    expect(decision.earlyRenewal).toBe(true);
    expect(decision.invitationCount).toBe(1);
  });

  it("with no source, starts now and is not an early renewal", () => {
    const decision = keyPurchaseContinuityDecision({
      mapping: mapping("HABITUEE"),
      purchasedAt: at,
      source: null,
    });
    expect(decision.startsAt).toEqual(at);
    expect(decision.earlyRenewal).toBe(false);
    expect(decision.invitationCount).toBe(0);
  });
});
