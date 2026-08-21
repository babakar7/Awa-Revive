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
    expect(m.orientation).toBe("portrait");
    expect(m.icons).toHaveLength(2);
    expect(m.theme_color).toBe("#fbf7f2");
    expect(m.background_color).toBe("#fbf6f0");
  });

  it("app.js parses as valid JavaScript", () => {
    expect(() => new Function(OWNER_APP_JS)).not.toThrow();
  });

  it("has FULL ticket control: cuisine + salle verbs on its own /ops/owner endpoints", () => {
    // The owner drives every transition the cuisine iPad and the salle phones
    // can: commencer / prête / terminée (BAR) / servie (TABLE) / urgent / annuler.
    for (const action of ["/preparing", "/ready", "/complete", "/served", "/urgent", "/cancel"]) {
      expect(OWNER_APP_JS).toContain(`+'${action}'`);
    }
    // All mutations go through postJSON(BASE+…) — never a cross-role endpoint.
    expect(OWNER_APP_JS).not.toContain("/ops/cuisine/");
    expect(OWNER_APP_JS).not.toContain("/ops/service/");
    // "Prête" keeps the local undo grace (mis-tap never reaches the server) and
    // cancelling asks a verb-labelled confirmation first.
    expect(OWNER_APP_JS).toContain("READY_DELAY_MS=2000");
    expect(OWNER_APP_JS).toContain("cancelPendingReady");
    expect(OWNER_APP_JS).toContain("askConfirm('Annuler cette commande ?'");
  });

  it("can take a salle order: spot picker + menu composer posting to /spots/:id/orders", () => {
    // The one write the owner is allowed: create an order (server decides prices).
    expect(OWNER_APP_JS).toContain("/spots/");
    expect(OWNER_APP_JS).toContain("/orders");
    expect(OWNER_APP_JS).toMatch(/method:\s*['"]POST['"]/);
    // Every required choice group + per-line note are carried (no dropped data).
    expect(OWNER_APP_JS).toContain("obligatoire");
    expect(OWNER_APP_JS).toContain("it.optionGroups");
    expect(OWNER_APP_JS).toContain("e.selections=selections");
    expect(OWNER_APP_JS).toContain("l.selections.map");
    expect(OWNER_APP_JS).toContain("e.note=d.note");
    // The header entry point.
    expect(ownerBoardPage()).toContain('id="take"');
  });

  it("defaults to Terrasse and keeps the three spaces on one row", () => {
    expect(OWNER_APP_JS).toContain("a.label==='Terrasse'?0:1");
    expect(OWNER_APP_JS).toContain("spotId:SPOTS.length?SPOTS[0].id:''");
    expect(ownerBoardPage()).toContain("grid-template-columns:repeat(3,minmax(0,1fr))");
  });

  it("offers only 30/50-minute scheduling and keeps scheduled orders actionable", () => {
    expect(OWNER_APP_JS).toContain("[30,50].forEach");
    expect(OWNER_APP_JS).toContain("body.ready_in_minutes=state.readyIn");
    expect(OWNER_APP_JS).toContain("Préparer maintenant");
    expect(OWNER_APP_JS).toContain("/prepare-now");
    expect(OWNER_APP_JS).toContain("Commande programmée envoyée en cuisine — ");
    expect(ownerBoardPage()).toContain(".later-options");
  });

  it("reveals ordinary-item notes after adding from search", () => {
    expect(OWNER_APP_JS).toContain("else { finishSearch(); }");
    expect(OWNER_APP_JS).toContain("Note (optionnel)");
    expect(OWNER_APP_JS).toContain("e.note=d.note");
  });

  it("uses persistent accessible space buttons instead of a native select", () => {
    expect(OWNER_APP_JS).not.toContain("createElement('select')");
    expect(OWNER_APP_JS).toContain("SPOTS.forEach(function(sp)");
    expect(OWNER_APP_JS).toContain("'spotbtn'");
    expect(OWNER_APP_JS).toContain("setAttribute('aria-pressed'");
    expect(OWNER_APP_JS).toContain("summarySpot.textContent");
    expect(ownerBoardPage()).toContain(".spotbtn.sel");
    expect(ownerBoardPage()).toContain(".spotbtn.sel .check");
  });

  it("lets the supervisor return to the space picker after adding an item through search", () => {
    expect(OWNER_APP_JS).toContain("summarySpot=el('button','summary-action','Espace à choisir')");
    expect(OWNER_APP_JS).toContain("summarySpot.onclick=revealSpotPicker");
    expect(OWNER_APP_JS).toContain("if(!state.spotId){ setError('Choisissez d’abord un espace.'); revealSpotPicker(); return; }");
    expect(OWNER_APP_JS).toContain("spotPicker.scrollIntoView({block:'start'})");
    expect(ownerBoardPage()).toContain(".search-summary .summary-action");
  });

  it("has a selected-items cart, collapsed optional details, and contextual sticky footer", () => {
    expect(OWNER_APP_JS).toContain("document.createElement('details')");
    expect(OWNER_APP_JS).toContain("Détails optionnels");
    expect(OWNER_APP_JS).toContain("state.cartOnly");
    expect(OWNER_APP_JS).toContain("Panier (0)");
    expect(OWNER_APP_JS).toContain("searchbar.appendChild(cartChip)");
    expect(OWNER_APP_JS).not.toContain("browsebar.appendChild(cartChip)");
    expect(OWNER_APP_JS).toContain("draft[it.id]&&draft[it.id].qty>0");
    expect(OWNER_APP_JS).toContain("n+' article'");
    expect(OWNER_APP_JS).toContain("'Envoyer en cuisine'");
    expect(ownerBoardPage()).toContain(".foot{position:sticky");
  });

  it("has keyboard-aware focused search with compact controls and dense results", () => {
    expect(OWNER_APP_JS).toContain("state.searching=true");
    expect(OWNER_APP_JS).toContain("sh.classList.add('searching')");
    expect(OWNER_APP_JS).toContain("Effacer la recherche");
    expect(OWNER_APP_JS).toContain("'Terminé'");
    expect(OWNER_APP_JS).toContain("window.visualViewport");
    expect(OWNER_APP_JS).toContain("vv.height");
    expect(OWNER_APP_JS).toContain("vv.offsetTop");
    expect(OWNER_APP_JS).toContain("if(state.searching&&!needsChoice)e.preventDefault()");
    expect(OWNER_APP_JS).toContain("state.q=''; search.value=''; renderList()");
    expect(OWNER_APP_JS).toContain("search.blur()");
    expect(ownerBoardPage()).toContain(".sheet.searching .mi");
    expect(ownerBoardPage()).toContain(".sheet.searching .spot-picker");
  });

  it("collapses a completed required choice and returns focus to search", () => {
    expect(OWNER_APP_JS).toContain("creq.classList.toggle('collapsed'");
    expect(OWNER_APP_JS).toContain("✓ — modifier");
    expect(OWNER_APP_JS).toContain("state.searching&&choicesComplete");
    expect(OWNER_APP_JS).toContain("setAttribute('aria-expanded'");
    expect(ownerBoardPage()).toContain(".creq.collapsed .cpills{display:none}");
    expect(ownerBoardPage()).toContain(".sheet.searching .creq.collapsed~.lnlab");
  });

  it("protects drafts and keeps actionable feedback around submission", () => {
    expect(OWNER_APP_JS).toContain("if(cartCount()>0)");
    expect(OWNER_APP_JS).toContain("Abandonner cette commande ?");
    expect(OWNER_APP_JS).toContain("Oui, abandonner");
    expect(OWNER_APP_JS).toContain("Non, continuer la saisie");
    expect(OWNER_APP_JS).toContain("Commande envoyée — ");
    expect(OWNER_APP_JS).toContain("Vérifiez la connexion puis réessayez.");
  });

  it("the owner composer has the SAME findability as the salle (search + chips + Populaires)", () => {
    expect(OWNER_APP_JS).toContain("window.__pick=");         // shared helper bundled
    expect(OWNER_APP_JS).toContain("🔥 Populaires");
    expect(OWNER_APP_JS).toContain("window.__pick.top");
    expect(OWNER_APP_JS).toContain("window.__pick.sortItems");
    expect(OWNER_APP_JS).toContain("search.oninput");         // real-time search
    expect(OWNER_APP_JS).toContain("enterkeyhint");
    expect(OWNER_APP_JS).not.toContain("Favoris");
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
    const version = ownerBoardPage().match(/app\.js\?b=(v\d+)/)?.[1];
    expect(version).toBe("v16");
    expect(OWNER_SW).toContain(`owner-${version}`);
  });

  it("has the delivery column and shared composer", () => {
    expect(ownerBoardPage()).toContain("delivery-list");
    expect(OWNER_APP_JS).toContain("window.__deliveryComposer");
    expect(OWNER_APP_JS).toContain("/deliveries");
  });

  it("pages honour prefers-reduced-motion and only ever talk same-origin", () => {
    expect(ownerBoardPage()).toContain("prefers-reduced-motion");
    expect(ownerPairingPage()).toContain("prefers-reduced-motion");
    expect(OWNER_APP_JS).not.toMatch(/https?:\/\//);
  });

  it("web push: bell walkthrough + SW lock-screen alert on its own endpoints", () => {
    // Bell is always visible and dims until subscribed (same UX as the salle).
    expect(ownerBoardPage()).toContain('id="bell"');
    expect(OWNER_APP_JS).toContain("paintBell");
    expect(OWNER_APP_JS).toContain("pushManager.subscribe");
    // Subscribe/test go through the OWNER endpoints (postJSON prefixes BASE).
    expect(OWNER_APP_JS).toContain("/push/subscribe");
    expect(OWNER_APP_JS).toContain("/push/test");
    expect(OWNER_APP_JS).toContain("Activer les alertes");
    expect(OWNER_APP_JS).toContain("Tester la sonnerie");
    // iOS reset instructions name THIS app, not the salle.
    expect(OWNER_APP_JS).toContain("Supprime l’icône Supervision");
    // Android is never gated on install; iOS is.
    expect(OWNER_APP_JS).toMatch(/IOS\s*&&\s*!isStandalone\(\)/);
    // The SW shows the alert, vibrates, and a tap lands on the owner board.
    expect(OWNER_SW).toContain("showNotification");
    expect(OWNER_SW).toContain("vibrate:");
    expect(OWNER_SW).toContain("'/ops/owner/'");
  });

  it("the board has no inline boot (CSP script-src 'self' would block it)", () => {
    expect(ownerBoardPage()).not.toContain("window.__BOOT__");
    expect(ownerBoardPage()).not.toContain("<script>");
  });
});
