import { describe, expect, it } from "vitest";
import {
  CAFE_MENU,
  computeExtras,
  extrasFromJson,
  formatExtrasMultiline,
  formatExtrasOneLine,
  parseCafeMenu,
} from "../src/lib/cafeMenu.js";

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

describe("real cafe-menu.md", () => {
  it("loads with a sane item count and known ids", () => {
    expect(CAFE_MENU.items.size).toBeGreaterThanOrEqual(30);
    expect(CAFE_MENU.items.get("SMOOTHIE_JANT_BI")!.priceXof).toBe(3000);
    expect(CAFE_MENU.items.get("BRUNCH_MYKONOS")!.priceXof).toBe(7500);
    expect(CAFE_MENU.items.get("SHOT_BOOST_ENERGY")!.priceXof).toBe(1000);
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
