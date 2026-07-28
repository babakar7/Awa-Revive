import { describe, expect, it } from "vitest";
import {
  COMMANDER_APP_JS,
  commanderPage,
  commandeMerciPage,
  commandeErreurPage,
} from "../src/public/commandePage.js";
import { computeBarOpen } from "../src/domain/openingHours.js";
import { allowPublicOrder } from "../src/lib/rateLimit.js";
import { pickerMenu } from "../src/lib/cafeMenu.js";
import { setCafeMenu, type CafeMenuRow } from "../src/lib/cafeMenu.js";

describe("/commander page assets", () => {
  it("app.js parses as valid JavaScript (no syntax error in the big string)", () => {
    expect(() => new Function(COMMANDER_APP_JS)).not.toThrow();
  });

  it("offers all four service modes incl. native delivery", () => {
    for (const m of ["SUR_PLACE", "A_EMPORTER", "RETRAIT", "LIVRAISON"]) {
      expect(COMMANDER_APP_JS).toContain(m);
    }
    // Delivery shows the cash-fee notice, never collects the fee online.
    expect(COMMANDER_APP_JS).toContain("espèces au livreur");
  });

  it("submits ids/qty/selections only — never a price — and posts to /api/order", () => {
    expect(COMMANDER_APP_JS).toContain("/api/order");
    expect(COMMANDER_APP_JS).toContain("item_id:id,qty:d.qty");
    // No client-set price anywhere in the payload.
    expect(COMMANDER_APP_JS).not.toContain("unitPriceXof");
    expect(COMMANDER_APP_JS).not.toMatch(/price:\s*it\.price/);
    // Idempotency key travels with the order.
    expect(COMMANDER_APP_JS).toContain("client_request_id");
  });

  it("boots via fetch (CSP-safe), not an inline boot script", () => {
    const html = commanderPage();
    expect(html).toContain("/commander/app.js");
    expect(html).not.toContain("window.__BOOT__");
    expect(COMMANDER_APP_JS).toContain("/menu.json");
  });

  it("has static thank-you and error return pages", () => {
    expect(commandeMerciPage()).toContain("Paiement reçu");
    expect(commandeErreurPage()).toContain("Paiement non abouti");
    expect(commandeMerciPage()).not.toContain("<script src");
  });
});

describe("computeBarOpen (bar hours + delivery cutoff)", () => {
  // Mon 09:00 shift 08:00–18:00 (weekday 0 = Monday).
  const monShift = [{ weekday: 0, start_min: 480, end_min: 1080 }];

  it("open during a bar shift; delivery open before the cutoff", () => {
    const r = computeBarOpen(monShift, { weekday: 0, minute: 600 }, 1080); // 10:00
    expect(r.open).toBe(true);
    expect(r.deliveryOpen).toBe(true);
  });

  it("open but delivery closed once the cutoff passes", () => {
    // Extend the shift to 20:00 so the bar is open at 18:30 but delivery is not.
    const late = [{ weekday: 0, start_min: 480, end_min: 1200 }];
    const r = computeBarOpen(late, { weekday: 0, minute: 1110 }, 1080); // 18:30, cutoff 18:00
    expect(r.open).toBe(true);
    expect(r.deliveryOpen).toBe(false);
  });

  it("closed outside any shift, with a next-reopening label", () => {
    const r = computeBarOpen(monShift, { weekday: 0, minute: 60 }, 1080); // 01:00 Monday
    expect(r.open).toBe(false);
    expect(r.deliveryOpen).toBe(false);
    expect(r.reopensLabel).toContain("8h00");
  });

  it("closed with no reopening when there are no bar shifts at all", () => {
    const r = computeBarOpen([], { weekday: 2, minute: 600 }, 1080);
    expect(r.open).toBe(false);
    expect(r.reopensLabel).toBeNull();
  });

  it("finds the next shift across the Sunday→Monday week wrap (Monday = 'demain')", () => {
    // Only a Monday shift; now is Sunday 12:00 (weekday 6) → next open is tomorrow.
    const r = computeBarOpen(monShift, { weekday: 6, minute: 720 }, 1080);
    expect(r.open).toBe(false);
    expect(r.reopensLabel).toBe("demain à 8h00");
  });
});

describe("allowPublicOrder rate limit", () => {
  it("allows a burst then blocks the same key, independently per key", () => {
    const key = `test-${Math.random()}`;
    let allowed = 0;
    for (let i = 0; i < 7; i++) if (allowPublicOrder(key)) allowed++;
    expect(allowed).toBe(5); // ORDER_MAX
    // A different key is unaffected.
    expect(allowPublicOrder(`other-${Math.random()}`)).toBe(true);
  });
});

describe("pickerMenu (shared order-picker menu)", () => {
  it("exposes fav + full optionGroups (not just the first group)", () => {
    const rows: CafeMenuRow[] = [
      {
        id: "BRUNCH",
        name: "Brunch Mykonos",
        priceXof: 6000,
        category: "Brunch",
        favourite: true,
        enabled: true,
        sortOrder: 1,
        optionGroups: [
          { label: "Boisson", choices: ["Jus", "Café"] },
          { label: "Pain", choices: ["Blanc", "Complet"] },
        ],
      },
    ];
    setCafeMenu(rows);
    const menu = pickerMenu();
    const item = menu.flatMap((c) => c.items).find((i) => i.id === "BRUNCH")!;
    expect(item.fav).toBe(true);
    expect(item.price).toBe(6000);
    expect(item.optionGroups).toHaveLength(2);
    // Back-compat single-choice fields still present for the service composer.
    expect(item.optionLabel).toBe("Boisson");
    expect(item.choices).toEqual(["Jus", "Café"]);
  });
});
