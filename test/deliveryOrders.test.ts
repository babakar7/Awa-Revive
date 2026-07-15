import { describe, expect, it } from "vitest";
import type { ExtraLine } from "../src/lib/cafeMenu.js";
import {
  aggregateKitchenOutcome,
  canTransition,
  deliveryTemplateParams,
  hashReadyToken,
  kitchenMessage,
  magicLinkUrl,
  newReadyToken,
  normalizeDeliveryPhone,
  parseDeliveryQtyFields,
  readyClientMessage,
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
  const all: DeliveryStatus[] = ["IN_KITCHEN", "READY", "DELIVERED", "CANCELLED"];
  it("allows exactly the forward + cancel edges", () => {
    expect(canTransition("IN_KITCHEN", "READY")).toBe(true);
    expect(canTransition("IN_KITCHEN", "CANCELLED")).toBe(true);
    expect(canTransition("READY", "DELIVERED")).toBe(true);
    expect(canTransition("READY", "CANCELLED")).toBe(true);
  });
  it("forbids skipping, going backwards, and leaving terminal states", () => {
    expect(canTransition("IN_KITCHEN", "DELIVERED")).toBe(false); // no skip
    expect(canTransition("READY", "IN_KITCHEN")).toBe(false); // no backwards
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
  it("magicLinkUrl joins base + id + token with no double slash", () => {
    expect(magicLinkUrl("https://x.app/", "abc", "tok")).toBe("https://x.app/livraison/abc/tok");
    expect(magicLinkUrl("https://x.app", "abc", "tok")).toBe("https://x.app/livraison/abc/tok");
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
  it("readyClientMessage localizes fr/en and names the client", () => {
    expect(readyClientMessage("fr", ORDER)).toContain("Bonne nouvelle Rama");
    expect(readyClientMessage("fr", ORDER)).toContain("à régler à la livraison");
    expect(readyClientMessage("en", ORDER)).toContain("Good news Rama");
  });
  it("deliveryTemplateParams are sanitized (no newlines) and 2 params", () => {
    const params = deliveryTemplateParams(ORDER);
    expect(params).toHaveLength(2);
    expect(params[0]).toBe("Rama");
    expect(params[1]).not.toMatch(/\n/);
    expect(params[1]).toContain("9500 FCFA");
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
