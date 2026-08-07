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

// Prod 07/08 (Kadidiatou Diallo) : réponse « Dimanche » 22 h après la liste de
// créneaux — les lignes presented_choices avaient expiré (TTL 2 h), la garde
// « pending » ne s'est pas armée et le modèle a répondu <NO_REPLY> deux fois
// (fallback technique + takeover 12 h). Le bloc « expired » couvre ce trou :
// sentinelle interdit ET ids périmés à re-vérifier via les outils.
describe("expired interactive list prompt block", () => {
  it("bans <NO_REPLY> and stale ids when the client answers an expired list", () => {
    const context = dynamicContext({ ...baseArgs, expiredInteractiveList: true });
    expect(context).toContain("EXPIRED INTERACTIVE LIST");
    expect(context).toContain("<NO_REPLY> now is FORBIDDEN");
    expect(context).toContain("FRESH");
    expect(context).toContain("never treat the old list's entries as still valid");
  });

  it("is absent by default", () => {
    expect(dynamicContext({ ...baseArgs })).not.toContain("EXPIRED INTERACTIVE LIST");
    expect(dynamicContext({ ...baseArgs, expiredInteractiveList: false })).not.toContain(
      "EXPIRED INTERACTIVE LIST",
    );
  });
});
