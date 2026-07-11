import { describe, expect, it } from "vitest";
import { cafeConfirmationMessage } from "../src/webhooks/wave.js";
import type { ExtraLine } from "../src/lib/cafeMenu.js";

const EXTRAS: ExtraLine[] = [
  { id: "SMOOTHIE_JANT_BI", name: "Jant Bi", qty: 2, unitPriceXof: 3000, lineTotalXof: 6000 },
  { id: "MATCHA_VANILLE", name: "Iced Matcha Vanille", qty: 1, unitPriceXof: 3500, lineTotalXof: 3500 },
];

describe("cafeConfirmationMessage (café-only order, membership booking)", () => {
  it.each([
    ["fr", "ta commande café est confirmée", "prête après ton cours (Pilates Fusion)"],
    ["en", "your café order is confirmed", "ready after your class (Pilates Fusion)"],
    ["wo", "sa commande café dëgg na", "dina pare ginnaaw sa cours (Pilates Fusion)"],
  ])("%s: confirms, lists items and states default timing with the class name", (lang, marker, note) => {
    const msg = cafeConfirmationMessage(lang, EXTRAS, null, "Pilates Fusion");
    expect(msg).toContain(marker);
    expect(msg).toContain("• 2× Jant Bi — 6000 FCFA");
    expect(msg).toContain("• 1× Iced Matcha Vanille — 3500 FCFA");
    expect(msg).toContain(note);
  });

  it("uses the client's custom note when provided (fr)", () => {
    const msg = cafeConfirmationMessage("fr", EXTRAS, "avant le cours, lait d'avoine", "Pilates Fusion");
    expect(msg).toContain("avant le cours, lait d'avoine");
    expect(msg).not.toContain("prête après ton cours");
  });

  it("falls back to French for an unknown language", () => {
    expect(cafeConfirmationMessage("de", EXTRAS, null, null)).toContain("Paiement reçu");
  });

  it.each([
    ["fr", "prête dès que possible — à récupérer au comptoir"],
    ["en", "ready as soon as possible — pick it up at the counter"],
    ["wo", "jëlal ko ci comptoir bi"],
  ])("%s: a standalone order (no class) defaults to counter pickup", (lang, note) => {
    const msg = cafeConfirmationMessage(lang, EXTRAS, null, null);
    expect(msg).toContain(note);
    expect(msg).not.toContain("cours (");
  });

  it("still honors the client's own note on a standalone order", () => {
    const msg = cafeConfirmationMessage("fr", EXTRAS, "pour 17h", null);
    expect(msg).toContain("pour 17h");
    expect(msg).not.toContain("comptoir");
  });
});
