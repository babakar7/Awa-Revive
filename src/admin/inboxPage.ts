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

/**
 * Home « À faire » — single inbox for human work. Money always visible;
 * other sections only when non-empty.
 */
export function renderInbox(d: InboxData): string {
  const refundRows = d.refunds
    .map(
      (b) => `<tr>
<td><a href="/admin/conversations/${b.client_id}">${escapeHtml(b.client_name ?? "?")}</a><div class="muted">+${escapeHtml(b.wa_phone)}</div></td>
<td>${escapeHtml(b.service_name)}<div class="muted">${fmtDate(b.slot_start)} · ${b.participants} place(s)</div></td>
<td><b>${fmtFcfa(b.amount_xof)}</b><div class="muted">Wave : ${escapeHtml(b.wave_session_id ?? "?")}</div></td>
<td><form class="inline" method="post" action="/admin/bookings/${b.id}/refund-done" onsubmit="return confirm('Confirmer : le remboursement de ${fmtFcfa(b.amount_xof)} a bien été fait dans le portail Wave ?')"><button class="act">✅ Remboursement effectué</button></form></td>
</tr>`,
    )
    .join("");

  const planRows = d.planActivations
    .map(
      (p) => `<tr>
<td><a href="/admin/conversations/${p.client_id}">${escapeHtml(p.client_name ?? "?")}</a><div class="muted">+${escapeHtml(p.wa_phone)}</div></td>
<td>${escapeHtml(p.plan_name)}<div class="muted">payé ${fmtDate(p.updated_at)}</div></td>
<td><b>${fmtFcfa(p.amount_xof)}</b></td>
<td><form class="inline" method="post" action="/admin/plan-orders/${p.id}/activated" onsubmit="return confirm('Confirmer : l\\'abonnement a bien été attribué au client dans le dashboard Wix ?')"><button class="act">✅ Abonnement activé</button></form></td>
</tr>`,
    )
    .join("");

  const handoffRows = d.openHandoffs
    .map(
      (h) => `<tr>
<td>${ago(h.created_at)}</td>
<td><a href="/admin/conversations/${h.client_id}">${escapeHtml(h.client_name ?? "?")}</a><div class="muted">+${escapeHtml(h.wa_phone)}</div></td>
<td>${escapeHtml(h.reason ?? "")}</td>
<td><form class="inline" method="post" action="/admin/handoffs/${h.id}/done"><button class="act">✅ Traité</button></form></td>
</tr>`,
    )
    .join("");

  const reviewRows = d.openReviews
    .slice(0, 15)
    .map((r) => {
      const severe =
        r.severity === "severe"
          ? `<span class="badge" style="background:#cf222e">grave</span> `
          : "";
      return `<tr>
<td>${severe}<a href="/admin/conversations/${r.client_id}"><b>${escapeHtml(r.client_name ?? "?")}</b></a>
<div class="muted">+${escapeHtml(r.wa_phone)} · ${ago(r.created_at)}</div></td>
<td>${escapeHtml((r.summary ?? "").slice(0, 120))}${r.suggested_action ? `<div class="muted">→ ${escapeHtml(r.suggested_action)}</div>` : ""}</td>
<td><a href="/admin/reviews">Ouvrir</a></td>
</tr>`;
    })
    .join("");

  const s = d.stats;
  const L = d.livraisonAlerts;
  const total = d.badges.total;

  const allClear =
    total === 0
      ? `<div class="card" style="border-color:#1a7f37"><span class="ok">✓ Rien d'urgent — tout est à jour.</span>
<p class="muted" style="margin:.4rem 0 0">Cherche un client en haut, ou ouvre une section à gauche.</p></div>`
      : "";

  return `
<p class="subhead">${total ? `<b>${total}</b> action(s) en attente` : "File d'attente vide"} · connecté : ${escapeHtml(d.adminUser)} · ${new Date().toLocaleString("fr-FR", { timeZone: config.TIMEZONE })}</p>
${allClear}

<h2>💸 Remboursements ${d.refunds.length ? `(${d.refunds.length})` : ""}</h2>
<div class="card ${d.refunds.length ? "warn" : ""}">
${
  d.refunds.length
    ? `<p class="muted">1. Rembourser dans le portail Wave Business → 2. cliquer le bouton.</p>
       <table><tr><th>Client</th><th>Cours</th><th>Montant</th><th></th></tr>${refundRows}</table>`
    : `<span class="ok">✓ Aucun remboursement en attente</span>`
}
</div>

<h2>🎫 Abonnements à activer ${d.planActivations.length ? `(${d.planActivations.length})` : ""}</h2>
<div class="card ${d.planActivations.length ? "warn" : ""}">
${
  d.planActivations.length
    ? `<p class="muted">1. Attribuer la formule au client dans Wix (Abonnements) → 2. cliquer le bouton.</p>
       <table><tr><th>Client</th><th>Formule</th><th>Montant</th><th></th></tr>${planRows}</table>`
    : `<span class="ok">✓ Aucun abonnement en attente d'activation</span>`
}
</div>

${
  d.openHandoffs.length
    ? `<h2>🙋🏼 Handoffs ouverts (${d.openHandoffs.length})</h2>
<div class="card warn">
<p class="muted">Client dont le besoin attend un humain. « Traité » = recontacté ou cas réglé. <a href="/admin/handoffs">Tous les handoffs →</a></p>
<table><tr><th>Quand</th><th>Client</th><th>Motif</th><th></th></tr>${handoffRows}</table>
</div>`
    : ""
}

${
  d.openReviews.length
    ? `<h2>🔁 À reprendre (${d.openReviews.length})</h2>
<div class="card warn">
<p class="muted">Conversations classées impasse / échec. <a href="/admin/reviews">File complète →</a></p>
<table><tr><th>Client</th><th>Résumé</th><th></th></tr>${reviewRows}</table>
</div>`
    : ""
}

${
  d.crmLinks > 0
    ? `<h2>🔗 Liaisons CRM (${d.crmLinks})</h2>
<div class="card warn">
<p><b>${d.crmLinks}</b> demande(s) de liaison compte en attente.
<a href="/admin/crm#liaisons">Ouvrir le CRM →</a></p>
</div>`
    : ""
}

${
  L.late + L.kitchenFailed + L.clientFailed > 0
    ? `<h2>🛵 Livraisons à surveiller</h2>
<div class="card warn">
<ul style="margin:.2rem 0;padding-left:1.2rem">
${L.late ? `<li><b>${L.late}</b> en retard (SLA)</li>` : ""}
${L.kitchenFailed ? `<li><b>${L.kitchenFailed}</b> notif cuisine en échec</li>` : ""}
${L.clientFailed ? `<li><b>${L.clientFailed}</b> client non prévenu (appeler)</li>` : ""}
</ul>
<p style="margin:.4rem 0 0"><a href="/admin/livraisons">Tableau livraisons →</a>
${L.open ? ` <span class="muted">· ${L.open} ouverte(s)</span>` : ""}</p>
</div>`
    : ""
}

<h2>📊 Activité</h2>
<div class="stat-grid">
<div class="stat"><span class="muted">Messages reçus aujourd'hui</span><b>${s.msgToday}</b><span class="muted">${s.msg7d} sur 7 j</span></div>
<div class="stat"><span class="muted">Clients actifs aujourd'hui</span><b>${s.activeClientsToday}</b><span class="muted">${s.activeClients7d} sur 7 j</span></div>
<div class="stat"><span class="muted">Résas confirmées aujourd'hui</span><b>${s.bookingsToday}</b><span class="muted">${s.bookings7d} sur 7 j</span></div>
<div class="stat"><span class="muted">Encaissé aujourd'hui</span><b>${fmtFcfa(s.revenueToday)}</b><span class="muted">${fmtFcfa(s.revenue7d)} sur 7 j</span></div>
</div>`;
}
