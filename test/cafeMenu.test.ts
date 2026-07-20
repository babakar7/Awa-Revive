import fs from "node:fs";
import { describe, expect, it } from "vitest";
import {
  buildPromptText,
  type CafeMenuRow,
  cafeFavouriteOptions,
  cafeMenuVersion,
  computeExtras,
  extrasFromJson,
  FAVOURITE_SEED_IDS,
  formatExtrasMultiline,
  formatExtrasOneLine,
  getCafeMenu,
  parseCafeMenu,
  setCafeMenu,
  slugifyMenuId,
} from "../src/lib/cafeMenu.js";
import { isRecipeComplete, parseMenuItemForm } from "../src/domain/cafeMenuRepo.js";
import { systemPrompt } from "../src/agent/systemPrompt.js";

/** The real menu file, parsed as the DB seed would — items are the source. */
const REAL_MENU = parseCafeMenu(fs.readFileSync("cafe-menu.md", "utf8"));

/** Build snapshot rows from a parsed menu (mirrors the seed → DB → snapshot path). */
function rowsFromMenu(menu = REAL_MENU, favIds = new Set(FAVOURITE_SEED_IDS)): CafeMenuRow[] {
  let order = 0;
  return [...menu.items.values()].map((it) => ({
    ...it,
    favourite: favIds.has(it.id),
    enabled: true,
    sortOrder: (order += 10),
  }));
}

const FIXTURE = `# Menu test

<!-- commentaire -->

## SMOOTHIES

Tous les smoothies sont à 3 000 FCFA.

- SMOOTHIE_JANT_BI | Jant Bi | 3000 | papaye, ananas & orange
- SMOOTHIE_COCO | Coco Beach | 3000

## ICED MATCHA

- MATCHA_VANILLE | Iced Matcha Vanille | 3500 | doux et crémeux
- SUPP_TAPIOCA | Supplément perles de tapioca | 500
`;

describe("parseCafeMenu", () => {
  const menu = parseCafeMenu(FIXTURE);

  it("parses items with id, name, price, category and optional description", () => {
    expect(menu.items.size).toBe(4);
    const jantBi = menu.items.get("SMOOTHIE_JANT_BI")!;
    expect(jantBi).toMatchObject({
      name: "Jant Bi",
      priceXof: 3000,
      category: "SMOOTHIES",
      description: "papaye, ananas & orange",
    });
    expect(menu.items.get("SMOOTHIE_COCO")!.description).toBeUndefined();
    expect(menu.items.get("MATCHA_VANILLE")!.category).toBe("ICED MATCHA");
  });

  it("keeps prose lines verbatim and re-renders item lines with ids and prices", () => {
    expect(menu.promptText).toContain("Tous les smoothies sont à 3 000 FCFA.");
    expect(menu.promptText).toContain("- id: SMOOTHIE_JANT_BI — Jant Bi — 3000 FCFA — papaye, ananas & orange");
    expect(menu.promptText).toContain("## ICED MATCHA");
  });

  it("throws on duplicate ids", () => {
    expect(() => parseCafeMenu("- X | A | 100\n- X | B | 200")).toThrow(/duplicate item id "X"/);
  });

  it("throws on a zero price", () => {
    expect(() => parseCafeMenu("- X | A | 0")).toThrow(/invalid price/);
  });

  it("ignores malformed lines instead of mispricing them", () => {
    const m = parseCafeMenu("- pas_un_id | A | 100\n- Y | B | pas_un_prix | desc");
    expect(m.items.size).toBe(0);
  });
});

describe("real cafe-menu.md (the seed source)", () => {
  it("parses with a sane item count and known ids/prices", () => {
    expect(REAL_MENU.items.size).toBeGreaterThanOrEqual(30);
    expect(REAL_MENU.items.get("SMOOTHIE_JANT_BI")!.priceXof).toBe(3000);
    expect(REAL_MENU.items.get("BRUNCH_MYKONOS")!.priceXof).toBe(7500);
    expect(REAL_MENU.items.get("SHOT_BOOST_ENERGY")!.priceXof).toBe(1000);
  });
});

describe("computeExtras", () => {
  const { items } = parseCafeMenu(FIXTURE);

  it("computes the total from server-side prices", () => {
    const r = computeExtras(items, [
      { item_id: "SMOOTHIE_JANT_BI", qty: 2 },
      { item_id: "MATCHA_VANILLE", qty: 1 },
    ]);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.totalXof).toBe(2 * 3000 + 3500);
      expect(r.lines).toHaveLength(2);
      expect(r.lines[0]).toMatchObject({ name: "Jant Bi", qty: 2, lineTotalXof: 6000 });
    }
  });

  it("rejects unknown ids with the list of valid ids (anti-injection)", () => {
    const r = computeExtras(items, [{ item_id: "FREE_STUFF", qty: 1 }]);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toBe("unknown_menu_item");
      expect(r.unknownIds).toEqual(["FREE_STUFF"]);
      expect(r.validIds).toContain("SMOOTHIE_JANT_BI");
    }
  });

  it("rejects invalid quantities instead of clamping", () => {
    for (const qty of [0, 11, 1.5, "2"]) {
      const r = computeExtras(items, [{ item_id: "SMOOTHIE_JANT_BI", qty }]);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toBe("invalid_extras");
    }
  });

  it("rejects non-array, empty and oversized inputs", () => {
    for (const input of ["SMOOTHIE_JANT_BI", [], Array(16).fill({ item_id: "SMOOTHIE_COCO", qty: 1 })]) {
      const r = computeExtras(items, input);
      expect(r.ok).toBe(false);
    }
  });
});

describe("formatters", () => {
  const lines = [
    { id: "A", name: "Jant Bi", qty: 2, unitPriceXof: 3000, lineTotalXof: 6000 },
    { id: "B", name: "Iced Matcha Vanille", qty: 1, unitPriceXof: 3500, lineTotalXof: 3500 },
  ];

  it("multiline: one bullet per line with the line total", () => {
    expect(formatExtrasMultiline(lines)).toBe(
      "• 2× Jant Bi — 6000 FCFA\n• 1× Iced Matcha Vanille — 3500 FCFA",
    );
  });

  it("one-line: qty× name joined with +", () => {
    expect(formatExtrasOneLine(lines)).toBe("2× Jant Bi + 1× Iced Matcha Vanille");
  });

  it("extrasFromJson filters garbage defensively", () => {
    expect(extrasFromJson(null)).toEqual([]);
    expect(extrasFromJson([{ bad: true }, ...lines])).toHaveLength(2);
  });
});

describe("cafeFavouriteOptions (incontournables shown after a booking)", () => {
  setCafeMenu(rowsFromMenu());
  const favs = cafeFavouriteOptions();

  it("comes from the snapshot's favourite rows (9 seed favourites, WhatsApp cap 10)", () => {
    expect(favs).toHaveLength(9);
    expect(favs.length).toBeLessThanOrEqual(10);
  });

  it("each row carries a menu id, a title, a priced description and a section", () => {
    for (const row of favs) {
      expect(getCafeMenu().items.has(row.id)).toBe(true);
      expect(row.title.length).toBeGreaterThan(0);
      expect(row.description).toMatch(/\d+ F/);
      expect(row.description!.length).toBeLessThanOrEqual(72);
      expect(row.section).toBeTruthy();
    }
  });

  it("prices come from the snapshot, not hard-coded", () => {
    const jantBi = favs.find((o) => o.id === "SMOOTHIE_JANT_BI")!;
    expect(jantBi.description).toContain(`${getCafeMenu().items.get("SMOOTHIE_JANT_BI")!.priceXof} F`);
  });

  it("caps at 10 favourites even if more rows are flagged", () => {
    const rows = rowsFromMenu(REAL_MENU, new Set([...REAL_MENU.items.keys()])); // everything favourite
    setCafeMenu(rows);
    expect(cafeFavouriteOptions().length).toBe(10);
    setCafeMenu(rowsFromMenu()); // restore the seed set for other suites
  });
});

describe("setCafeMenu / getCafeMenu snapshot", () => {
  it("only enabled rows reach the live menu, and the version bumps", () => {
    const rows = rowsFromMenu();
    rows[0].enabled = false;
    const before = cafeMenuVersion();
    setCafeMenu(rows);
    expect(cafeMenuVersion()).toBeGreaterThan(before);
    expect(getCafeMenu().items.has(rows[0].id)).toBe(false);
    expect(getCafeMenu().items.has(rows[1].id)).toBe(true);
    setCafeMenu(rowsFromMenu()); // restore
  });
});

describe("buildPromptText", () => {
  const rows: CafeMenuRow[] = [
    { id: "A", name: "Alpha", priceXof: 3000, category: "SMOOTHIES", description: "x", favourite: false, enabled: true, sortOrder: 10 },
    { id: "B", name: "Beta", priceXof: 500, category: "SMOOTHIES", favourite: false, enabled: true, sortOrder: 20 } as CafeMenuRow,
    { id: "C", name: "Gamma", priceXof: 1000, category: "SHOTS", description: undefined, favourite: false, enabled: false, sortOrder: 30 } as CafeMenuRow,
  ];

  it("renders ## categories and id lines, excluding disabled rows", () => {
    const t = buildPromptText(rows);
    expect(t).toContain("## SMOOTHIES");
    expect(t).toContain("- id: A — Alpha — 3000 FCFA — x");
    expect(t).toContain("- id: B — Beta — 500 FCFA");
    expect(t).not.toContain("Gamma"); // disabled
    expect(t).not.toContain("## SHOTS"); // its only item is disabled
  });

  it("returns the disabled text for an empty/all-disabled menu", () => {
    expect(buildPromptText([])).toMatch(/bar ordering is disabled/i);
  });
});

describe("slugifyMenuId", () => {
  it("uppercases, strips accents and non-alphanumerics", () => {
    expect(slugifyMenuId("Thé Glacé Menthe", [])).toBe("THE_GLACE_MENTHE");
    expect(slugifyMenuId("Café + Lait!", [])).toBe("CAFE_LAIT");
  });
  it("suffixes on collision, including against archived ids", () => {
    expect(slugifyMenuId("Matcha", ["MATCHA"])).toBe("MATCHA_2");
    expect(slugifyMenuId("Matcha", ["MATCHA", "MATCHA_2"])).toBe("MATCHA_3");
  });
  it("falls back to ITEM for a name with no usable characters", () => {
    expect(slugifyMenuId("!!!", [])).toBe("ITEM");
  });
});

describe("systemPrompt() — memoized on the menu version (prompt cache)", () => {
  it("returns the SAME string reference between menu edits, and rebuilds after one", () => {
    setCafeMenu(rowsFromMenu());
    const a = systemPrompt();
    const b = systemPrompt();
    expect(a).toBe(b); // same reference → Anthropic prefix cache holds

    const rows = rowsFromMenu();
    rows[0] = { ...rows[0], priceXof: rows[0].priceXof + 111 };
    setCafeMenu(rows);
    const c = systemPrompt();
    expect(c).not.toBe(a);
    expect(c).toContain(`${rows[0].priceXof} FCFA`);
    setCafeMenu(rowsFromMenu()); // restore
  });
});

describe("parseMenuItemForm", () => {
  const base = {
    name: "Jus Vert",
    price_xof: "2500",
    category: "JUS",
    description: "pomme, épinard",
    recipe_ingredients: "  100 g pomme\n50 g épinard  ",
    recipe_steps: "  1. Mixer\n2. Servir  ",
  };
  it("accepts a valid item and reads the favourite checkbox", () => {
    const r = parseMenuItemForm({ ...base, favourite: "on" });
    expect(r).toMatchObject({
      name: "Jus Vert",
      price_xof: 2500,
      category: "JUS",
      favourite: true,
      recipe_ingredients: "100 g pomme\n50 g épinard",
      recipe_steps: "1. Mixer\n2. Servir",
    });
  });
  it("requires name, category and a valid integer price", () => {
    expect("error" in parseMenuItemForm({ ...base, name: "" })).toBe(true);
    expect("error" in parseMenuItemForm({ ...base, category: "" })).toBe(true);
    expect("error" in parseMenuItemForm({ ...base, price_xof: "0" })).toBe(true);
    expect("error" in parseMenuItemForm({ ...base, price_xof: "abc" })).toBe(true);
  });
  it("defaults optional public and recipe fields to null", () => {
    const r = parseMenuItemForm({ ...base, description: "", recipe_ingredients: "", recipe_steps: "" });
    expect(r).toMatchObject({
      favourite: false,
      description: null,
      recipe_ingredients: null,
      recipe_steps: null,
    });
  });
  it("rejects an oversized recipe field", () => {
    expect(parseMenuItemForm({ ...base, recipe_ingredients: "x".repeat(5_001) })).toEqual({
      error: "ingrédients trop longs (max 5000 caractères).",
    });
    expect(parseMenuItemForm({ ...base, recipe_steps: "x".repeat(5_001) })).toEqual({
      error: "préparation trop longue (max 5000 caractères).",
    });
  });
});

describe("internal recipes", () => {
  it("is complete only when ingredients and steps are both present", () => {
    expect(isRecipeComplete({ recipe_ingredients: "Mangue", recipe_steps: "Mixer" })).toBe(true);
    expect(isRecipeComplete({ recipe_ingredients: "Mangue", recipe_steps: null })).toBe(false);
    expect(isRecipeComplete({ recipe_ingredients: " ", recipe_steps: "Mixer" })).toBe(false);
  });

  it("never reaches the Awa snapshot or prompt even if attached to input rows", () => {
    const rows = rowsFromMenu() as Array<CafeMenuRow & {
      recipe_ingredients?: string;
      recipe_steps?: string;
    }>;
    rows[0].recipe_ingredients = "SECRET CUISINE";
    rows[0].recipe_steps = "ÉTAPE INTERNE";
    setCafeMenu(rows);
    expect(getCafeMenu().promptText).not.toContain("SECRET CUISINE");
    expect(getCafeMenu().promptText).not.toContain("ÉTAPE INTERNE");
    expect(getCafeMenu().items.get(rows[0].id)).not.toHaveProperty("recipe_ingredients");
    expect(getCafeMenu().items.get(rows[0].id)).not.toHaveProperty("recipe_steps");
    setCafeMenu(rowsFromMenu());
  });
});
