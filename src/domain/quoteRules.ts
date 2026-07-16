/**
 * Pure logic for event quotes ("devis"): number formatting, form-line
 * parsing/validation, defaults. No DB, no network — the server owns every
 * amount (a line with no amount is "Inclus / 0", never trusted-computed from
 * the model), same stance as invoiceRules/deliveryRules.
 */

export interface QuoteItem {
  label: string;
  detail: string | null;
  /** null = « Inclus / 0 » (line shown with no price). */
  amount_xof: number | null;
}

const MAX_ITEMS = 20;
const MAX_LABEL = 120;
const MAX_DETAIL = 300;

export const QUOTE_STATUSES = ["DRAFT", "SENT", "ACCEPTED", "EXPIRED"] as const;
export type QuoteStatus = (typeof QUOTE_STATUSES)[number];

export const QUOTE_STATUS_LABELS: Record<QuoteStatus, string> = {
  DRAFT: "Brouillon",
  SENT: "Envoyé",
  ACCEPTED: "Accepté",
  EXPIRED: "Expiré",
};

export function isQuoteStatus(s: unknown): s is QuoteStatus {
  return (QUOTE_STATUSES as readonly string[]).includes(String(s));
}

export const DEFAULT_LOCATION = "Revive Ventures, Almadies";

/** Prefilled in the create form; the manager edits freely (one line = one bullet). */
export const DEFAULT_CONDITIONS = [
  "Réservation confirmée par un acompte de 50 %. Solde le jour de l'événement.",
  "Paiement par Wave ou Orange Money.",
  "Devis valable 15 jours à compter de la date d'émission.",
  "Toute modification du nombre de participants ou de l'horaire à confirmer 48h à l'avance.",
].join("\n");

/** DEV-YYYY-NNNN, zero-padded to 4 (never truncates: 10000 → DEV-2026-10000). */
export function formatQuoteNumber(year: number, n: number): string {
  return `DEV-${year}-${String(n).padStart(4, "0")}`;
}

/** Sum of priced lines; "Inclus" (null) lines contribute 0. Pure. */
export function quoteTotal(items: QuoteItem[]): number {
  return items.reduce((sum, i) => sum + (i.amount_xof ?? 0), 0);
}

/**
 * Collect indexed line fields (item_label_i / item_detail_i / item_amount_i)
 * into validated QuoteItem[]. Fully blank rows are skipped so trailing template
 * rows don't error. Empty or "0" amount → null ("Inclus"). Any non-integer or
 * negative amount is rejected.
 */
export function parseQuoteItemFields(
  body: Record<string, string>,
): { items: QuoteItem[] } | { error: string } {
  const indices = new Set<number>();
  for (const key of Object.keys(body)) {
    const m = key.match(/^item_label_(\d+)$/);
    if (m) indices.add(Number(m[1]));
  }
  const items: QuoteItem[] = [];
  for (const i of [...indices].sort((a, b) => a - b)) {
    const label = String(body[`item_label_${i}`] ?? "").trim();
    const detail = String(body[`item_detail_${i}`] ?? "").trim();
    const amountRaw = String(body[`item_amount_${i}`] ?? "").trim();
    // Untouched blank row (no label, no detail, no amount) → skip silently.
    if (!label && !detail && !amountRaw) continue;
    if (!label) return { error: "chaque prestation doit avoir un intitulé." };
    if (label.length > MAX_LABEL) return { error: "intitulé trop long (max 120 caractères)." };
    if (detail.length > MAX_DETAIL) return { error: "détail trop long (max 300 caractères)." };
    let amount: number | null = null;
    if (amountRaw && amountRaw !== "0") {
      const n = Number(amountRaw.replaceAll(" ", ""));
      if (!Number.isInteger(n) || n < 0)
        return { error: `montant invalide pour « ${label} » (entier ≥ 0, ou vide = inclus).` };
      amount = n;
    }
    items.push({ label, detail: detail || null, amount_xof: amount });
  }
  if (items.length === 0) return { error: "ajoute au moins une prestation." };
  if (items.length > MAX_ITEMS) return { error: `trop de prestations (max ${MAX_ITEMS}).` };
  return { items };
}

export interface QuoteFormData {
  client_name: string;
  client_company: string | null;
  client_role: string | null;
  client_phone: string | null;
  event_title: string;
  description: string | null;
  event_date: string | null; // ISO yyyy-mm-dd or null
  event_time: string | null;
  participants: string | null;
  location: string;
  items: QuoteItem[];
  conditions: string;
  validity_days: number;
}

function cleanOpt(v: unknown): string | null {
  const s = String(v ?? "").trim();
  return s ? s : null;
}

/** Validate + normalize the whole quote form. Delegates line parsing. */
export function parseQuoteForm(
  body: Record<string, string>,
): { data: QuoteFormData } | { error: string } {
  const client_name = String(body.client_name ?? "").trim();
  if (!client_name) return { error: "le nom du client est requis." };
  const event_title = String(body.event_title ?? "").trim();
  if (!event_title) return { error: "le titre de l'événement est requis." };

  const validityRaw = String(body.validity_days ?? "15").trim();
  const validity_days = Number(validityRaw);
  if (!Number.isInteger(validity_days) || validity_days < 1 || validity_days > 365)
    return { error: "validité invalide (1 à 365 jours)." };

  const dateRaw = String(body.event_date ?? "").trim();
  const event_date = dateRaw && /^\d{4}-\d{2}-\d{2}$/.test(dateRaw) ? dateRaw : null;

  const parsed = parseQuoteItemFields(body);
  if ("error" in parsed) return { error: parsed.error };

  return {
    data: {
      client_name,
      client_company: cleanOpt(body.client_company),
      client_role: cleanOpt(body.client_role),
      client_phone: cleanOpt(body.client_phone),
      event_title,
      description: cleanOpt(body.description),
      event_date,
      event_time: cleanOpt(body.event_time),
      participants: cleanOpt(body.participants),
      location: cleanOpt(body.location) ?? DEFAULT_LOCATION,
      items: parsed.items,
      conditions: String(body.conditions ?? "").trim() || DEFAULT_CONDITIONS,
      validity_days,
    },
  };
}
