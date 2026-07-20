import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../../src/server.js";
import { pool, migrate } from "../../src/db/index.js";
import {
  createMenuItem,
  initCafeMenu,
  listMenuItems,
  refreshCafeMenu,
  seedMenuIfEmpty,
  setMenuItemEnabled,
  updateMenuItem,
} from "../../src/domain/cafeMenuRepo.js";
import { getCafeMenu } from "../../src/lib/cafeMenu.js";

const AUTH = `Basic ${Buffer.from("revive:revive@5000").toString("base64")}`;
let app: FastifyInstance;

/**
 * Bar menu DB source-of-truth against a real Postgres. Seed from cafe-menu.md,
 * idempotence, and the CRUD → refreshCafeMenu → in-memory snapshot path that the
 * agent prompt / delivery form read.
 */

beforeAll(async () => {
  await migrate();
  app = buildServer();
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await pool.end();
});

beforeEach(async () => {
  await pool.query("delete from cafe_menu_items");
});

describe("seed + snapshot", () => {
  it("seeds from cafe-menu.md when empty, idempotently", async () => {
    const n = await seedMenuIfEmpty();
    expect(n).toBeGreaterThanOrEqual(30);
    const again = await seedMenuIfEmpty(); // table now non-empty → no-op
    expect(again).toBe(0);

    const items = await listMenuItems();
    expect(items.find((i) => i.id === "SMOOTHIE_JANT_BI")?.price_xof).toBe(3000);
    expect(items.filter((i) => i.favourite).length).toBe(9);
  });

  it("initCafeMenu pushes the enabled rows into the live snapshot", async () => {
    await initCafeMenu();
    expect(getCafeMenu().items.get("SMOOTHIE_JANT_BI")?.priceXof).toBe(3000);
  });
});

describe("CRUD → refresh → snapshot", () => {
  beforeEach(async () => {
    await initCafeMenu();
  });

  it("creates an item with an auto slug id and reflects it after refresh", async () => {
    const { id } = await createMenuItem({
      name: "Thé Glacé Maison",
      price_xof: 2000,
      category: "FRAÎCHEUR",
      description: "citron & menthe",
      recipe_ingredients: "Thé vert\nCitron\nMenthe",
      recipe_steps: "Infuser, refroidir puis servir sur glace.",
      favourite: false,
    });
    expect(id).toBe("THE_GLACE_MAISON");
    const stored = (await listMenuItems()).find((row) => row.id === id);
    expect(stored?.recipe_ingredients).toContain("Thé vert");
    expect(stored?.recipe_steps).toContain("Infuser");
    await refreshCafeMenu();
    expect(getCafeMenu().items.get(id)?.priceXof).toBe(2000);
    expect(getCafeMenu().promptText).not.toContain("Infuser, refroidir");
    expect(getCafeMenu().items.get(id)).not.toHaveProperty("recipe_steps");
  });

  it("updates a price live and archives without deleting", async () => {
    await updateMenuItem("SMOOTHIE_JANT_BI", {
      name: "Jant Bi",
      price_xof: 3500,
      category: "SMOOTHIES",
      description: "papaye, ananas & orange",
      recipe_ingredients: "Papaye 120 g\nAnanas 80 g",
      recipe_steps: "Mixer puis servir.",
      favourite: true,
    });
    await refreshCafeMenu();
    expect(getCafeMenu().items.get("SMOOTHIE_JANT_BI")?.priceXof).toBe(3500);

    await setMenuItemEnabled("SMOOTHIE_JANT_BI", false);
    await refreshCafeMenu();
    expect(getCafeMenu().items.has("SMOOTHIE_JANT_BI")).toBe(false); // hidden from Awa
    const rows = await listMenuItems();
    expect(rows.find((r) => r.id === "SMOOTHIE_JANT_BI")?.enabled).toBe(false); // still on file (id never reused)

    await setMenuItemEnabled("SMOOTHIE_JANT_BI", true);
    await refreshCafeMenu();
    expect(getCafeMenu().items.has("SMOOTHIE_JANT_BI")).toBe(true); // restored
  });
});

describe("admin recipe workflow", () => {
  beforeEach(async () => {
    await initCafeMenu();
  });

  const post = (url: string, fields: Record<string, string>) =>
    app.inject({
      method: "POST",
      url,
      headers: { authorization: AUTH, "content-type": "application/x-www-form-urlencoded" },
      payload: new URLSearchParams(fields).toString(),
    });

  it("creates an item, opens its dedicated recipe page and keeps recipes internal", async () => {
    const created = await post("/admin/menu/items", {
      name: "Limonade Maison",
      price_xof: "2000",
      category: "FRAÎCHEUR",
      description: "Citron frais",
      recipe_ingredients: "2 citrons\n20 g sucre",
      recipe_steps: "Presser puis allonger avec de l’eau.",
    });
    expect(created.statusCode).toBe(303);
    expect(created.headers.location).toBe("/admin/menu/items/LIMONADE_MAISON?done=created");

    const detail = await app.inject({
      method: "GET",
      url: created.headers.location!,
      headers: { authorization: AUTH },
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.body).toContain("2 citrons");
    expect(detail.body).toContain("Presser puis allonger");

    await refreshCafeMenu();
    expect(getCafeMenu().promptText).not.toContain("2 citrons");
    expect(getCafeMenu().promptText).not.toContain("Presser puis allonger");
  });

  it("supports recipe filters and redirects the legacy inline edit URL", async () => {
    const missing = await app.inject({
      method: "GET",
      url: "/admin/menu?recipe=missing",
      headers: { authorization: AUTH },
    });
    expect(missing.statusCode).toBe(200);
    expect(missing.body).toContain("Recette à compléter");

    const legacy = await app.inject({
      method: "GET",
      url: "/admin/menu?edit=SMOOTHIE_JANT_BI",
      headers: { authorization: AUTH },
    });
    expect(legacy.statusCode).toBe(303);
    expect(legacy.headers.location).toBe("/admin/menu/items/SMOOTHIE_JANT_BI");
  });
});
