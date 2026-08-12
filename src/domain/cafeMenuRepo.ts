import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { pool } from "../db/index.js";
import {
  type CafeMenuRow,
  FAVOURITE_SEED_IDS,
  type MenuOptionGroup,
  parseCafeMenu,
  parseOptionChoices,
  parseOptionGroups,
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
  option_groups?: unknown;
  favourite: boolean;
  enabled: boolean;
  sort_order: number;
  photo_version: string | null;
  updated_at: Date;
}

function rowToSnapshot(r: MenuItemView): CafeMenuRow {
  const optionGroups = parseOptionGroups(r.option_groups, r.option_label, r.option_choices);
  const firstGroup = optionGroups[0];
  return {
    id: r.id,
    name: r.name,
    priceXof: r.price_xof,
    category: r.category,
    description: r.description ?? undefined,
    optionLabel: firstGroup?.label,
    optionChoices: firstGroup?.choices,
    optionGroups: optionGroups.length ? optionGroups : undefined,
    favourite: r.favourite,
    enabled: r.enabled,
    sortOrder: r.sort_order,
    photoVersion: r.photo_version ?? undefined,
  };
}

const ITEM_COLUMNS = `i.id, i.name, i.price_xof, i.category, i.description, i.recipe_ingredients, i.recipe_steps,
            i.no_recipe_needed, i.option_label, i.option_choices, i.option_groups, i.favourite, i.enabled,
            i.sort_order, i.updated_at, p.version as photo_version`;

export async function listMenuItems(): Promise<MenuItemView[]> {
  const res = await pool.query(
    `select ${ITEM_COLUMNS} from cafe_menu_items i
       left join cafe_menu_item_photos p on p.item_id = i.id
      order by i.sort_order, i.name`,
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
  option_groups?: unknown;
  favourite: boolean;
  sort_order: number;
  photo_version: string | null;
}

export async function listPublicMenuItems(): Promise<PublicMenuItem[]> {
  const res = await pool.query(
    `select i.id, i.name, i.price_xof, i.category, i.description, i.option_label,
            i.option_choices, i.option_groups, i.favourite, i.sort_order,
            p.version as photo_version
       from cafe_menu_items i
       left join cafe_menu_item_photos p on p.item_id = i.id
      where i.enabled order by i.sort_order, i.name`,
  );
  return res.rows as PublicMenuItem[];
}

export async function getMenuItem(id: string): Promise<MenuItemView | null> {
  const res = await pool.query(
    `select ${ITEM_COLUMNS} from cafe_menu_items i
       left join cafe_menu_item_photos p on p.item_id = i.id
      where i.id = $1`,
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
  option_groups?: MenuOptionGroup[];
  favourite: boolean;
}

const MAX_NAME = 80;
const MAX_CATEGORY = 40;
const MAX_DESC = 200;
const MAX_RECIPE_FIELD = 5_000;
const MAX_OPTION_LABEL = 40;
const MAX_OPTION_CHOICES = 200;
export const MAX_MENU_OPTION_RESPONSES = 12;
export const MAX_MENU_OPTION_GROUPS = 6;

export function isRecipeComplete(
  item: Pick<MenuItemView, "recipe_ingredients" | "recipe_steps" | "no_recipe_needed">,
): boolean {
  if (item.no_recipe_needed) return true;
  return Boolean(item.recipe_ingredients?.trim() && item.recipe_steps?.trim());
}

function submittedOptionChoices(body: Record<string, unknown>): string[] | { error: string } {
  const indexed = Object.entries(body)
    .flatMap(([key, value]) => {
      const match = key.match(/^option_choices\[(\d+)\]$/);
      return match ? [{ index: Number(match[1]), value }] : [];
    })
    .sort((a, b) => a.index - b.index);

  // New forms submit one indexed field per visible row. If none are present,
  // keep accepting the former pipe-separated field used by older clients.
  const rawValues = indexed.length ? indexed.map((entry) => entry.value) : [body.option_choices];
  const choices = rawValues
    .flatMap((value) => (Array.isArray(value) ? value : [value]))
    .flatMap((value) => String(value ?? "").split("|"))
    .map((value) => value.trim())
    .filter(Boolean);

  if (choices.length > MAX_MENU_OPTION_RESPONSES)
    return { error: `ajoutez au maximum ${MAX_MENU_OPTION_RESPONSES} réponses proposées.` };
  return choices;
}

function submittedOptionGroups(
  body: Record<string, unknown>,
): MenuOptionGroup[] | { error: string } {
  const groupIndexes = new Set<number>();
  for (const key of Object.keys(body)) {
    const match = key.match(
      /^option_groups\[(\d+)\](?:\[label\]|\[choices\]\[\d+\])$/,
    );
    if (match) groupIndexes.add(Number(match[1]));
  }

  if (groupIndexes.size) {
    const groups: MenuOptionGroup[] = [];
    for (const groupIndex of [...groupIndexes].sort((a, b) => a - b)) {
      const label = String(body[`option_groups[${groupIndex}][label]`] ?? "").trim();
      const choiceEntries = Object.entries(body)
        .flatMap(([key, value]) => {
          const match = key.match(
            new RegExp(`^option_groups\\[${groupIndex}\\]\\[choices\\]\\[(\\d+)\\]$`),
          );
          return match ? [{ index: Number(match[1]), value }] : [];
        })
        .sort((a, b) => a.index - b.index);
      const choices = choiceEntries
        .flatMap((entry) => (Array.isArray(entry.value) ? entry.value : [entry.value]))
        .flatMap((value) => String(value ?? "").split("|"))
        .map((value) => value.trim())
        .filter(Boolean);

      if (!label && !choices.length) continue;
      if (!label)
        return {
          error: `indiquez l’intitulé du choix ${groups.length + 1} dès qu’une réponse est proposée.`,
        };
      if (!choices.length)
        return { error: `ajoutez au moins une réponse pour « ${label} ».` };
      if (label.length > MAX_OPTION_LABEL)
        return {
          error: `intitulé « ${label} » trop long (${MAX_OPTION_LABEL} caractères maximum).`,
        };
      if (choices.length > MAX_MENU_OPTION_RESPONSES)
        return {
          error: `ajoutez au maximum ${MAX_MENU_OPTION_RESPONSES} réponses pour « ${label} ».`,
        };
      if (choices.join(" | ").length > MAX_OPTION_CHOICES)
        return {
          error: `réponses de « ${label} » trop longues (${MAX_OPTION_CHOICES} caractères maximum au total).`,
        };
      groups.push({ label, choices });
    }
    if (groups.length > MAX_MENU_OPTION_GROUPS)
      return { error: `ajoutez au maximum ${MAX_MENU_OPTION_GROUPS} types de choix.` };
    const normalizedLabels = groups.map((group) => group.label.toLocaleLowerCase("fr-FR"));
    if (new Set(normalizedLabels).size !== normalizedLabels.length)
      return { error: "chaque type de choix doit avoir un intitulé différent." };
    return groups;
  }

  // Legacy editor/API: one label plus pipe-separated or indexed responses.
  const label = String(body.option_label ?? "").trim();
  const choices = submittedOptionChoices(body);
  if ("error" in choices) return choices;
  if (label.length > MAX_OPTION_LABEL)
    return { error: `intitulé du choix trop long (${MAX_OPTION_LABEL} caractères maximum).` };
  if (choices.join(" | ").length > MAX_OPTION_CHOICES)
    return {
      error: `réponses proposées trop longues (${MAX_OPTION_CHOICES} caractères maximum au total).`,
    };
  if (choices.length && !label)
    return { error: "indiquez un intitulé du choix dès qu’une réponse est proposée." };
  return label && choices.length ? [{ label, choices }] : [];
}

/** Pure: validate/normalize the admin form. */
export function parseMenuItemForm(body: Record<string, unknown>): MenuItemInput | { error: string } {
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

  const optionGroups = submittedOptionGroups(body);
  if ("error" in optionGroups) return optionGroups;
  const firstGroup = optionGroups[0];

  return {
    name,
    price_xof,
    category,
    description: desc || null,
    recipe_ingredients: recipeIngredients || null,
    recipe_steps: recipeSteps || null,
    no_recipe_needed:
      body.no_recipe_needed === "on" || body.no_recipe_needed === "true" || body.no_recipe_needed === "1",
    option_label: firstGroup?.label ?? null,
    option_choices: firstGroup?.choices.join(" | ") ?? null,
    option_groups: optionGroups,
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
        no_recipe_needed, option_label, option_choices, option_groups, favourite, sort_order)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,$13)`,
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
      JSON.stringify(
        input.option_groups ??
          parseOptionGroups(null, input.option_label, input.option_choices),
      ),
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
       option_choices = $10, option_groups = $11::jsonb, favourite = $12, updated_at = now()
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
      JSON.stringify(
        input.option_groups ??
          parseOptionGroups(null, input.option_label, input.option_choices),
      ),
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

// ---------- optional optimized menu-item photos ----------

export interface MenuItemPhoto {
  image_bytes: Buffer;
  mime_type: "image/webp";
  width: number;
  height: number;
  version: string;
}

export interface MenuItemPhotoEditorState {
  version: string;
  focalX: number;
  focalY: number;
  repositionable: boolean;
}

export interface MenuItemPhotoSource {
  source_bytes: Buffer;
  source_width: number;
  source_height: number;
  version: string;
  focal_x: number;
  focal_y: number;
  repositionable: boolean;
}

/** Fetch bytes only for the dedicated versioned image response. */
export async function getMenuItemPhoto(
  itemId: string,
  version: string,
): Promise<MenuItemPhoto | null> {
  const res = await pool.query(
    `select image_bytes, mime_type, width, height, version
       from cafe_menu_item_photos where item_id = $1 and version = $2`,
    [itemId, version],
  );
  return (res.rows[0] as MenuItemPhoto) ?? null;
}

/** Metadata-only state for the admin editor; source bytes stay out of item queries. */
export async function getMenuItemPhotoEditorState(
  itemId: string,
): Promise<MenuItemPhotoEditorState | null> {
  const res = await pool.query(
    `select version, focal_x, focal_y, source_bytes is not null as repositionable
       from cafe_menu_item_photos where item_id = $1`,
    [itemId],
  );
  const row = res.rows[0];
  return row
    ? {
        version: String(row.version),
        focalX: Number(row.focal_x),
        focalY: Number(row.focal_y),
        repositionable: Boolean(row.repositionable),
      }
    : null;
}

/** Full-frame source only for the authenticated crop editor/reprocessor. */
export async function getMenuItemPhotoSource(
  itemId: string,
  version: string,
): Promise<MenuItemPhotoSource | null> {
  const res = await pool.query(
    `select coalesce(source_bytes, image_bytes) as source_bytes,
            coalesce(source_width, width) as source_width,
            coalesce(source_height, height) as source_height,
            version, focal_x, focal_y, source_bytes is not null as repositionable
       from cafe_menu_item_photos where item_id = $1 and version = $2`,
    [itemId, version],
  );
  return (res.rows[0] as MenuItemPhotoSource) ?? null;
}

export async function setMenuItemPhoto(input: {
  itemId: string;
  imageBytes: Buffer;
  mimeType: "image/webp";
  width: number;
  height: number;
  sourceBytes: Buffer;
  sourceWidth: number;
  sourceHeight: number;
  focalX: number;
  focalY: number;
}): Promise<string> {
  const version = randomUUID();
  await pool.query(
    `insert into cafe_menu_item_photos
       (item_id, image_bytes, mime_type, width, height, source_bytes, source_width,
        source_height, focal_x, focal_y, version)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     on conflict (item_id) do update set
       image_bytes = excluded.image_bytes,
       mime_type = excluded.mime_type,
       width = excluded.width,
       height = excluded.height,
       source_bytes = excluded.source_bytes,
       source_width = excluded.source_width,
       source_height = excluded.source_height,
       focal_x = excluded.focal_x,
       focal_y = excluded.focal_y,
       version = excluded.version,
       updated_at = now()`,
    [
      input.itemId,
      input.imageBytes,
      input.mimeType,
      input.width,
      input.height,
      input.sourceBytes,
      input.sourceWidth,
      input.sourceHeight,
      input.focalX,
      input.focalY,
      version,
    ],
  );
  return version;
}

/** Replace only the public crop if the source version is still current. */
export async function updateMenuItemPhotoCrop(input: {
  itemId: string;
  expectedVersion: string;
  imageBytes: Buffer;
  focalX: number;
  focalY: number;
}): Promise<string | null> {
  const version = randomUUID();
  const res = await pool.query(
    `update cafe_menu_item_photos set
       image_bytes = $3, focal_x = $4, focal_y = $5, version = $6, updated_at = now()
     where item_id = $1 and version = $2 and source_bytes is not null`,
    [
      input.itemId,
      input.expectedVersion,
      input.imageBytes,
      input.focalX,
      input.focalY,
      version,
    ],
  );
  return (res.rowCount ?? 0) > 0 ? version : null;
}

export async function removeMenuItemPhoto(itemId: string): Promise<boolean> {
  const res = await pool.query(`delete from cafe_menu_item_photos where item_id = $1`, [itemId]);
  return (res.rowCount ?? 0) > 0;
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
