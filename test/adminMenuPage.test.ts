import { describe, expect, it } from "vitest";
import type { MenuItemView } from "../src/domain/cafeMenuRepo.js";
import {
  filterMenuItems,
  menuCategories,
  renderCategoriesPage,
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
    no_recipe_needed: false,
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
    expect(html).toContain('name="no_recipe_needed"');
    expect(html).not.toContain('name="no_recipe_needed" checked');
    expect(html).toContain("Nouvel article");
  });

  it("category is a pure dropdown of managed categories (no free-text/datalist)", () => {
    const html = renderMenuItemForm({
      item: item({ category: "BOISSONS CHAUDES" }),
      categories: ["SMOOTHIES", "BOISSONS CHAUDES"],
      banner: "",
    });
    expect(html).toContain('<select name="category" required>');
    expect(html).toContain('<option value="BOISSONS CHAUDES" selected>');
    expect(html).not.toContain("<datalist");
    expect(html).not.toContain('list="menu-categories"');
    // no free-text category input any more
    expect(html).not.toContain('<input name="category"');
    // link to the manager
    expect(html).toContain('href="/admin/menu/categories"');
  });

  it("keeps the item's current category selectable even if not in the managed list", () => {
    const html = renderMenuItemForm({
      item: item({ category: "ORPHELINE" }),
      categories: ["SMOOTHIES"],
      banner: "",
    });
    expect(html).toContain('<option value="ORPHELINE" selected>');
  });

  it("no_recipe_needed items get the neutral badge and leave the à-compléter count", () => {
    const items = [
      item(),
      item({
        id: "SUPP_SMOOTHIE_WHEY",
        name: "Supplément protéine whey",
        category: "SMOOTHIES",
        recipe_ingredients: null,
        recipe_steps: null,
        no_recipe_needed: true,
        favourite: false,
        sort_order: 20,
      }),
    ];
    const html = renderMenuPage({ items, filters: {}, banner: "" });
    expect(html).toContain("Sans recette");
    expect(html).not.toContain("Recette à compléter");
    expect(html).toContain("0</b><span>sans impact sur la vente");
    // le filtre « À compléter » ne le liste plus
    expect(filterMenuItems(items, { recipe: "missing" })).toHaveLength(0);
  });

  it("the flag wins over a filled recipe and pre-checks the editor checkbox", () => {
    const flagged = item({ no_recipe_needed: true });
    const html = renderMenuItemForm({ item: flagged, categories: ["SMOOTHIES"], banner: "" });
    expect(html).toContain("Sans recette");
    expect(html).not.toContain("Recette complète");
    expect(html).toContain('name="no_recipe_needed" checked');
  });
});

describe("menu catalogue UX (category tabs + live search + clickable rows)", () => {
  it("renders a jump-nav pill with an anchor and count per visible category", () => {
    const html = renderMenuPage({ items: ITEMS, filters: {}, banner: "" });
    expect(html).toContain('id="menu-jumpnav"');
    expect(html).toContain('href="#cat-smoothies"');
    expect(html).toContain('href="#cat-boissons-chaudes"');
    expect(html).toContain('id="cat-smoothies"'); // the section anchor itself
    // Retired-only category is invisible in the default (active) view.
    expect(html).not.toContain('href="#cat-jus"');
  });

  it("opens on the first category as an active tab, the rest hidden (server default)", () => {
    const html = renderMenuPage({ items: ITEMS, filters: {}, banner: "" });
    // First category = SMOOTHIES: its pill is active, its section is not hidden.
    expect(html).toContain('class="menu-tab active" href="#cat-smoothies"');
    expect(html).toContain('<div data-cat-section="smoothies">');
    // Second category is present but hidden until its tab is chosen.
    expect(html).toContain('<div data-cat-section="boissons-chaudes" hidden>');
    // Only the first pill is active.
    expect(html).not.toContain('class="menu-tab active" href="#cat-boissons-chaudes"');
    // Count starts on the first category (1 smoothie), not the whole menu.
    expect(html).toContain('id="menu-live-count">1 article<');
  });

  it("keeps a no-JS fallback that reveals every category", () => {
    const html = renderMenuPage({ items: ITEMS, filters: {}, banner: "" });
    expect(html).toContain("<noscript>");
    expect(html).toContain("[data-cat-section][hidden]{display:block!important}");
  });

  it("ships the tab-switch logic in the page script", () => {
    const html = renderMenuPage({ items: ITEMS, filters: {}, banner: "" });
    expect(html).toContain("function showCategory");
    expect(html).toContain("function runSearch"); // search overrides the active tab
    // Clicking a tab clears the search box before switching.
    expect(html).toContain("input.value=''");
  });

  it("rows are clickable and carry a normalized search haystack", () => {
    const html = renderMenuPage({ items: ITEMS, filters: {}, banner: "" });
    expect(html).toContain('data-href="/admin/menu/items/CAFE_TOUBA"');
    // normalized(): lowercase + accents stripped → « Café Touba » searchable as "cafe touba"
    expect(html).toContain('data-search="cafe touba boissons chaudes cafe_touba"');
  });

  it("shows the Retiré badge on rows only in retired/all views", () => {
    const activeView = renderMenuPage({ items: ITEMS, filters: {}, banner: "" });
    expect(activeView).not.toContain(">Retiré</span>");
    const retiredView = renderMenuPage({ items: ITEMS, filters: { status: "retired" }, banner: "" });
    expect(retiredView).toContain(">Retiré</span>");
    expect(retiredView).toContain('data-href="/admin/menu/items/ANCIEN_JUS"');
  });

  it("ships the live-search plumbing: input id, count, hidden empty state, page script", () => {
    const html = renderMenuPage({ items: ITEMS, filters: {}, banner: "" });
    expect(html).toContain('id="menu-live-search"');
    expect(html).toContain('id="menu-live-count"');
    expect(html).toContain('id="menu-live-empty" hidden');
    expect(html).toContain("addEventListener('input'");
    // No more full-page-reload button; selects submit themselves.
    expect(html).not.toContain(">Filtrer</button>");
    expect(html).toContain('onchange="this.form.submit()"');
  });

  it("links to the category manager from the menu header", () => {
    const html = renderMenuPage({ items: ITEMS, filters: {}, banner: "" });
    expect(html).toContain('href="/admin/menu/categories"');
  });
});

describe("category manager page", () => {
  it("lists categories with item counts and an add form", () => {
    const html = renderCategoriesPage({
      categories: [
        { name: "SMOOTHIES", itemCount: 7 },
        { name: "SHOTS", itemCount: 0 },
      ],
      banner: "",
    });
    expect(html).toContain("Catégories du menu");
    expect(html).toContain("SMOOTHIES");
    expect(html).toContain('action="/admin/menu/categories"'); // add form
    expect(html).toContain('action="/admin/menu/categories/rename"');
  });

  it("disables delete for a category still in use, allows it when empty", () => {
    const html = renderCategoriesPage({
      categories: [
        { name: "SMOOTHIES", itemCount: 7 }, // used
        { name: "SHOTS", itemCount: 0 }, // empty
      ],
      banner: "",
    });
    // The empty one gets a delete form; the used one shows "Utilisée" instead.
    expect(html).toContain('action="/admin/menu/categories/delete"');
    expect(html).toContain("Utilisée");
    // Exactly one delete form (only the empty category).
    expect(html.match(/action="\/admin\/menu\/categories\/delete"/g)).toHaveLength(1);
  });
});
