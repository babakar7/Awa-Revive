import { describe, expect, it } from "vitest";
import { planNamesConflict } from "../src/domain/planNameGuard.js";

describe("planNamesConflict (anti-conflation guard)", () => {
  it("flags the real incident: Aquafitness id confirmed as Pack Découverte", () => {
    expect(planNamesConflict("Aquafitness (2x/semaine)", "Pack Découverte")).toBe(true);
  });

  it("accepts an exact match regardless of case/accents/punctuation", () => {
    expect(planNamesConflict("Pack Découverte", "pack decouverte")).toBe(false);
    expect(planNamesConflict("Pilates Reformer (3x/semaine)", "Pilates Reformer (3x/semaine)")).toBe(false);
  });

  it("accepts a shorter confirmation contained in the catalog name (verbosity varies)", () => {
    expect(planNamesConflict("Pack Découverte Pilates Reformer", "Pack Découverte")).toBe(false);
    expect(planNamesConflict("Carnet 10 séances", "Carnet 10 séances - Pilates")).toBe(false);
  });

  it("treats an empty confirmation as no-signal, not a conflict", () => {
    expect(planNamesConflict("Pack Découverte", "")).toBe(false);
    expect(planNamesConflict("", "Pack Découverte")).toBe(false);
  });

  it("flags two genuinely different plans", () => {
    expect(planNamesConflict("Pilates Mat (2x/semaine)", "Pilates Reformer (3x/semaine)")).toBe(true);
  });
});
