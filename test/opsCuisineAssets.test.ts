import { describe, expect, it } from "vitest";
import {
  CUISINE_APP_JS,
  CUISINE_MANIFEST,
  CUISINE_SW,
  cuisineKitchenPage,
  cuisinePairingPage,
} from "../src/ops/opsCuisinePage.js";
import {
  hashOpsToken,
  newOpsToken,
  newPairCode,
  normalizePairCode,
} from "../src/ops/opsAuth.js";

describe("cuisine PWA assets", () => {
  it("manifest is valid JSON with a scope, two icons and the light Revive colors", () => {
    const m = JSON.parse(CUISINE_MANIFEST);
    expect(m.scope).toBe("/ops/cuisine/");
    expect(m.start_url).toBe("/ops/cuisine/");
    expect(m.display).toBe("standalone");
    expect(m.icons).toHaveLength(2);
    expect(m.icons.map((i: any) => i.sizes)).toContain("512x512");
    // Light theme (not the old dark #161016/#211921).
    expect(m.theme_color).toBe("#fbf7f2");
    expect(m.background_color).toBe("#fbf6f0");
  });

  it("cache-bust version is identical in the app.js query and the SW cache name", () => {
    // A mismatch (app.js?b=v3 but cache 'cuisine-v2') would serve stale JS from an
    // un-purged cache — assert the exact same token appears in both.
    const version = cuisineKitchenPage("{}").match(/app\.js\?b=(v\d+)/)?.[1];
    expect(version).toBeTruthy();
    expect(CUISINE_SW).toContain(`cuisine-${version}`);
  });

  it("SW purges only this app's caches (shared localhost origin in dev)", () => {
    expect(CUISINE_SW).toContain("startsWith('cuisine-')");
  });

  it("pages honour prefers-reduced-motion", () => {
    expect(cuisineKitchenPage("{}")).toContain("prefers-reduced-motion");
    expect(cuisinePairingPage()).toContain("prefers-reduced-motion");
  });

  it("shows an à-emporter badge on takeaway tickets", () => {
    expect(CUISINE_APP_JS).toContain("À emporter");
    expect(CUISINE_APP_JS).toContain("t.takeaway");
  });

  it("bubbles urgent tickets to the top and announces the board by voice", () => {
    // Urgent-first sort + strong badge.
    expect(CUISINE_APP_JS).toContain("y.urgent");
    expect(CUISINE_APP_JS).toContain("URGENT");
    // Spoken alerts (Web Speech API) + a persisted mute toggle.
    expect(CUISINE_APP_JS).toContain("speechSynthesis");
    expect(CUISINE_APP_JS).toContain("cuisine.sound");
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
