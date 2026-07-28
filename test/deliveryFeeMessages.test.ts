import { describe, expect, it } from "vitest";
import {
  createdClientMessage,
  deliveryPaymentStaffText,
  deliveryFeeCashPhrase,
  isWebDelivery,
  recipientRouteMessage,
  type DeliveryOrderView,
} from "../src/domain/deliveryRules.js";

const baseWeb: DeliveryOrderView = {
  client_name: "Awa",
  client_phone: "221770000001",
  recipient_name: null,
  recipient_phone: null,
  address: "Almadies",
  note: null,
  items: [{ id: "JANTBI", name: "Jant Bi", qty: 1, unitPriceXof: 3000, lineTotalXof: 3000 }],
  amount_xof: 3000,
  payment_status: "PAID",
  payment_method: "wave",
  source_cafe_order_id: "cafe-1",
  delivery_fee_xof: 1000,
  delivery_fee_status: "CASH_DUE",
};

describe("hybrid web-delivery payment messaging", () => {
  it("recognises a web delivery and phrases the cash fee", () => {
    expect(isWebDelivery(baseWeb)).toBe(true);
    expect(deliveryFeeCashPhrase(baseWeb)).toContain("1000 FCFA");
    // No fixed amount configured → generic phrase, still cash to driver.
    expect(deliveryFeeCashPhrase({ ...baseWeb, delivery_fee_xof: null })).toContain("espèces");
  });

  it("staff text NEVER says 'ne rien encaisser' for a web delivery with a fee", () => {
    const t = deliveryPaymentStaffText(baseWeb);
    expect(t).toContain("ENCAISSER");
    expect(t).not.toContain("ne rien encaisser");
    // A normal fully-paid delivery (no web fee) keeps the old wording.
    const normal = deliveryPaymentStaffText({ ...baseWeb, source_cafe_order_id: null, delivery_fee_status: null });
    expect(normal).toContain("ne rien encaisser");
  });

  it("client created message confirms payment + fee and never re-asks for a method", () => {
    const msg = createdClientMessage("fr", baseWeb);
    expect(msg).toContain("payée");
    expect(msg).toContain("1000");
    expect(msg).not.toContain("Réponds WAVE");
    // A normal staff-entered delivery still asks the client to pick a method.
    const normal = createdClientMessage("fr", { ...baseWeb, source_cafe_order_id: null, delivery_fee_status: null });
    expect(normal).toContain("Réponds WAVE");
  });

  it("recipient departure note tells the handoff contact about the cash fee", () => {
    const withRecipient = { ...baseWeb, recipient_name: "Bou", recipient_phone: "221780000002" };
    const msg = recipientRouteMessage(withRecipient);
    expect(msg).toContain("1000 FCFA");
    expect(msg).not.toContain("rien à régler");
  });
});
