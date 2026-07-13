import { describe, expect, it } from "vitest";
import { shouldOfferOnboarding } from "../src/agent/systemPrompt.js";

describe("shouldOfferOnboarding", () => {
  const base = {
    unlinkedNeverAsked: false,
    hasHabit: false,
    assistantTurnCount: 0,
    hasActivePaymentLink: false,
  };

  it("true for a linked first-session client with no habit", () => {
    expect(shouldOfferOnboarding(base)).toBe(true);
  });

  it("false when account-linking invite is due (unlinkedNeverAsked)", () => {
    expect(shouldOfferOnboarding({ ...base, unlinkedNeverAsked: true })).toBe(false);
  });

  it("false when a booking habit exists (habit shortcut wins)", () => {
    expect(shouldOfferOnboarding({ ...base, hasHabit: true })).toBe(false);
  });

  it("false when an unpaid payment link is active", () => {
    expect(shouldOfferOnboarding({ ...base, hasActivePaymentLink: true })).toBe(false);
  });

  it("false after Awa has already replied at least once", () => {
    expect(shouldOfferOnboarding({ ...base, assistantTurnCount: 1 })).toBe(false);
    expect(shouldOfferOnboarding({ ...base, assistantTurnCount: 5 })).toBe(false);
  });
});
