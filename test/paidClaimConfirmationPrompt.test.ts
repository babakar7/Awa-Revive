import { describe, expect, it } from "vitest";
import { systemPrompt } from "../src/agent/systemPrompt.js";

// Incident Khadija 14/08 : la confirmation automatique « ✅ Paiement reçu » est
// arrivée à 21:33, la cliente écrit « C'est fait » à 21:34, et Awa répond
// « je n'ai pas encore reçu la confirmation » — contredisant le message
// précédent. La règle 4 du flux paiement doit imposer de relire l'historique
// AVANT de dérouler le script « la confirmation arrive dans une minute ou deux ».
describe("paid-claim vs already-sent confirmation (payment flow step 4)", () => {
  it("orders a history check before the waiting script", () => {
    const prompt = systemPrompt();
    const rule = prompt.split("\n").find((l) => l.startsWith("4. When they say they paid"));
    expect(rule).toBeDefined();
    expect(rule).toContain("FIRST reread the recent history");
    expect(rule).toContain("✅ Paiement reçu");
    expect(rule).toContain("NEVER say you are still waiting");
    // The waiting script survives, gated on the confirmation being absent.
    expect(rule).toContain("Only when NO ✅ confirmation appears in the history");
    expect(rule).toContain("handoff_to_human");
  });

  it("keeps the screenshot-is-not-proof rule intact", () => {
    const prompt = systemPrompt();
    expect(prompt).toContain("a screenshot is a claim, NOT proof");
  });
});
