import { describe, expect, it } from "vitest";
import {
  buildHistoryMessages,
  conversationReplayContext,
  turnsAfterConversationGap,
} from "../src/agent/index.js";

// The agent replays past turns — including 'tool' turns (Awa's own actions) —
// into the alternating user/assistant messages the Messages API requires.
// Prod 13/07: without tool turns in context the model re-submitted a stale
// code and re-sent payment buttons because it couldn't see what it had done.

describe("buildHistoryMessages", () => {
  it("folds tool turns into the following assistant turn as ⟦trace⟧ lines", () => {
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
      "⟦trace⟧ list_classes({}) -> [...]\n⟦trace⟧ check_availability({}) -> {slot}\nvoici un créneau",
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
    expect(msgs[1].content).toBe("⟦trace⟧ t1 -> ok\n⟦trace⟧ t2 -> ok");
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
    // "⟦trace⟧ " prefix + 10 chars of the result.
    expect(msgs[1].content).toBe(`⟦trace⟧ ${"x".repeat(10)}`);
  });

  it("returns an empty array for empty history (caller supplies the current message)", () => {
    expect(buildHistoryMessages([])).toEqual([]);
  });
});

describe("turnsAfterConversationGap", () => {
  it("drops an unrelated old intent after a long silence", () => {
    const turns = [
      {
        role: "assistant",
        content: "Ton lien pour le cours de Pilates a expiré.",
        created_at: new Date("2026-07-12T12:00:00Z"),
      },
      {
        role: "user",
        content: "Par Wave",
        created_at: new Date("2026-07-27T16:05:00Z"),
      },
    ];

    expect(turnsAfterConversationGap(turns)).toEqual([turns[1]]);
  });

  it("keeps Aïda's latest intent as a stale-safe summary across the 24h reset", () => {
    const turns = [
      {
        role: "user",
        content: "Coucou je veux venir une fois par semaine les samedi à 12h15 comment faire et quel prix ?",
        created_at: new Date("2026-08-15T13:05:22Z"),
      },
      {
        role: "user",
        content: "Reformer",
        created_at: new Date("2026-08-15T13:05:34Z"),
      },
      {
        role: "user",
        content: "Non c’est la première fois",
        created_at: new Date("2026-08-15T13:06:47Z"),
      },
      {
        role: "tool",
        content: "check_availability({service_id: stale}) -> {slot_id: stale}",
        created_at: new Date("2026-08-15T13:06:53Z"),
      },
      {
        role: "assistant",
        content:
          "Aucun créneau samedi 12h15 pour l'instant. Voici les créneaux Reformer Foundation ouverts 👇\n" +
          "[message interactif list — options : Dimanche · 10:15]",
        created_at: new Date("2026-08-15T13:07:03Z"),
      },
      {
        role: "user",
        content: "Et maintenant?",
        created_at: new Date("2026-08-18T16:58:15Z"),
      },
    ];

    const context = conversationReplayContext(turns);

    expect(context.currentTurns).toEqual([turns[5]]);
    expect(context.gapDays).toBe(3);
    expect(context.priorSummary?.latestClientIntent).toContain("samedi à 12h15");
    expect(context.priorSummary?.latestClientIntent).toContain("Reformer");
    expect(context.priorSummary?.latestClientIntent).toContain("première fois");
    expect(context.priorSummary?.lastAssistantOutcome).toContain("Reformer Foundation");
    expect(JSON.stringify(context.priorSummary)).not.toContain("slot_id");
    expect(JSON.stringify(context.priorSummary)).not.toContain("Dimanche · 10:15");
  });

  it("keeps a continuous conversation, including tool turns", () => {
    const turns = [
      { role: "user", content: "u1", created_at: new Date("2026-07-27T10:00:00Z") },
      { role: "tool", content: "t1", created_at: new Date("2026-07-27T10:05:00Z") },
      { role: "assistant", content: "a1", created_at: new Date("2026-07-27T10:06:00Z") },
    ];

    expect(turnsAfterConversationGap(turns)).toEqual(turns);
  });
});
