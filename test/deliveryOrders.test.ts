import { describe, expect, it } from "vitest";
import type { ExtraLine } from "../src/lib/cafeMenu.js";
import {
  aggregateKitchenOutcome,
  canTransition,
  createdClientMessage,
  deliveryUpdateTemplateParams,
  formatDakarDateTime,
  hashReadyToken,
  kitchenMessage,
  kitchenTemplateParams,
  magicLinkUrl,
  newReadyToken,
  normalizeDeliveryPhone,
  parseDakarDateTime,
  parseDeliveryQtyFields,
  recipientRouteMessage,
  recipientRouteTemplateParams,
  rescheduledClientMessage,
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

describe("Dakar delivery schedule", () => {
  it("parses datetime-local as Dakar wall time and rejects invalid dates", () => {
    expect(parseDakarDateTime("2026-08-04T14:30")?.toISOString()).toBe(
      "2026-08-04T14:30:00.000Z",
    );
    expect(parseDakarDateTime("2026-02-30T14:30")).toBeNull();
    expect(parseDakarDateTime("2026-08-04 14:30")).toBeNull();
  });

  it("formats the promised arrival explicitly in Dakar", () => {
    expect(formatDakarDateTime("2026-08-04T14:30:00.000Z", "fr")).toContain("14:30");
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
    const fr = createdClientMessage("fr", ORDER);
    const en = createdClientMessage("en", ORDER);
    expect(fr).toContain("Merci Rama");
    expect(fr).toContain("bien reçue");
    expect(fr).toContain("Almadies, villa 12");
    expect(fr).toContain("9500 FCFA");
    expect(fr).toContain("WAVE, OM, MAXIT ou ESPÈCES");
    expect(fr).not.toContain("à régler à la livraison");
    expect(en).toContain("Thanks Rama");
    expect(en).toContain("Almadies, villa 12");
    expect(en).toContain("WAVE, OM, MAXIT or CASH");
    expect(en).not.toContain("to pay on delivery");
  });
  it("labels every test-order message and template update explicitly", () => {
    const testOrder = { ...ORDER, is_test: true };
    expect(kitchenMessage(testOrder, "https://x.test/livraison/token").subject).toContain("TEST");
    expect(kitchenMessage(testOrder, "https://x.test/livraison/token").body).toContain("COMMANDE DE TEST");
    expect(createdClientMessage("fr", testOrder)).toContain("TEST");
    expect(routeClientMessage("fr", testOrder)).toContain("TEST");
    expect(deliveryUpdateTemplateParams("created", testOrder)[1]).toContain("TEST");
  });
  it("routeClientMessage localizes fr/en and says the order is on its way", () => {
    const fr = routeClientMessage("fr", ORDER);
    const en = routeClientMessage("en", ORDER);
    expect(fr).toContain("C'est parti Rama");
    expect(fr).toContain("en route");
    expect(fr).not.toContain("9500");
    expect(fr).not.toContain("régler");
    expect(en).toContain("On its way Rama");
    expect(en).toContain("out for delivery");
    expect(en).not.toContain("9500");
    expect(en).not.toContain("payment");
  });
  it("deliveryUpdateTemplateParams: 2 sanitized params, created ≠ route text", () => {
    const created = deliveryUpdateTemplateParams("created", ORDER);
    const route = deliveryUpdateTemplateParams("route", ORDER);
    expect(created).toHaveLength(2);
    expect(created[0]).toBe("Rama");
    expect(created[1]).not.toMatch(/\n/);
    expect(created[1]).toContain("bien reçue");
    expect(route[1]).toContain("en route");
    expect(created[1]).toContain("WAVE, OM, MAXIT ou ESPÈCES");
    expect(route[1]).not.toContain("FCFA");
    expect(created[1]).not.toBe(route[1]);
  });

  it("adds the promised arrival to scheduled confirmations and omits payment on reschedule", () => {
    const scheduled = { ...ORDER, scheduled_for: new Date("2026-08-04T14:30:00.000Z") };
    const created = createdClientMessage("fr", scheduled);
    const moved = rescheduledClientMessage("fr", scheduled);
    expect(created).toContain("arrivée prévue");
    expect(created).toContain("14:30");
    expect(created).toContain("WAVE");
    expect(moved).toContain("maintenant prévue");
    expect(moved).toContain("14:30");
    expect(moved).not.toMatch(/paiement|WAVE|OM|MAXIT|ESPÈCES/i);
    expect(deliveryUpdateTemplateParams("rescheduled", scheduled)[1]).toContain(
      "reprogrammée",
    );
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

  it("puts an alternate handoff contact on kitchen/client updates without replacing the client", () => {
    const withRecipient: DeliveryOrderView = {
      ...ORDER,
      recipient_name: "Fatou Assistante",
      recipient_phone: "221780001122",
      payment_status: "PAID",
    };
    const kitchen = kitchenMessage(withRecipient, "https://x.test/livraison/token").body;
    expect(kitchen).toContain("Client : Rama Thiam Ndiaye (+221771234567)");
    expect(kitchen).toContain("Contact remise : Fatou Assistante (+221780001122)");
    expect(createdClientMessage("fr", withRecipient)).toContain(
      "remise est prévue avec Fatou Assistante",
    );
    expect(routeClientMessage("fr", withRecipient)).toContain(
      "livreur appellera Fatou Assistante",
    );
    expect(kitchenTemplateParams(withRecipient)).toEqual([
      "Rama Thiam Ndiaye — remise à Fatou Assistante",
      "+221780001122",
      "Almadies, villa 12",
      "2× Jant Bi + 1× Iced Matcha Vanille",
      "9500",
    ]);
  });

  it("builds the recipient-only route alert with the correct payment instruction", () => {
    const recipient = {
      ...ORDER,
      recipient_name: "Fatou Assistante",
      recipient_phone: "221780001122",
    };
    expect(recipientRouteMessage({ ...recipient, payment_status: "PAID" })).toContain(
      "rien à régler",
    );
    expect(
      recipientRouteMessage({ ...recipient, payment_status: "CASH_DUE" }),
    ).toContain("9500 FCFA en espèces");
    const params = recipientRouteTemplateParams({
      ...recipient,
      payment_status: "CASH_DUE",
    });
    expect(params[0]).toBe("Fatou");
    expect(params[1]).toContain("commande de Rama Thiam Ndiaye");
    expect(params[1]).toContain("9500 FCFA en espèces");
    expect(params[1]).not.toMatch(/\n/);
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
