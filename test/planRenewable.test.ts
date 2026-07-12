import { describe, expect, it } from "vitest";
import { isPlanRenewable } from "../src/lib/wix.js";

// Business rule (Babakar, 12/07): renewable = duration ≥ ~1 month AND not a
// gift card. Free programs are filtered out upstream (0 F) so never reach here.
describe("isPlanRenewable", () => {
  it("renews monthly plans and longer", () => {
    expect(isPlanRenewable("Pilates Reformer (3x/semaine)", 30)).toBe(true); // 1 mois
    expect(isPlanRenewable("Carnet de 10 Reformer", 60)).toBe(true); // 2 mois
  });

  it("never renews a short trial like the Pack Découverte (2 weeks)", () => {
    expect(isPlanRenewable("Pack Découverte", 14)).toBe(false);
  });

  it("never renews gift cards, even with a long duration", () => {
    expect(isPlanRenewable("Carte Cadeau", 90)).toBe(false);
    expect(isPlanRenewable("Carte Cadeau (mat)", 90)).toBe(false);
  });

  it("treats unknown/absent duration as NOT renewable (conservative)", () => {
    expect(isPlanRenewable("Illimité", null)).toBe(false);
  });

  it("uses a ~1 month floor of 28 days (a 3-week plan is not renewable)", () => {
    expect(isPlanRenewable("Essai 3 semaines", 21)).toBe(false);
    expect(isPlanRenewable("Plan 4 semaines", 28)).toBe(true);
  });
});
