import fs from "node:fs";
import path from "node:path";
import { pool } from "../db/index.js";
import {
  type CafeMenuRow,
  FAVOURITE_SEED_IDS,
  parseCafeMenu,
  setCafeMenu,
  slugifyMenuId,
} from "../lib/cafeMenu.js";

/**
 * DB source of truth for the bar menu (table cafe_menu_items). Mutations here;
 * after each one the caller runs refreshCafeMenu() to push the new snapshot into
 * lib/cafeMenu (which the agent prompt, tools and admin forms read synchronously).
 * Seeded once from cafe-menu.md when the table is empty. Ids are never reused:
 * "removing" an item = enabled=false.
 */

export interface MenuItemView {
  id: string;
  name: string;
  price_xof: number;
  category: string;
  description: string | null;
  recipe_ingredients: string | null;
  recipe_steps: string | null;
  favourite: boolean;
  enabled: boolean;
  sort_order: number;
  updated_at: Date;
}

function rowToSnapshot(r: MenuItemView): CafeMenuRow {
  return {
    id: r.id,
    name: r.name,
    priceXof: r.price_xof,
    category: r.category,
    description: r.description ?? undefined,
    favourite: r.favourite,
    enabled: r.enabled,
    sortOrder: r.sort_order,
  };
}

export async function listMenuItems(): Promise<MenuItemView[]> {
  const res = await pool.query(
    `select id, name, price_xof, category, description, recipe_ingredients, recipe_steps,
            favourite, enabled, sort_order, updated_at
       from cafe_menu_items order by sort_order, name`,
  );
  return res.rows as MenuItemView[];
}

export async function getMenuItem(id: string): Promise<MenuItemView | null> {
  const res = await pool.query(
    `select id, name, price_xof, category, description, recipe_ingredients, recipe_steps,
            favourite, enabled, sort_order, updated_at
       from cafe_menu_items where id = $1`,
    [id],
  );
  return (res.rows[0] as MenuItemView) ?? null;
}

export interface MenuItemInput {
  name: string;
  price_xof: number;
  category: string;
  description: string | null;
  recipe_ingredients: string | null;
  recipe_steps: string | null;
  favourite: boolean;
}

const MAX_NAME = 80;
const MAX_CATEGORY = 40;
const MAX_DESC = 200;
const MAX_RECIPE_FIELD = 5_000;

export function isRecipeComplete(item: Pick<MenuItemView, "recipe_ingredients" | "recipe_steps">): boolean {
  return Boolean(item.recipe_ingredients?.trim() && item.recipe_steps?.trim());
}

/** Pure: validate/normalize the admin form. */
export function parseMenuItemForm(body: Record<string, string>): MenuItemInput | { error: string } {
  const name = String(body.name ?? "").trim();
  if (!name) return { error: "le nom de l'article est requis." };
  if (name.length > MAX_NAME) return { error: `nom trop long (max ${MAX_NAME}).` };

  const category = String(body.category ?? "").trim();
  if (!category) return { error: "la catégorie est requise." };
  if (category.length > MAX_CATEGORY) return { error: `catégorie trop longue (max ${MAX_CATEGORY}).` };

  const priceRaw = String(body.price_xof ?? "").trim().replace(/\s/g, "");
  const price_xof = Number(priceRaw);
  if (!Number.isInteger(price_xof) || price_xof < 1 || price_xof > 1_000_000)
    return { error: "prix invalide (entier en FCFA, entre 1 et 1 000 000)." };

  const desc = String(body.description ?? "").trim();
  if (desc.length > MAX_DESC) return { error: `description trop longue (max ${MAX_DESC}).` };

  const recipeIngredients = String(body.recipe_ingredients ?? "").trim();
  if (recipeIngredients.length > MAX_RECIPE_FIELD)
    return { error: `ingrédients trop longs (max ${MAX_RECIPE_FIELD} caractères).` };

  const recipeSteps = String(body.recipe_steps ?? "").trim();
  if (recipeSteps.length > MAX_RECIPE_FIELD)
    return { error: `préparation trop longue (max ${MAX_RECIPE_FIELD} caractères).` };

  return {
    name,
    price_xof,
    category,
    description: desc || null,
    recipe_ingredients: recipeIngredients || null,
    recipe_steps: recipeSteps || null,
    favourite: body.favourite === "on" || body.favourite === "true" || body.favourite === "1",
  };
}

async function allIds(): Promise<string[]> {
  const res = await pool.query(`select id from cafe_menu_items`);
  return res.rows.map((r) => r.id as string);
}

export async function createMenuItem(input: MenuItemInput): Promise<{ id: string }> {
  const id = slugifyMenuId(input.name, await allIds());
  const ord = await pool.query(`select coalesce(max(sort_order), 0) + 10 as n from cafe_menu_items`);
  const sortOrder = Number(ord.rows[0]?.n ?? 10);
  await pool.query(
    `insert into cafe_menu_items
       (id, name, price_xof, category, description, recipe_ingredients, recipe_steps, favourite, sort_order)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [
      id,
      input.name,
      input.price_xof,
      input.category,
      input.description,
      input.recipe_ingredients,
      input.recipe_steps,
      input.favourite,
      sortOrder,
    ],
  );
  return { id };
}

export async function updateMenuItem(id: string, input: MenuItemInput): Promise<boolean> {
  const res = await pool.query(
    `update cafe_menu_items set
       name = $2, price_xof = $3, category = $4, description = $5,
       recipe_ingredients = $6, recipe_steps = $7, favourite = $8, updated_at = now()
     where id = $1`,
    [
      id,
      input.name,
      input.price_xof,
      input.category,
      input.description,
      input.recipe_ingredients,
      input.recipe_steps,
      input.favourite,
    ],
  );
  return (res.rowCount ?? 0) > 0;
}

export async function setMenuItemEnabled(id: string, enabled: boolean): Promise<boolean> {
  const res = await pool.query(
    `update cafe_menu_items set enabled = $2, updated_at = now() where id = $1`,
    [id, enabled],
  );
  return (res.rowCount ?? 0) > 0;
}

/**
 * First-boot import from cafe-menu.md when the table is empty. File order →
 * sort_order 10,20,30…; FAVOURITE_SEED_IDS → favourite=true. Missing file +
 * empty table → nothing imported (bar stays disabled, like the old ENOENT
 * behaviour); a corrupt file throws (fails the first boot loudly). Idempotent:
 * on conflict do nothing, and skipped entirely once the table has rows.
 */
export async function seedMenuIfEmpty(): Promise<number> {
  const count = await pool.query(`select count(*)::int as n from cafe_menu_items`);
  if (Number(count.rows[0]?.n ?? 0) > 0) return 0;

  let raw: string;
  try {
    raw = fs.readFileSync(path.resolve(process.cwd(), "cafe-menu.md"), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw err;
  }
  const favourites = new Set(FAVOURITE_SEED_IDS);
  const items = [...parseCafeMenu(raw).items.values()];
  let order = 0;
  let inserted = 0;
  for (const it of items) {
    order += 10;
    const res = await pool.query(
      `insert into cafe_menu_items (id, name, price_xof, category, description, favourite, sort_order)
       values ($1,$2,$3,$4,$5,$6,$7) on conflict (id) do nothing`,
      [it.id, it.name, it.priceXof, it.category, it.description ?? null, favourites.has(it.id), order],
    );
    inserted += res.rowCount ?? 0;
  }
  return inserted;
}

/** Reload the in-memory snapshot from DB (enabled rows drive the live menu). */
export async function refreshCafeMenu(): Promise<void> {
  const rows = await listMenuItems();
  setCafeMenu(rows.map(rowToSnapshot));
}

/** Boot: seed if empty, then load the snapshot. Call after migrate(). */
export async function initCafeMenu(): Promise<void> {
  await seedMenuIfEmpty();
  await refreshCafeMenu();
}
