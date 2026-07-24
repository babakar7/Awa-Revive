import { describe, expect, it } from "vitest";
import { dynamicContext, systemPrompt } from "../src/agent/systemPrompt.js";

describe("Pack Découverte ad-lead prompt contract", () => {
  it("contains the documented risk reversal and keeps the included drink outside the paid bar flow", () => {
    const prompt = systemPrompt();

    expect(prompt).toMatch(/garantie satisfait ou remboursé/i);
    expect(prompt).toMatch(/intégralement remboursé/i);
    expect(prompt).toMatch(/boisson au choix du menu\s+café/i);
    expect(prompt).toMatch(/ne passe JAMAIS par create_cafe_payment_link/i);
  });

  it("qualifies and shows a real slot before asking for the name and plan payment", () => {
    const prompt = systemPrompt();

    expect(prompt).toMatch(/PRIORITY EXCEPTION — NEW PROSPECT \+ PACK DÉCOUVERTE/);
    expect(prompt).toMatch(/initial sales intent, NOT confirmation/i);
    expect(prompt).toMatch(/Only after they select a slot may you ask for their first name/i);
    expect(prompt).toMatch(/payment webhook does not wake you or persist the chosen slot/i);
  });

  it("limits each client-facing message to one information request", () => {
    expect(systemPrompt()).toMatch(/at most ONE information request per client-facing message/);
  });

  it("keeps the first-contact AI disclosure mandate in dynamic context", () => {
    const context = dynamicContext({
      clientName: null,
      clientLanguage: "fr",
      activeBooking: null,
      activePlanOrder: null,
      activeCafeOrder: null,
      memberships: [],
      recentRefunds: [],
      habit: null,
      firstContact: true,
    });

    expect(context).toMatch(/FIRST CONTACT/);
    expect(context).toMatch(/introduce Awa as Revive's assistant/);
    expect(context).toContain("Moi c'est Awa, l'assistante de Revive");
  });

  it("states the Meta-campaign pack economics without double-counting the first session", () => {
    const context = dynamicContext({
      clientName: null,
      clientLanguage: "fr",
      activeBooking: null,
      activePlanOrder: null,
      activeCafeOrder: null,
      memberships: [],
      recentRefunds: [],
      habit: null,
      firstContact: false,
      packDiscoveryCampaign: true,
    });

    expect(context).toMatch(/3 sessions for 30,000 FCFA total/i);
    expect(context).toMatch(/ALREADY part of the 30,000 total/i);
    expect(context).toMatch(/NOT an extra charge/i);
    expect(context).toMatch(/Never present 10,000 and 30,000 as two sequential or additive/i);
  });

  it("defers payment: first message pitches without a pay-now push, slot before payment", () => {
    const context = dynamicContext({
      clientName: null,
      clientLanguage: "fr",
      activeBooking: null,
      activePlanOrder: null,
      activeCafeOrder: null,
      memberships: [],
      recentRefunds: [],
      habit: null,
      firstContact: false,
      packDiscoveryCampaign: true,
    });

    expect(context).toMatch(/DO NOT mention paying now or the 10,000 first-session amount yet/i);
    expect(context).toMatch(/Lead with proposing a real slot, not payment/i);
    expect(context).toMatch(/Only AFTER the client agrees on a slot do you move to payment/i);
  });
});
