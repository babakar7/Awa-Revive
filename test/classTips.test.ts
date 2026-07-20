import { describe, expect, it } from "vitest";
import { classTip } from "../src/lib/classTips.js";

describe("classTip — keyword matching", () => {
  it("Reformer only → non-slip socks required", () => {
    for (const name of ["Pilates Reformer Foundation", "REFORMER Women Only", "Reformer Sculpt"]) {
      const tip = classTip(name, "fr");
      expect(tip, name).toMatch(/chaussettes antidérapantes/i);
      expect(tip, name).toMatch(/Reformer/i);
    }
  });

  it("Pilates / Fusion / Yoga / Inversion without Reformer → tenue only, no socks", () => {
    for (const name of ["Pilates Mat", "Fusion Flow", "Yoga Vinyasa", "Inversion Workshop"]) {
      const tip = classTip(name, "fr");
      expect(tip, name).toBeTruthy();
      expect(tip, name).toMatch(/tenue de sport/i);
      expect(tip, name).not.toMatch(/chaussettes antidérapantes/i);
    }
  });

  it("Aqua / Natation / Bébé Nageur → swimsuit tip", () => {
    for (const name of ["Aquabike", "Aquagym", "Natation Enfant", "Bébé Nageur"]) {
      const tip = classTip(name, "fr");
      expect(tip, name).toMatch(/maillot/i);
    }
  });

  it("Bébé Nageur → swim diaper tip (not just the generic swimsuit one)", () => {
    for (const lang of ["fr", "en", "wo"] as const) {
      expect(classTip("Bébé Nageur", lang)).toMatch(/couche|diaper/i);
    }
    // Adult aquatic classes keep the plain swimsuit tip.
    expect(classTip("Aquabike", "fr")).not.toMatch(/couche/i);
    // A dry-land baby class would get no pool advice.
    expect(classTip("Éveil Bébé", "fr")).toBeNull();
  });

  it("Cardio Boxe → trainers + water", () => {
    expect(classTip("Cardio Boxe", "fr")).toMatch(/baskets|eau/i);
    expect(classTip("Boxe", "en")).toMatch(/trainers|water/i);
  });

  it("case and accents do not matter", () => {
    expect(classTip("AQUABIKE", "fr")).toMatch(/maillot/i);
    expect(classTip("bébé nageur", "fr")).toMatch(/maillot/i);
  });

  it("unknown class → null (never invent)", () => {
    expect(classTip("Impédancemétrie", "fr")).toBeNull();
    expect(classTip("Something Random", "en")).toBeNull();
    expect(classTip("", "fr")).toBeNull();
  });

  it("en / wo variants exist for reformer", () => {
    expect(classTip("Reformer", "en")).toMatch(/non-slip|socks/i);
    expect(classTip("Reformer", "wo")).toBeTruthy();
  });

  it("aqua wins over pilates if both keywords present", () => {
    expect(classTip("Aqua Pilates", "fr")).toMatch(/maillot/i);
    expect(classTip("Aqua Pilates", "fr")).not.toMatch(/chaussettes/i);
  });
});
