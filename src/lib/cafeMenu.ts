/**
 * Bar menu — the DB table cafe_menu_items is the single source of truth
 * (editable via /admin/menu; seeded from cafe-menu.md on first boot). This
 * module stays pure (no DB, no fs): domain/cafeMenuRepo.ts loads the rows and
 * PUSHES them here via setCafeMenu(). Same anti-injection stance as slot_cache:
 * the model passes item ids + quantities only; every price is resolved
 * server-side from the in-memory snapshot (computeExtras).
 */

export interface CafeMenuItem {
  id: string;
  name: string;
  priceXof: number;
  category: string;
  description?: string;
}

/** A menu row as stored in DB (snapshot input). */
export interface CafeMenuRow extends CafeMenuItem {
  favourite: boolean;
  enabled: boolean;
  sortOrder: number;
}

export interface ExtraLine {
  id: string;
  name: string;
  qty: number;
  unitPriceXof: number;
  lineTotalXof: number;
}

export interface CafeMenu {
  items: Map<string, CafeMenuItem>;
  promptText: string;
}

const ITEM_LINE = /^-\s*([A-Z0-9_]+)\s*\|\s*([^|]+?)\s*\|\s*(\d+)\s*(?:\|\s*(.*?)\s*)?$/;

const MENU_DISABLED_TEXT =
  "(le menu du bar est vide — bar ordering is disabled; if asked, say the bar menu is unavailable right now)";

/** The exact prompt line format so the model sees the ids to pass to tools. */
function itemPromptLine(item: CafeMenuItem): string {
  return `- id: ${item.id} — ${item.name} — ${item.priceXof} FCFA${item.description ? ` — ${item.description}` : ""}`;
}

/**
 * Parse cafe-menu.md. Item lines follow `- ID | Name | price | description`;
 * headers/prose flow verbatim into promptText. Throws on duplicate ids or bad
 * price so a corrupt seed file fails the FIRST boot loudly. Used now only by the
 * one-shot DB seed (and tests) — the live menu comes from the DB snapshot.
 */
export function parseCafeMenu(raw: string): CafeMenu {
  const items = new Map<string, CafeMenuItem>();
  const promptLines: string[] = [];
  let category = "";
  for (const line of raw.split("\n")) {
    const header = line.match(/^##\s+(.+?)\s*$/);
    if (header) {
      category = header[1];
      promptLines.push(line);
      continue;
    }
    const m = line.match(ITEM_LINE);
    if (!m) {
      promptLines.push(line);
      continue;
    }
    const [, id, name, priceStr, description] = m;
    if (items.has(id)) throw new Error(`cafe-menu.md: duplicate item id "${id}"`);
    const priceXof = parseInt(priceStr, 10);
    if (!Number.isInteger(priceXof) || priceXof <= 0)
      throw new Error(`cafe-menu.md: invalid price for "${id}": ${priceStr}`);
    const item = { id, name, priceXof, category, description: description || undefined };
    items.set(id, item);
    promptLines.push(itemPromptLine(item));
  }
  return { items, promptText: promptLines.join("\n") };
}

/**
 * Ids favourited by default at seed time — the studio "incontournables". After
 * the seed the `favourite` column in DB is the source of truth (editable in
 * /admin/menu). A WhatsApp list caps at 10 rows, so keep the live set ≤ 10.
 */
export const FAVOURITE_SEED_IDS: string[] = [
  "MATCHA_VANILLE",
  "MATCHA_PISTACHE",
  "MATCHA_MANGUE",
  "SMOOTHIE_JANT_BI",
  "SMOOTHIE_COCO_BEACH",
  "FRAICHEUR_ZEST_UP",
  "DETOX_PURIF_VERT",
  "BRUNCH_MYKONOS",
  "SALADE_CHICKEN_CRUNCH",
];

// ---------- in-memory snapshot (pushed by cafeMenuRepo) ----------

function emptyMenu(): CafeMenu {
  return { items: new Map(), promptText: MENU_DISABLED_TEXT };
}

let snapshot: CafeMenu = emptyMenu();
let favouriteOpts: CafeOption[] = [];
let menuVersion = 0;

/** The live menu snapshot (sync). Empty until initCafeMenu() runs at boot. */
export function getCafeMenu(): CafeMenu {
  return snapshot;
}

/** Bumped on every setCafeMenu — memo key for systemPrompt(). */
export function cafeMenuVersion(): number {
  return menuVersion;
}

const bySortOrder = (a: CafeMenuRow, b: CafeMenuRow) => a.sortOrder - b.sortOrder;

/**
 * Pure: render enabled rows to the <cafe_menu> prompt text (## CATEGORY headers
 * in sort order, then item lines). Disabled rows are excluded; an empty result
 * yields the "bar disabled" text.
 */
export function buildPromptText(rows: CafeMenuRow[]): string {
  const enabled = rows.filter((r) => r.enabled).sort(bySortOrder);
  if (enabled.length === 0) return MENU_DISABLED_TEXT;
  const lines: string[] = [];
  let category = "";
  for (const r of enabled) {
    if (r.category !== category) {
      category = r.category;
      lines.push(`## ${category}`);
    }
    lines.push(itemPromptLine(r));
  }
  return lines.join("\n");
}

/** Replace the live snapshot from DB rows (enabled ones drive the menu). */
export function setCafeMenu(rows: CafeMenuRow[]): void {
  const enabled = rows.filter((r) => r.enabled).sort(bySortOrder);
  const items = new Map<string, CafeMenuItem>();
  for (const r of enabled) {
    items.set(r.id, {
      id: r.id,
      name: r.name,
      priceXof: r.priceXof,
      category: r.category,
      description: r.description,
    });
  }
  snapshot = { items, promptText: buildPromptText(rows) };
  favouriteOpts = enabled
    .filter((r) => r.favourite)
    .slice(0, 10)
    .map((r) => {
      const pitch = r.description ? ` · ${r.description}` : "";
      return {
        id: r.id,
        title: r.name.slice(0, 24),
        description: `${r.priceXof} F${pitch}`.slice(0, 72),
        section: r.category.slice(0, 24),
      };
    });
  menuVersion++;
}

/**
 * Turn a display name into a stable menu id (UPPER_SNAKE, accents stripped),
 * unique against existingIds (including archived) with a _2/_3 suffix on clash.
 */
export function slugifyMenuId(name: string, existingIds: Iterable<string>): string {
  const base =
    name
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .toUpperCase()
      .replace(/[^A-Z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "") || "ITEM";
  const set = new Set(existingIds);
  if (!set.has(base)) return base;
  let n = 2;
  while (set.has(`${base}_${n}`)) n++;
  return `${base}_${n}`;
}

/** A clickable menu row (mirrors present_options option shape). */
export interface CafeOption {
  id: string;
  title: string;
  description?: string;
  section?: string;
}

/**
 * The studio "incontournables" as present_options rows, from the live snapshot's
 * favourite rows (priced from the snapshot). Empty if none/menu unavailable, so
 * callers can decide not to send anything.
 */
export function cafeFavouriteOptions(): CafeOption[] {
  return favouriteOpts;
}

export type ExtrasResult =
  | { ok: true; lines: ExtraLine[]; totalXof: number }
  | {
      ok: false;
      error: "invalid_extras" | "unknown_menu_item";
      message: string;
      unknownIds?: string[];
      validIds?: string[];
    };

/**
 * Resolve the model-provided extras (item ids + quantities) against the menu.
 * Rejects rather than clamps, so the model corrects itself explicitly.
 */
export function computeExtras(items: Map<string, CafeMenuItem>, input: unknown): ExtrasResult {
  if (!Array.isArray(input) || input.length === 0 || input.length > 15)
    return { ok: false, error: "invalid_extras", message: "extras must be an array of 1 to 15 {item_id, qty} entries." };
  const lines: ExtraLine[] = [];
  const unknownIds: string[] = [];
  for (const entry of input) {
    const itemId = String((entry as any)?.item_id ?? "");
    const qty = (entry as any)?.qty;
    if (!Number.isInteger(qty) || qty < 1 || qty > 10)
      return { ok: false, error: "invalid_extras", message: `qty for "${itemId}" must be an integer between 1 and 10.` };
    const item = items.get(itemId);
    if (!item) {
      unknownIds.push(itemId);
      continue;
    }
    lines.push({
      id: item.id,
      name: item.name,
      qty,
      unitPriceXof: item.priceXof,
      lineTotalXof: item.priceXof * qty,
    });
  }
  if (unknownIds.length > 0)
    return {
      ok: false,
      error: "unknown_menu_item",
      message: "Some item ids are not on the menu. Use ONLY ids listed in <cafe_menu>.",
      unknownIds,
      validIds: [...items.keys()],
    };
  return { ok: true, lines, totalXof: lines.reduce((sum, l) => sum + l.lineTotalXof, 0) };
}

/** `• 2× Jant Bi — 6000 FCFA` per line — for client-facing messages. */
export function formatExtrasMultiline(lines: ExtraLine[]): string {
  return lines.map((l) => `• ${l.qty}× ${l.name} — ${l.lineTotalXof} FCFA`).join("\n");
}

/** `2× Jant Bi + 1× Iced Matcha Vanille` — for one-line summaries. */
export function formatExtrasOneLine(lines: ExtraLine[]): string {
  return lines.map((l) => `${l.qty}× ${l.name}`).join(" + ");
}

/** Defensive parse of the extras_json column (jsonb → ExtraLine[]). */
export function extrasFromJson(value: unknown): ExtraLine[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (l): l is ExtraLine =>
      typeof l?.name === "string" && Number.isInteger(l?.qty) && Number.isInteger(l?.lineTotalXof),
  );
}
