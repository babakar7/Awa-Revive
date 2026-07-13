import { describe, expect, it } from "vitest";
import { buildHistoryMessages } from "../src/agent/index.js";

// The agent replays past turns — including 'tool' turns (Awa's own actions) —
// into the alternating user/assistant messages the Messages API requires.
// Prod 13/07: without tool turns in context the model re-submitted a stale
// code and re-sent payment buttons because it couldn't see what it had done.

describe("buildHistoryMessages", () => {
  it("folds tool turns into the following assistant turn as [outil] lines", () => {
    const msgs = buildHistoryMessages([
      { role: "user", content: "je veux réserver" },
      { role: "tool", content: "list_classes({}) -> [...]" },
      { role: "tool", content: "check_availability({}) -> {slot}" },
      { role: "assistant", content: "voici un créneau" },
    ]);
    expect(msgs).toHaveLength(2);
    expect(msgs[0]).toEqual({ role: "user", content: "je veux réserver" });
    expect(msgs[1].role).toBe("assistant");
    expect(msgs[1].content).toBe(
      "[outil] list_classes({}) -> [...]\n[outil] check_availability({}) -> {slot}\nvoici un créneau",
    );
  });

  it("keeps roles strictly alternating across a multi-turn conversation", () => {
    const msgs = buildHistoryMessages([
      { role: "user", content: "u1" },
      { role: "tool", content: "t1 -> ok" },
      { role: "assistant", content: "a1" },
      { role: "user", content: "u2" },
      { role: "tool", content: "t2 -> ok" },
      { role: "assistant", content: "a2" },
    ]);
    expect(msgs.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant"]);
  });

  it("drops leading non-user turns (assistant/tool) so the first message is user", () => {
    const msgs = buildHistoryMessages([
      { role: "assistant", content: "orphan reply" },
      { role: "tool", content: "orphan tool -> x" },
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
    ]);
    expect(msgs).toEqual([
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
    ]);
  });

  it("coalesces tool turns that have no following assistant (failed/undelivered reply)", () => {
    // The assistant reply never got persisted (WhatsApp send failed), leaving
    // only user + tool turns — must still produce valid alternation.
    const msgs = buildHistoryMessages([
      { role: "user", content: "u1" },
      { role: "tool", content: "t1 -> ok" },
      { role: "tool", content: "t2 -> ok" },
      { role: "user", content: "u2" },
    ]);
    expect(msgs.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(msgs[1].content).toBe("[outil] t1 -> ok\n[outil] t2 -> ok");
  });

  it("caps each replayed tool result at the given length", () => {
    const long = "x".repeat(50);
    const msgs = buildHistoryMessages(
      [
        { role: "user", content: "u" },
        { role: "tool", content: long },
      ],
      10,
    );
    // "[outil] " prefix + 10 chars of the result.
    expect(msgs[1].content).toBe(`[outil] ${"x".repeat(10)}`);
  });

  it("returns an empty array for empty history (caller supplies the current message)", () => {
    expect(buildHistoryMessages([])).toEqual([]);
  });
});
