import type { AdminReport } from "./queries.js";
import type { AdminAuditRow } from "../domain/adminOperations.js";
import { ago, escapeHtml as esc, fmtDate, fmtFcfa } from "./helpers.js";

function trend(current: number, previous: number): string {
  if (previous === 0) return current === 0 ? "stable" : "nouvelle activité";
  const value = Math.round(((current - previous) / previous) * 100);
  return `${value >= 0 ? "+" : ""}${value} % vs période précédente`;
}

export function renderAdminReport(report: AdminReport, canViewAudit = false): string {
  const revenue = report.bookingRevenue + report.planRevenue + report.cafeRevenue;
  const conversion = report.activeClients ? Math.round((report.bookings / report.activeClients) * 100) : null;
  return `<header class="page-header"><div class="page-header-copy"><span class="eyebrow">Pilotage</span><h2>Rapport du studio</h2><p>Activité, encaissements et qualité comparés à la période précédente.</p></div>${canViewAudit ? `<div class="page-header-actions"><a class="act act--ghost" href="/admin/journal">Journal des actions</a></div>` : ""}</header>
<nav class="filters" aria-label="Période"><a href="/admin/rapport?period=today" class="${report.periodDays === 1 ? "active" : ""}">Aujourd’hui</a><a href="/admin/rapport?period=7" class="${report.periodDays === 7 ? "active" : ""}">7 jours</a><a href="/admin/rapport?period=30" class="${report.periodDays === 30 ? "active" : ""}">30 jours</a></nav>
<div class="stat-grid report-stat-grid">
  <div class="stat"><span>Messages reçus</span><b>${report.messages}</b><span>${trend(report.messages, report.previousMessages)}</span></div>
  <div class="stat"><span>Clients actifs</span><b>${report.activeClients}</b><span>${trend(report.activeClients, report.previousActiveClients)}</span></div>
  <div class="stat"><span>Réservations</span><b>${report.bookings}</b><span>${conversion === null ? "—" : `${conversion} réservations / 100 clients actifs`}</span></div>
  <div class="stat"><span>Clients servis</span><b>${report.servedRate === null ? "—" : `${report.servedRate} %`}</b><span>hors abandons libres</span></div>
</div>
<div class="section-header"><div><span class="eyebrow">Financier</span><h2>Encaissements enregistrés</h2></div><b>${fmtFcfa(revenue)}</b></div>
<div class="card report-breakdown"><div><span>Cours</span><b>${fmtFcfa(report.bookingRevenue)}</b></div><div><span>Abonnements</span><b>${fmtFcfa(report.planRevenue)}</b></div><div><span>Bar</span><b>${fmtFcfa(report.cafeRevenue)}</b></div><div><span>Comparaison</span><b>${trend(revenue, report.previousRevenue)}</b></div></div>
<div class="section-header"><div><span class="eyebrow">Service client</span><h2>Charge de suivi</h2></div></div>
<div class="card row between"><div><b>${report.openFollowUps} suivi(s) ouvert(s)</b><p class="muted">${report.oldestFollowUpAt ? `Le plus ancien date de ${ago(report.oldestFollowUpAt)}.` : "La file est à jour."}</p></div><a class="act act--ghost" href="/admin/suivi">Ouvrir la file</a></div>`;
}

const ACTION_LABELS: Record<string, string> = {
  "follow_up.resolved": "Suivi clôturé",
  "conversation.takeover_started": "Relais humain démarré",
  "conversation.takeover_ended": "Conversation rendue à Awa",
  "conversation.message_sent": "Message client envoyé",
  "conversation.message_failed": "Échec d’envoi client",
};

export function renderAuditPage(rows: AdminAuditRow[]): string {
  const body = rows.map((row) => `<tr><td data-label="Quand">${fmtDate(row.created_at)}</td><td data-label="Compte"><b>${esc(row.admin_user)}</b><div class="muted">${esc(row.admin_role)}</div></td><td data-label="Action">${esc(ACTION_LABELS[row.action] ?? row.action)}</td><td data-label="Cible">${row.target_type === "client" && row.target_id ? `<a href="/admin/conversations/${esc(row.target_id)}">Client</a>` : esc(row.target_type ?? "—")}</td></tr>`).join("");
  return `<header class="page-header"><div class="page-header-copy"><span class="eyebrow">Contrôle</span><h2>Journal des actions</h2><p>Les dernières actions sensibles effectuées dans l’administration.</p></div></header><div class="card">${body ? `<div class="table-wrap"><table class="responsive-table"><thead><tr><th>Quand</th><th>Compte</th><th>Action</th><th>Cible</th></tr></thead><tbody>${body}</tbody></table></div>` : `<div class="empty"><b>Aucune action enregistrée</b><p>Le journal se remplira avec les prochains suivis et relais humains.</p></div>`}</div>`;
}
