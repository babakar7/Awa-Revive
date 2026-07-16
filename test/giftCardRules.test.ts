import { describe, expect, it } from "vitest";
import { parseGiftCardForm } from "../src/domain/giftCardRules.js";

const base = {
  offer_line1: "PACK DECOUVERTE",
  offer_line2: "3 SEANCES REFORMER",
  recipient_name: "Cedrica",
  from_name: "Vanessa",
};

describe("parseGiftCardForm", () => {
  it("accepts a full card", () => {
    const r = parseGiftCardForm({ ...base });
    expect("data" in r && r.data).toMatchObject({
      offer_line1: "PACK DECOUVERTE",
      offer_line2: "3 SEANCES REFORMER",
      recipient_name: "Cedrica",
      from_name: "Vanessa",
      send_phone: null,
    });
  });

  it("makes offer line 2 optional (empty → null)", () => {
    const r = parseGiftCardForm({ ...base, offer_line2: "" });
    expect("data" in r && r.data.offer_line2).toBe(null);
  });

  it("requires offer line 1, recipient and giver", () => {
    expect("error" in parseGiftCardForm({ ...base, offer_line1: "" })).toBe(true);
    expect("error" in parseGiftCardForm({ ...base, recipient_name: "" })).toBe(true);
    expect("error" in parseGiftCardForm({ ...base, from_name: "" })).toBe(true);
  });

  it("normalizes a local phone and rejects an invalid one", () => {
    const ok = parseGiftCardForm({ ...base, send_phone: "77 123 45 67" });
    expect("data" in ok && ok.data.send_phone).toBe("221771234567");
    expect("error" in parseGiftCardForm({ ...base, send_phone: "123" })).toBe(true);
  });

  it("rejects over-long fields", () => {
    expect("error" in parseGiftCardForm({ ...base, offer_line1: "X".repeat(61) })).toBe(true);
    expect("error" in parseGiftCardForm({ ...base, recipient_name: "Y".repeat(61) })).toBe(true);
  });
});
