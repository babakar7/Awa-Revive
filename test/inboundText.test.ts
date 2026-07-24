import { describe, expect, it } from "vitest";
import { normalizeInboundText } from "../src/lib/inboundText.js";

describe("normalizeInboundText", () => {
  it("decodes valid WhatsApp prefilled text", () => {
    expect(normalizeInboundText("Bonjour%2C%20je%20veux%20r%C3%A9server")).toBe("Bonjour, je veux réserver");
  });

  it("keeps malformed percent text untouched", () => {
    expect(normalizeInboundText("100%20%ZZ")).toBe("100%20%ZZ");
  });
});
