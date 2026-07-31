import { describe, expect, it } from "vitest";
import { resolveServiceAlias } from "../src/domain/serviceAlias.js";

const services = [
  { id: "foundation-id", name: "Pilates Reformer (Foundation)" },
  { id: "sculpt-id", name: "Pilates Reformer (Sculpt)" },
];

describe("resolveServiceAlias", () => {
  it("recovers the common model shorthand for Foundation", () => {
    expect(resolveServiceAlias("pilates_foundation", services)).toBe("foundation-id");
  });

  it.each(["sculpt", "reformer_sculpt"])("resolves %s after dropping generic terms", (alias) => {
    expect(resolveServiceAlias(alias, services)).toBe("sculpt-id");
  });

  it.each(["reformer", "pilates_reformer", "pilates"])("rejects generic-only alias %s", (alias) => {
    expect(resolveServiceAlias(alias, services)).toBeNull();
  });

  it("fails closed when normalization creates a collision", () => {
    expect(resolveServiceAlias("sculpt", [
      ...services,
      { id: "other-sculpt", name: "Reformer Sculpt" },
    ])).toBeNull();
  });

  it("never guesses opaque IDs such as a plan UUID", () => {
    expect(resolveServiceAlias("64591a99-1c22-406a-ac9a-7701325c0009", services)).toBeNull();
  });
});
