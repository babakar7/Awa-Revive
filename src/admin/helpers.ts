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

export const STATUS_COLORS: Record<string, string> = {
  BOOKED: "#1a7f37",
  ACTIVATED: "#1a7f37",
  PAID: "#9a6700",
  AWAITING_PAYMENT: "#0969da",
  DRAFT: "#6e7781",
  EXPIRED: "#6e7781",
  CANCELLED: "#6e7781",
  REFUND_NEEDED: "#cf222e",
  REFUNDED: "#8250df",
};

export function badge(status: string): string {
  const color = STATUS_COLORS[status] ?? "#6e7781";
  return `<span class="badge" style="background:${color}">${escapeHtml(status)}</span>`;
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
