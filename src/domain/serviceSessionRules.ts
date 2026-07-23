/**
 * Pure logic for on-site service sessions (Phase 2, service.revive.sn). A session
 * is a group seated at a FIXED spot (one place per space — Canapé / Terrasse /
 * Pergola). The spot's label IS the session's human tag; its position is the
 * spot's. No money is decided here — the POS is the only ledger. No DB, no
 * network: the close guard and the first-name cleanup live here so they are
 * unit-testable and reused identically by the repo and the PWA.
 */

export { ACCUEIL_CHANNEL as SERVICE_CHANNEL } from "./kitchenTicketRules.js";

/**
 * Closing a session is refused while it still has an OPEN kitchen ticket (NEW /
 * PREPARING / READY) — the accueil must first serve or cancel it; a session never
 * silently swallows a live kitchen order. Pure predicate; the repo enforces it
 * atomically in SQL.
 */
export function canCloseSession(openTicketCount: number): boolean {
  return openTicketCount <= 0;
}

/** First name shown on tiles: trimmed, single-spaced, capped; "" → null. */
export function cleanFirstName(raw: unknown): string | null {
  const s = String(raw ?? "").trim().replace(/\s+/g, " ").slice(0, 40);
  return s || null;
}
