import { describe, expect, it } from "vitest";
import { renderGiftCardImage } from "../src/lib/giftCardImage.js";

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47]); // \x89PNG

describe("renderGiftCardImage", () => {
  it("renders a two-line offer card as a PNG buffer", async () => {
    const buf = await renderGiftCardImage({
      offerLine1: "PACK DECOUVERTE",
      offerLine2: "3 SEANCES REFORMER",
      recipientName: "Cedrica",
      fromName: "Vanessa",
    });
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(buf.length).toBeGreaterThan(1000);
    expect(buf.subarray(0, 4).equals(PNG_MAGIC)).toBe(true);
  });

  it("handles a single-line offer and a long name without throwing (auto-shrink)", async () => {
    const buf = await renderGiftCardImage({
      offerLine1: "CARNET DE 10 SEANCES",
      offerLine2: null,
      recipientName: "Marie-Christine Diallo",
      fromName: "Le studio Revive",
    });
    expect(buf.subarray(0, 4).equals(PNG_MAGIC)).toBe(true);
  });
});
