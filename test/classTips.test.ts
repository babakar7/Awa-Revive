import { describe, expect, it } from "vitest";
import { classTip } from "../src/lib/classTips.js";

describe("classTip — keyword matching", () => {
  it("Reformer / Pilates / Fusion / Yoga / Inversion → non-slip socks tip (fr)", () => {
    for (const name of [
      "Pilates Reformer Foundation",
      "REFORMER Women Only",
      "Pilates Mat",
      "Fusion Flow",
      "Yoga Vinyasa",
      "Inversion Workshop",
    ]) {
      const tip = classTip(name, "fr");
      expect(tip, name).toBeTruthy();
      expect(tip).toMatch(/chaussettes antidérapantes|tenue de sport/i);
    }
  });

  it("Aqua / Natation / Bébé Nageur → swimsuit tip", () => {
    for (const name of ["Aquabike", "Aquagym", "Natation Enfant", "Bébé Nageur"]) {
      const tip = classTip(name, "fr");
      expect(tip, name).toMatch(/maillot/i);
    }
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
  });
});
