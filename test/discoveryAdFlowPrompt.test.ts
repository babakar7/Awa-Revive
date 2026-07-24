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

    expect(context).toMatch(/30,000 FCFA total/i);
    expect(context).toMatch(/ALREADY the first part/i);
    expect(context).toMatch(/NOT an extra charge/i);
    expect(context).toMatch(/Never present 10,000 and 30,000 as two sequential or additive/i);
  });

  it("leads with the 10,000 first session and books it via create_payment_link, not the plan", () => {
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

    expect(context).toMatch(/LEAD with the 10,000/i);
    expect(context).toMatch(/never call create_plan_payment_link/i);
    expect(context).toMatch(/create_payment_link/);
    expect(context).toMatch(/only take the 10,000 payment once the client picks one/i);
  });
});
