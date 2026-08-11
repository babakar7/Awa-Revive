import crypto from "node:crypto";
import { paymentMethodLabel } from "../lib/paymentMethod.js";
import { dakarDay } from "../domain/paymentsLedger.js";
import type { LedgerMovement, MethodTotal } from "../domain/paymentsLedger.js";
import type { WixPaymentSyncState } from "../domain/wixPaymentSync.js";
import { escapeHtml as esc, fmtDate, fmtFcfa } from "./helpers.js";

export interface PaymentsPageData {
  from: string;
  to: string;
  startDate: string;
  rows: LedgerMovement[];
  daily: MethodTotal[];
  currentMonth: MethodTotal[];
  previousMonth: MethodTotal[];
  untagged: LedgerMovement[];
  excludedCounts: Record<string, number>;
  refundNeeded: Array<{ id: string; service_name: string; amount_xof: number; client_name: string | null }>;
  owner: boolean;
  method?: string;
  source?: string;
  type?: string;
  notice?: string;
  error?: string;
  sync: WixPaymentSyncState;
}

const METHODS = ["wave", "orange_money", "maxit", "cash", "card", "other"];

function totalCards(title: string, rows: MethodTotal[]): string {
  const net = rows.reduce((n, r) => n + r.netXof, 0);
  const refunds = rows.reduce((n, r) => n + r.refundsXof, 0);
  return `<article class="card"><span class="eyebrow">${esc(title)}</span><h2>${fmtFcfa(net)}</h2>
    <p class="muted">Remboursements : ${fmtFcfa(refunds)}</p>
    <div class="cluster">${rows.map((r) => `<span class="badge badge--gray">${esc(paymentMethodLabel(r.method))} ${fmtFcfa(r.netXof)}</span>`).join("")}</div></article>`;
}

function dayHref(day: string, d: PaymentsPageData): string {
  const q = new URLSearchParams({ from: day, to: day, ...(d.method ? { method: d.method } : {}), ...(d.source ? { source: d.source } : {}), ...(d.type ? { type: d.type } : {}) });
  return `/admin/paiements?${q.toString()}#pay-mouvements`;
}

function dailyTable(rows: MethodTotal[], d: PaymentsPageData): string {
  const days = [...new Set(rows.map((r) => r.day).filter(Boolean))] as string[];
  const methods = [...new Set(rows.map((r) => r.method))];
  if (!days.length) return `<p class="muted">Aucun mouvement sur cette période.</p>`;
  return `<p class="muted">Cliquez sur une date pour voir chaque transaction du jour (client, montant, méthode).</p>
    <div class="table-wrap"><table class="responsive-table"><thead><tr><th>Jour</th>${methods.map((m) => `<th>${esc(paymentMethodLabel(m === "untagged" ? "À qualifier" : m))}</th>`).join("")}<th>Total net</th></tr></thead><tbody>
    ${days.map((day) => {
      const entries = methods.map((method) => rows.find((r) => r.day === day && r.method === method));
      const net = entries.reduce((n, r) => n + (r?.netXof ?? 0), 0);
      return `<tr><td data-label="Jour"><a href="${esc(dayHref(day, d))}"><b>${esc(day)}</b></a></td>${entries.map((r, i) => `<td data-label="${esc(methods[i])}">${r ? `<b>${fmtFcfa(r.netXof)}</b><div class="muted">Brut ${fmtFcfa(r.grossXof)} · remb. ${fmtFcfa(r.refundsXof)}</div>` : "—"}</td>`).join("")}<td data-label="Total"><b>${fmtFcfa(net)}</b></td></tr>`;
    }).join("")}</tbody></table></div>`;
}

function qualifyRow(r: LedgerMovement): string {
  return `<form method="post" action="/admin/paiements/tag" class="qualify-row">
      <input type="hidden" name="target_id" value="${esc(r.targetId)}">
      <div><b>${esc(r.label)}</b><div class="muted">${fmtDate(r.occurredAt)} · ${esc(r.clientName ?? r.clientPhone ?? "Client Wix")} · ${fmtFcfa(r.amountXof)}</div></div>
      <div class="qualify-act"><input name="note" placeholder="Note (Autre / Exclu / re-tag)">
      <div class="cluster">${[...METHODS, "exclu"].map((m) => `<button class="act act--sm${m === "exclu" ? " act--ghost" : ""}" name="method" value="${m}" type="submit">${esc(paymentMethodLabel(m))}</button>`).join("")}</div></div>
    </form>`;
}

const QUALIFY_VISIBLE = 10;

function qualifier(rows: LedgerMovement[]): string {
  if (!rows.length) return "";
  const visible = rows.slice(0, QUALIFY_VISIBLE);
  const rest = rows.slice(QUALIFY_VISIBLE);
  const capped = rows.length >= 50 ? `<p class="muted">50 mouvements maximum affichés ici ; les autres apparaissent une fois ceux-ci qualifiés.</p>` : "";
  return `<section class="card anchor-target" id="pay-qualifier"><div class="section-header"><div><span class="eyebrow">À qualifier</span><h2>${rows.length} paiement${rows.length > 1 ? "s" : ""} « en personne »</h2></div></div>
    ${visible.map(qualifyRow).join("")}
    ${rest.length ? `<details><summary class="act act--ghost act--sm" style="margin-top:.6rem">Afficher les ${rest.length} suivant${rest.length > 1 ? "s" : ""}</summary>${rest.map(qualifyRow).join("")}</details>` : ""}
    ${capped}</section>`;
}

function movementRow(r: LedgerMovement, owner: boolean): string {
  const flags = [r.origin, r.movementType, r.dateEstimated ? "date estimée" : "", r.excludedReason ?? ""].filter(Boolean);
  const amount = r.amountXof < 0 ? `−${fmtFcfa(Math.abs(r.amountXof))}` : fmtFcfa(r.amountXof);
  const retag = r.origin === "wix" && r.targetId ? `<details><summary>Requalifier</summary><form method="post" action="/admin/paiements/tag"><input type="hidden" name="target_id" value="${esc(r.targetId)}"><select name="method">${[...METHODS,"exclu"].map((m) => `<option value="${m}">${esc(paymentMethodLabel(m))}</option>`).join("")}</select><input name="note" required placeholder="Motif du changement"><button class="act act--sm" type="submit">Valider</button></form></details>` : "";
  const reverse = owner && r.origin === "manual" ? `<details><summary>Contre-passer</summary><form method="post" action="/admin/paiements/manuel"><input type="hidden" name="idempotency_key" value="${crypto.randomUUID()}"><input type="hidden" name="movement_type" value="${r.movementType === "payment" ? "refund" : "payment"}"><input type="hidden" name="occurred_at" value="${new Date().toISOString().slice(0,16)}"><input type="hidden" name="amount_xof" value="${Math.abs(r.amountXof)}"><input type="hidden" name="method" value="${esc(r.method)}"><input type="hidden" name="label" value="${esc(`Contre-passation — ${r.label}`)}"><input type="hidden" name="reverses_movement_id" value="${esc(r.sourceId)}"><input name="note" required placeholder="Motif de la correction"><button class="act act--sm" type="submit">Créer le mouvement inverse</button></form></details>` : "";
  return `<tr><td data-label="Date">${fmtDate(r.occurredAt)}</td><td data-label="Mouvement"><b>${esc(r.label)}</b><div class="muted">${flags.map(esc).join(" · ")}</div>${reverse}</td><td data-label="Client">${esc(r.clientName ?? "—")}<div class="muted">${esc(r.clientPhone ?? "")}</div></td><td data-label="Méthode">${esc(r.method ? paymentMethodLabel(r.method) : "À qualifier")}${retag}</td><td data-label="Montant"><b>${amount}</b></td></tr>`;
}

// Rows arrive sorted by occurred_at desc, so a day changes only at a boundary.
// We prepend a header row per Dakar day with its transaction count and net total
// (excluded Wix lines don't count toward net, matching Totaux journaliers).
function movementRows(rows: LedgerMovement[], owner: boolean): string {
  if (!rows.length) return `<p class="muted">Aucun mouvement trouvé.</p>`;
  const groups: Array<{ day: string; rows: LedgerMovement[] }> = [];
  for (const r of rows) {
    const day = dakarDay(r.occurredAt);
    const last = groups[groups.length - 1];
    if (last && last.day === day) last.rows.push(r);
    else groups.push({ day, rows: [r] });
  }
  const body = groups.map(({ day, rows: dayRows }) => {
    const net = dayRows.reduce((n, r) => n + (r.excludedReason ? 0 : r.amountXof), 0);
    const header = `<tr class="day-head"><td colspan="5" data-label=""><b>${esc(day)}</b> · ${dayRows.length} transaction${dayRows.length > 1 ? "s" : ""} · net ${fmtFcfa(net)}</td></tr>`;
    return header + dayRows.map((r) => movementRow(r, owner)).join("");
  }).join("");
  return `<div class="table-wrap"><table class="responsive-table"><thead><tr><th>Date</th><th>Mouvement</th><th>Client</th><th>Méthode</th><th>Montant</th></tr></thead><tbody>${body}</tbody></table></div>`;
}

function manualForm(): string {
  return `<details class="card anchor-target" id="pay-manuel"><summary><span class="eyebrow">Propriétaire</span> <b>Ajouter un mouvement manuel</b></summary>
    <p class="muted">Pour un lien ad hoc, un virement ou un remboursement sans flux natif. Une correction se fait avec un mouvement inverse.</p>
    <form method="post" action="/admin/paiements/manuel">
      <input type="hidden" name="idempotency_key" value="${crypto.randomUUID()}">
      <div class="form-grid"><label>Type<select name="movement_type"><option value="payment">Encaissement</option><option value="refund">Remboursement</option></select></label>
      <label>Date et heure<input name="occurred_at" type="datetime-local" required></label>
      <label>Montant FCFA<input name="amount_xof" type="number" min="1" step="1" required></label>
      <label>Méthode<select name="method">${METHODS.map((m) => `<option value="${m}">${esc(paymentMethodLabel(m))}</option>`).join("")}</select></label>
      <label>Libellé<input name="label" required maxlength="200"></label>
      <label>Référence fournisseur<input name="provider_reference" maxlength="200"></label>
      <label>Flux lié<select name="source_kind"><option value="">Hors commande</option><option value="booking">Cours</option><option value="plan">Clé / abonnement</option><option value="cafe">Bar</option><option value="delivery">Livraison</option></select></label>
      <label>ID du flux lié<input name="source_id" maxlength="200" placeholder="Optionnel"></label>
      <label>Client<input name="client_name" maxlength="200"></label>
      <label>Téléphone<input name="client_phone" maxlength="50"></label></div>
      <label>Note d’audit<textarea name="note" required maxlength="1000"></textarea></label>
      <button class="act" type="submit">Enregistrer le mouvement</button>
    </form></details>`;
}

function jumpNav(d: PaymentsPageData): string {
  const untaggedBadge = d.untagged.length >= 50 ? "50+" : String(d.untagged.length);
  const links = [
    `<a href="#pay-mouvements">Mouvements</a>`,
    d.untagged.length ? `<a href="#pay-qualifier">À qualifier <span class="badge badge--gray">${untaggedBadge}</span></a>` : "",
    `<a href="#pay-totaux">Totaux</a>`,
    `<a href="#pay-filtres">Filtrer</a>`,
    `<a href="#pay-journaliers">Journaliers</a>`,
    d.refundNeeded.length ? `<a href="#pay-remboursements">Remboursements <span class="badge badge--gray">${d.refundNeeded.length}</span></a>` : "",
    d.owner ? `<a href="#pay-manuel">Mouvement manuel</a>` : "",
  ].filter(Boolean);
  return `<nav class="jump-nav jump-nav--sticky" aria-label="Sections">${links.join("")}</nav>`;
}

export function renderPaymentsPage(d: PaymentsPageData): string {
  const alerts = Object.entries(d.excludedCounts).filter(([, n]) => n > 0);
  const filterQuery = new URLSearchParams({ from: d.from, to: d.to, ...(d.method ? { method: d.method } : {}), ...(d.source ? { source: d.source } : {}), ...(d.type ? { type: d.type } : {}) }).toString();
  return `${d.notice ? `<div class="card success">${esc(d.notice)}</div>` : ""}${d.error ? `<div class="card warn">${esc(d.error)}</div>` : ""}
  ${jumpNav(d)}
  <section class="card anchor-target" id="pay-mouvements"><h2>Mouvements</h2><p class="muted">300 lignes maximum à l’écran ; les totaux et l’export portent sur toute la période.</p>${movementRows(d.rows, d.owner)}</section>
  <div class="card${d.sync.lastError ? " warn" : ""}"><b>Synchronisation Wix : ${d.sync.lastSucceededAt ? fmtDate(d.sync.lastSucceededAt) : "jamais réussie"}</b><p class="muted">${d.sync.recordCount} mouvement(s) stocké(s) · réconciliation complète ${d.sync.lastFullReconciledAt ? fmtDate(d.sync.lastFullReconciledAt) : "jamais"}${d.sync.lastError ? ` · dernière erreur : ${esc(d.sync.lastError)}` : ""}</p><p class="muted">Périmètre comptable depuis le ${esc(d.startDate)} : les lignes antérieures ne sont pas couvertes, les dates historiques estimées sont signalées, et les anciennes commandes Wix en XAF sont comptées à parité nominale 1:1 comme XOF (devise d’origine conservée pour audit).</p></div>
  ${alerts.length ? `<div class="card warn"><b>Lignes Wix écartées des totaux</b><p>${alerts.map(([k,n]) => `${esc(k)} : ${n}`).join(" · ")}</p></div>` : ""}
  ${qualifier(d.untagged)}
  <section class="grid-2 anchor-target" id="pay-totaux">${totalCards("Mois en cours", d.currentMonth)}${totalCards("Mois précédent", d.previousMonth)}</section>
  <section class="card anchor-target" id="pay-filtres"><h2>Filtrer</h2><form method="get" action="/admin/paiements" class="form-grid">
    <label>Du<input type="date" name="from" value="${esc(d.from)}" min="${esc(d.startDate)}"></label><label>Au<input type="date" name="to" value="${esc(d.to)}"></label>
    <label>Méthode<select name="method"><option value="">Toutes</option><option value="untagged">À qualifier</option>${METHODS.map((m) => `<option value="${m}"${d.method===m?" selected":""}>${esc(paymentMethodLabel(m))}</option>`).join("")}</select></label>
    <label>Source<select name="source"><option value="">Toutes</option>${["booking","plan","cafe","delivery","manual","wix_ecom","wix_plan"].map((s) => `<option value="${s}"${d.source===s?" selected":""}>${esc(s)}</option>`).join("")}</select></label>
    <label>Type<select name="type"><option value="">Tous</option><option value="payment"${d.type==="payment"?" selected":""}>Encaissements</option><option value="refund"${d.type==="refund"?" selected":""}>Remboursements</option></select></label>
    <button class="act" type="submit">Afficher</button><a class="act act--ghost" href="/admin/paiements/export.csv?${esc(filterQuery)}">Exporter CSV</a></form></section>
  <section class="card anchor-target" id="pay-journaliers"><h2>Totaux journaliers</h2>${dailyTable(d.daily, d)}</section>
  ${d.refundNeeded.length ? `<section class="card anchor-target" id="pay-remboursements"><h2>Remboursements bookings à pointer</h2>${d.refundNeeded.map((b) => `<form class="row between" method="post" action="/admin/bookings/${esc(b.id)}/refund-done"><input type="hidden" name="return_to" value="/admin/paiements"><span><b>${esc(b.service_name)}</b> · ${esc(b.client_name ?? "Client")} · ${fmtFcfa(b.amount_xof)}</span><button class="act act--sm" type="submit">Remboursement effectué</button></form>`).join("")}</section>` : ""}
  ${d.owner ? manualForm() : ""}`;
}

export function csvCell(value: unknown): string {
  let text = String(value ?? "").replaceAll("\r", " ").replaceAll("\n", " ");
  if (/^[=+\-@]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}
