import { describe, expect, it } from "vitest";
import {
  invitationEarnings,
  isBonusSlotAllowed,
  isInvitationSlotAllowed,
} from "../src/domain/keyRules.js";

describe("Clés business rules", () => {
  it.each([
    ["HABITUEE", false, false, 0],
    ["RESIDENTE", false, false, 1],
    ["HABITUEE", true, true, 1],
    ["RESIDENTE", true, true, 2],
    ["HABITUEE", true, false, 0],
    ["RESIDENTE", true, false, 1],
  ] as const)(
    "computes invitation rights for %s / previous=%s / early=%s",
    (type, previous, early, expected) => {
      expect(invitationEarnings(type, previous, early)).toBe(expected);
    },
  );

  it.each([
    ["HABITUEE", true, true, 1],
    ["RESIDENTE", true, true, 2],
    ["HABITUEE", true, false, 0],
    ["RESIDENTE", true, false, 1],
  ] as const)(
    "applies the same continuity formula to a Fondatrice: %s / active=%s / early=%s",
    (type, legacy, early, expected) => {
      expect(invitationEarnings(type, legacy, early)).toBe(expected);
    },
  );

  it("accepts bonus classes only on weekdays", () => {
    expect(isBonusSlotAllowed(new Date("2026-07-31T23:59:00Z"))).toBe(true);
    expect(isBonusSlotAllowed(new Date("2026-08-01T00:00:00Z"))).toBe(false);
    expect(isBonusSlotAllowed(new Date("2026-08-02T12:30:00Z"))).toBe(false);
    expect(isBonusSlotAllowed(new Date("2026-08-03T00:00:00Z"))).toBe(true);
  });

  it("accepts invitations exactly at 12:30 on weekdays", () => {
    expect(isInvitationSlotAllowed(new Date("2026-07-27T12:30:00Z"))).toBe(true);
    expect(isInvitationSlotAllowed(new Date("2026-07-27T12:29:00Z"))).toBe(false);
    expect(isInvitationSlotAllowed(new Date("2026-07-27T12:31:00Z"))).toBe(false);
    expect(isInvitationSlotAllowed(new Date("2026-08-01T12:30:00Z"))).toBe(false);
  });
});
