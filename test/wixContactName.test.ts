import { describe, expect, it } from "vitest";
import { splitContactName, wixContactFullName } from "../src/lib/wix.js";

describe("Wix contact canonical names", () => {
  it("uses the full CRM first and last name", () => {
    expect(
      wixContactFullName({ info: { name: { first: "Habott", last: "Lina" } } }),
    ).toBe("Habott Lina");
  });

  it("splits the canonical name into Wix booking fields", () => {
    expect(splitContactName("Habott Lina")).toEqual({
      firstName: "Habott",
      lastName: "Lina",
    });
  });

  it("keeps multi-part surnames intact", () => {
    expect(splitContactName("Awa Diop Ndiaye")).toEqual({
      firstName: "Awa",
      lastName: "Diop Ndiaye",
    });
  });
});
