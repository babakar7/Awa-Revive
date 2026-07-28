import { describe, expect, it } from "vitest";
import { resolveFreeTextChoice } from "../src/agent/choiceMatcher.js";

const slots = [
  { choice_id: "slot_a", title: "Mer 29 juil · 12:30" },
  { choice_id: "slot_b", title: "Jeu 30 juil · 18:00" },
];

describe("free-text choice matcher", () => {
  it("maps a unique written time to the same id as a tap", () => {
    expect(resolveFreeTextChoice("12h30 svp", slots)?.choice_id).toBe("slot_a");
  });

  it("maps an explicit payment rail only when it was offered", () => {
    const payment = [{ choice_id: "pay_wave", title: "Payer Wave" }];
    expect(resolveFreeTextChoice("On va faire un paiement Wave", payment)).toBeNull();
    expect(resolveFreeTextChoice("Wave", payment)?.choice_id).toBe("pay_wave");
  });

  it("does not guess an ambiguous or vague answer", () => {
    const sameTime = [...slots, { choice_id: "slot_c", title: "Ven 31 juil · 12:30" }];
    expect(resolveFreeTextChoice("12h30", sameTime)).toBeNull();
    expect(resolveFreeTextChoice("mercredi", slots)).toBeNull();
  });
});
