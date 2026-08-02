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

// add_spots extension bookings (order_note "Ajout de N place(s)…") must say the
// confirmation covers the ADDED spot(s) — the generic "ta place est confirmée"
// made client AND model read it as the client's own spot (Khadidjatou 02/08).
describe("confirmationMessage for an add_spots extension booking", () => {
  it("fr singular: announces the extra spot and that the original booking is unchanged", () => {
    const msg = confirmationMessage("fr", "Pilates Reformer", SLOT, undefined, "Ajout de 1 place(s) à la résa 2644fc59");
    expect(msg).toContain("la place supplémentaire est confirmée");
    expect(msg).toContain("ta propre réservation sur ce créneau reste inchangée");
    expect(msg).not.toContain("ta place est confirmée");
  });

  it("fr plural: names the count", () => {
    const msg = confirmationMessage("fr", "Pilates Reformer", SLOT, undefined, "Ajout de 3 place(s) à la résa 2644fc59");
    expect(msg).toContain("les 3 places supplémentaires sont confirmées");
  });

  it("en: extra-spot copy", () => {
    const msg = confirmationMessage("en", "Pilates Reformer", SLOT, undefined, "Ajout de 1 place(s) à la résa x");
    expect(msg).toContain("the extra spot is confirmed");
    expect(msg).toContain("your own booking on this slot is unchanged");
  });

  it("a cafe order note is never mistaken for an extension", () => {
    const msg = confirmationMessage("fr", "Pilates", SLOT, EXTRAS, "Ajout de 2 place(s) de sucre svp");
    expect(msg).toContain("ta place est confirmée");
    expect(msg).not.toContain("supplémentaire");
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
