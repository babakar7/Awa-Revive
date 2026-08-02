import { describe, expect, it } from "vitest";
import {
  classifyConversationSignal,
  isTranscriptionPromptEcho,
  noIntentClosingMessage,
  TRANSCRIPTION_CONTEXT_PROMPT,
} from "../src/domain/noIntentGuard.js";

describe("no-intent conversation guard", () => {
  it("trips on the third Atueydjk-style low-information voice turn", () => {
    const transcript = [
      "[note vocale] Bonsoir, je vous remercie.",
      "[note vocale] espérons nous.",
      "[note vocale] ana petrol bi?",
      "[note vocale] À la prochaine.",
    ];
    let streak = 0;
    const tripAt = transcript.findIndex((turn) => {
      const signal = classifyConversationSignal(turn);
      streak = signal === "no_intent" ? streak + 1 : 0;
      return streak === 3;
    });
    expect(tripAt).toBe(2);
  });

  it("recognizes transcription prompt hallucinations as noise", () => {
    expect(isTranscriptionPromptEcho(TRANSCRIPTION_CONTEXT_PROMPT)).toBe(true);
    expect(
      classifyConversationSignal(`[note vocale] ${TRANSCRIPTION_CONTEXT_PROMPT}`),
    ).toBe("no_intent");
  });

  it.each([
    "Je veux réserver un cours",
    "Pilates demain à 18h",
    "[choix cliqué] Réserver (id: cap_book)",
    "fatou@example.com",
    "123456",
    "Où se trouve le studio ?",
    "Je voudrais essayer",
  ])("keeps a clear Revive continuation active: %s", (text) => {
    expect(classifyConversationSignal(text)).toBe("revive_intent");
  });

  it("does not mute a substantive unknown question on a keyword miss", () => {
    expect(
      classifyConversationSignal("Pourriez-vous m'expliquer comment cela fonctionne exactement ?"),
    ).toBe("substantive");
  });

  it("localizes the deterministic closing and preserves vouvoiement", () => {
    expect(noIntentClosingMessage("fr", true)).toContain("Je suis l’assistante automatisée");
    expect(noIntentClosingMessage("en")).toContain("Revive’s automated assistant");
    expect(noIntentClosingMessage("wo")).toContain("Man Awa laa");
  });
});
