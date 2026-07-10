import { describe, expect, it } from "vitest";
import { buildInteractivePayload, parseInboundMessages } from "../src/lib/whatsapp.js";
import { slotChoiceKey } from "../src/domain/repo.js";

describe("buildInteractivePayload", () => {
  it("uses reply buttons for ≤3 options without descriptions", () => {
    const { kind, payload } = buildInteractivePayload("221771234567", "Autre chose ?", "Choisir", [
      { id: "done", title: "C'est tout ✅" },
      { id: "more", title: "Ajouter autre chose" },
    ]);
    expect(kind).toBe("buttons");
    const interactive = (payload as any).interactive;
    expect(interactive.type).toBe("button");
    expect(interactive.action.buttons).toEqual([
      { type: "reply", reply: { id: "done", title: "C'est tout ✅" } },
      { type: "reply", reply: { id: "more", title: "Ajouter autre chose" } },
    ]);
  });

  it("uses a list when any option has a description or >3 options", () => {
    const { kind, payload } = buildInteractivePayload("221771234567", "Nos matchas 🍵", "Voir le menu", [
      { id: "MATCHA_VANILLE", title: "Iced Matcha Vanille", description: "3 500 F · doux et crémeux" },
      { id: "MATCHA_PISTACHE", title: "Iced Matcha Pistache", description: "4 000 F · notre chouchou" },
    ]);
    expect(kind).toBe("list");
    const interactive = (payload as any).interactive;
    expect(interactive.type).toBe("list");
    expect(interactive.action.button).toBe("Voir le menu");
    expect(interactive.action.sections[0].rows).toHaveLength(2);
    expect(interactive.action.sections[0].rows[0]).toEqual({
      id: "MATCHA_VANILLE",
      title: "Iced Matcha Vanille",
      description: "3 500 F · doux et crémeux",
    });
  });

  it("truncates to Meta limits (row title 24, description 72, button 20)", () => {
    const { payload } = buildInteractivePayload("2217", "corps", "un label de bouton beaucoup trop long", [
      { id: "a", title: "x".repeat(40), description: "y".repeat(100) },
      { id: "b", title: "b", description: "d" },
      { id: "c", title: "c", description: "d" },
      { id: "d", title: "d", description: "d" },
    ]);
    const action = (payload as any).interactive.action;
    expect(action.button).toHaveLength(20);
    expect(action.sections[0].rows[0].title).toHaveLength(24);
    expect(action.sections[0].rows[0].description).toHaveLength(72);
  });

  it("rejects 0, >10 and duplicate-id options", () => {
    expect(() => buildInteractivePayload("2217", "b", "l", [])).toThrow(/1-10/);
    expect(() =>
      buildInteractivePayload(
        "2217",
        "b",
        "l",
        Array.from({ length: 11 }, (_, i) => ({ id: `o${i}`, title: `Option ${i}` })),
      ),
    ).toThrow(/1-10/);
    expect(() =>
      buildInteractivePayload("2217", "b", "l", [
        { id: "same", title: "A" },
        { id: "same", title: "B" },
      ]),
    ).toThrow(/unique/);
  });
});

describe("parseInboundMessages — interactive replies", () => {
  const envelope = (message: Record<string, unknown>) => ({
    entry: [
      {
        changes: [
          {
            field: "messages",
            value: {
              contacts: [{ wa_id: "221771234567", profile: { name: "Fatou" } }],
              messages: [message],
            },
          },
        ],
      },
    ],
  });

  it("extracts a list_reply as text=title + interactiveId", () => {
    const [msg] = parseInboundMessages(
      envelope({
        from: "221771234567",
        id: "wamid.1",
        type: "interactive",
        interactive: {
          type: "list_reply",
          list_reply: { id: "MATCHA_PISTACHE", title: "Iced Matcha Pistache", description: "4 000 F" },
        },
      }),
    );
    expect(msg).toMatchObject({
      type: "interactive",
      text: "Iced Matcha Pistache",
      interactiveId: "MATCHA_PISTACHE",
      profileName: "Fatou",
    });
  });

  it("extracts a button_reply the same way", () => {
    const [msg] = parseInboundMessages(
      envelope({
        from: "221771234567",
        id: "wamid.2",
        type: "interactive",
        interactive: { type: "button_reply", button_reply: { id: "done", title: "C'est tout ✅" } },
      }),
    );
    expect(msg).toMatchObject({ type: "interactive", text: "C'est tout ✅", interactiveId: "done" });
  });

  it("still parses plain text messages unchanged", () => {
    const [msg] = parseInboundMessages(
      envelope({ from: "221771234567", id: "wamid.3", type: "text", text: { body: "salut" } }),
    );
    expect(msg).toMatchObject({ type: "text", text: "salut", interactiveId: undefined });
  });

  it("extracts the media id from voice notes (audio messages)", () => {
    const [msg] = parseInboundMessages(
      envelope({
        from: "221771234567",
        id: "wamid.4",
        type: "audio",
        audio: { id: "media_123", mime_type: "audio/ogg; codecs=opus", voice: true },
      }),
    );
    expect(msg).toMatchObject({ type: "audio", mediaId: "media_123", text: undefined });
  });
});

describe("slotChoiceKey", () => {
  it("is deterministic, under WhatsApp's 200-char row id limit, and collision-distinct", () => {
    const longEventId = "x".repeat(320);
    const key = slotChoiceKey(longEventId);
    expect(key.length).toBeLessThanOrEqual(200);
    expect(key).toBe(slotChoiceKey(longEventId));
    expect(key).not.toBe(slotChoiceKey(`${longEventId}y`));
  });
});
