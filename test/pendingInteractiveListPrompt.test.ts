import { describe, expect, it } from "vitest";
import { dynamicContext } from "../src/agent/systemPrompt.js";

const baseArgs = {
  clientName: "Mareme",
  clientLanguage: "fr",
  activeBooking: null,
  activePlanOrder: null,
  activeCafeOrder: null,
  memberships: [],
  recentRefunds: [],
} as const;

// Prod 06/08 (Mareme Diatta) : la cliente répond en texte libre (« niveau
// débutant ») juste après une liste interactive de créneaux, sans en choisir un.
// Le modèle a reconduit la discipline <NO_REPLY> de present_options sur CE tour
// et s'est tu deux fois → fallback technique + handoff, lead chaud perdu. Le
// bloc doit interdire explicitement le sentinelle sur le tour courant, et
// rester absent quand aucune liste n'est en attente (ou que le texte a résolu
// un choix — le flag est alors false côté handler).
describe("pending interactive list prompt block", () => {
  it("bans <NO_REPLY> for the current turn when a list is pending unanswered", () => {
    const context = dynamicContext({ ...baseArgs, pendingInteractiveList: true });
    expect(context).toContain("PENDING INTERACTIVE LIST");
    expect(context).toContain("does NOT count");
    expect(context).toContain("<NO_REPLY> now is FORBIDDEN");
    expect(context).toContain("Answer their message normally");
  });

  it("is absent when no list is pending", () => {
    expect(dynamicContext({ ...baseArgs })).not.toContain("PENDING INTERACTIVE LIST");
    expect(dynamicContext({ ...baseArgs, pendingInteractiveList: false })).not.toContain(
      "PENDING INTERACTIVE LIST",
    );
  });
});
