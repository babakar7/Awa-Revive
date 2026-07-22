import { describe, expect, it } from "vitest";
import type { ExtraLine } from "../src/lib/cafeMenu.js";
import {
  aggregateKitchenOutcome,
  canTransition,
  createdClientMessage,
  deliveryUpdateTemplateParams,
  hashReadyToken,
  kitchenMessage,
  kitchenTemplateParams,
  magicLinkUrl,
  newReadyToken,
  normalizeDeliveryPhone,
  parseDeliveryQtyFields,
  routeClientMessage,
  shouldFallbackDeliveryTemplate,
  verifyReadyToken,
  type DeliveryOrderView,
  type DeliveryStatus,
} from "../src/domain/deliveryRules.js";

const ITEMS: ExtraLine[] = [
  { id: "SMOOTHIE_JANT_BI", name: "Jant Bi", qty: 2, unitPriceXof: 3000, lineTotalXof: 6000 },
  { id: "MATCHA_VANILLE", name: "Iced Matcha Vanille", qty: 1, unitPriceXof: 3500, lineTotalXof: 3500 },
];

const ORDER: DeliveryOrderView = {
  client_name: "Rama Thiam Ndiaye",
  client_phone: "221771234567",
  address: "Almadies, villa 12",
  note: "Interphone en panne",
  items: ITEMS,
  amount_xof: 9500,
};

describe("canTransition", () => {
  const all: DeliveryStatus[] = [
    "IN_KITCHEN",
    "OUT_FOR_DELIVERY",
    "DELIVERED",
    "CANCELLED",
  ];
  it("allows exactly the forward + cancel edges", () => {
    expect(canTransition("IN_KITCHEN", "OUT_FOR_DELIVERY")).toBe(true);
    expect(canTransition("IN_KITCHEN", "DELIVERED")).toBe(true); // reception may close a never-departed order
    expect(canTransition("IN_KITCHEN", "CANCELLED")).toBe(true);
    expect(canTransition("OUT_FOR_DELIVERY", "DELIVERED")).toBe(true);
    expect(canTransition("OUT_FOR_DELIVERY", "CANCELLED")).toBe(true);
  });
  it("forbids going backwards and leaving terminal states", () => {
    expect(canTransition("OUT_FOR_DELIVERY", "IN_KITCHEN")).toBe(false); // no backwards
    for (const to of all) {
      expect(canTransition("DELIVERED", to)).toBe(false);
      expect(canTransition("CANCELLED", to)).toBe(false);
    }
  });
});

describe("normalizeDeliveryPhone", () => {
  it("prefixes 221 to a 9-digit local mobile", () => {
    expect(normalizeDeliveryPhone("77 123 45 67")).toBe("221771234567");
  });
  it("accepts already-international forms (+221, 00221, spaces)", () => {
    expect(normalizeDeliveryPhone("+221 77 123 45 67")).toBe("221771234567");
    expect(normalizeDeliveryPhone("00221771234567")).toBe("221771234567");
    expect(normalizeDeliveryPhone("221771234567")).toBe("221771234567");
  });
  it("keeps a foreign mobile verbatim (digits only)", () => {
    expect(normalizeDeliveryPhone("+33 7 67 18 22 28")).toBe("33767182228");
  });
  it("rejects landline / too short / garbage", () => {
    expect(normalizeDeliveryPhone("33 82 00")).toBeNull(); // 6 digits
    expect(normalizeDeliveryPhone("338200000")).toBeNull(); // 9 digits not starting with 7
    expect(normalizeDeliveryPhone("")).toBeNull();
    expect(normalizeDeliveryPhone("abc")).toBeNull();
  });
});

describe("parseDeliveryQtyFields", () => {
  it("collects only positive quantities", () => {
    const r = parseDeliveryQtyFields({
      qty_SMOOTHIE_JANT_BI: "2",
      qty_MATCHA_VANILLE: "0",
      qty_CHAUD_THE: "",
      client_name: "ignored",
    });
    expect(r).toEqual({ entries: [{ item_id: "SMOOTHIE_JANT_BI", qty: 2 }] });
  });
  it("rejects an empty basket", () => {
    expect(parseDeliveryQtyFields({ qty_X: "0", qty_Y: "" })).toEqual({
      error: expect.stringContaining("au moins un"),
    });
  });
  it("pairs each ordered item with its choice_<ID> field", () => {
    const r = parseDeliveryQtyFields({
      qty_BRUNCH_MYKONOS: "1",
      choice_BRUNCH_MYKONOS: "Jus d'orange",
      qty_SMOOTHIE_JANT_BI: "2",
      choice_SMOOTHIE_JANT_BI: "", // no choice for this one → omitted
    });
    expect(r).toEqual({
      entries: [
        { item_id: "BRUNCH_MYKONOS", qty: 1, choice: "Jus d'orange" },
        { item_id: "SMOOTHIE_JANT_BI", qty: 2 },
      ],
    });
  });
});

describe("magic-link token", () => {
  it("newReadyToken is 32 hex chars (128 bits)", () => {
    for (let i = 0; i < 20; i++) expect(newReadyToken()).toMatch(/^[0-9a-f]{32}$/);
  });
  it("verifyReadyToken accepts the right token, rejects everything else", () => {
    const token = newReadyToken();
    const hash = hashReadyToken(token);
    expect(verifyReadyToken(token, hash)).toBe(true);
    expect(verifyReadyToken(newReadyToken(), hash)).toBe(false); // wrong token
    expect(verifyReadyToken("short", hash)).toBe(false); // length mismatch
    expect(verifyReadyToken(token, "not-hex-!!")).toBe(false); // garbage stored hash
  });
  it("magicLinkUrl joins base + token with no double slash", () => {
    expect(magicLinkUrl("https://x.app/", "tok")).toBe("https://x.app/livraison/tok");
    expect(magicLinkUrl("https://x.app", "tok")).toBe("https://x.app/livraison/tok");
  });
});

describe("message bodies", () => {
  it("kitchenMessage carries items, address, amount, and the magic link", () => {
    const link = "https://x.app/livraison/id1/tok1";
    const { subject, body } = kitchenMessage(ORDER, link);
    expect(subject).toContain("livraison");
    expect(body).toContain("Almadies, villa 12");
    expect(body).toContain("2× Jant Bi");
    expect(body).toContain("9500 FCFA");
    expect(body).toContain("Interphone en panne");
    expect(body).toContain(link);
  });
  it("createdClientMessage localizes fr/en, names the client, includes the address", () => {
    expect(createdClientMessage("fr", ORDER)).toContain("Merci Rama");
    expect(createdClientMessage("fr", ORDER)).toContain("bien reçue");
    expect(createdClientMessage("fr", ORDER)).toContain("Almadies, villa 12");
    expect(createdClientMessage("fr", ORDER)).toContain("à régler à la livraison");
    expect(createdClientMessage("en", ORDER)).toContain("Thanks Rama");
    expect(createdClientMessage("en", ORDER)).toContain("Almadies, villa 12");
  });
  it("routeClientMessage localizes fr/en and says the order is on its way", () => {
    expect(routeClientMessage("fr", ORDER)).toContain("C'est parti Rama");
    expect(routeClientMessage("fr", ORDER)).toContain("en route");
    expect(routeClientMessage("fr", ORDER)).toContain("à régler à la livraison");
    expect(routeClientMessage("en", ORDER)).toContain("On its way Rama");
    expect(routeClientMessage("en", ORDER)).toContain("out for delivery");
  });
  it("deliveryUpdateTemplateParams: 2 sanitized params, created ≠ route text", () => {
    const created = deliveryUpdateTemplateParams("created", ORDER);
    const route = deliveryUpdateTemplateParams("route", ORDER);
    expect(created).toHaveLength(2);
    expect(created[0]).toBe("Rama");
    expect(created[1]).not.toMatch(/\n/);
    expect(created[1]).toContain("bien reçue");
    expect(route[1]).toContain("en route");
    expect(created[1]).not.toBe(route[1]);
  });

  it("kitchenTemplateParams keep the exact 5-variable order of the Meta template", () => {
    // Order MUST match ticket_cuisine: {{1}} name {{2}} phone {{3}} address {{4}} items {{5}} total.
    const params = kitchenTemplateParams(ORDER);
    expect(params).toEqual([
      "Rama Thiam Ndiaye",
      "+221771234567",
      "Almadies, villa 12",
      "2× Jant Bi + 1× Iced Matcha Vanille",
      "9500",
    ]);
    for (const p of params) expect(p).not.toMatch(/\n/);
  });
});

describe("shouldFallbackDeliveryTemplate", () => {
  it("only on 131047 with a template configured", () => {
    expect(shouldFallbackDeliveryTemplate(new Error("(131047) window closed"), "tpl")).toBe(true);
    expect(shouldFallbackDeliveryTemplate(new Error("(131047)"), "")).toBe(false); // no template
    expect(shouldFallbackDeliveryTemplate(new Error("500 boom"), "tpl")).toBe(false); // other error
  });
});

describe("aggregateKitchenOutcome", () => {
  it("folds recipient outcomes", () => {
    expect(aggregateKitchenOutcome([])).toBe("failed");
    expect(aggregateKitchenOutcome(["sent", "sent"])).toBe("sent");
    expect(aggregateKitchenOutcome(["sent_template"])).toBe("sent_template");
    expect(aggregateKitchenOutcome(["sent", "sent_template"])).toBe("sent_template");
    expect(aggregateKitchenOutcome(["sent", "failed"])).toBe("partial");
    expect(aggregateKitchenOutcome(["failed", "failed"])).toBe("failed");
  });
});
