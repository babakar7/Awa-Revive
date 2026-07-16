/**
 * Pure logic for reception invoices ("factures"): number formatting and the
 * admin form-line parsing/validation. No DB, no network — the server owns every
 * total (never trusted from the form), mirroring the delivery/cafe stance.
 * Phone normalization is reused from deliveryRules (empty → null allowed here,
 * since a facture may have no WhatsApp number).
 */

export interface InvoiceLine {
  label: string;
  qty: number;
  unit_xof: number;
  total_xof: number;
}

const MAX_LINES = 20;
const MAX_LABEL = 120;

/** FAC-YYYY-NNNN, zero-padded to 4 (never truncates: 10000 → FAC-2026-10000). */
export function formatInvoiceNumber(year: number, n: number): string {
  return `FAC-${year}-${String(n).padStart(4, "0")}`;
}

/**
 * Collect the indexed line fields of the create form (line_label_i / line_qty_i
 * / line_unit_i) into validated InvoiceLine[] with a grand total computed HERE.
 * Empty rows (no label) are skipped so trailing blank template rows don't error.
 */
export function parseInvoiceLineFields(
  body: Record<string, string>,
): { lines: InvoiceLine[]; totalXof: number } | { error: string } {
  // Discover row indices from any line_label_<i> present.
  const indices = new Set<number>();
  for (const key of Object.keys(body)) {
    const m = key.match(/^line_label_(\d+)$/);
    if (m) indices.add(Number(m[1]));
  }
  const lines: InvoiceLine[] = [];
  for (const i of [...indices].sort((a, b) => a - b)) {
    const label = String(body[`line_label_${i}`] ?? "").trim();
    const qtyRaw = String(body[`line_qty_${i}`] ?? "").trim();
    const unitRaw = String(body[`line_unit_${i}`] ?? "").trim();
    // A row with no label AND no amounts is an untouched blank → skip silently.
    if (!label && !qtyRaw && !unitRaw) continue;
    if (!label) return { error: "chaque ligne doit avoir une désignation." };
    if (label.length > MAX_LABEL) return { error: "désignation trop longue (max 120 caractères)." };
    const qty = Number(qtyRaw);
    if (!Number.isInteger(qty) || qty < 1 || qty > 99)
      return { error: `quantité invalide pour « ${label} » (1 à 99).` };
    const unit = Number(unitRaw);
    if (!Number.isInteger(unit) || unit < 0)
      return { error: `prix unitaire invalide pour « ${label} » (entier ≥ 0).` };
    lines.push({ label, qty, unit_xof: unit, total_xof: qty * unit });
  }
  if (lines.length === 0) return { error: "ajoute au moins une ligne." };
  if (lines.length > MAX_LINES) return { error: `trop de lignes (max ${MAX_LINES}).` };
  const totalXof = lines.reduce((sum, l) => sum + l.total_xof, 0);
  if (totalXof <= 0) return { error: "le total doit être supérieur à 0." };
  return { lines, totalXof };
}

const SOURCE_KINDS = ["booking", "plan", "cafe", "delivery", "manual"] as const;
export type InvoiceSourceKind = (typeof SOURCE_KINDS)[number];

/** Whitelist the source_kind coming from the form (defaults to "manual"). */
export function normalizeSourceKind(raw: unknown): InvoiceSourceKind {
  return (SOURCE_KINDS as readonly string[]).includes(String(raw))
    ? (String(raw) as InvoiceSourceKind)
    : "manual";
}
