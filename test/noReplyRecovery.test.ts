import { describe, expect, it } from "vitest";
import {
  buildHistoryMessages,
  classifyReplyOutcome,
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
});
