import { afterEach, describe, expect, it, vi } from "vitest";
import { sendImageTemplate } from "../src/lib/whatsapp.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("sendImageTemplate", () => {
  it("uploads the PNG and sends its media id as the approved template image header", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      calls.push({ url, init });
      if (url.endsWith("/media")) {
        return new Response(JSON.stringify({ id: "media_story_123" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ messages: [{ id: "wamid.story.123" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }));

    const messageId = await sendImageTemplate(
      "+221770000000",
      Buffer.from("png"),
      "story_quotidienne",
      "en",
    );

    expect(messageId).toBe("wamid.story.123");
    expect(calls).toHaveLength(2);
    expect(calls[0].url).toMatch(/\/media$/);
    expect(calls[0].init?.body).toBeInstanceOf(FormData);
    expect(JSON.parse(String(calls[1].init?.body))).toEqual({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: "+221770000000",
      type: "template",
      template: {
        name: "story_quotidienne",
        language: { code: "en" },
        components: [
          {
            type: "header",
            parameters: [{ type: "image", image: { id: "media_story_123" } }],
          },
        ],
      },
    });
  });
});
