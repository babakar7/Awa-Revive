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
    const version = serviceBoardPage().match(/app\.js\?b=(v\d+)/)?.[1];
    expect(version).toBe("v25");
    expect(SERVICE_SW).toContain(`service-${version}`);
  });

  it("SW purges only this app's caches (shared localhost origin in dev)", () => {
    expect(SERVICE_SW).toContain("startsWith('service-')");
  });

  it("pages honour prefers-reduced-motion", () => {
    expect(serviceBoardPage()).toContain("prefers-reduced-motion");
    expect(servicePairingPage()).toContain("prefers-reduced-motion");
  });

  it("the board has no inline boot (CSP script-src 'self' would block it)", () => {
    expect(serviceBoardPage()).not.toContain("window.__BOOT__");
    expect(serviceBoardPage()).not.toContain("<script>");
  });

  it("composer sheet has dialog semantics and guards an unfinished order", () => {
    expect(SERVICE_APP_JS).toContain("'aria-modal'");
    expect(SERVICE_APP_JS).toContain("'dialog'");
    expect(SERVICE_APP_JS).toContain("Abandonner cette commande ?");
  });

  it("keeps cart persistent without taking width from the category scroller", () => {
    expect(SERVICE_APP_JS).toContain("searchbar.appendChild(cartChip)");
    expect(SERVICE_APP_JS).not.toContain("chips.appendChild(cartChip)");
    expect(SERVICE_APP_JS).not.toContain("browsebar.appendChild(cartChip)");
    expect(SERVICE_APP_JS).toContain("state.cartOnly");
    expect(SERVICE_APP_JS).toContain("draft[it.id]&&draft[it.id].qty>0");
    expect(serviceBoardPage()).toContain(".browsebar .chips{width:100%}");
    expect(serviceBoardPage()).toContain(".foot{position:sticky");
  });

  it("uses the same keyboard-aware focused search and clears after add", () => {
    expect(SERVICE_APP_JS).toContain("state.searching=true");
    expect(SERVICE_APP_JS).toContain("sh.classList.add('searching')");
    expect(SERVICE_APP_JS).toContain("Effacer la recherche");
    expect(SERVICE_APP_JS).toContain("'Terminé'");
    expect(SERVICE_APP_JS).toContain("window.visualViewport");
    expect(SERVICE_APP_JS).toContain("vv.height");
    expect(SERVICE_APP_JS).toContain("if(state.searching&&!needsChoice)e.preventDefault()");
    expect(SERVICE_APP_JS).toContain("state.q='';search.value='';renderList()");
    expect(serviceBoardPage()).toContain(".sheet.searching .mi");
    expect(serviceBoardPage()).toContain(".sheet.searching .optional");
  });

  it("collapses completed choices, refocuses search, and keeps choices editable", () => {
    expect(SERVICE_APP_JS).toContain("creq.classList.toggle('collapsed'");
    expect(SERVICE_APP_JS).toContain("✓ — modifier");
    expect(SERVICE_APP_JS).toContain("if(state.searching){try{search.focus()");
    expect(SERVICE_APP_JS).toContain("setAttribute('aria-expanded'");
    expect(serviceBoardPage()).toContain(".creq.collapsed .cpills{display:none}");
  });

  it("deprioritizes optional details and provides success/retry feedback", () => {
    expect(SERVICE_APP_JS).toContain("document.createElement('details')");
    expect(SERVICE_APP_JS).toContain("Détails optionnels");
    expect(SERVICE_APP_JS).toContain("Commande envoyée — ");
    expect(SERVICE_APP_JS).toContain("Vérifiez la connexion puis réessayez.");
    // Service-only semantics remain inside the optional section and POST body.
    expect(SERVICE_APP_JS).toContain("Commande test — exclue des statistiques");
    expect(SERVICE_APP_JS).toContain("test:state.test");
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

  it("a READY ticket has ONE serve action (no two-step take/serve)", () => {
    // One tap "Je prends" completes the ready ticket via /served; the old claim
    // step (/take, "Servie", "Pris par") is gone.
    expect(SERVICE_APP_JS).toContain("🙋 Je prends");
    expect(SERVICE_APP_JS).toContain("/served");
    expect(SERVICE_APP_JS).not.toContain("/tickets/'+t.id+'/take");
    expect(SERVICE_APP_JS).not.toContain("Pris par");
  });

  it("never gets stuck on 'Chargement…': load guard + retry + reachable-first render", () => {
    // The board loads via /state (inline boot is CSP-blocked). A load guard keeps
    // it honest and self-heals a transient failure instead of hanging.
    expect(SERVICE_APP_JS).toContain("function retryLoad");
    expect(SERVICE_APP_JS).toContain("loaded?'Aucun espace chargé.':'Chargement…'");
    // render()+refreshState() run before the optional audio/push setup.
    const firstRender = SERVICE_APP_JS.indexOf("render();\n  refreshState();");
    const audioInit = SERVICE_APP_JS.indexOf("sound & voice");
    expect(firstRender).toBeGreaterThan(0);
    expect(firstRender).toBeLessThan(audioInit);
  });

  it("READY alert reinforces beep + vibration + voice (foreground)", () => {
    // The ticket_update READY branch routes through readyAlert, not a bare beep.
    expect(SERVICE_APP_JS).toContain("readyAlert(t)");
    expect(SERVICE_APP_JS).toContain("Commande prête");
    expect(SERVICE_APP_JS).toContain("navigator.vibrate");
  });

  it("the SW push notification vibrates the phone", () => {
    expect(SERVICE_SW).toContain("vibrate:");
  });

  it("keeps the voice alive on a long-running page (TTS resume heartbeat)", () => {
    expect(SERVICE_APP_JS).toMatch(/setInterval\([\s\S]{0,80}speechSynthesis\.resume/);
  });

  it("blocked-notifications help gives the reinstall reset (no bogus Réglages path)", () => {
    // iOS lists a web app in Réglages → Notifications only after a first prompt;
    // a stuck « denied » is reset by reinstalling the icon (then re-pairing).
    expect(SERVICE_APP_JS).toContain("Supprime l’icône Salle");
    expect(SERVICE_APP_JS).toContain("réappaire");
    expect(SERVICE_APP_JS).not.toContain("Réglages iOS → Salle Revive");
  });

  it("the alerts panel is platform-aware: Android is never gated on install", () => {
    // Home-screen install is an iOS-only prerequisite for push; on Android the
    // enable button must be offered even from a plain Chrome tab.
    expect(SERVICE_APP_JS).toMatch(/IOS\s*&&\s*!isStandalone\(\)/);
    // Android-specific unblock path (no reinstall) + install tip.
    expect(SERVICE_APP_JS).toContain("Autorisations → Notifications");
    expect(SERVICE_APP_JS).toContain("Ajouter à l’écran d’accueil");
    expect(SERVICE_APP_JS).toContain("Ne pas déranger");
  });

  it("the 🔔 alerts panel is always shown and walks install → enable → test", () => {
    // Bell is no longer auto-hidden; it dims until subscribed.
    expect(serviceBoardPage()).not.toContain('id="bell" hidden');
    expect(SERVICE_APP_JS).toContain("paintBell");
    expect(SERVICE_APP_JS).toContain("isStandalone");
    expect(SERVICE_APP_JS).toContain("Sur l’écran d’accueil");
    expect(SERVICE_APP_JS).toContain("Activer les alertes");
    expect(SERVICE_APP_JS).toContain("Tester la sonnerie");
    // Test button hits the per-device endpoint.
    expect(SERVICE_APP_JS).toContain("/push/test");
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

  it("leads the default picker with a 🔥 Populaires section + real-time search + sort", () => {
    // Best-sellers on top (server `top` ids), resolved via the shared helper.
    expect(SERVICE_APP_JS).toContain("🔥 Populaires");
    expect(SERVICE_APP_JS).toContain("window.__pick.top");
    expect(SERVICE_APP_JS).toContain("window.__pick.sortItems");
    // Search filters on input (no Enter) and hints the keyboard.
    expect(SERVICE_APP_JS).toContain("search.oninput");
    expect(SERVICE_APP_JS).toContain("enterkeyhint");
    // The shared helper snippet is bundled ahead of the app IIFE.
    expect(SERVICE_APP_JS).toContain("window.__pick=");
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
