import { config } from "../config.js";

/** Escape ANY DB-sourced content before injecting into HTML (client text!). */
export function escapeHtml(s: unknown): string {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function fmtDate(d: Date | string | null): string {
  if (!d) return "—";
  return new Date(d).toLocaleString("fr-FR", {
    timeZone: config.TIMEZONE,
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function fmtFcfa(n: number): string {
  return `${Number(n).toLocaleString("fr-FR")} F`;
}

/** Status → badge modifier class (colors live in layout.ts CSS tokens). */
export const STATUS_BADGE_CLASS: Record<string, string> = {
  BOOKED: "badge--green",
  ACTIVATED: "badge--green",
  PAID: "badge--amber",
  AWAITING_PAYMENT: "badge--blue",
  DRAFT: "badge--gray",
  EXPIRED: "badge--gray",
  CANCELLED: "badge--gray",
  REFUND_NEEDED: "badge--red",
  REFUNDED: "badge--violet",
};

export function badge(status: string): string {
  const cls = STATUS_BADGE_CLASS[status] ?? "badge--gray";
  return `<span class="badge ${cls}">${escapeHtml(status)}</span>`;
}

/** "il y a Xh" style relative time for lists. */
export function ago(d: Date | string | null): string {
  if (!d) return "—";
  const mins = Math.round((Date.now() - new Date(d).getTime()) / 60000);
  if (mins < 1) return "à l'instant";
  if (mins < 60) return `il y a ${mins} min`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `il y a ${hours} h`;
  return `il y a ${Math.round(hours / 24)} j`;
}

/** Cap badge counts for the nav (avoid huge numbers). */
export function badgeLabel(n: number): string {
  if (n <= 0) return "";
  if (n > 9) return "9+";
  return String(n);
}
