import { describe, expect, it } from "vitest";
import { OPS_BASE, OPS_PAIR_STYLE, OPS_TOKENS, esc } from "../src/ops/opsTheme.js";

describe("ops shared theme", () => {
  it("declares the light Revive palette (not a dark theme)", () => {
    expect(OPS_TOKENS).toContain("color-scheme:light");
    expect(OPS_TOKENS).toContain("--plum-600:#7c547d");
  });

  it("honours prefers-reduced-motion in the base styles", () => {
    expect(OPS_BASE).toContain("prefers-reduced-motion");
  });

  it("every shared CSS block has balanced braces (guards template typos)", () => {
    for (const css of [OPS_TOKENS, OPS_BASE, OPS_PAIR_STYLE]) {
      const open = (css.match(/{/g) ?? []).length;
      const close = (css.match(/}/g) ?? []).length;
      expect(open).toBe(close);
    }
  });

  it("esc escapes all five HTML-significant characters without double-escaping", () => {
    expect(esc("<")).toBe("&lt;");
    expect(esc(">")).toBe("&gt;");
    expect(esc('"')).toBe("&quot;");
    expect(esc("'")).toBe("&#39;");
    expect(esc("&")).toBe("&amp;");
    // Ampersand is replaced first, so the entities it introduces are not re-escaped.
    expect(esc("<&>")).toBe("&lt;&amp;&gt;");
  });
});
