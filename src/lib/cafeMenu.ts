/**
 * Bar menu — the DB table cafe_menu_items is the single source of truth
 * (editable via /admin/menu; seeded from cafe-menu.md on first boot). This
 * module stays pure (no DB, no fs): domain/cafeMenuRepo.ts loads the rows and
 * PUSHES them here via setCafeMenu(). Same anti-injection stance as slot_cache:
 * the model passes item ids + quantities only; every price is resolved
 * server-side from the in-memory snapshot (computeExtras).
 */

export interface MenuOptionGroup {
  label: string;
  choices: string[];
}

export interface MenuOptionSelection {
  label: string;
  value: string;
}

export interface CafeMenuItem {
  id: string;
  name: string;
  priceXof: number;
  category: string;
  description?: string;
  /** Label of a built-in choice (e.g. "Boisson"); undefined = no choice. */
  optionLabel?: string;
  /** The choices the client picks from (e.g. ["Jus d'orange", "Boisson chaude"]). */
  optionChoices?: string[];
  /** Every independent choice requested for this item, in display order. */
  optionGroups?: MenuOptionGroup[];
  /** Studio "incontournable" — surfaced as a Favoris shortcut in the order picker. */
  favourite?: boolean;
  /** Immutable cache-busting token only; photo bytes never enter the snapshot. */
  photoVersion?: string;
}

/** Parse the pipe-separated option_choices column into a clean list. */
export function parseOptionChoices(raw: string | null | undefined): string[] {
  return String(raw ?? "")
    .split("|")
    .map((c) => c.trim())
    .filter(Boolean)
    .slice(0, 12);
}

/** Parse the JSONB multi-choice column, falling back to the legacy first group. */
export function parseOptionGroups(
  raw: unknown,
  legacyLabel?: string | null,
  legacyChoices?: string | null,
): MenuOptionGroup[] {
  let value = raw;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      value = [];
    }
  }
  const groups = Array.isArray(value)
    ? value
        .map((group) => ({
          label: String(group?.label ?? "").trim().slice(0, 40),
          choices: Array.isArray(group?.choices)
            ? group.choices
                .map((choice: unknown) => String(choice ?? "").trim())
                .filter(Boolean)
                .slice(0, 12)
            : [],
        }))
        .filter((group) => group.label && group.choices.length)
        .slice(0, 6)
    : [];
  if (groups.length) return groups;
  const choices = parseOptionChoices(legacyChoices);
  const label = String(legacyLabel ?? "").trim().slice(0, 40);
  return label && choices.length ? [{ label, choices }] : [];
}

/** Canonical groups for a snapshot item, including old in-memory fixtures. */
export function menuOptionGroups(
  item: Pick<CafeMenuItem, "optionGroups" | "optionLabel" | "optionChoices">,
): MenuOptionGroup[] {
  if (item.optionGroups?.length) return item.optionGroups;
  return item.optionLabel && item.optionChoices?.length
    ? [{ label: item.optionLabel, choices: item.optionChoices }]
    : [];
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
  /** The picked option for an item with a choice (e.g. "Jus d'orange"). */
  choice?: string;
  /** Per-line kitchen instruction (e.g. "sans oignons"). On-site orders only. */
  note?: string;
  /** All independently selected options, in the article's configured order. */
  selections?: MenuOptionSelection[];
}

/** Trim + cap a per-line kitchen instruction; "" (or non-string) → undefined. */
export function cleanLineNote(raw: unknown): string | undefined {
  const s = String(raw ?? "").trim().replace(/\s+/g, " ").slice(0, 140);
  return s || undefined;
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
  const groups = menuOptionGroups(item);
  const choices = groups.length
    ? ` — choix requis: ${groups.map((group) => `${group.label} [${group.choices.join(", ")}]`).join("; ")}`
    : "";
  return `- id: ${item.id} — ${item.name} — ${item.priceXof} FCFA${item.description ? ` — ${item.description}` : ""}${choices}`;
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

/** One clickable item in an order picker (service composer + /commander). */
export interface PickerMenuItem {
  id: string;
  name: string;
  price: number; // server-priced — the client NEVER sends a price
  /** First group's label/choices (back-compat for the single-choice service UI). */
  optionLabel?: string;
  choices: string[];
  /** Every independent choice group (the /commander app submits `selections`). */
  optionGroups: MenuOptionGroup[];
  fav: boolean;
  /** Same-origin URL for display only; omitted from order submissions. */
  photoUrl?: string;
}
export interface PickerMenuCategory {
  category: string;
  items: PickerMenuItem[];
}

/**
 * The live menu grouped by category for an order picker — the SINGLE source of
 * truth for both the reception composer and the public /commander app. Ids +
 * prices come only from the server snapshot; the browser never sets a price.
 * Exposes the FULL optionGroups (not just the first group) so multi-choice items
 * are orderable under computeExtras({requireChoices:true}).
 */
export function pickerMenu(): PickerMenuCategory[] {
  const { items } = getCafeMenu();
  const cats: PickerMenuCategory[] = [];
  const byCat = new Map<string, PickerMenuItem[]>();
  for (const it of items.values()) {
    let arr = byCat.get(it.category);
    if (!arr) {
      arr = [];
      byCat.set(it.category, arr);
      cats.push({ category: it.category, items: arr });
    }
    const groups = menuOptionGroups(it);
    arr.push({
      id: it.id,
      name: it.name,
      price: it.priceXof,
      optionLabel: groups[0]?.label,
      choices: groups[0]?.choices ?? [],
      optionGroups: groups,
      fav: Boolean(it.favourite),
      ...(it.photoVersion
        ? { photoUrl: `/menu/photos/${encodeURIComponent(it.id)}/${encodeURIComponent(it.photoVersion)}` }
        : {}),
    });
  }
  return cats;
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
      optionLabel: r.optionLabel,
      optionChoices: r.optionChoices,
      optionGroups: r.optionGroups,
      favourite: r.favourite,
      photoVersion: r.photoVersion,
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
 *
 * An entry may carry `selections` for every independent option group. The old
 * single `choice` field remains accepted as the first group's value.
 */
export function computeExtras(
  items: Map<string, CafeMenuItem>,
  input: unknown,
  opts: { requireChoices?: boolean } = {},
): ExtrasResult {
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
    const line: ExtraLine = {
      id: item.id,
      name: item.name,
      qty,
      unitPriceXof: item.priceXof,
      lineTotalXof: item.priceXof * qty,
    };
    const groups = menuOptionGroups(item);
    if (groups.length > 0) {
      const submitted = Array.isArray((entry as any)?.selections)
        ? (entry as any).selections
        : [];
      const selections: MenuOptionSelection[] = [];
      for (const [groupIndex, group] of groups.entries()) {
        const row = submitted.find(
          (selection: any) =>
            Number(selection?.group_index) === groupIndex ||
            String(selection?.label ?? "").trim() === group.label,
        );
        const value = String(
          row?.value ?? (groupIndex === 0 ? (entry as any)?.choice ?? "" : ""),
        ).trim();
        if (value) {
          if (!group.choices.includes(value))
            return {
              ok: false,
              error: "invalid_extras",
              message: `« ${value} » n'est pas une réponse valide pour « ${group.label} » sur ${item.name} (${group.choices.join(", ")}).`,
            };
          selections.push({ label: group.label, value });
        } else if (opts.requireChoices) {
          return {
            ok: false,
            error: "invalid_extras",
            message: `choisis une réponse pour « ${group.label} » sur ${item.name} : ${group.choices.join(", ")}.`,
          };
        }
      }
      if (selections.length) {
        line.selections = selections;
        line.choice = selections[0].value;
      }
    }
    const note = cleanLineNote((entry as any)?.note);
    if (note) line.note = note;
    lines.push(line);
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

/** Chosen options for client/staff summaries, with labels when several exist. */
function choiceSuffix(l: ExtraLine): string {
  if ((l.selections?.length ?? 0) > 1)
    return ` (${l.selections!.map((selection) => `${selection.label} : ${selection.value}`).join(" · ")})`;
  return l.choice ? ` (${l.choice})` : "";
}

/** ` — sans oignons` when the line carries a per-line instruction, else "". */
function noteSuffix(l: ExtraLine): string {
  return l.note ? ` — ${l.note}` : "";
}

/** `• 2× Jant Bi — 6000 FCFA` per line — for client-facing messages. */
export function formatExtrasMultiline(lines: ExtraLine[]): string {
  return lines.map((l) => `• ${l.qty}× ${l.name}${choiceSuffix(l)}${noteSuffix(l)} — ${l.lineTotalXof} FCFA`).join("\n");
}

/** `2× Jant Bi + 1× Iced Matcha Vanille` — for one-line summaries. */
export function formatExtrasOneLine(lines: ExtraLine[]): string {
  return lines.map((l) => `${l.qty}× ${l.name}${choiceSuffix(l)}${noteSuffix(l)}`).join(" + ");
}

/** Defensive parse of the extras_json column (jsonb → ExtraLine[]). */
export function extrasFromJson(value: unknown): ExtraLine[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter(
      (l): l is ExtraLine =>
        typeof l?.name === "string" && Number.isInteger(l?.qty) && Number.isInteger(l?.lineTotalXof),
    )
    .map((l) => {
      const selections = Array.isArray(l.selections)
        ? l.selections
            .map((selection) => ({
              label: String(selection?.label ?? "").trim(),
              value: String(selection?.value ?? "").trim(),
            }))
            .filter((selection) => selection.label && selection.value)
        : [];
      const choice =
        typeof l.choice === "string" && l.choice
          ? l.choice
          : selections[0]?.value;
      return {
        ...l,
        choice: choice || undefined,
        note: cleanLineNote(l.note),
        selections: selections.length ? selections : undefined,
      };
    });
}
