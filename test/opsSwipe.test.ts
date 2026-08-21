import { describe, expect, it } from "vitest";
import { OPS_SWIPE_HELPER } from "../src/ops/opsSwipe.js";
import { OPS_BASE } from "../src/ops/opsTheme.js";
import { ownerBoardPage } from "../src/ops/opsOwnerPage.js";
import { serviceBoardPage } from "../src/ops/opsServicePage.js";

describe("ops swipe navigation", () => {
  it("parses as valid JavaScript and exposes one shared binder", () => {
    expect(() => new Function(OPS_SWIPE_HELPER)).not.toThrow();
    expect(OPS_SWIPE_HELPER).toContain("window.__swipe");
  });

  it("stays out of the way of scrolling, the composer, and text entry", () => {
    // A composer/dialog overlay owns the screen — never navigate underneath it.
    expect(OPS_SWIPE_HELPER).toContain("document.querySelector('.ov')");
    // Sideways scrollers (category chips) and inputs are excluded at touchstart.
    expect(OPS_SWIPE_HELPER).toContain(".chips");
    expect(OPS_SWIPE_HELPER).toContain("input,textarea,select");
    // Vertical intent wins, and a slow drag is not a swipe.
    expect(OPS_SWIPE_HELPER).toContain("Math.abs(dy)*RATIO");
    expect(OPS_SWIPE_HELPER).toContain("MAX_MS");
    // Listeners stay passive so scrolling is never janked.
    expect(OPS_SWIPE_HELPER).toContain("{passive:true}");
  });

  it("[hidden] beats author display rules, so one board really hides the other", () => {
    // Without this, `main{display:grid}` / `#delivery-board{display:grid}` win
    // over the UA [hidden] rule and both boards render stacked — the livraison
    // board used to bleed onto the salle screen with its sticky ＋ bar.
    expect(OPS_BASE).toContain("[hidden]{display:none!important}");
    for (const page of [ownerBoardPage(), serviceBoardPage()]) {
      expect(page).toContain("[hidden]{display:none!important}");
      expect(page).toContain('id="delivery-board"');
    }
  });
});
