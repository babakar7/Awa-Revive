import type {
  AttendanceDetail,
  AttendanceLeader,
  AttendancePeriod,
  AttendanceSyncState,
} from "../domain/attendanceLeaderboard.js";
import type { WixDeliveryClient } from "../lib/wix.js";
import { ago, escapeHtml, fmtDate } from "./helpers.js";

const PERIODS: Array<{ value: AttendancePeriod; label: string }> = [
  { value: "all", label: "Depuis toujours" },
  { value: "month", label: "Ce mois" },
  { value: "30", label: "30 jours" },
  { value: "90", label: "90 jours" },
  { value: "year", label: "Cette année" },
];

function query(period: AttendancePeriod, extra: Record<string, string> = {}): string {
  return new URLSearchParams({ period, ...extra }).toString();
}

function clientLabel(client: WixDeliveryClient): string {
  return client.name || client.email || client.phone || "Client Wix";
}

function podium(rows: AttendanceLeader[]): string {
  if (!rows.length) return "";
  return `<section class="leaderboard-podium" aria-label="Top clients">${rows.slice(0, 3).map((row, index) => {
    const medals = ["🥇", "🥈", "🥉"];
    return `<article class="leaderboard-podium-card leaderboard-podium-card--${index + 1}">
      <span class="leaderboard-medal" aria-hidden="true">${medals[index]}</span>
      <b>${escapeHtml(row.client_name)}</b>
      <strong>${row.session_count}</strong><span>séance${row.session_count > 1 ? "s" : ""} confirmée${row.session_count > 1 ? "s" : ""}</span>
    </article>`;
  }).join("")}</section>`;
}

function leaderRows(rows: AttendanceLeader[], startRank: number): string {
  return rows.map((row, index) => `<tr>
    <td data-label="Rang"><b>#${startRank + index}</b></td>
    <td data-label="Client"><b>${escapeHtml(row.client_name)}</b>${row.client_phone ? `<div class="muted">+${escapeHtml(row.client_phone)}</div>` : ""}${row.duplicate_profiles > 1 ? `<div><span class="badge badge--amber">${row.duplicate_profiles} fiches Wix</span></div>` : ""}</td>
    <td data-label="Séances"><b>${row.session_count}</b><div class="muted">${row.marked_attended_count} pointée${row.marked_attended_count > 1 ? "s" : ""} présente${row.marked_attended_count > 1 ? "s" : ""}</div></td>
    <td data-label="Dernière séance" class="hide-sm">${fmtDate(row.last_attended_at)}</td>
  </tr>`).join("");
}

function detailCard(client: WixDeliveryClient, detail: AttendanceDetail): string {
  const services = detail.by_service.length
    ? `<ul class="leaderboard-breakdown">${detail.by_service.map((item) => `<li><span>${escapeHtml(item.service_name)}</span><b>${item.attended_count}</b></li>`).join("")}</ul>`
    : `<p class="muted">Aucune séance marquée présente.</p>`;
  const sessions = detail.sessions.length
    ? `<div class="table-wrap"><table class="responsive-table"><thead><tr><th>Cours</th><th>Date</th><th>Pointage Wix</th></tr></thead><tbody>${detail.sessions.map((session) => `<tr><td data-label="Cours">${escapeHtml(session.service_name)}</td><td data-label="Date">${fmtDate(session.session_start)}</td><td data-label="Pointage Wix">${session.marked_attended ? `<span class="badge badge--green">Présente</span>` : `<span class="badge badge--amber">Non pointée</span>`}</td></tr>`).join("")}</tbody></table></div>`
    : "";
  return `<section class="card leaderboard-detail" id="client">
    <div class="section-header"><div><span class="eyebrow">Fiche cliente</span><h2>${escapeHtml(clientLabel(client))}</h2><p>${client.phone ? `+${escapeHtml(client.phone)}` : escapeHtml(client.email ?? "")}</p></div><div class="leaderboard-total"><b>${detail.session_count}</b><span>séance${detail.session_count > 1 ? "s" : ""} confirmée${detail.session_count > 1 ? "s" : ""}</span></div></div>
    <p class="leaderboard-breakdown-note"><b>${detail.marked_attended_count}</b> pointée${detail.marked_attended_count > 1 ? "s" : ""} présente${detail.marked_attended_count > 1 ? "s" : ""} dans Wix · <b>${detail.session_count - detail.marked_attended_count}</b> confirmée${detail.session_count - detail.marked_attended_count > 1 ? "s" : ""} sans pointage.</p>
    <div class="leaderboard-detail-grid"><div><h3>Par cours</h3>${services}</div><div><h3>Dernières séances</h3>${sessions || `<p class="muted">Aucune séance pour cette période.</p>`}</div></div>
  </section>`;
}

export function renderAttendanceLeaderboard(args: {
  period: AttendancePeriod;
  leaders: AttendanceLeader[];
  total: number;
  page: number;
  search: string;
  searchResults: WixDeliveryClient[];
  selectedClient: WixDeliveryClient | null;
  detail: AttendanceDetail | null;
  sync: AttendanceSyncState;
  notice?: string;
}): string {
  const { period, leaders, total, page, search, searchResults, selectedClient, detail, sync, notice } = args;
  const filters = PERIODS.map((item) => `<a class="${item.value === period ? "active" : ""}" href="/admin/classement?${query(item.value)}">${item.label}</a>`).join("");
  const syncText = sync.last_succeeded_at
    ? `Données Wix actualisées ${ago(sync.last_succeeded_at)}.`
    : "Synchronisation Wix en attente.";
  const searchBlock = search
    ? `<section class="card leaderboard-search-results"><h2>Recherche client</h2>${searchResults.length ? `<div class="table-wrap"><table class="responsive-table"><thead><tr><th>Client</th><th>Contact</th><th>Action</th></tr></thead><tbody>${searchResults.map((client) => `<tr><td data-label="Client"><b>${escapeHtml(clientLabel(client))}</b></td><td data-label="Contact">${escapeHtml(client.phone ?? client.email ?? "—")}</td><td data-label=""><a class="act act--ghost act--sm" href="/admin/classement?${query(period, { q: search, client: client.id })}#client">Voir ses présences</a></td></tr>`).join("")}</tbody></table></div>` : `<p class="muted">Aucune fiche Wix trouvée pour « ${escapeHtml(search)} ».</p>`}</section>`
    : "";
  const pages = Math.max(1, Math.ceil(total / 50));
  const pager = pages > 1 ? `<nav class="pagination" aria-label="Pagination du classement"><span>${page > 1 ? `<a class="act act--ghost act--sm" href="/admin/classement?${query(period, { page: String(page - 1) })}">Précédent</a>` : ""}</span><span>Page <b>${page}</b> sur ${pages}</span><span>${page < pages ? `<a class="act act--ghost act--sm" href="/admin/classement?${query(period, { page: String(page + 1) })}">Suivant</a>` : ""}</span></nav>` : "";
  return `<header class="page-header"><div class="page-header-copy"><span class="eyebrow">Présences</span><h2>Classement clients</h2><p>Classement basé sur les séances passées et confirmées dans Wix. Le pointage « présente » reste affiché séparément.</p></div><form method="post" action="/admin/classement/refresh"><button class="act act--ghost" type="submit">Actualiser Wix</button></form></header>
  ${notice ? `<div class="card success">${escapeHtml(notice)}</div>` : ""}
  ${sync.last_error ? `<div class="card warn">⚠️ La dernière synchronisation Wix a échoué. ${escapeHtml(syncText)} Le dernier classement disponible reste affiché.</div>` : `<p class="muted leaderboard-sync">${escapeHtml(syncText)}</p>`}
  <nav class="filters" aria-label="Période du classement">${filters}</nav>
  <form class="card leaderboard-search" method="get" action="/admin/classement" role="search"><input type="hidden" name="period" value="${period}"><label for="attendance-client-search">Rechercher une cliente</label><div><input id="attendance-client-search" name="q" type="search" value="${escapeHtml(search)}" placeholder="Nom, téléphone ou e-mail" minlength="2"><button class="act" type="submit">Rechercher</button></div><p class="muted">Une cliente sans présence enregistrée apparaîtra avec 0 séance.</p></form>
  ${searchBlock}
  ${selectedClient && detail ? detailCard(selectedClient, detail) : ""}
  ${podium(leaders)}
  <section class="card"><div class="section-header"><div><span class="eyebrow">${total} cliente${total > 1 ? "s" : ""}</span><h2>Classement</h2><p class="muted">Grand total : séances passées confirmées. Sous chaque total : celles que Wix indique aussi comme présentes.</p></div></div>${leaders.length ? `<div class="table-wrap"><table class="responsive-table"><thead><tr><th>Rang</th><th>Client</th><th>Séances confirmées</th><th class="hide-sm">Dernière séance</th></tr></thead><tbody>${leaderRows(leaders, (page - 1) * 50 + 1)}</tbody></table></div>${pager}` : `<div class="empty"><b>Aucune séance synchronisée</b><p>Les séances confirmées dans Wix apparaîtront ici après la synchronisation.</p></div>`}</section>`;
}
