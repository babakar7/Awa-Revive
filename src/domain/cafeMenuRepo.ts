import fs from "node:fs";
import path from "node:path";
import { pool } from "../db/index.js";
import {
  type CafeMenuRow,
  FAVOURITE_SEED_IDS,
  parseCafeMenu,
  parseOptionChoices,
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
  no_recipe_needed: boolean;
  option_label: string | null;
  option_choices: string | null;
  favourite: boolean;
  enabled: boolean;
  sort_order: number;
  updated_at: Date;
}

function rowToSnapshot(r: MenuItemView): CafeMenuRow {
  const optionChoices = parseOptionChoices(r.option_choices);
  return {
    id: r.id,
    name: r.name,
    priceXof: r.price_xof,
    category: r.category,
    description: r.description ?? undefined,
    optionLabel: r.option_label?.trim() || undefined,
    optionChoices: optionChoices.length ? optionChoices : undefined,
    favourite: r.favourite,
    enabled: r.enabled,
    sortOrder: r.sort_order,
  };
}

const ITEM_COLUMNS = `id, name, price_xof, category, description, recipe_ingredients, recipe_steps,
            no_recipe_needed, option_label, option_choices, favourite, enabled, sort_order, updated_at`;

export async function listMenuItems(): Promise<MenuItemView[]> {
  const res = await pool.query(
    `select ${ITEM_COLUMNS} from cafe_menu_items order by sort_order, name`,
  );
  return res.rows as MenuItemView[];
}

/** Public menu page (menu.revive.sn): enabled items only, and ONLY the
 *  client-facing columns — recipe fields must never reach the public module. */
export interface PublicMenuItem {
  id: string;
  name: string;
  price_xof: number;
  category: string;
  description: string | null;
  option_label: string | null;
  option_choices: string | null;
  favourite: boolean;
  sort_order: number;
}

export async function listPublicMenuItems(): Promise<PublicMenuItem[]> {
  const res = await pool.query(
    `select id, name, price_xof, category, description, option_label, option_choices, favourite, sort_order
       from cafe_menu_items where enabled order by sort_order, name`,
  );
  return res.rows as PublicMenuItem[];
}

export async function getMenuItem(id: string): Promise<MenuItemView | null> {
  const res = await pool.query(
    `select ${ITEM_COLUMNS} from cafe_menu_items where id = $1`,
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
  no_recipe_needed: boolean;
  option_label: string | null;
  option_choices: string | null;
  favourite: boolean;
}

const MAX_NAME = 80;
const MAX_CATEGORY = 40;
const MAX_DESC = 200;
const MAX_RECIPE_FIELD = 5_000;
const MAX_OPTION_LABEL = 40;
const MAX_OPTION_CHOICES = 200;

export function isRecipeComplete(
  item: Pick<MenuItemView, "recipe_ingredients" | "recipe_steps" | "no_recipe_needed">,
): boolean {
  if (item.no_recipe_needed) return true;
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

  const optionLabel = String(body.option_label ?? "").trim();
  if (optionLabel.length > MAX_OPTION_LABEL)
    return { error: `libellé du choix trop long (max ${MAX_OPTION_LABEL}).` };
  // Normalize the pipe-separated list (trim, drop empties) so what's stored is
  // exactly what the order form and validation compare against.
  const optionChoices = parseOptionChoices(body.option_choices).join(" | ");
  if (optionChoices.length > MAX_OPTION_CHOICES)
    return { error: `liste des options trop longue (max ${MAX_OPTION_CHOICES}).` };
  if (optionChoices && !optionLabel)
    return { error: "indique un libellé de choix (ex. « Boisson ») pour les options." };

  return {
    name,
    price_xof,
    category,
    description: desc || null,
    recipe_ingredients: recipeIngredients || null,
    recipe_steps: recipeSteps || null,
    no_recipe_needed:
      body.no_recipe_needed === "on" || body.no_recipe_needed === "true" || body.no_recipe_needed === "1",
    option_label: optionChoices ? optionLabel : null,
    option_choices: optionChoices || null,
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
       (id, name, price_xof, category, description, recipe_ingredients, recipe_steps,
        no_recipe_needed, option_label, option_choices, favourite, sort_order)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [
      id,
      input.name,
      input.price_xof,
      input.category,
      input.description,
      input.recipe_ingredients,
      input.recipe_steps,
      input.no_recipe_needed,
      input.option_label,
      input.option_choices,
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
       recipe_ingredients = $6, recipe_steps = $7, no_recipe_needed = $8, option_label = $9,
       option_choices = $10, favourite = $11, updated_at = now()
     where id = $1`,
    [
      id,
      input.name,
      input.price_xof,
      input.category,
      input.description,
      input.recipe_ingredients,
      input.recipe_steps,
      input.no_recipe_needed,
      input.option_label,
      input.option_choices,
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

// ---------- managed categories (table menu_categories) ----------

/** Trim + collapse internal whitespace so "  Iced   Matcha " → "Iced Matcha". */
export function normalizeCategoryName(raw: string): string {
  return String(raw ?? "").trim().replace(/\s+/g, " ");
}

/** Pure: validate a category name from the admin form. */
export function validateCategoryName(raw: string): { name: string } | { error: string } {
  const name = normalizeCategoryName(raw);
  if (!name) return { error: "le nom de la catégorie est requis." };
  if (name.length > MAX_CATEGORY) return { error: `nom trop long (max ${MAX_CATEGORY}).` };
  return { name };
}

export interface CategoryView {
  name: string;
  itemCount: number; // articles (actifs ou retirés) qui utilisent la catégorie
}

/** Managed categories with how many items use each (for the manager page). */
export async function listCategories(): Promise<CategoryView[]> {
  const res = await pool.query(
    `select c.name, count(i.id)::int as item_count
       from menu_categories c
       left join cafe_menu_items i on i.category = c.name
      group by c.name, c.sort_order
      order by c.sort_order, c.name`,
  );
  return res.rows.map((r) => ({ name: r.name as string, itemCount: Number(r.item_count) }));
}

/** Just the ordered names — for the item-form dropdown. */
export async function categoryNames(): Promise<string[]> {
  const res = await pool.query(`select name from menu_categories order by sort_order, name`);
  return res.rows.map((r) => r.name as string);
}

/** Add a category. Case-insensitive unique; error if it already exists. */
export async function createCategory(raw: string): Promise<{ error?: string }> {
  const v = validateCategoryName(raw);
  if ("error" in v) return v;
  const ord = await pool.query(`select coalesce(max(sort_order), 0) + 10 as n from menu_categories`);
  const res = await pool.query(
    `insert into menu_categories (name, sort_order) values ($1, $2)
       on conflict (lower(name)) do nothing`,
    [v.name, Number(ord.rows[0]?.n ?? 10)],
  );
  if ((res.rowCount ?? 0) === 0) return { error: `la catégorie « ${v.name} » existe déjà.` };
  return {};
}

/**
 * Rename a category and cascade the new name onto every item using it (one
 * transaction). Rejects if the target name already exists (no silent merge).
 */
export async function renameCategory(oldName: string, rawNew: string): Promise<{ error?: string }> {
  const v = validateCategoryName(rawNew);
  if ("error" in v) return v;
  if (normalizeCategoryName(oldName) === v.name) return {}; // no-op
  const client = await pool.connect();
  try {
    await client.query("begin");
    const exists = await client.query(
      `select 1 from menu_categories where lower(name) = lower($1) and lower(name) <> lower($2)`,
      [v.name, oldName],
    );
    if ((exists.rowCount ?? 0) > 0) {
      await client.query("rollback");
      return { error: `la catégorie « ${v.name} » existe déjà.` };
    }
    const upd = await client.query(`update menu_categories set name = $2 where name = $1`, [oldName, v.name]);
    if ((upd.rowCount ?? 0) === 0) {
      await client.query("rollback");
      return { error: "catégorie introuvable." };
    }
    await client.query(`update cafe_menu_items set category = $2, updated_at = now() where category = $1`, [oldName, v.name]);
    await client.query("commit");
    return {};
  } catch (err) {
    await client.query("rollback").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** Delete a category — only when no item still uses it. */
export async function deleteCategory(name: string): Promise<{ error?: string }> {
  const n = normalizeCategoryName(name);
  const used = await pool.query(`select count(*)::int as c from cafe_menu_items where category = $1`, [n]);
  if (Number(used.rows[0]?.c ?? 0) > 0)
    return { error: `« ${n} » est utilisée par des articles — déplacez-les d'abord.` };
  await pool.query(`delete from menu_categories where name = $1`, [n]);
  return {};
}
