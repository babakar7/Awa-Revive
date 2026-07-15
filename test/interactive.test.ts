import { describe, expect, it } from "vitest";
import { buildInteractivePayload, parseInboundMessages, parseStatuses } from "../src/lib/whatsapp.js";
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

  it("groups rows into sections in ONE list (categories without re-opening)", () => {
    const { kind, payload } = buildInteractivePayload("221771234567", "Nos incontournables 👇", "Voir le menu", [
      { id: "MATCHA_VANILLE", title: "Iced Matcha Vanille", description: "3 500 F", section: "🍵 Iced Matcha" },
      { id: "MATCHA_PISTACHE", title: "Iced Matcha Pistache", description: "4 000 F", section: "🍵 Iced Matcha" },
      { id: "SMOOTHIE_JANT_BI", title: "Jant Bi", description: "3 000 F", section: "🥤 Smoothies" },
    ]);
    expect(kind).toBe("list");
    const sections = (payload as any).interactive.action.sections;
    expect(sections).toHaveLength(2);
    expect(sections[0].title).toBe("🍵 Iced Matcha");
    expect(sections[0].rows).toHaveLength(2);
    expect(sections[1].title).toBe("🥤 Smoothies");
    expect(sections[1].rows).toHaveLength(1);
    expect(sections[1].rows[0].id).toBe("SMOOTHIE_JANT_BI");
    // Still capped at 10 rows TOTAL across sections.
    const total = sections.reduce((n: number, s: any) => n + s.rows.length, 0);
    expect(total).toBeLessThanOrEqual(10);
  });

  it("a single unnamed section carries no title; sectioned options force a list even if ≤3", () => {
    const flat = buildInteractivePayload("2217", "b", "l", [
      { id: "a", title: "A", description: "d" },
    ]);
    expect(flat.payload.interactive as any).toMatchObject({ type: "list" });
    expect((flat.payload as any).interactive.action.sections[0].title).toBeUndefined();
    const sectioned = buildInteractivePayload("2217", "b", "l", [
      { id: "a", title: "A", section: "Cat" },
    ]);
    expect((sectioned.payload as any).interactive.type).toBe("list"); // not buttons
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

  it("extracts the media id and caption from image messages", () => {
    const [msg] = parseInboundMessages(
      envelope({
        from: "221771234567",
        id: "wamid.5",
        type: "image",
        image: { id: "media_456", mime_type: "image/jpeg", caption: "j'ai payé, regarde" },
      }),
    );
    expect(msg).toMatchObject({
      type: "image",
      mediaId: "media_456",
      caption: "j'ai payé, regarde",
      text: undefined,
    });
  });

  it("leaves caption undefined on an image without one", () => {
    const [msg] = parseInboundMessages(
      envelope({
        from: "221771234567",
        id: "wamid.6",
        type: "image",
        image: { id: "media_789", mime_type: "image/jpeg" },
      }),
    );
    expect(msg).toMatchObject({ type: "image", mediaId: "media_789", caption: undefined });
  });
});

describe("parseStatuses", () => {
  const payload = (statuses: unknown) => ({
    entry: [{ changes: [{ field: "statuses", value: { statuses } }] }],
  });

  it("extracts a failed status with its error code/title", () => {
    const out = parseStatuses(
      payload([
        {
          id: "wamid.ABC",
          status: "failed",
          errors: [{ code: 131047, title: "Re-engagement message" }],
        },
      ]),
    );
    expect(out).toEqual([
      { wamid: "wamid.ABC", status: "failed", errorCode: 131047, errorTitle: "Re-engagement message" },
    ]);
  });

  it("returns sent/delivered too, and ignores rows without an id", () => {
    const out = parseStatuses(payload([{ id: "wamid.OK", status: "delivered" }, { status: "read" }]));
    expect(out).toEqual([{ wamid: "wamid.OK", status: "delivered", errorCode: undefined, errorTitle: undefined }]);
  });

  it("is empty for an inbound-message payload (no statuses)", () => {
    expect(parseStatuses({ entry: [{ changes: [{ field: "messages", value: { messages: [] } }] }] })).toEqual([]);
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
