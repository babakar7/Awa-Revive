import fs from "node:fs";
import path from "node:path";

/**
 * Café menu — owner-editable cafe-menu.md is the single source of truth.
 * Same anti-injection stance as slot_cache: the model passes item ids and
 * quantities only; every price is resolved server-side from this file.
 * Loaded once at boot; restart/redeploy to pick up edits (like business-info).
 */

export interface CafeMenuItem {
  id: string;
  name: string;
  priceXof: number;
  category: string;
  description?: string;
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

/**
 * Parse the menu file. Item lines follow `- ID | Name | price | description`;
 * every other line (headers, prose) flows verbatim into promptText so the
 * owner can annotate freely. Throws on duplicate ids so a bad edit fails the
 * boot loudly instead of silently mispricing orders.
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
    items.set(id, { id, name, priceXof, category, description: description || undefined });
    // Re-render so the model sees the exact ids to pass to create_payment_link.
    promptLines.push(
      `- id: ${id} — ${name} — ${priceXof} FCFA${description ? ` — ${description}` : ""}`,
    );
  }
  return { items, promptText: promptLines.join("\n") };
}

function loadCafeMenu(): CafeMenu {
  try {
    return parseCafeMenu(fs.readFileSync(path.resolve(process.cwd(), "cafe-menu.md"), "utf8"));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err; // bad file = fail boot
    return {
      items: new Map(),
      promptText:
        "(cafe-menu.md not found — café ordering is disabled; if asked, say the café menu is unavailable right now)",
    };
  }
}

export const CAFE_MENU = loadCafeMenu();

/** A clickable menu row (mirrors present_options option shape). */
export interface CafeOption {
  id: string;
  title: string;
  description?: string;
  section?: string;
}

/**
 * The studio "incontournables" — the exact 10 favourites the prompt lists, kept
 * here as the single source of truth so the webhook can show the same list the
 * model shows. A WhatsApp list caps at 10 rows, so keep this ≤ 10.
 */
const FAVOURITE_IDS: { id: string; section: string }[] = [
  { id: "MATCHA_VANILLE", section: "🍵 Iced Matcha" },
  { id: "MATCHA_PISTACHE", section: "🍵 Iced Matcha" },
  { id: "MATCHA_MANGUE", section: "🍵 Iced Matcha" },
  { id: "MATCHA_CAFE", section: "🍵 Iced Matcha" },
  { id: "SMOOTHIE_JANT_BI", section: "🥤 Smoothies" },
  { id: "SMOOTHIE_COCO_BEACH", section: "🥤 Smoothies" },
  { id: "FRAICHEUR_ZEST_UP", section: "🧊 Fraîcheur & détox" },
  { id: "DETOX_PURIF_VERT", section: "🧊 Fraîcheur & détox" },
  { id: "BRUNCH_MYKONOS", section: "🍽️ À manger" },
  { id: "SALADE_CHICKEN_CRUNCH", section: "🍽️ À manger" },
];

/**
 * Build the incontournables as present_options rows, priced live from the menu.
 * Ids absent from cafe-menu.md (owner renamed/removed one) are skipped rather
 * than shown broken — returns [] if none resolve (menu unavailable), so callers
 * can decide not to send anything.
 */
export function cafeFavouriteOptions(): CafeOption[] {
  const out: CafeOption[] = [];
  for (const fav of FAVOURITE_IDS) {
    const item = CAFE_MENU.items.get(fav.id);
    if (!item) continue; // defensive: id changed in cafe-menu.md
    const pitch = item.description ? ` · ${item.description}` : "";
    out.push({
      id: item.id,
      title: item.name.slice(0, 24),
      description: `${item.priceXof} F${pitch}`.slice(0, 72),
      section: fav.section,
    });
  }
  return out;
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
