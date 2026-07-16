import { describe, expect, it } from "vitest";
import { isGiftCard } from "../src/lib/wix.js";

// Business rule (Babakar, 16/07): Awa must never SELL a gift card (it would
// activate on the buyer's own account). listPlans() drops gift cards so they
// never reach list_plans / getPlan. Name-based, same style as isDiscoveryPlan.
describe("isGiftCard", () => {
  it("matches the live gift card names and common variants", () => {
    expect(isGiftCard("Carte Cadeau")).toBe(true);
    expect(isGiftCard("Carte Cadeau (mat)")).toBe(true);
    expect(isGiftCard("carte cadeau reformer")).toBe(true);
    expect(isGiftCard("Gift Card")).toBe(true);
  });

  it("does not match normal subscriptions, carnets or the discovery pack", () => {
    expect(isGiftCard("Pack Découverte")).toBe(false);
    expect(isGiftCard("Carnet de 10 Reformer")).toBe(false);
    expect(isGiftCard("Pilates Reformer (3x/semaine)")).toBe(false);
    expect(isGiftCard("1x Reformer")).toBe(false);
  });
});
