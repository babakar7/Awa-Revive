import { describe, expect, it } from "vitest";
import {
  SERVICE_APP_JS,
  SERVICE_MANIFEST,
  SERVICE_SW,
} from "../src/ops/opsServicePage.js";

describe("service PWA assets", () => {
  it("manifest is valid JSON scoped to /ops/service/ with two icons", () => {
    const m = JSON.parse(SERVICE_MANIFEST);
    expect(m.scope).toBe("/ops/service/");
    expect(m.start_url).toBe("/ops/service/");
    expect(m.display).toBe("standalone");
    expect(m.orientation).toBe("portrait");
    expect(m.icons).toHaveLength(2);
    expect(m.icons.map((i: any) => i.sizes)).toContain("512x512");
  });

  it("app.js parses as valid JavaScript (no syntax errors in the big string)", () => {
    expect(() => new Function(SERVICE_APP_JS)).not.toThrow();
  });

  it("service worker parses and never caches mutations", () => {
    expect(() => new Function(SERVICE_SW)).not.toThrow();
    expect(SERVICE_SW).toContain("e.request.method==='GET'");
    // The SSE stream, sessions API and every POST must stay network-only.
    expect(SERVICE_SW).not.toContain("/events");
    expect(SERVICE_SW).not.toContain("/sessions");
    expect(SERVICE_SW).not.toContain("/tickets");
  });

  it("client only ever talks same-origin (prices/labels come from the server)", () => {
    // No absolute URLs in the client — every fetch is BASE-relative same-origin.
    expect(SERVICE_APP_JS).not.toMatch(/https?:\/\//);
    // The order POST sends item ids + qty, never a price.
    expect(SERVICE_APP_JS).toContain("/orders");
    expect(SERVICE_APP_JS).not.toContain("unitPriceXof");
  });
});
