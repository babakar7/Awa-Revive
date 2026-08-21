import { describe, expect, it } from "vitest";
import { OPS_DELIVERY_COMPOSER, OPS_DELIVERY_COMPOSER_CSS } from "../src/ops/opsDeliveryComposer.js";
import { ownerBoardPage } from "../src/ops/opsOwnerPage.js";
import { serviceBoardPage } from "../src/ops/opsServicePage.js";

// Assertions target the composer EXPORTS directly: sentinels on the full page
// bundles would already pass thanks to the salle composers and prove nothing.
describe("shared delivery composer (owner + service)", () => {
  it("parses as valid JavaScript", () => {
    expect(() => new Function(OPS_DELIVERY_COMPOSER)).not.toThrow();
  });

  it("is a full-screen two-step flow, not the old clipped bottom sheet", () => {
    expect(OPS_DELIVERY_COMPOSER).toContain("'sheet dfull'");
    expect(OPS_DELIVERY_COMPOSER).toContain("'dstep'");
    // The old unstyled, unscrollable list class is gone…
    expect(OPS_DELIVERY_COMPOSER).not.toContain("delivery-menu");
    // …and so is tap-outside dismissal: it reads as a page; × asks to confirm
    // only when the draft is dirty.
    expect(OPS_DELIVERY_COMPOSER).not.toContain("e.target===ov");
    expect(OPS_DELIVERY_COMPOSER).toContain("Abandonner cette livraison ?");
  });

  it("item picker reuses the salle pattern: search mode, populaires, in-place qty sync", () => {
    expect(OPS_DELIVERY_COMPOSER).toContain("🔥 Populaires");
    expect(OPS_DELIVERY_COMPOSER).toContain("state.searching");
    expect(OPS_DELIVERY_COMPOSER).toContain("visualViewport");
    // Steps never leak search mode into the details screen.
    expect(OPS_DELIVERY_COMPOSER).toContain("if(s===2)finishSearch()");
  });

  it("keeps the API contract: index-keyed selections, idempotency id, server caps mirrored", () => {
    expect(OPS_DELIVERY_COMPOSER).toContain("group_index");
    expect(OPS_DELIVERY_COMPOSER).toContain("client_request_id");
    expect(OPS_DELIVERY_COMPOSER).toContain("MAX_QTY=10");
    expect(OPS_DELIVERY_COMPOSER).toContain("MAX_LINES=15");
    expect(OPS_DELIVERY_COMPOSER).toContain("/delivery-clients?q=");
  });

  it("cleans up async work on close and locks all navigation while the POST is in flight", () => {
    expect(OPS_DELIVERY_COMPOSER).toContain("clearTimeout(searchTimer)");
    expect(OPS_DELIVERY_COMPOSER).toContain("removeEventListener('resize',fitViewport)");
    // Stale autocomplete responses never overwrite a newer search.
    expect(OPS_DELIVERY_COMPOSER).toContain("if(seq!==clientReq)return");
    // ×, ← and « Modifier » are all sending-guarded (an in-flight POST may have
    // already created the order — closing would read as an abandon).
    expect(OPS_DELIVERY_COMPOSER).toContain("if(state.sending)return");
    expect(OPS_DELIVERY_COMPOSER).toContain("back.disabled=true");
  });

  it("CSS defines the page/scroll contract and BOTH pages actually ship it", () => {
    expect(OPS_DELIVERY_COMPOSER_CSS).toContain(".sheet.dfull");
    expect(OPS_DELIVERY_COMPOSER_CSS).toContain(".dstep[hidden]{display:none}");
    // Previously-unstyled form classes are covered now.
    expect(OPS_DELIVERY_COMPOSER_CSS).toContain(".dfull .field");
    expect(OPS_DELIVERY_COMPOSER_CSS).toContain(".dfull .client-results");
    // A forgotten <style> include on either page fails loudly here.
    expect(ownerBoardPage()).toContain(".sheet.dfull");
    expect(serviceBoardPage()).toContain(".sheet.dfull");
  });
});
