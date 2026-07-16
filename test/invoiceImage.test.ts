import { describe, expect, it } from "vitest";
import { renderInvoiceImage, type InvoiceImageData } from "../src/lib/invoiceImage.js";
import type { InvoiceLine } from "../src/domain/invoiceRules.js";

const line = (label: string, qty = 1, unit = 12000): InvoiceLine => ({
  label,
  qty,
  unit_xof: unit,
  total_xof: qty * unit,
});

const base: InvoiceImageData = {
  number: "FAC-2026-0001",
  clientName: "Aïssatou Ndiaye",
  clientRef: "Société Teranga Conseil SARL",
  lines: [line("Pilates Reformer (Sculpt)", 4), line("Iced Matcha Vanille", 2, 3500)],
  totalXof: 55000,
  paidVia: "Wave",
  paymentRef: "WV-8f3a21",
  paidAt: new Date("2026-07-12T12:00:00Z"),
  createdAt: new Date("2026-07-16T09:00:00Z"),
};

/** PNG width/height live at bytes 16-19 / 20-23 of the IHDR chunk. */
const pngWidth = (b: Buffer) => b.readUInt32BE(16);
const pngHeight = (b: Buffer) => b.readUInt32BE(20);

describe("renderInvoiceImage", () => {
  it("renders a 720-wide PNG with the right signature", () => {
    const buf = renderInvoiceImage(base);
    expect(buf.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    expect(pngWidth(buf)).toBe(720);
    expect(buf.length).toBeGreaterThan(1000);
  });

  it("grows taller with more lines", () => {
    const short = pngHeight(renderInvoiceImage({ ...base, lines: [line("A")] }));
    const tall = pngHeight(
      renderInvoiceImage({ ...base, lines: Array.from({ length: 12 }, (_, i) => line(`L${i}`)) }),
    );
    expect(tall).toBeGreaterThan(short);
  });

  it("renders without clientRef, note, or payment info", () => {
    const buf = renderInvoiceImage({
      number: "FAC-2026-0002",
      clientName: "Client Comptoir",
      lines: [line("Séance découverte", 1, 8000)],
      totalXof: 8000,
      createdAt: new Date(),
    });
    expect(buf.length).toBeGreaterThan(1000);
  });

  it("throws on 0 lines and on more than 20 lines", () => {
    expect(() => renderInvoiceImage({ ...base, lines: [] })).toThrow();
    expect(() =>
      renderInvoiceImage({ ...base, lines: Array.from({ length: 21 }, (_, i) => line(`L${i}`)) }),
    ).toThrow();
  });
});
