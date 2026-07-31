import { afterEach, describe, expect, it } from "vitest";
import { config } from "../src/config.js";
import { systemPrompt } from "../src/agent/systemPrompt.js";
import { TOOL_DEFINITIONS } from "../src/agent/tools.js";
import { hasPastReformerBooking } from "../src/lib/wix.js";

const realFetch = globalThis.fetch;
const originalReformerIds = [...config.KEY_REFORMER_SERVICE_IDS];

afterEach(() => {
  globalThis.fetch = realFetch;
  config.KEY_REFORMER_SERVICE_IDS = [...originalReformerIds];
});

describe("Key invitation eligibility", () => {
  it("aligns Awa's prompt and tool contract with Reformer-only history", () => {
    const prompt = systemPrompt();
    const tool = TOOL_DEFINITIONS.find((definition) => definition.name === "book_key_invitation");

    expect(prompt).toMatch(/NEVER taken a REFORMER class at Revive/);
    expect(prompt).toMatch(/Aquabike, Yoga, Mat, Step.*does NOT disqualify/is);
    expect(tool?.description).toMatch(/never have taken a Reformer class at Revive/i);
    expect(tool?.description).toMatch(/other Revive visits do not disqualify/i);
  });

  it("allows non-Reformer history and rejects configured or labelled Reformer history", async () => {
    config.KEY_REFORMER_SERVICE_IDS = ["reformer-current"];
    const bookings: Record<string, any[]> = {
      "contact-aqua": [booking("aqua", "Aquabike")],
      "contact-current": [booking("reformer-current", "Foundation")],
      "contact-legacy": [booking("reformer-old", "")],
    };

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/_api/bookings-reader/v2/extended-bookings/query")) {
        const body = JSON.parse(String(init?.body ?? "{}"));
        const contactId = body?.query?.filter?.["contactDetails.contactId"];
        return json({ extendedBookings: bookings[contactId] ?? [] });
      }
      if (url.includes("/bookings/v2/services/query")) {
        return json({
          services: [
            service("aqua", "Aquabike"),
            service("reformer-old", "Pilates Reformer Sculpt"),
          ],
        });
      }
      throw new Error(`Unexpected URL ${url}`);
    }) as typeof fetch;

    await expect(hasPastReformerBooking("contact-aqua")).resolves.toBe(false);
    await expect(hasPastReformerBooking("contact-current")).resolves.toBe(true);
    await expect(hasPastReformerBooking("contact-legacy")).resolves.toBe(true);
  });

  it("surfaces Wix history failures so Awa hands eligibility to reception", async () => {
    globalThis.fetch = (async () =>
      new Response("down", { status: 503 })) as typeof fetch;

    await expect(hasPastReformerBooking("contact-error")).rejects.toThrow(/503/);
  });
});

function booking(serviceId: string, title: string): any {
  return {
    booking: {
      id: `booking-${serviceId}`,
      status: "CONFIRMED",
      bookedEntity: { title, slot: { serviceId } },
    },
  };
}

function service(id: string, name: string): any {
  return { id, name, type: "CLASS", payment: {}, bookingPolicy: {} };
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
