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

  it("never guesses opaque IDs such as a plan UUID", () => {
    expect(resolveServiceAlias("64591a99-1c22-406a-ac9a-7701325c0009", services)).toBeNull();
  });
});
