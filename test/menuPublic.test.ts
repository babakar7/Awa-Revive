import { afterEach, describe, expect, it, vi } from "vitest";
import { buildServer } from "../src/server.js";
import { pool } from "../src/db/index.js";
import { groupPublicMenu, renderPublicMenuPage } from "../src/menuPublic.js";
import type { PublicMenuItem } from "../src/domain/cafeMenuRepo.js";

afterEach(() => vi.restoreAllMocks());

function item(over: Partial<PublicMenuItem> = {}): PublicMenuItem {
  return {
    id: "CAFE_LATTE",
    name: "Café latte",
    price_xof: 3500,
    category: "Cafés",
    description: null,
    option_label: null,
    option_choices: null,
    favourite: false,
    sort_order: 10,
    ...over,
  };
}

describe("groupPublicMenu", () => {
  it("groups items following the curated category order", () => {
    const items = [
      item({ id: "A", category: "Jus" }),
      item({ id: "B", category: "Cafés" }),
      item({ id: "C", category: "Jus" }),
    ];
    const groups = groupPublicMenu(items, ["Cafés", "Jus"]);
    expect(groups.map((g) => g.category)).toEqual(["Cafés", "Jus"]);
    expect(groups[1].items.map((i) => i.id)).toEqual(["A", "C"]);
  });

  it("hides categories with no items", () => {
    const groups = groupPublicMenu([item({ category: "Jus" })], ["Cafés", "Jus", "Snacks"]);
    expect(groups.map((g) => g.category)).toEqual(["Jus"]);
  });

  it("puts items with an unknown category last, in first-appearance order", () => {
    const items = [
      item({ id: "A", category: "Mystère" }),
      item({ id: "B", category: "Cafés" }),
      item({ id: "C", category: "Mystère" }),
    ];
    const groups = groupPublicMenu(items, ["Cafés"]);
    expect(groups.map((g) => g.category)).toEqual(["Cafés", "Mystère"]);
    expect(groups[1].items.map((i) => i.id)).toEqual(["A", "C"]);
  });
});

describe("renderPublicMenuPage", () => {
  it("renders name, formatted price, description and parsed options", () => {
    const html = renderPublicMenuPage(
      groupPublicMenu(
        [
          item({
            description: "Un classique onctueux",
            option_label: "Lait",
            option_choices: "Entier | Avoine",
          }),
        ],
        ["Cafés"],
      ),
    );
    expect(html).toContain("Café latte");
    expect(html).toContain("3 500 F");
    expect(html).toContain("Un classique onctueux");
    expect(html).toContain("Lait : Entier · Avoine");
  });

  it("shows the ★ Incontournable badge only for favourites", () => {
    const fav = renderPublicMenuPage(groupPublicMenu([item({ favourite: true })], ["Cafés"]));
    const plain = renderPublicMenuPage(groupPublicMenu([item()], ["Cafés"]));
    expect(fav).toContain("Incontournable");
    expect(plain).not.toContain("Incontournable");
  });

  it("escapes HTML coming from the database", () => {
    const html = renderPublicMenuPage(
      groupPublicMenu([item({ name: `<script>alert("x")</script>` })], ["Cafés"]),
    );
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("is indexable, with canonical + og tags pointing at menu.revive.sn", () => {
    const html = renderPublicMenuPage(groupPublicMenu([item()], ["Cafés"]));
    expect(html).toContain(`<link rel="canonical" href="https://menu.revive.sn/">`);
    expect(html).toContain(`og:url" content="https://menu.revive.sn/"`);
    expect(html).not.toContain("noindex");
  });

  it("renders a friendly message when the menu is empty", () => {
    const html = renderPublicMenuPage([]);
    expect(html).toContain("Le menu arrive bientôt");
  });

  it("stays script-free with a labelled nav, favicon, og:image and one floating CTA", () => {
    const html = renderPublicMenuPage(groupPublicMenu([item()], ["Cafés"]));
    expect(html).not.toContain("<script");
    expect(html).toContain(`aria-label="Catégories"`);
    expect(html).toContain(`rel="icon" href="data:image/svg+xml`);
    expect(html).toContain(`property="og:image"`);
    expect(html).toContain(`content="only light"`);
    expect(html.match(/wa-float/g)).toHaveLength(2); // 1 CSS rule + 1 anchor
  });
});

/** Mock the two public-page queries (items + categories); any other query
 *  (healthz…) resolves empty. */
function mockMenuDb(rows: Array<Record<string, unknown>>, categories: string[]) {
  vi.spyOn(pool, "query").mockImplementation(((sql: unknown) => {
    const text = typeof sql === "string" ? sql : String((sql as { text?: string })?.text ?? "");
    if (text.includes("cafe_menu_items")) return Promise.resolve({ rows });
    if (text.includes("menu_categories")) {
      return Promise.resolve({ rows: categories.map((name) => ({ name })) });
    }
    return Promise.resolve({ rows: [] });
  }) as never);
}

describe("public menu routes", () => {
  it("serves the menu on / for menu.revive.sn, with public caching", async () => {
    mockMenuDb([item()], ["Cafés"]);
    const app = buildServer();
    const res = await app.inject({
      method: "GET",
      url: "/",
      headers: { host: "menu.revive.sn" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/html/);
    expect(res.headers["cache-control"]).toContain("public");
    expect(res.body).toContain("Café latte");
    await app.close();
  });

  it("keeps redirecting / to /admin on any other host", async () => {
    const app = buildServer();
    for (const host of ["awa.revive.sn", "localhost"]) {
      const res = await app.inject({ method: "GET", url: "/", headers: { host } });
      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toBe("/admin");
    }
    await app.close();
  });

  it("serves /menu on every host", async () => {
    mockMenuDb([item()], ["Cafés"]);
    const app = buildServer();
    for (const host of ["awa.revive.sn", "menu.revive.sn", "localhost"]) {
      const res = await app.inject({ method: "GET", url: "/menu", headers: { host } });
      expect(res.statusCode).toBe(200);
      expect(res.body).toContain("Café latte");
    }
    await app.close();
  });

  it("keeps the strict CSP with only the data: image relaxation", async () => {
    mockMenuDb([item()], ["Cafés"]);
    const app = buildServer();
    const res = await app.inject({ method: "GET", url: "/menu" });
    expect(res.headers["content-security-policy"]).toContain("default-src 'none'");
    expect(res.headers["content-security-policy"]).toContain("img-src data:");
    await app.close();
  });

  it("serves the og:image as a cacheable PNG", async () => {
    const app = buildServer();
    const res = await app.inject({ method: "GET", url: "/menu/og.png" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toMatch(/image\/png/);
    expect(res.headers["cache-control"]).toContain("public");
    expect(res.rawPayload.subarray(0, 4)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    await app.close();
  });

  it("never leaks recipe fields, even if a query returned them", async () => {
    mockMenuDb(
      [{ ...item(), recipe_ingredients: "SECRET_RECIPE_MARKER", recipe_steps: "SECRET_RECIPE_MARKER" }],
      ["Cafés"],
    );
    const app = buildServer();
    const res = await app.inject({ method: "GET", url: "/menu" });
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain("SECRET_RECIPE_MARKER");
    await app.close();
  });
});
