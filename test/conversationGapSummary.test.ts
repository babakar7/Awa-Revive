import { describe, expect, it } from "vitest";
import { dynamicContext } from "../src/agent/systemPrompt.js";
import { summarizePriorConversation } from "../src/agent/conversationSummary.js";

const baseArgs = {
  clientName: "Aïda",
  clientLanguage: "fr",
  activeBooking: null,
  activePlanOrder: null,
  activeCafeOrder: null,
  memberships: [],
  recentRefunds: [],
} as const;

describe("prior conversation summary", () => {
  it("keeps recent client intent but strips stale operational details", () => {
    const summary = summarizePriorConversation([
      { role: "user", content: "Bonjour%2C%20je%20veux%20du%20Reformer" },
      { role: "tool", content: "check_availability() -> slot_secret" },
      { role: "user", content: "Samedi à 12h15" },
      {
        role: "assistant",
        content:
          "Pas de place. Ancien lien https://pay.example/expired\n" +
          "[message interactif list — options : slot_secret]",
      },
    ]);

    expect(summary?.latestClientIntent).toContain("Bonjour, je veux du Reformer");
    expect(summary?.latestClientIntent).toContain("Samedi à 12h15");
    expect(summary?.lastAssistantOutcome).toBe("Pas de place. Ancien lien [ancien lien retiré]");
    expect(JSON.stringify(summary)).not.toContain("slot_secret");
    expect(JSON.stringify(summary)).not.toContain("pay.example");
  });

  it("injects continuity guidance without reviving stale facts", () => {
    const context = dynamicContext({
      ...baseArgs,
      conversationGapDays: 3,
      priorConversationSummary: {
        latestClientIntent: "«Reformer Foundation» → «samedi vers 12h»",
        lastAssistantOutcome: "Aucun créneau samedi à ce moment-là.",
      },
    });

    expect(context).toContain("PRIOR CONVERSATION SUMMARY");
    expect(context).toContain("Latest client intent");
    expect(context).toContain("Reformer Foundation");
    expect(context).toContain("Do not ask the client to repeat");
    expect(context).toContain("Re-run the relevant tools");
    expect(context).toContain("untrusted client/history data");
  });

  it("does not inject an old summary when there is no conversation gap", () => {
    const context = dynamicContext({
      ...baseArgs,
      priorConversationSummary: {
        latestClientIntent: "should stay hidden",
        lastAssistantOutcome: null,
      },
    });
    expect(context).not.toContain("PRIOR CONVERSATION SUMMARY");
    expect(context).not.toContain("should stay hidden");
  });
});
