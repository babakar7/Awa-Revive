import { describe, expect, it } from "vitest";
import { silentLeadNudgeMessage } from "../src/domain/leadNudge.js";

describe("silentLeadNudgeMessage", () => {
  it("greets by name in French and never promises a reservation", () => {
    const msg = silentLeadNudgeMessage(null, "Fatou");
    expect(msg).toContain("Coucou, Fatou");
    expect(msg).toContain("Awa, de Revive");
    expect(msg).toContain("L'Invitée");
    expect(msg).toContain("matin ou soir");
    // payment-first: help find a spot, not hold one
    expect(msg).toContain("t'aider à trouver une place");
    expect(msg).not.toMatch(/garde.* une place/i);
  });

  it("omits the comma when there is no name", () => {
    expect(silentLeadNudgeMessage(null, null)).toMatch(/^Coucou 👋🏾/);
    expect(silentLeadNudgeMessage(null, "   ")).toMatch(/^Coucou 👋🏾/);
  });

  it("switches to English on language=en", () => {
    const msg = silentLeadNudgeMessage("en", "Sophie");
    expect(msg).toContain("Hi, Sophie!");
    expect(msg).toContain("Awa from Revive");
    expect(msg).toContain("mornings or evenings");
  });
});
