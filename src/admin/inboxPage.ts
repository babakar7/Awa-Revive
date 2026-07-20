import { config } from "../config.js";
import type { AdminStats } from "./queries.js";
import type { NavBadges } from "./navBadges.js";
import { ago, escapeHtml, fmtDate, fmtFcfa } from "./helpers.js";

export interface InboxData {
  refunds: any[];
  planActivations: any[];
  openHandoffs: any[];
  openReviews: any[];
  crmLinks: number;
  livraisonAlerts: { late: number; kitchenFailed: number; clientFailed: number; open: number };
  stats: AdminStats;
  badges: NavBadges;
  adminUser: string;
}

function clearState(title: string, detail: string): string {
  return `<div class="empty"><span class="empty-icon" aria-hidden="true">✓</span><b>${escapeHtml(title)}</b><p>${escapeHtml(detail)}</p></div>`;
}

/** Home « À faire » — one prioritized operational queue. */
export function renderInbox(d: InboxData): string {
  const refundTasks = d.refunds
    .map(
      (b) => `<article class="task-item">
  <span class="task-priority danger" aria-hidden="true"></span>
  <div class="task-copy">
    <b>Rembourser ${escapeHtml(b.client_name ?? "Client")}</b>
    <p>${escapeHtml(b.service_name)} · ${fmtDate(b.slot_start)} · ${b.participants} place(s)</p>
    <div class="task-meta"><a href="/admin/conversations/${b.client_id}">Voir la conversation</a><span class="badge badge--red">${fmtFcfa(b.amount_xof)}</span><span class="muted">Wave ${escapeHtml(b.wave_session_id ?? "—")}</span></div>
  </div>
  <div class="task-action"><form class="inline" method="post" action="/admin/bookings/${b.id}/refund-done" data-confirm="Confirmer que le remboursement de ${fmtFcfa(b.amount_xof)} a bien été effectué dans le portail Wave."><button class="act act--ok act--sm">Remboursement effectué</button></form></div>
</article>`,
    )
    .join("");

  const activationTasks = d.planActivations
    .map(
      (p) => `<article class="task-item">
  <span class="task-priority warn" aria-hidden="true"></span>
  <div class="task-copy">
    <b>Activer l’abonnement de ${escapeHtml(p.client_name ?? "Client")}</b>
    <p>${escapeHtml(p.plan_name)} · payé ${fmtDate(p.updated_at)}</p>
    <div class="task-meta"><a href="/admin/conversations/${p.client_id}">Voir la conversation</a><span class="badge badge--amber">${fmtFcfa(p.amount_xof)}</span></div>
  </div>
  <div class="task-action"><form class="inline" method="post" action="/admin/plan-orders/${p.id}/activated" data-confirm="Confirmer que cet abonnement a bien été attribué au client dans Wix."><button class="act act--ok act--sm">Abonnement activé</button></form></div>
</article>`,
    )
    .join("");

  const handoffTasks = d.openHandoffs
    .map(
      (h) => `<article class="task-item">
  <span class="task-priority warn" aria-hidden="true"></span>
  <div class="task-copy">
    <b>${escapeHtml(h.client_name ?? "Client")} attend la réception</b>
    <p>${escapeHtml(h.reason ?? "Demande transmise à l’équipe")}</p>
    <div class="task-meta"><span class="muted">${ago(h.created_at)} · +${escapeHtml(h.wa_phone)}</span><a href="/admin/conversations/${h.client_id}">Ouvrir la conversation</a></div>
  </div>
  <div class="task-action"><form class="inline" method="post" action="/admin/handoffs/${h.id}/done"><button class="act act--ok act--sm">Marquer traité</button></form></div>
</article>`,
    )
    .join("");

  const reviewTasks = d.openReviews
    .slice(0, 15)
    .map((r) => `<article class="task-item">
  <span class="task-priority ${r.severity === "severe" ? "danger" : "warn"}" aria-hidden="true"></span>
  <div class="task-copy">
    <b>Reprendre ${escapeHtml(r.client_name ?? "cette conversation")}</b>
    <p>${escapeHtml((r.summary ?? "Conversation restée sans issue").slice(0, 150))}</p>
    <div class="task-meta">${r.severity === "severe" ? '<span class="badge badge--red">Priorité haute</span>' : '<span class="badge badge--amber">À reprendre</span>'}<span class="muted">${ago(r.created_at)}</span>${r.suggested_action ? `<span class="muted">Prochaine étape : ${escapeHtml(r.suggested_action)}</span>` : ""}</div>
  </div>
  <div class="task-action"><a class="act act--ghost act--sm" href="/admin/conversations/${r.client_id}">Voir le fil</a><a class="act act--sm" href="/admin/reviews">Traiter</a></div>
</article>`)
    .join("");

  const L = d.livraisonAlerts;
  const followUpCount = d.openHandoffs.length + d.openReviews.length + d.crmLinks + L.late + L.kitchenFailed + L.clientFailed;
  const s = d.stats;
  const total = d.badges.total;
  const now = new Date().toLocaleString("fr-FR", {
    timeZone: config.TIMEZONE,
    weekday: "long",
    day: "numeric",
    month: "long",
    hour: "2-digit",
    minute: "2-digit",
  });

  return `
<header class="page-header">
  <div class="page-header-copy"><span class="eyebrow">Centre d’opérations</span><h2>Priorités du jour</h2><p>${total ? `<b>${total}</b> action(s) attendent l’équipe.` : "Tout est à jour."} Connecté : ${escapeHtml(d.adminUser)} · ${escapeHtml(now)}</p></div>
  <div class="page-header-actions"><a class="act act--ghost" href="/admin/conversations">Rechercher un client</a></div>
</header>

${
  total === 0
    ? `<div class="card success">${clearState("Rien d’urgent", "La file est vide. Vous pouvez rechercher un client ou ouvrir une section dans la navigation.")}</div>`
    : ""
}

<div class="section-header"><div><span class="eyebrow">Financier</span><h2>Paiements à finaliser</h2></div><span class="badge ${d.refunds.length + d.planActivations.length ? "badge--red" : "badge--green"}">${d.refunds.length + d.planActivations.length} en attente</span></div>
<div class="card">
  <div class="task-list">${refundTasks}${activationTasks}</div>
  ${!d.refunds.length && !d.planActivations.length ? clearState("Paiements à jour", "Aucun remboursement ni abonnement à activer.") : ""}
</div>

<div class="section-header"><div><span class="eyebrow">Suivi client</span><h2>Interventions humaines</h2></div><span class="badge ${followUpCount ? "badge--amber" : "badge--green"}">${followUpCount} signalement(s)</span></div>
<div class="card">
  <div class="task-list">
    ${handoffTasks}${reviewTasks}
    ${d.crmLinks ? `<article class="task-item"><span class="task-priority warn" aria-hidden="true"></span><div class="task-copy"><b>${d.crmLinks} liaison(s) CRM à vérifier</b><p>Des comptes clients attendent un rapprochement ou une décision.</p></div><div class="task-action"><a class="act act--ghost act--sm" href="/admin/crm#liaisons">Ouvrir le CRM</a></div></article>` : ""}
    ${L.late + L.kitchenFailed + L.clientFailed ? `<article class="task-item"><span class="task-priority danger" aria-hidden="true"></span><div class="task-copy"><b>Livraisons à surveiller</b><p>${[L.late ? `${L.late} en retard` : "", L.kitchenFailed ? `${L.kitchenFailed} cuisine non notifiée` : "", L.clientFailed ? `${L.clientFailed} client non prévenu` : ""].filter(Boolean).join(" · ")}</p><div class="task-meta"><span class="muted">${L.open} commande(s) ouverte(s)</span></div></div><div class="task-action"><a class="act act--ghost act--sm" href="/admin/livraisons">Voir les livraisons</a></div></article>` : ""}
  </div>
  ${!followUpCount ? clearState("Clients à jour", "Aucun handoff, reprise, problème CRM ou livraison en alerte.") : ""}
</div>

<div class="section-header"><div><span class="eyebrow">Aujourd’hui</span><h2>Activité du studio</h2></div></div>
<div class="stat-grid">
  <div class="stat"><span>Messages reçus</span><b>${s.msgToday}</b><span>${s.msg7d} sur 7 jours</span></div>
  <div class="stat"><span>Clients actifs</span><b>${s.activeClientsToday}</b><span>${s.activeClients7d} sur 7 jours</span></div>
  <div class="stat"><span>Réservations</span><b>${s.bookingsToday}</b><span>${s.bookings7d} sur 7 jours</span></div>
  <div class="stat"><span>Encaissé</span><b>${fmtFcfa(s.revenueToday)}</b><span>${fmtFcfa(s.revenue7d)} sur 7 jours</span></div>
</div>`;
}
