/**
 * Pure logic for on-site service sessions (Phase 2, service.revive.sn). A session
 * is a group seated in an area (Canapé / Terrasse / Pergola). It carries a SHORT
 * CODE (a human tag like "C-24", not a technical id — the UUID is that), an
 * OPTIONAL position on the area's diagram (proportional x/y ∈ [0,1] so every
 * screen size renders the same point), and an optional first name. No money is
 * decided here — the POS is the only ledger. No DB, no network: the short-code
 * arithmetic, the position parsing, and the close guard live here so they are
 * unit-testable and reused identically by the repo, the sweep, and the PWA.
 */

export { ACCUEIL_CHANNEL as SERVICE_CHANNEL } from "./kitchenTicketRules.js";

/** Zero-pad a session number to 2 digits for the short code (C-24, T-08). */
export function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** `C` + 24 → `C-24`. The area code is upper-cased and trimmed. */
export function formatShortCode(areaCode: string, seq: number): string {
  return `${String(areaCode).trim().toUpperCase()}-${pad2(seq)}`;
}

/**
 * Smallest positive integer NOT already used by an open session in the area, so
 * codes stay small and are reused after a session closes (C-01 frees up). Caps at
 * `max` (a busy area never realistically exceeds it); returns `max` if every slot
 * below it is taken, letting the caller decide (the DB unique index is the real
 * guard against a race).
 */
export function nextFreeSeq(usedSeqs: Iterable<number>, max = 99): number {
  const used = new Set<number>();
  for (const n of usedSeqs) if (Number.isInteger(n)) used.add(n);
  for (let n = 1; n < max; n++) if (!used.has(n)) return n;
  return max;
}

export interface Position {
  x: number;
  y: number;
}

/**
 * Parse a diagram tap into a proportional position. Accepts numbers or numeric
 * strings; both coordinates must be present and finite within [0,1]. Anything
 * out of range or missing → null (the position is optional; a session without one
 * is valid and simply shows a "location not set" warning once it's READY).
 */
export function parsePosition(x: unknown, y: unknown): Position | null {
  const px = typeof x === "number" ? x : Number(x);
  const py = typeof y === "number" ? y : Number(y);
  if (!Number.isFinite(px) || !Number.isFinite(py)) return null;
  if (px < 0 || px > 1 || py < 0 || py > 1) return null;
  return { x: px, y: py };
}

/**
 * Closing a session is refused while it still has an OPEN kitchen ticket (NEW /
 * PREPARING / READY) — the accueil must first serve or cancel it; a session never
 * silently swallows a live kitchen order. Pure predicate; the repo enforces it
 * atomically in SQL.
 */
export function canCloseSession(openTicketCount: number): boolean {
  return openTicketCount <= 0;
}

/** First name shown on cards: trimmed, single-spaced, capped; "" → null. */
export function cleanFirstName(raw: unknown): string | null {
  const s = String(raw ?? "").trim().replace(/\s+/g, " ").slice(0, 40);
  return s || null;
}
