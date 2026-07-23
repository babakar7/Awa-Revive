import { type ExtraLine, formatExtrasOneLine } from "../lib/cafeMenu.js";

/**
 * Pure logic for kitchen tickets — the cuisine-facing layer shared by delivery
 * orders (Phase 1) and, later, on-site table orders (Phase 2). A ticket is what
 * the kitchen SEES and advances; it never decides the client/payment lifecycle
 * (that stays on delivery_orders). No DB, no network here — the state machine,
 * the source vocabulary, and the SSE event shapes live in this unit so they are
 * unit-testable and reused identically by the repo, the sweep, and the PWA.
 */

export type KitchenTicketSource = "DELIVERY" | "TABLE";

export type KitchenTicketStatus =
  | "NEW"
  | "PREPARING"
  | "READY"
  | "COMPLETED"
  | "CANCELLED";

/**
 * Cuisine advances a ticket NEW → PREPARING → READY. COMPLETED and CANCELLED are
 * terminal and driven by the SOURCE order (a delivery departing = COMPLETED, a
 * delivery cancelled = CANCELLED), never by the kitchen tap — so they are NOT
 * reachable from the cuisine-facing transitions below. A ticket may be cancelled
 * from any non-terminal state (source order aborted mid-prep).
 */
const CUISINE_TRANSITIONS: Record<KitchenTicketStatus, KitchenTicketStatus[]> = {
  NEW: ["PREPARING", "READY"], // allow skipping straight to READY (quick items)
  PREPARING: ["READY"],
  READY: [],
  COMPLETED: [],
  CANCELLED: [],
};

/** Is a cuisine-initiated status change (iPad tap) allowed? Pure. */
export function canCuisineAdvance(
  from: KitchenTicketStatus,
  to: KitchenTicketStatus,
): boolean {
  return CUISINE_TRANSITIONS[from]?.includes(to) ?? false;
}

/** Open = still on the kitchen board (a closed ticket leaves the iPad). */
export function isOpenStatus(status: KitchenTicketStatus): boolean {
  return status === "NEW" || status === "PREPARING" || status === "READY";
}

// ---------- SSE event shapes ----------

/** The only realtime channel in Phase 1. */
export const CUISINE_CHANNEL = "cuisine";

export type OpsEventKind =
  | "ticket_new"
  | "ticket_update"
  | "ticket_removed"
  | "ping";

// ---------- ticket view (what the iPad renders) ----------

/** The minimal ticket shape the PWA + message builders need. */
export interface KitchenTicketView {
  id: string;
  source: KitchenTicketSource;
  status: KitchenTicketStatus;
  items: ExtraLine[];
  note: string | null;
  amount_xof: number;
  is_test: boolean;
  claimed_by: string | null;
  /** Human label shown on the card: client name (delivery) or table code (table). */
  heading: string;
  /** Secondary line: address (delivery) or space + first name (table). */
  subheading: string | null;
  created_at: Date | string;
  /** When the kitchen marked it READY — freezes the prep timer on the card. */
  ready_at: Date | string | null;
}

/** One-line items summary reused by the ticket card and the fallback WhatsApp. */
export function ticketItemsSummary(view: Pick<KitchenTicketView, "items">): string {
  return formatExtrasOneLine(view.items);
}

/**
 * The fallback WhatsApp fires only in `fallback` mode AND only when the iPad
 * never acked the ticket within the grace window. This decides, purely, whether
 * a given ticket is due for that fallback right now.
 */
export function fallbackIsDue(
  ticket: { ipad_ack_at: Date | null; fallback_claimed_at: Date | null; fallback_due_at: Date | null },
  now: Date,
): boolean {
  return (
    ticket.ipad_ack_at === null &&
    ticket.fallback_claimed_at === null &&
    ticket.fallback_due_at !== null &&
    new Date(ticket.fallback_due_at).getTime() <= now.getTime()
  );
}

export type InternalNotifyMode = "parallel" | "fallback";

/** Parse INTERNAL_NOTIFY_MODE; anything but the exact `fallback` keeps the safe
 *  pilot default (parallel = PWA AND WhatsApp both fire). Pure. */
export function parseInternalNotifyMode(raw: string | undefined): InternalNotifyMode {
  return String(raw ?? "").trim().toLowerCase() === "fallback" ? "fallback" : "parallel";
}
