import { afterEach, describe, expect, it } from "vitest";
import {
  searchWixDeliveryClients,
  wixDeliveryClientFromContact,
} from "../src/lib/wix.js";

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("Wix clients for deliveries", () => {
  it("extracts the main name, phone, email and delivery address", () => {
    expect(
      wixDeliveryClientFromContact({
        id: "contact-1",
        info: {
          name: { first: "Awa", last: "Ndiaye" },
          phones: {
            items: [
              { tag: "HOME", phone: "33 000 00 00" },
              { tag: "MAIN", phone: "77 123 45 67", e164Phone: "+221771234567" },
            ],
          },
          emails: { items: [{ tag: "MAIN", email: "awa@example.com" }] },
          addresses: {
            items: [
              {
                tag: "MAIN",
                address: { addressLine: "Route des Almadies", addressLine2: "Villa 4", city: "Dakar" },
              },
            ],
          },
        },
      }),
    ).toEqual({
      id: "contact-1",
      name: "Awa Ndiaye",
      phone: "+221771234567",
      email: "awa@example.com",
      address: "Route des Almadies, Villa 4, Dakar",
    });
  });

  it("queries Wix server-side and returns ranked, deduplicated snapshots", async () => {
    let requestBody: any;
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      requestBody = JSON.parse(String(init?.body));
      return new Response(
        JSON.stringify({
          contacts: [
            { id: "2", info: { name: { first: "Fatou", last: "Awa" } } },
            { id: "1", info: { name: { first: "Awa", last: "Diop" } } },
            { id: "1", info: { name: { first: "Awa", last: "Doublon" } } },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;

    const clients = await searchWixDeliveryClients("Awa", 10);

    expect(requestBody.query.filter.$or).toContainEqual({
      "info.name.first": { $startsWith: "Awa" },
    });
    expect(clients.map((client) => client.id)).toEqual(["1", "2"]);
  });

  it("does not call Wix for a one-character search", async () => {
    let called = false;
    globalThis.fetch = (async () => {
      called = true;
      return new Response("{}");
    }) as typeof fetch;

    expect(await searchWixDeliveryClients("A")).toEqual([]);
    expect(called).toBe(false);
  });
});
