import { describe, expect, it } from "vitest";
import {
  CUISINE_APP_JS,
  CUISINE_MANIFEST,
  CUISINE_SW,
} from "../src/ops/opsCuisinePage.js";
import {
  hashOpsToken,
  newOpsToken,
  newPairCode,
  normalizePairCode,
} from "../src/ops/opsAuth.js";

describe("cuisine PWA assets", () => {
  it("manifest is valid JSON with a scope and two icons", () => {
    const m = JSON.parse(CUISINE_MANIFEST);
    expect(m.scope).toBe("/ops/cuisine/");
    expect(m.start_url).toBe("/ops/cuisine/");
    expect(m.display).toBe("standalone");
    expect(m.icons).toHaveLength(2);
    expect(m.icons.map((i: any) => i.sizes)).toContain("512x512");
  });

  it("app.js parses as valid JavaScript (no syntax errors in the big string)", () => {
    // new Function only parses (doesn't run), so undefined browser globals are fine.
    expect(() => new Function(CUISINE_APP_JS)).not.toThrow();
  });

  it("service worker parses and never caches mutations", () => {
    expect(() => new Function(CUISINE_SW)).not.toThrow();
    // Only GET shell assets are cached; the SSE stream and POSTs are network-only.
    expect(CUISINE_SW).toContain("e.request.method==='GET'");
    expect(CUISINE_SW).not.toContain("/events");
  });
});

describe("ops device auth helpers", () => {
  it("hashOpsToken is a deterministic 64-char hex sha256", () => {
    const h = hashOpsToken("abc");
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(hashOpsToken("abc")).toBe(h);
    expect(hashOpsToken("abd")).not.toBe(h);
  });

  it("newOpsToken is 48 hex chars (192-bit) and unique", () => {
    const a = newOpsToken();
    const b = newOpsToken();
    expect(a).toMatch(/^[0-9a-f]{48}$/);
    expect(a).not.toBe(b);
  });

  it("pairing codes are 8 chars from the unambiguous alphabet", () => {
    for (let i = 0; i < 50; i++) {
      const code = newPairCode();
      expect(code).toMatch(/^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{8}$/);
    }
  });

  it("normalizePairCode strips spaces and uppercases", () => {
    expect(normalizePairCode("  ab cd ef gh ")).toBe("ABCDEFGH");
  });
});
