import { describe, expect, it } from "vitest";
import type { MenuItemView } from "../src/domain/cafeMenuRepo.js";
import {
  filterMenuItems,
  menuCategories,
  renderMenuItemForm,
  renderMenuPage,
} from "../src/admin/menuPage.js";

function item(over: Partial<MenuItemView> = {}): MenuItemView {
  return {
    id: "SMOOTHIE_MANGUE",
    name: "Smoothie Mangue",
    price_xof: 3_000,
    category: "SMOOTHIES",
    description: "Frais et fruité",
    recipe_ingredients: "150 g de mangue",
    recipe_steps: "Mixer 45 secondes",
    favourite: true,
    enabled: true,
    sort_order: 10,
    updated_at: new Date("2026-07-20T10:00:00Z"),
    ...over,
  };
}

const ITEMS = [
  item(),
  item({
    id: "CAFE_TOUBA",
    name: "Café Touba",
    price_xof: 1_500,
    category: "BOISSONS CHAUDES",
    recipe_ingredients: null,
    recipe_steps: null,
    favourite: false,
    sort_order: 20,
  }),
  item({
    id: "ANCIEN_JUS",
    name: "Ancien Jus",
    category: "JUS",
    enabled: false,
    favourite: false,
    sort_order: 30,
  }),
];

describe("menu catalogue filters", () => {
  it("defaults to active items and supports accent-insensitive search", () => {
    expect(filterMenuItems(ITEMS, {})).toHaveLength(2);
    expect(filterMenuItems(ITEMS, { q: "cafe touba" }).map((row) => row.id)).toEqual([
      "CAFE_TOUBA",
    ]);
  });

  it("filters by status, category and recipe completeness", () => {
    expect(filterMenuItems(ITEMS, { status: "retired" }).map((row) => row.id)).toEqual([
      "ANCIEN_JUS",
    ]);
    expect(filterMenuItems(ITEMS, { status: "all", category: "JUS" })).toHaveLength(1);
    expect(filterMenuItems(ITEMS, { recipe: "missing" }).map((row) => row.id)).toEqual([
      "CAFE_TOUBA",
    ]);
    expect(filterMenuItems(ITEMS, { recipe: "complete" }).map((row) => row.id)).toEqual([
      "SMOOTHIE_MANGUE",
    ]);
  });

  it("keeps category order stable", () => {
    expect(menuCategories(ITEMS)).toEqual(["SMOOTHIES", "BOISSONS CHAUDES", "JUS"]);
  });
});

describe("menu admin rendering", () => {
  it("shows recipe completion without leaking recipe contents in the catalogue", () => {
    const html = renderMenuPage({ items: ITEMS, filters: {}, banner: "" });
    expect(html).toContain("Menu et recettes");
    expect(html).toContain("Recette complète");
    expect(html).toContain("Recette à compléter");
    expect(html).toContain("1</b><span>sans impact sur la vente");
    expect(html).not.toContain("150 g de mangue");
    expect(html).not.toContain("Mixer 45 secondes");
  });

  it("renders and escapes the internal recipe editor", () => {
    const html = renderMenuItemForm({
      item: item({
        recipe_ingredients: '<script>alert("ingredient")</script>',
        recipe_steps: "1. Mixer & servir",
      }),
      categories: ["SMOOTHIES"],
      banner: "",
    });
    expect(html).toContain("Fiche recette");
    expect(html).toContain("Interne équipe");
    expect(html).toContain("&lt;script&gt;alert(&quot;ingredient&quot;)&lt;/script&gt;");
    expect(html).toContain("1. Mixer &amp; servir");
    expect(html).not.toContain('<script>alert("ingredient")</script>');
  });

  it("renders a dedicated create form with optional recipe fields", () => {
    const html = renderMenuItemForm({ item: null, categories: ["SMOOTHIES"], banner: "" });
    expect(html).toContain('action="/admin/menu/items"');
    expect(html).toContain('name="recipe_ingredients"');
    expect(html).toContain('name="recipe_steps"');
    expect(html).toContain("Nouvel article");
  });
});
