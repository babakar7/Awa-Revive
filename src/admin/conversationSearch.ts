import { escapeHtml } from "./helpers.js";

export const MAX_CONVERSATION_SEARCH_LENGTH = 300;
export const MAX_CONVERSATION_SEARCH_TERMS = 8;
export const MAX_CONVERSATION_SEARCH_TERM_LENGTH = 48;

const SPECIAL_LATIN: Record<string, string> = {
  æ: "ae",
  œ: "oe",
  ø: "o",
  ł: "l",
  đ: "d",
  ð: "d",
  þ: "th",
  ß: "ss",
};

function asciiFold(value: string): string {
  return Array.from(value.toLowerCase(), (character) => SPECIAL_LATIN[character] ?? character)
    .join("")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

/**
 * Turns an untrusted query into a small, deterministic list of literal terms.
 * Punctuation is a separator, so SQL wildcard characters never become syntax.
 */
export function normalizeConversationSearch(value: string | null | undefined): string[] {
  const normalized = asciiFold(String(value ?? "").slice(0, MAX_CONVERSATION_SEARCH_LENGTH))
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  if (!normalized) return [];

  const unique: string[] = [];
  const seen = new Set<string>();
  for (const rawTerm of normalized.split(/\s+/)) {
    const term = rawTerm.slice(0, MAX_CONVERSATION_SEARCH_TERM_LENGTH);
    if (!term || seen.has(term)) continue;
    seen.add(term);
    unique.push(term);
    if (unique.length >= MAX_CONVERSATION_SEARCH_TERMS) break;
  }
  return unique;
}

/** Live-search threshold: names stay responsive, common mobile prefixes do not. */
export function isConversationLiveSearchReady(value: string | null | undefined): boolean {
  const folded = asciiFold(String(value ?? ""));
  const letters = folded.match(/[a-z]/g)?.length ?? 0;
  const digits = folded.match(/[0-9]/g)?.length ?? 0;
  return letters > 0 ? letters + digits >= 2 : digits >= 4;
}

type FoldedCharacter = { value: string; start: number; end: number };

function foldedCharacters(value: string): FoldedCharacter[] {
  const result: FoldedCharacter[] = [];
  let offset = 0;
  for (const character of value) {
    const start = offset;
    offset += character.length;
    const folded = asciiFold(character).replace(/[^a-z0-9]/g, "");
    for (const value of folded) result.push({ value, start, end: offset });
  }
  return result;
}

function safeSliceStart(value: string, index: number): number {
  if (index > 0 && /[\uDC00-\uDFFF]/.test(value[index] ?? "")) return index - 1;
  return index;
}

function safeSliceEnd(value: string, index: number): number {
  if (index < value.length && /[\uDC00-\uDFFF]/.test(value[index] ?? "")) return index + 1;
  return index;
}

/** Plain-text counterpart used by the JSON suggestion API. */
export function plainConversationExcerpt(message: string, terms: string[], maxLength = 130): string {
  const value = String(message ?? "");
  if (value.length <= maxLength) return value;
  const folded = foldedCharacters(value);
  const haystack = folded.map((item) => item.value).join("");
  const matches = terms
    .map((term) => haystack.indexOf(term))
    .filter((index) => index >= 0)
    .sort((a, b) => a - b);
  const anchor = folded[matches[0] ?? 0]?.start ?? 0;
  let start = Math.max(0, anchor - Math.floor(maxLength / 3));
  let end = Math.min(value.length, start + maxLength);
  if (end - start < maxLength) start = Math.max(0, end - maxLength);
  start = safeSliceStart(value, start);
  end = safeSliceEnd(value, end);
  return `${start > 0 ? "…" : ""}${value.slice(start, end)}${end < value.length ? "…" : ""}`;
}

/** Escapes the message first, then adds markup only around literal matches. */
export function highlightedConversationExcerpt(message: string, terms: string[], maxLength = 160): string {
  const value = String(message ?? "");
  const folded = foldedCharacters(value);
  const haystack = folded.map((item) => item.value).join("");
  const ranges: Array<{ start: number; end: number }> = [];

  for (const term of terms) {
    if (!term) continue;
    let from = 0;
    while (from <= haystack.length - term.length) {
      const found = haystack.indexOf(term, from);
      if (found < 0) break;
      const first = folded[found];
      const last = folded[found + term.length - 1];
      if (first && last) ranges.push({ start: first.start, end: last.end });
      from = found + Math.max(1, term.length);
    }
  }

  ranges.sort((a, b) => a.start - b.start || a.end - b.end);
  const anchor = ranges[0]?.start ?? 0;
  let excerptStart = value.length > maxLength ? Math.max(0, anchor - Math.floor(maxLength / 3)) : 0;
  let excerptEnd = Math.min(value.length, excerptStart + maxLength);
  if (excerptEnd - excerptStart < maxLength) excerptStart = Math.max(0, excerptEnd - maxLength);
  excerptStart = safeSliceStart(value, excerptStart);
  excerptEnd = safeSliceEnd(value, excerptEnd);

  const visible = ranges
    .filter((range) => range.end > excerptStart && range.start < excerptEnd)
    .map((range) => ({ start: Math.max(range.start, excerptStart), end: Math.min(range.end, excerptEnd) }))
    .sort((a, b) => a.start - b.start || a.end - b.end)
    .reduce<Array<{ start: number; end: number }>>((merged, range) => {
      const previous = merged.at(-1);
      if (previous && range.start <= previous.end) previous.end = Math.max(previous.end, range.end);
      else merged.push({ ...range });
      return merged;
    }, []);

  let html = excerptStart > 0 ? "…" : "";
  let cursor = excerptStart;
  for (const range of visible) {
    html += escapeHtml(value.slice(cursor, range.start));
    html += `<mark>${escapeHtml(value.slice(range.start, range.end))}</mark>`;
    cursor = range.end;
  }
  html += escapeHtml(value.slice(cursor, excerptEnd));
  if (excerptEnd < value.length) html += "…";
  return html;
}
