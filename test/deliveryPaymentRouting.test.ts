import { describe, expect, it } from "vitest";
import { deliveryPaymentMethodFromReply } from "../src/agent/index.js";

describe("deliveryPaymentMethodFromReply", () => {
  it.each([
    ["Wave", "wave"],
    ["Par Wave", "wave"],
    ["OM", "orange_money"],
    ["Orange Money svp", "orange_money"],
    ["MAXIT", "maxit"],
    ["Max It", "maxit"],
    ["Espèces", "cash"],
    ["En espèces", "cash"],
    ["cash", "cash"],
  ] as const)("maps the delivery-template reply %j to %s", (text, expected) => {
    expect(deliveryPaymentMethodFromReply(text)).toBe(expected);
  });

  it.each([
    "Je veux payer mon cours par Wave",
    "Je veux un lien pour payer ma commande de 68 000 FCFA",
    "Wave pour le Pilates de mercredi",
    "Est-ce que Wave fonctionne ?",
    "Payer Wave (id: pay_wave)",
  ])("rejects broader or interactive payment intents: %j", (text) => {
    expect(deliveryPaymentMethodFromReply(text)).toBeNull();
  });
});
