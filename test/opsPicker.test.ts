import { describe, expect, it, beforeAll } from "vitest";
import { OPS_PICKER_HELPERS } from "../src/ops/opsPicker.js";

/**
 * The shared findability logic (best-seller "Populaires" resolution + within-
 * category sort) is inlined into all three pickers, so it's tested once here by
 * evaluating the snippet against a fake `window`.
 */
describe("opsPicker shared helpers", () => {
  let pick: any;
  beforeAll(() => {
    const win: any = {};
    new Function("window", OPS_PICKER_HELPERS)(win);
    pick = win.__pick;
  });

  const menu = [
    { category: "ICED MATCHA", items: [
      { id: "matcha-van", name: "Iced Matcha Vanille", fav: true },
      { id: "matcha-madd", name: "Iced Matcha Madd", fav: false },
      { id: "matcha-supp", name: "Supplément perles de tapioca", fav: false },
    ] },
    { category: "TOASTS", items: [
      { id: "tuna", name: "Tuna Toast", fav: false },
      { id: "avo", name: "Avocado toast", fav: false },
    ] },
  ];

  it("top() resolves best-seller ids to items, skips unknown + suppléments, caps", () => {
    const top = pick.top(menu, ["avo", "NOPE", "matcha-supp", "matcha-van"], 8);
    expect(top.map((i: any) => i.id)).toEqual(["avo", "matcha-van"]); // NOPE + supp dropped
    expect(pick.top(menu, ["tuna", "avo", "matcha-van"], 2)).toHaveLength(2); // cap honoured
    expect(pick.top(menu, [], 8)).toEqual([]); // no signal → empty (caller omits section)
  });

  it("sortItems() floats favourites up and 'Supplément…' down, stable otherwise", () => {
    const sorted = pick.sortItems(menu[0].items).map((i: any) => i.id);
    expect(sorted).toEqual(["matcha-van", "matcha-madd", "matcha-supp"]);
  });

  it("isSupp() matches accented/case variants of 'supplément'", () => {
    expect(pick.isSupp({ name: "Supplément œufs" })).toBe(true);
    expect(pick.isSupp({ name: "supplement whey" })).toBe(true);
    expect(pick.isSupp({ name: "Salade Light" })).toBe(false);
  });
});
