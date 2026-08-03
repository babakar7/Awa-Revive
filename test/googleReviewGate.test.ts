import { describe, expect, it } from "vitest";
import { reviewGateApplies } from "../src/domain/keyRules.js";
import { googleReviewAskMessage } from "../src/domain/fulfillment.js";
import { dynamicContext, systemPrompt } from "../src/agent/systemPrompt.js";

const ctxBase = {
  clientName: null,
  clientLanguage: "fr",
  activeBooking: null,
  activePlanOrder: null,
  memberships: null,
  recentRefunds: [],
} as const;

const base = {
  featureEnabled: true,
  typeEligible: true,
  earlyRenewal: true,
  clientKnown: true,
  clientAlreadyGated: false,
  invitationCount: 1,
};

describe("reviewGateApplies", () => {
  it("gates a client's first early renewal that earns an invitation", () => {
    expect(reviewGateApplies(base)).toBe(true);
  });

  it.each([
    ["feature off", { featureEnabled: false }],
    ["type not eligible", { typeEligible: false }],
    ["not an early renewal", { earlyRenewal: false }],
    ["anonymous purchase", { clientKnown: false }],
    ["client already gated once", { clientAlreadyGated: true }],
    ["no invitation earned", { invitationCount: 0 }],
  ] as const)("does not gate when %s", (_label, override) => {
    expect(reviewGateApplies({ ...base, ...override })).toBe(false);
  });
});

describe("googleReviewAskMessage", () => {
  it.each(["fr", "en", "wo"] as const)("includes the review link (%s)", (lang) => {
    const url = "https://g.page/r/EXAMPLE/review";
    const msg = googleReviewAskMessage(lang, url);
    expect(msg).toContain(url);
    expect(msg.length).toBeGreaterThan(40);
  });

  it("uses tutoiement in the French copy (frenchRegister flips to vous)", () => {
    const msg = googleReviewAskMessage("fr", "https://g.page/r/EXAMPLE/review");
    expect(msg).toMatch(/\bta\b|\btu\b|\bton\b/);
  });
});

describe("review gate prompt contract", () => {
  const link = "https://g.page/r/EXAMPLE/review";

  it("carries the static gate rule with the no-pressure / screenshot stance", () => {
    const prompt = systemPrompt();
    expect(prompt).toMatch(/GOOGLE REVIEW GATE/);
    expect(prompt).toMatch(/record_google_review/);
    expect(prompt).toMatch(/never pressure/i);
  });

  it("announces the condition (with the link) only in the announce state", () => {
    const text = dynamicContext({ ...ctxBase, reviewGate: "announce", reviewLink: link });
    expect(text).toMatch(/GOOGLE REVIEW — À ANNONCER/);
    expect(text).toContain(link);
  });

  it("prompts activation on a screenshot in the pending state", () => {
    const text = dynamicContext({ ...ctxBase, reviewGate: "pending", reviewLink: link });
    expect(text).toMatch(/GOOGLE REVIEW — EN ATTENTE/);
    expect(text).toMatch(/record_google_review/);
    expect(text).toContain(link);
  });

  it("says nothing about reviews once activated (null)", () => {
    const text = dynamicContext({ ...ctxBase, reviewGate: null, reviewLink: link });
    expect(text).not.toMatch(/GOOGLE REVIEW/);
  });
});
