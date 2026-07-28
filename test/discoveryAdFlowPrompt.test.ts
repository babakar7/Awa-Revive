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

  it("confirms that teleworking is welcome during opening hours", () => {
    expect(systemPrompt()).toMatch(/clients peuvent télétravailler chez Revive pendant les heures\s+d'ouverture/i);
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
    expect(context).toMatch(/introduce Awa up front as an automated assistant/);
    expect(context).toContain("Moi c'est Awa, je suis une assistante automatisée de Revive");
    expect(context).toContain('exact words "je suis une assistante automatisée"');
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
    expect(context).toMatch(/run request_email_verification/i);
  });

  it("keeps the Meta offer strictly on Reformer and uses the tool price for Step or any other class", () => {
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

    expect(context).toMatch(/ONLY to Pilates Reformer/i);
    expect(context).toMatch(/non-Reformer class \(including Step\).*normal price returned by the latest class or availability tool/i);
    expect(systemPrompt()).toMatch(/including Step, use the normal price returned by the class\/availability tool/i);
  });

  it("uses the short Pack Découverte copy for a new Meta-ad lead without asking eligibility", () => {
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
      packDiscoveryCampaign: true,
      packDiscoveryMetaNewLead: true,
    });

    expect(context).toContain("Always start with ‘Salut !’; never use or guess a client name");
    expect(context).toContain(
      "Salut ! Moi, c’est Awa, je suis une assistante automatisée de Revive 😊",
    );
    expect(context).not.toContain("Salut Sophie");
    expect(context).toContain("La première séance de Pilates Reformer coûte 10 000 FCFA.");
    expect(context).toContain("3 séances pour 30 000 FCFA sur 2 semaines.");
    expect(context).toContain("Si la séance ne te convient pas, elle est remboursée.");
    expect(context).toMatch(/Do NOT ask whether she has already done Pilates at Revive/i);
  });

  it("does not let a sticker or ambiguous acknowledgement decide eligibility", () => {
    expect(systemPrompt()).toMatch(/Never interpret a sticker, emoji, reaction, acknowledgement/i);
    expect(systemPrompt()).toMatch(/explicit statement.*Pilates at Revive/i);
  });
});
