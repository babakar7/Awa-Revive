import { describe, expect, it } from "vitest";
import {
  invitationEarnings,
  invitationScopeAllows,
  bonusScopeAllows,
  isBonusSlotAllowed,
  isInvitationSlotAllowed,
  type KeyPlanMapping,
  type KeyType,
} from "../src/domain/keyRules.js";

const REFORMER_SVC = "svc-reformer";
const AQUABIKE_SVC = "svc-aquabike";
const BONUS_SVC = "svc-mat";

function mapping(type: KeyType): KeyPlanMapping {
  const base = {
    type,
    planId: `plan-${type}`,
    family: "REFORMER" as const,
    durationDays: 30,
    baseInvitations: 0,
    continuityInvitation: true,
    invitation: {
      planId: "plan-invitation",
      serviceIds: [REFORMER_SVC],
      slotRule: "CALM_SLOT_1230" as const,
      friendRule: "NEVER_REFORMER" as const,
    },
    bonus: {
      planId: "plan-bonus",
      serviceIds: [BONUS_SVC],
      slotRule: "ANY_WEEKDAY_HOUR" as const,
    },
  };
  if (type === "RESIDENTE") return { ...base, baseInvitations: 1 };
  if (type === "SUR_MESURE")
    return {
      ...base,
      baseInvitations: 1,
      continuityInvitation: false,
      bonus: null,
    };
  if (type === "AQUABIKE")
    return {
      ...base,
      family: "AQUABIKE",
      baseInvitations: 1,
      continuityInvitation: false,
      invitation: {
        planId: "plan-aquabike-invitation",
        serviceIds: [AQUABIKE_SVC],
        slotRule: "ANY_WEEKDAY_HOUR",
        friendRule: "NEVER_AQUABIKE",
      },
      bonus: {
        planId: "plan-aquabike-bonus",
        serviceIds: [REFORMER_SVC],
        slotRule: "CALM_SLOT_1230",
      },
    };
  return base;
}

describe("invitationEarnings", () => {
  it.each([
    ["HABITUEE", false, false, 0],
    ["RESIDENTE", false, false, 1],
    ["HABITUEE", true, true, 1],
    ["RESIDENTE", true, true, 2],
    ["HABITUEE", true, false, 0],
    ["RESIDENTE", true, false, 1],
  ] as const)(
    "Clé %s / previous=%s / early=%s",
    (type, previous, early, expected) => {
      expect(invitationEarnings(mapping(type), previous, early)).toBe(expected);
    },
  );

  it.each([
    // AQUABIKE and SUR_MESURE grant exactly 1 per cycle, no continuity bonus,
    // regardless of an earlier same-family subscription or early renewal.
    ["AQUABIKE", false, false, 1],
    ["AQUABIKE", true, true, 1],
    ["AQUABIKE", true, false, 1],
    ["SUR_MESURE", false, false, 1],
    ["SUR_MESURE", true, true, 1],
    ["SUR_MESURE", true, false, 1],
  ] as const)(
    "flat-1 plan %s / previous=%s / early=%s",
    (type, previous, early, expected) => {
      expect(invitationEarnings(mapping(type), previous, early)).toBe(expected);
    },
  );
});

describe("invitation & bonus scope", () => {
  const weekday1230 = new Date("2026-07-27T12:30:00Z"); // Monday
  const weekday10 = new Date("2026-07-27T10:00:00Z");
  const saturday = new Date("2026-08-01T10:00:00Z");

  it("Clé invitation: Reformer at 12:30 on a weekday only", () => {
    const m = mapping("RESIDENTE");
    expect(invitationScopeAllows(m, REFORMER_SVC, weekday1230)).toBe(true);
    expect(invitationScopeAllows(m, REFORMER_SVC, weekday10)).toBe(false);
    expect(invitationScopeAllows(m, AQUABIKE_SVC, weekday1230)).toBe(false);
  });

  it("Aquabike invitation: an Aquabike class any weekday hour, never weekend", () => {
    const m = mapping("AQUABIKE");
    expect(invitationScopeAllows(m, AQUABIKE_SVC, weekday10)).toBe(true);
    expect(invitationScopeAllows(m, AQUABIKE_SVC, weekday1230)).toBe(true);
    expect(invitationScopeAllows(m, AQUABIKE_SVC, saturday)).toBe(false);
    expect(invitationScopeAllows(m, REFORMER_SVC, weekday10)).toBe(false);
  });

  it("Aquabike bonus: a Reformer session only on the 12:30 calm slot", () => {
    const m = mapping("AQUABIKE");
    expect(bonusScopeAllows(m, REFORMER_SVC, weekday1230)).toBe(true);
    expect(bonusScopeAllows(m, REFORMER_SVC, weekday10)).toBe(false);
  });

  it("sur-mesure has no bonus scope", () => {
    const m = mapping("SUR_MESURE");
    expect(bonusScopeAllows(m, BONUS_SVC, weekday10)).toBe(false);
    expect(bonusScopeAllows(m, REFORMER_SVC, weekday1230)).toBe(false);
  });
});

describe("legacy slot helpers", () => {
  it("accepts bonus classes only on weekdays", () => {
    expect(isBonusSlotAllowed(new Date("2026-07-31T23:59:00Z"))).toBe(true);
    expect(isBonusSlotAllowed(new Date("2026-08-01T00:00:00Z"))).toBe(false);
    expect(isBonusSlotAllowed(new Date("2026-08-03T00:00:00Z"))).toBe(true);
  });

  it("accepts invitations exactly at 12:30 on weekdays", () => {
    expect(isInvitationSlotAllowed(new Date("2026-07-27T12:30:00Z"))).toBe(true);
    expect(isInvitationSlotAllowed(new Date("2026-07-27T12:29:00Z"))).toBe(false);
    expect(isInvitationSlotAllowed(new Date("2026-08-01T12:30:00Z"))).toBe(false);
  });
});
