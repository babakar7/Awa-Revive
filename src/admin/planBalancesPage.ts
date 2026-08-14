import { escapeHtml } from "./helpers.js";
import { config } from "../config.js";
import type { PoolBalance } from "../lib/wix.js";

/**
 * « Soldes séances » — remaining sessions per active Wix subscription.
 *
 * The Wix dashboard shows a subscription's commercial facts (plan, dates,
 * payment) but never its credit pool, so reception cannot see how many
 * sessions are left. This page joins the ACTIVE pricing-plan orders with the
 * Benefit Programs ledger (the same pools Awa debits on redemption) and the
 * CRM names, entirely server-side — the model is never involved.
 */

export interface PlanBalanceRow {
  clientName: string;
  planName: string;
  endDate: string | null;
  /** null when no ledger pool matched the order (index/creation anomaly). */
  available: number | null;
  total: number | null;
  reserved: number;
}

export function assemblePlanBalanceRows(
  orders: any[],
  balances: PoolBalance[],
  namesByContactId: Map<string, string>,
): PlanBalanceRow[] {
  const poolByOrderId = new Map(balances.map((b) => [b.orderId, b]));
  return orders
    .map((order): PlanBalanceRow => {
      const contactId = String(order?.buyer?.contactId ?? "");
      const pool = poolByOrderId.get(String(order?.id ?? ""));
      const available = Number(pool?.available);
      const total = Number(pool?.total);
      const reserved = Number(pool?.reserved);
      return {
        clientName: namesByContactId.get(contactId) || contactId || "Cliente Wix",
        planName: String(order?.planName ?? "—").trim(),
        endDate: order?.endDate ? String(order.endDate) : null,
        available: pool && Number.isFinite(available) ? available : null,
        total: pool && Number.isFinite(total) && total > 0 ? total : null,
        reserved: Number.isFinite(reserved) ? reserved : 0,
      };
    })
    .sort(
      (a, b) =>
        (a.endDate ? Date.parse(a.endDate) : Infinity) -
          (b.endDate ? Date.parse(b.endDate) : Infinity) ||
        a.clientName.localeCompare(b.clientName, "fr"),
    );
}

function fmtDay(d: string | null): string {
  if (!d) return "—";
  return new Date(d).toLocaleDateString("fr-FR", {
    timeZone: config.TIMEZONE,
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });
}

function balanceBadge(row: PlanBalanceRow): string {
  if (row.available === null) {
    return `<span class="badge badge--amber">Solde introuvable</span>`;
  }
  const label = row.total !== null ? `${row.available} / ${row.total}` : String(row.available);
  const cls = row.available === 0 ? "badge--gray" : row.available <= 1 ? "badge--amber" : "badge--green";
  const reserved = row.reserved > 0 ? ` <small class="muted">(+${row.reserved} réservée${row.reserved > 1 ? "s" : ""})</small>` : "";
  return `<span class="badge ${cls}">${escapeHtml(label)}</span>${reserved}`;
}

export function renderPlanBalances(rows: PlanBalanceRow[], loadError = false): string {
  const body = rows
    .map(
      (row) => `<tr>
        <td data-label="Cliente"><b>${escapeHtml(row.clientName)}</b></td>
        <td data-label="Abonnement">${escapeHtml(row.planName)}</td>
        <td data-label="Fin">${escapeHtml(fmtDay(row.endDate))}</td>
        <td data-label="Séances restantes">${balanceBadge(row)}</td>
      </tr>`,
    )
    .join("");
  const table = rows.length
    ? `<div class="table-wrap"><table class="responsive-table">
        <thead><tr><th>Cliente</th><th>Abonnement</th><th>Fin</th><th>Séances restantes</th></tr></thead>
        <tbody>${body}</tbody></table></div>`
    : `<div class="empty"><b>Aucun abonnement actif</b><p>Les abonnements actifs dans Wix apparaîtront ici avec leur solde.</p></div>`;
  const errorBanner = loadError
    ? `<div class="flash error">Wix n'a pas répondu complètement — certains soldes peuvent manquer. Recharge la page.</div>`
    : "";
  return `${errorBanner}
  <header class="page-header">
    <div class="page-header-copy">
      <span class="eyebrow">Abonnements</span>
      <h2>Soldes séances</h2>
      <p>Séances restantes par abonnement actif, lues en direct dans le registre de crédits Wix (invisible dans le dashboard Wix).</p>
    </div>
    <div class="page-header-actions">
      <a class="act act--ghost" href="/admin/abonnements">Retour au registre</a>
    </div>
  </header>
  <section class="card">
    <div class="section-header"><div>
      <span class="eyebrow">${rows.length} abonnement${rows.length > 1 ? "s" : ""} actif${rows.length > 1 ? "s" : ""}</span>
      <p class="muted">« Solde introuvable » : la commande existe mais Wix n'a pas (encore) de pool de crédits lisible — vérifier avant de décompter à la main.</p>
    </div></div>
    ${table}
  </section>`;
}
