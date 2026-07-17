import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
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

/**
 * Bar menu DB source-of-truth against a real Postgres. Seed from cafe-menu.md,
 * idempotence, and the CRUD → refreshCafeMenu → in-memory snapshot path that the
 * agent prompt / delivery form read.
 */

beforeAll(async () => {
  await migrate();
});

afterAll(async () => {
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
      favourite: false,
    });
    expect(id).toBe("THE_GLACE_MAISON");
    await refreshCafeMenu();
    expect(getCafeMenu().items.get(id)?.priceXof).toBe(2000);
  });

  it("updates a price live and archives without deleting", async () => {
    await updateMenuItem("SMOOTHIE_JANT_BI", {
      name: "Jant Bi",
      price_xof: 3500,
      category: "SMOOTHIES",
      description: "papaye, ananas & orange",
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
