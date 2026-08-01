import { describe, expect, it } from "vitest";
import {
  buildHistoryMessages,
  classifyReplyOutcome,
  modelSilenceFallbackMessage,
  stripNoReplySentinel,
} from "../src/agent/index.js";
import { NO_REPLY_SENTINEL } from "../src/agent/tools.js";

// Prod regression, 22/07: Awa sent an interactive Aquabike list, the client
// answered "Ok merci" on the next turn, and a stale <NO_REPLY> was mistaken for
// an outage. The sentinel is valid only in the SAME turn as present_options.
describe("classifyReplyOutcome", () => {
  it("recovers a stale NO_REPLY on the message after an interactive list", () => {
    const history = buildHistoryMessages([
      { role: "user", content: "Cours Aquabike amena taye?" },
      {
        role: "assistant",
        content: "Pas d'Aquabike aujourd'hui. [message interactif list]",
      },
      {
        role: "tool",
        content: `present_options({}) -> {"sent":true,"note":"Reply exactly ${NO_REPLY_SENTINEL}"}`,
      },
      { role: "user", content: "Ok merci" },
    ]);

    expect(history.at(-1)).toEqual({ role: "user", content: "Ok merci" });
    expect(classifyReplyOutcome(NO_REPLY_SENTINEL, false)).toBe("recover");
  });

  it("keeps NO_REPLY silent when present_options succeeded in the current turn", () => {
    expect(classifyReplyOutcome(NO_REPLY_SENTINEL, true)).toBe(
      "silent_after_interactive",
    );
    expect(classifyReplyOutcome("", true)).toBe("silent_after_interactive");
  });

  it("recovers an unexplained empty model response but delivers real text", () => {
    expect(classifyReplyOutcome("", false)).toBe("recover");
    expect(classifyReplyOutcome("Avec plaisir 😊", false)).toBe("deliver");
  });

  it("uses a calm acknowledgement when recovery itself returns NO_REPLY", () => {
    expect(modelSilenceFallbackMessage()).not.toMatch(/souci technique/i);
    expect(modelSilenceFallbackMessage()).toContain("Je suis là");
  });
});

// Prod regression, 01/08: Gogo Ibrahim received "<NO_REPLY>\n\nPour répondre..."
// because the model mixed the internal sentinel with a genuine answer. The token
// must be stripped, the real text delivered, and a pure sentinel still recover.
describe("stripNoReplySentinel", () => {
  it("returns empty for the sentinel alone, whatever the surrounding whitespace", () => {
    expect(stripNoReplySentinel(NO_REPLY_SENTINEL)).toBe("");
    expect(stripNoReplySentinel(`  ${NO_REPLY_SENTINEL}  `)).toBe("");
    expect(stripNoReplySentinel(`\n\n${NO_REPLY_SENTINEL}\n`)).toBe("");
    expect(stripNoReplySentinel(null)).toBe("");
    expect(stripNoReplySentinel("")).toBe("");
  });

  it("keeps the real text when the sentinel leads, trails, sits mid-text, or repeats", () => {
    expect(stripNoReplySentinel(`${NO_REPLY_SENTINEL}\n\nPour répondre à ta question : oui !`)).toBe(
      "Pour répondre à ta question : oui !",
    );
    expect(stripNoReplySentinel(`Avec plaisir 😊 ${NO_REPLY_SENTINEL}`)).toBe("Avec plaisir 😊");
    expect(stripNoReplySentinel(`Bonjour${NO_REPLY_SENTINEL}à bientôt`)).toBe("Bonjour à bientôt");
    expect(
      stripNoReplySentinel(`${NO_REPLY_SENTINEL}\nOui${NO_REPLY_SENTINEL}\nvoici les créneaux 👇`),
    ).toBe("Oui voici les créneaux 👇");
  });

  it("leaves a normal reply untouched", () => {
    expect(stripNoReplySentinel("Voici ton lien de paiement 👇")).toBe(
      "Voici ton lien de paiement 👇",
    );
  });
});

describe("classifyReplyOutcome with a leaked sentinel", () => {
  it("delivers the real text when the sentinel is mixed in and no interactive was sent", () => {
    expect(
      classifyReplyOutcome(`${NO_REPLY_SENTINEL}\n\nOui, il y a bien la natation !`, false),
    ).toBe("deliver");
  });

  it("stays silent when the sentinel is mixed in but an interactive message went out", () => {
    expect(
      classifyReplyOutcome(`${NO_REPLY_SENTINEL}\n\nDétails en plus`, true),
    ).toBe("deliver");
    // pure sentinel after an interactive send is still suppressed
    expect(classifyReplyOutcome(`  ${NO_REPLY_SENTINEL}  `, true)).toBe(
      "silent_after_interactive",
    );
  });
});
