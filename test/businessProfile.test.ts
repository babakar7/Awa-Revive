import { describe, expect, it } from "vitest";
import { composeBusinessDescription } from "../src/lib/whatsapp.js";

describe("composeBusinessDescription", () => {
  it("returns the trimmed description unchanged when hours is empty", () => {
    expect(composeBusinessDescription("  Studio de yoga à Dakar.  ", "")).toBe(
      "Studio de yoga à Dakar.",
    );
  });

  it("appends an hours block after the description", () => {
    const out = composeBusinessDescription("Studio de yoga à Dakar.", "Lun-Ven 8h-20h");
    expect(out).toBe("Studio de yoga à Dakar.\n\n🕒 Horaires\nLun-Ven 8h-20h");
  });

  it("never exceeds Meta's 512-char limit", () => {
    const out = composeBusinessDescription("x".repeat(600), "Lun-Ven 8h-20h");
    expect(out.length).toBeLessThanOrEqual(512);
  });

  it("truncates the description to make room for the hours block, keeping hours intact", () => {
    const hours = "Lun-Ven 8h-20h, Sam 9h-13h";
    const out = composeBusinessDescription("x".repeat(600), hours);
    expect(out.endsWith(`🕒 Horaires\n${hours}`)).toBe(true);
    expect(out.length).toBeLessThanOrEqual(512);
  });

  it("drops the hours block entirely if the description alone already fills the limit", () => {
    const hours = "y".repeat(600); // block alone > 512
    const out = composeBusinessDescription("x".repeat(600), hours);
    expect(out).toBe("x".repeat(512));
    expect(out).not.toContain("Horaires");
  });
});
