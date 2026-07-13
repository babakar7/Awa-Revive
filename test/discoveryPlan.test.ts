import { describe, expect, it } from "vitest";
import { isDiscoveryPlan } from "../src/lib/wix.js";

// Business rule (Babakar, 13/07): Pack Découverte / trial plans are first-time
// Pilates only. Name-based classifier (same style as isPlanRenewable).
describe("isDiscoveryPlan", () => {
  it("matches the live Pack Découverte name and common trial variants", () => {
    expect(isDiscoveryPlan("Pack Découverte")).toBe(true);
    expect(isDiscoveryPlan("Pack découverte")).toBe(true);
    expect(isDiscoveryPlan("PACK DÉCOUVERTE")).toBe(true);
    expect(isDiscoveryPlan("Discovery Pack")).toBe(true);
    expect(isDiscoveryPlan("Essai Pilates")).toBe(true);
    expect(isDiscoveryPlan("Trial week")).toBe(true);
  });

  it("does not match normal subscriptions or carnets", () => {
    expect(isDiscoveryPlan("Abonnement mensuel")).toBe(false);
    expect(isDiscoveryPlan("Pilates Reformer (3x/semaine)")).toBe(false);
    expect(isDiscoveryPlan("Carnet de 10 Reformer")).toBe(false);
    expect(isDiscoveryPlan("Carte Cadeau")).toBe(false);
    expect(isDiscoveryPlan("Illimité")).toBe(false);
  });
});
