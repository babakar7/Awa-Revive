import { describe, expect, it } from "vitest";
import { renderQuotePdf, type QuotePdfData } from "../src/lib/quotePdf.js";

const full: QuotePdfData = {
  quoteNumber: "DEV-2026-0716",
  issuedOn: new Date("2026-07-16T00:00:00Z"),
  validityDays: 15,
  clientName: "Dienaba",
  clientCompany: "La Maison du Cookie Dakar",
  clientRole: "Fondatrice",
  eventTitle: 'Événement privé « Pilates & Cookies »',
  description: "Séance de Pilates reformer privée suivie d'une dégustation de cookies.",
  eventDate: new Date("2026-09-27T00:00:00Z"),
  eventTime: "À partir de 11h (demi-journée)",
  participants: "7 personnes",
  location: "Revive Ventures, Almadies",
  items: [
    { label: "Privatisation demi-journée", detail: "coach dédié · studio exclusif", amount_xof: 105000 },
    { label: "Cookies & dégustation", detail: "fournis par la cliente", amount_xof: null },
  ],
  conditions: [
    "Réservation confirmée par un acompte de 50 %.",
    "Paiement par Wave ou Orange Money.",
  ],
};

describe("renderQuotePdf", () => {
  it("produces a non-trivial PDF buffer", async () => {
    const buf = await renderQuotePdf(full);
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(buf.length).toBeGreaterThan(1000);
    expect(buf.subarray(0, 5).toString("latin1")).toBe("%PDF-");
  });

  it("does not throw when optional fields are null/empty", async () => {
    const buf = await renderQuotePdf({
      ...full,
      clientCompany: null,
      clientRole: null,
      description: null,
      eventDate: null,
      eventTime: null,
      participants: null,
      conditions: [],
    });
    expect(buf.subarray(0, 5).toString("latin1")).toBe("%PDF-");
  });
});
