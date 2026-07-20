import type {
  BookingConversionDashboard,
  BookingConversionMetrics,
  FunnelStageMetric,
} from "../domain/bookingFunnel.js";
import { paymentMethodLabel } from "../lib/paymentMethod.js";
import { escapeHtml as esc, fmtDate, fmtFcfa } from "./helpers.js";

const STAGE_LABELS: Record<string, string> = {
  availability_requested: "Disponibilité demandée",
  slots_shown: "Créneaux ouverts montrés",
  slot_selected: "Créneau sélectionné",
  payment_link_created: "Lien de paiement créé",
  payment_confirmed: "Paiement confirmé",
  booked: "Réservation Wix confirmée",
};

const FAILURE_LABELS: Record<string, string> = {
  no_availability: "Aucun créneau disponible",
  slot_already_started: "Cours déjà commencé",
  slot_unavailable: "Créneau devenu indisponible",
  group_capacity: "Capacité groupe insuffisante",
  payment_method_unavailable: "Moyen de paiement indisponible",
  payment_provider_error: "Création du paiement échouée",
  payment_verification_failed: "Vérification du paiement échouée",
  wix_booking_failed: "Création Wix échouée après paiement",
  membership_not_eligible: "Abonnement non éligible",
  membership_balance_insufficient: "Solde abonnement insuffisant",
  membership_booking_failed: "Réservation abonnement échouée",
  client_account_not_found: "Compte client introuvable",
  client_notification_failed: "Confirmation client non livrée",
  unknown: "Échec non classé",
};

function pct(value: number | null): string {
  return value === null ? "—" : `${value.toLocaleString("fr-FR", { maximumFractionDigits: 1 })} %`;
}

function stageAt(metrics: BookingConversionMetrics, stage: string): FunnelStageMetric | undefined {
  return metrics.stages.find((row) => row.stage === stage);
}

function conversionCard(label: string, metrics: BookingConversionMetrics): string {
  return `<article class="card"><span class="eyebrow">${esc(label)}</span><div class="stat-grid">
  <div class="stat"><span>Parcours réels</span><b>${metrics.journeys}</b><span>équipe/tests exclus</span></div>
  <div class="stat"><span>Disponibilité → réservation</span><b>${pct(metrics.overallConversion)}</b><span>conversion commerciale</span></div>
  <div class="stat"><span>Lien → réservation</span><b>${pct(metrics.paymentLinkToBooked)}</b><span>objectif : +10 % relatif</span></div>
  <div class="stat"><span>Réservations</span><b>${stageAt(metrics, "booked")?.journeys ?? 0}</b><span>confirmées dans Wix</span></div>
  </div></article>`;
}

export function renderConversionPage(data: BookingConversionDashboard): string {
  const stages = data.thirtyDays.stages
    .map((row) => {
      const week = stageAt(data.sevenDays, row.stage);
      return `<tr><td data-label="Étape"><b>${esc(STAGE_LABELS[row.stage] ?? row.stage)}</b></td><td data-label="7 jours">${week?.journeys ?? 0}<div class="muted">${pct(week?.rateFromPrevious ?? null)} de l’étape précédente</div></td><td data-label="30 jours">${row.journeys}<div class="muted">${pct(row.rateFromPrevious)} de l’étape précédente</div></td></tr>`;
    })
    .join("");

  const methods = data.thirtyDays.paymentMethods
    .map((row) => `<tr><td data-label="Moyen"><b>${esc(paymentMethodLabel(row.method))}</b></td><td data-label="Liens">${row.links}</td><td data-label="Paiements">${row.confirmed}</td><td data-label="Réservations">${row.booked}</td><td data-label="Lien → résa"><b>${pct(row.linkToBookedRate)}</b></td></tr>`)
    .join("");

  const failures = data.thirtyDays.failures
    .slice(0, 8)
    .map((row) => `<div class="row between"><span>${esc(FAILURE_LABELS[row.code] ?? row.code)}</span><span class="badge badge--amber">${row.count}</span></div>`)
    .join("");

  const incidents = data.incidents
    .map((row) => `<tr><td data-label="Client"><a href="/admin/conversations/${esc(row.client_id)}"><b>${esc(row.client_name ?? "(sans nom)")}</b></a></td><td data-label="Cours">${esc(row.service_name)}</td><td data-label="Paiement">${esc(paymentMethodLabel(row.payment_method))} · ${fmtFcfa(row.amount_xof)}</td><td data-label="État"><span class="badge ${row.status === "PAID" ? "badge--red" : "badge--amber"}">${row.status === "PAID" ? "Payé, réservation à reprendre" : "Remboursement à traiter"}</span><div class="muted">${fmtDate(row.updated_at)}</div></td><td data-label=""><a class="act act--ghost act--sm" href="/admin/conversations/${esc(row.client_id)}">Ouvrir</a></td></tr>`)
    .join("");

  const affected = data.recentFailures
    .map((row) => `<tr><td data-label="Quand">${fmtDate(row.occurred_at)}</td><td data-label="Client"><a href="/admin/conversations/${esc(row.client_id)}">${esc(row.client_name ?? "(sans nom)")}</a></td><td data-label="Cause"><b>${esc(FAILURE_LABELS[row.failure_code] ?? row.failure_code)}</b><div class="muted">${esc(row.stage)}</div></td><td data-label=""><a class="act act--ghost act--sm" href="/admin/conversations/${esc(row.client_id)}">Conversation</a></td></tr>`)
    .join("");

  const recovery = data.thirtyDays.expiryRecovery;
  return `<header class="page-header"><div class="page-header-copy"><span class="eyebrow">Conversion commerciale</span><h2>Parcours de réservation</h2><p>Du premier contrôle de disponibilité à la réservation Wix. Les conversations équipe/test sont exclues.</p></div></header>
<div class="col">${conversionCard("7 derniers jours", data.sevenDays)}${conversionCard("30 derniers jours", data.thirtyDays)}</div>
<div class="section-header"><div><span class="eyebrow">Étapes</span><h2>Où les clients s’arrêtent</h2></div></div>
<div class="card"><div class="table-wrap"><table class="responsive-table"><thead><tr><th>Étape</th><th>7 jours</th><th>30 jours</th></tr></thead><tbody>${stages}</tbody></table></div><p class="muted">Un abandon volontaire reste neutre pour la qualité de service, mais ne compte jamais comme une vente terminée ici.</p></div>
<div class="section-header"><div><span class="eyebrow">Paiements</span><h2>Performance par moyen — 30 jours</h2></div></div>
<div class="card">${methods ? `<div class="table-wrap"><table class="responsive-table"><thead><tr><th>Moyen</th><th>Liens</th><th>Paiements</th><th>Réservations</th><th>Lien → résa</th></tr></thead><tbody>${methods}</tbody></table></div>` : `<div class="empty"><b>Pas encore assez de données</b><p>Les moyens apparaîtront après les prochains liens de paiement.</p></div>`}</div>
<div class="stat-grid report-stat-grid">
  <div class="stat"><span>Liens expirés</span><b>${recovery.expired}</b><span>30 jours</span></div>
  <div class="stat"><span>Relances envoyées</span><b>${recovery.recoverySent}</b><span>one-shot</span></div>
  <div class="stat"><span>Réservations récupérées</span><b>${recovery.recoveredBookings}</b><span>${pct(recovery.recoveryRate)} après relance</span></div>
</div>
<div class="section-header"><div><span class="eyebrow">Sécurité paiement</span><h2>Paiements à reprendre immédiatement</h2></div></div>
<div class="card">${incidents ? `<div class="table-wrap"><table class="responsive-table"><thead><tr><th>Client</th><th>Cours</th><th>Paiement</th><th>État</th><th></th></tr></thead><tbody>${incidents}</tbody></table></div>` : `<div class="empty"><b>Aucun paiement bloqué</b><p>Chaque paiement vérifié a une réservation Wix ou une tâche de remboursement.</p></div>`}</div>
<div class="section-header"><div><span class="eyebrow">Diagnostic</span><h2>Principales causes — 30 jours</h2></div></div>
<div class="card">${failures || `<div class="empty"><b>Aucun échec enregistré</b><p>Les codes apparaîtront avec les prochains parcours.</p></div>`}</div>
<div class="section-header"><div><span class="eyebrow">Drill-down</span><h2>Conversations affectées</h2></div></div>
<div class="card">${affected ? `<div class="table-wrap"><table class="responsive-table"><thead><tr><th>Quand</th><th>Client</th><th>Cause</th><th></th></tr></thead><tbody>${affected}</tbody></table></div>` : `<div class="empty"><b>Aucune conversation affectée</b></div>`}</div>`;
}
