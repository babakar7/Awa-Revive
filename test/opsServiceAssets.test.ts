import { describe, expect, it } from "vitest";
import {
  SERVICE_APP_JS,
  SERVICE_MANIFEST,
  SERVICE_SW,
  serviceBoardPage,
  servicePairingPage,
} from "../src/ops/opsServicePage.js";

describe("service PWA assets", () => {
  it("manifest is valid JSON scoped to /ops/service/ with two icons and light colors", () => {
    const m = JSON.parse(SERVICE_MANIFEST);
    expect(m.scope).toBe("/ops/service/");
    expect(m.start_url).toBe("/ops/service/");
    expect(m.display).toBe("standalone");
    expect(m.orientation).toBe("portrait");
    expect(m.icons).toHaveLength(2);
    expect(m.icons.map((i: any) => i.sizes)).toContain("512x512");
    expect(m.theme_color).toBe("#fbf7f2");
    expect(m.background_color).toBe("#fbf6f0");
  });

  it("cache-bust version is identical in the app.js query and the SW cache name", () => {
    const version = serviceBoardPage("{}").match(/app\.js\?b=(v\d+)/)?.[1];
    expect(version).toBeTruthy();
    expect(SERVICE_SW).toContain(`service-${version}`);
  });

  it("SW purges only this app's caches (shared localhost origin in dev)", () => {
    expect(SERVICE_SW).toContain("startsWith('service-')");
  });

  it("pages honour prefers-reduced-motion", () => {
    expect(serviceBoardPage("{}")).toContain("prefers-reduced-motion");
    expect(servicePairingPage()).toContain("prefers-reduced-motion");
  });

  it("composer sheet has dialog semantics and guards an unfinished order", () => {
    expect(SERVICE_APP_JS).toContain("'aria-modal'");
    expect(SERVICE_APP_JS).toContain("'dialog'");
    expect(SERVICE_APP_JS).toContain("Abandonner cette commande ?");
  });

  // The native confirm() renders OK/Annuler — ambiguous when the question is
  // « Annuler cette commande ? ». Both destructive guards go through the custom
  // dialog whose buttons carry their verb.
  it("confirmations put the verb on the buttons (no native confirm)", () => {
    expect(SERVICE_APP_JS).not.toContain("confirm(");
    expect(SERVICE_APP_JS).toContain("'alertdialog'");
    expect(SERVICE_APP_JS).toContain("Oui, annuler la commande");
    expect(SERVICE_APP_JS).toContain("Non, garder la commande");
    expect(SERVICE_APP_JS).toContain("Oui, abandonner");
  });

  it("offers the sur place / à emporter choice and sends it in the order body", () => {
    expect(SERVICE_APP_JS).toContain("Sur place");
    expect(SERVICE_APP_JS).toContain("À emporter");
    // The flag is sent to the server (which re-decides it) — never a price/total.
    expect(SERVICE_APP_JS).toContain("takeaway:state.takeaway");
  });

  it("lets the accueil flag an order urgent", () => {
    expect(SERVICE_APP_JS).toContain("Urgent");
    expect(SERVICE_APP_JS).toContain("/urgent");
  });

  it("offers a ⭐ Favoris shortcut via the __FAV__ sentinel category", () => {
    expect(SERVICE_APP_JS).toContain("Favoris");
    expect(SERVICE_APP_JS).toContain("__FAV__");
    // Favourite is a server flag read off the menu item, never a client decision.
    expect(SERVICE_APP_JS).toContain("it.fav");
  });

  it("shows an indicative running subtotal on an occupied tile", () => {
    expect(SERVICE_APP_JS).toContain("Sous-total — indicatif");
    expect(SERVICE_APP_JS).toContain("s.total_xof");
  });

  it("has a read-only recent-tables history the SW never caches", () => {
    expect(SERVICE_APP_JS).toContain("Tables récentes");
    expect(SERVICE_APP_JS).toContain("/recent");
    expect(SERVICE_SW).not.toContain("/recent");
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
