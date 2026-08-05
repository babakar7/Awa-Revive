import { describe, expect, it } from "vitest";
import {
  OWNER_APP_JS,
  OWNER_MANIFEST,
  OWNER_SW,
  ownerBoardPage,
  ownerPairingPage,
} from "../src/ops/opsOwnerPage.js";

describe("owner supervision PWA assets", () => {
  it("manifest is valid JSON scoped to /ops/owner/ with two icons and light colors", () => {
    const m = JSON.parse(OWNER_MANIFEST);
    expect(m.scope).toBe("/ops/owner/");
    expect(m.start_url).toBe("/ops/owner/");
    expect(m.display).toBe("standalone");
    expect(m.icons).toHaveLength(2);
    expect(m.theme_color).toBe("#fbf7f2");
    expect(m.background_color).toBe("#fbf6f0");
  });

  it("app.js parses as valid JavaScript", () => {
    expect(() => new Function(OWNER_APP_JS)).not.toThrow();
  });

  it("never MUTATES an existing ticket (watch-only over the live board)", () => {
    // The owner may take a NEW order, but must never drive a ticket's state.
    expect(OWNER_APP_JS).not.toContain("/preparing");
    expect(OWNER_APP_JS).not.toContain("/ready");
    expect(OWNER_APP_JS).not.toContain("/urgent");
    expect(OWNER_APP_JS).not.toContain("/served");
    expect(OWNER_APP_JS).not.toContain("/cancel");
  });

  it("can take a salle order: spot picker + menu composer posting to /spots/:id/orders", () => {
    // The one write the owner is allowed: create an order (server decides prices).
    expect(OWNER_APP_JS).toContain("/spots/");
    expect(OWNER_APP_JS).toContain("/orders");
    expect(OWNER_APP_JS).toMatch(/method:\s*['"]POST['"]/);
    // Required-choice guard + per-line note are carried (no dropped data).
    expect(OWNER_APP_JS).toContain("obligatoire");
    expect(OWNER_APP_JS).toContain("e.note=d.note");
    // The header entry point.
    expect(ownerBoardPage("{}")).toContain('id="take"');
  });

  it("service worker parses, never caches live data, purges only its own caches", () => {
    expect(() => new Function(OWNER_SW)).not.toThrow();
    expect(OWNER_SW).toContain("e.request.method==='GET'");
    expect(OWNER_SW).not.toContain("/events");
    expect(OWNER_SW).not.toContain("/state");
    expect(OWNER_SW).not.toContain("/stats");
    expect(OWNER_SW).toContain("startsWith('owner-')");
  });

  it("cache-bust version is identical in app.js query and SW cache name", () => {
    const version = ownerBoardPage("{}").match(/app\.js\?b=(v\d+)/)?.[1];
    expect(version).toBeTruthy();
    expect(OWNER_SW).toContain(`owner-${version}`);
  });

  it("pages honour prefers-reduced-motion and only ever talk same-origin", () => {
    expect(ownerBoardPage("{}")).toContain("prefers-reduced-motion");
    expect(ownerPairingPage()).toContain("prefers-reduced-motion");
    expect(OWNER_APP_JS).not.toMatch(/https?:\/\//);
  });
});
