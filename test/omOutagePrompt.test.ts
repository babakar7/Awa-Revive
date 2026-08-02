import { describe, expect, it } from "vitest";
import { dynamicContext } from "../src/agent/systemPrompt.js";

const baseArgs = {
  clientName: "Marie",
  clientLanguage: "fr",
  activeBooking: null,
  activePlanOrder: null,
  activeCafeOrder: null,
  memberships: [],
  recentRefunds: [],
} as const;

// Mode panne OM (owner toggle, callbacks Sonatel perdus 31/07) : le bloc doit
// interdire le « paiement non reçu », imposer le handoff, et rester absent
// quand le mode est éteint.
describe("OM outage mode prompt block", () => {
  it("injects the outage rules when active", () => {
    const context = dynamicContext({ ...baseArgs, omOutageActive: true });
    expect(context).toContain("OUTAGE MODE");
    expect(context).toContain("NEVER say the payment was not received");
    expect(context).toContain("handoff_to_human");
    expect(context).toContain("Wave is NOT affected");
  });

  it("is absent when the mode is off", () => {
    expect(dynamicContext({ ...baseArgs })).not.toContain("OUTAGE MODE");
    expect(dynamicContext({ ...baseArgs, omOutageActive: false })).not.toContain("OUTAGE MODE");
  });
});
