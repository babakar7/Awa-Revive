import { describe, expect, it } from "vitest";
import { confirmationMessage } from "../src/webhooks/wave.js";
import type { ExtraLine } from "../src/lib/cafeMenu.js";

const SLOT = new Date("2026-07-18T10:00:00Z");
const EXTRAS: ExtraLine[] = [
  { id: "SMOOTHIE_JANT_BI", name: "Jant Bi", qty: 2, unitPriceXof: 3000, lineTotalXof: 6000 },
  { id: "MATCHA_VANILLE", name: "Iced Matcha Vanille", qty: 1, unitPriceXof: 3500, lineTotalXof: 3500 },
];

describe("confirmationMessage with a bar order", () => {
  it.each([
    ["fr", "☕ Ta commande bar (déjà payée) :", "prête après ton cours"],
    ["en", "☕ Your bar order (already paid):", "ready after your class"],
    ["wo", "☕ Sa commande bar (fey nga ko ba noppi):", "dina pare ginnaaw sa cours"],
  ])("%s: lists items, default timing and keeps the 16h policy line", (lang, header, defaultNote) => {
    const msg = confirmationMessage(lang, "Pilates Reformer", SLOT, EXTRAS, null);
    expect(msg).toContain(header);
    expect(msg).toContain("• 2× Jant Bi — 6000 FCFA");
    expect(msg).toContain("• 1× Iced Matcha Vanille — 3500 FCFA");
    expect(msg).toContain(`→ ${defaultNote}`);
    expect(msg).toContain("16");
  });

  it("uses the client's order note instead of the default timing", () => {
    const msg = confirmationMessage("fr", "Pilates", SLOT, EXTRAS, "avant le cours, lait d'avoine");
    expect(msg).toContain("→ avant le cours, lait d'avoine");
    expect(msg).not.toContain("prête après ton cours");
  });
});

describe("confirmationMessage without a bar order (regression)", () => {
  it.each([["fr"], ["en"], ["wo"]])("%s: no bar block, same structure as before", (lang) => {
    const withUndefined = confirmationMessage(lang, "Pilates", SLOT);
    const withEmpty = confirmationMessage(lang, "Pilates", SLOT, [], null);
    expect(withUndefined).toBe(withEmpty);
    expect(withUndefined).not.toContain("☕");
    expect(withUndefined).toContain("✅");
    expect(withUndefined).toContain("📍");
    expect(withUndefined).toContain("16");
  });
});

describe("confirmationMessage pre-class tips (#6)", () => {
  it("Reformer gets socks tip; mat Pilates does not; aqua gets swimsuit", () => {
    const reformer = confirmationMessage("fr", "Pilates Reformer", SLOT);
    expect(reformer).toMatch(/chaussettes antidérapantes/i);
    const mat = confirmationMessage("fr", "Pilates Mat", SLOT);
    expect(mat).toMatch(/tenue de sport/i);
    expect(mat).not.toMatch(/chaussettes antidérapantes/);
    const aqua = confirmationMessage("fr", "Aquabike", SLOT);
    expect(aqua).toMatch(/maillot/i);
    expect(aqua).not.toMatch(/chaussettes antidérapantes/);
    const unknown = confirmationMessage("fr", "Impédancemétrie", SLOT);
    expect(unknown).not.toContain("💡");
  });
});
