import { describe, expect, it } from "vitest";
import { formatXof, renderReceiptImage } from "../src/lib/receiptImage.js";

describe("formatXof", () => {
  it("formats integer FCFA with spaces", () => {
    expect(formatXof(10000)).toMatch(/10.?000 FCFA/);
    expect(formatXof(3500)).toMatch(/3.?500 FCFA/);
  });

  it("rounds non-integers", () => {
    expect(formatXof(99.7)).toMatch(/100 FCFA/);
  });
});

describe("renderReceiptImage", () => {
  it("renders a PNG without throwing", () => {
    const buf = renderReceiptImage({
      title: "Reçu de paiement",
      clientName: "Awa Test",
      itemLabel: "Pilates Reformer",
      detailLine: "vendredi 18 juillet à 10:00",
      amountXof: 10000,
      paymentRef: "cos_test_123",
      paidVia: "Wave",
      paidAt: new Date("2026-07-12T12:00:00Z"),
    });
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(buf.length).toBeGreaterThan(1000);
    // PNG signature
    expect(buf.subarray(0, 8)).toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );
  });

  it("works without client name", () => {
    const buf = renderReceiptImage({
      title: "Reçu de paiement",
      clientName: null,
      itemLabel: "Café — Jant Bi",
      amountXof: 3000,
      paymentRef: "abc",
      paidVia: "Wave",
      paidAt: new Date(),
    });
    expect(buf.length).toBeGreaterThan(500);
  });
});
