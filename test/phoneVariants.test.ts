import { describe, expect, it } from "vitest";
import { phoneMatchVariants } from "../src/lib/wix.js";

describe("phoneMatchVariants", () => {
  it("senegalese number: includes e164, digits, 00-prefix, local raw and local spaced", () => {
    const v = phoneMatchVariants("221774446666"); // WhatsApp wa_id format (no +)
    expect(v).toContain("+221774446666");
    expect(v).toContain("221774446666");
    expect(v).toContain("00221774446666");
    expect(v).toContain("774446666");
    expect(v).toContain("77 444 66 66");
  });

  it("accepts an already-prefixed +221 number", () => {
    const v = phoneMatchVariants("+221710136246");
    expect(v).toContain("710136246");
    expect(v).toContain("71 013 62 46");
  });

  it("non-senegalese number: international forms only, no bare local variant", () => {
    const v = phoneMatchVariants("+33767182228");
    expect(v).toContain("+33767182228");
    expect(v).toContain("33767182228");
    expect(v).not.toContain("767182228");
  });

  it("senegalese non-mobile (not starting with 7) gets no local variant", () => {
    const v = phoneMatchVariants("+221338234567");
    expect(v).not.toContain("338234567");
  });
});
