import type { AdminQueueItem, FollowUpSource, PageResult } from "./queries.js";
import { ago, escapeHtml as esc, fmtDate } from "./helpers.js";
import { RESOLUTION_LABELS, RESOLUTION_OUTCOMES } from "../domain/adminOperations.js";

const SOURCE_LABELS: Record<FollowUpSource, string> = {
  handoff: "Handoff",
  review: "À reprendre",
};

function query(args: Record<string, string | number | undefined>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(args)) {
    if (value !== undefined && value !== "") params.set(key, String(value));
  }
  const out = params.toString();
  return out ? `?${out}` : "";
}

function pagination(page: PageResult<unknown>, filters: Record<string, string | number | undefined>): string {
  if (page.pages <= 1) return "";
  return `<nav class="pagination" aria-label="Pagination">
    ${page.page > 1 ? `<a class="act act--ghost act--sm" href="/admin/suivi${query({ ...filters, page: page.page - 1 })}">Précédent</a>` : `<span></span>`}
    <span>Page <b>${page.page}</b> sur ${page.pages}</span>
    ${page.page < page.pages ? `<a class="act act--ghost act--sm" href="/admin/suivi${query({ ...filters, page: page.page + 1 })}">Suivant</a>` : `<span></span>`}
  </nav>`;
}

export function resolutionForm(item: Pick<AdminQueueItem, "id" | "source">, next: string): string {
  return `<details class="resolution-panel">
  <summary class="act act--ok act--sm">Clore le suivi</summary>
  <form method="post" action="/admin/suivi/${item.source}/${esc(item.id)}/resolve" class="resolution-form">
    <input type="hidden" name="next" value="${esc(next)}">
    <label>Résultat<select name="outcome" required><option value="">Choisir…</option>${RESOLUTION_OUTCOMES.map((outcome) => `<option value="${outcome}">${esc(RESOLUTION_LABELS[outcome])}</option>`).join("")}</select></label>
    <label>Note interne <span class="muted">(optionnel)</span><textarea name="note" maxlength="500" placeholder="Contexte utile pour l’équipe…"></textarea></label>
    <button class="act act--ok act--sm" type="submit">Confirmer la clôture</button>
  </form>
</details>`;
}

function queueItem(item: AdminQueueItem): string {
  const done = item.status === "DONE";
  const source = SOURCE_LABELS[item.source];
  return `<article class="task-item follow-up-item${done ? " is-complete" : ""}">
  <span class="task-priority ${item.priority === "high" ? "danger" : "warn"}" aria-hidden="true"></span>
  <div class="task-copy">
    <div class="cluster"><span class="badge ${item.priority === "high" ? "badge--red" : "badge--violet"}">${esc(source)}</span>${done ? `<span class="badge badge--green">${esc(RESOLUTION_LABELS[item.resolution_outcome as keyof typeof RESOLUTION_LABELS] ?? "Traité")}</span>` : ""}</div>
    <b><a href="/admin/conversations/${esc(item.client_id)}">${esc(item.client_name ?? "Client")}</a></b>
    <p>${esc(item.title)}</p>
    <div class="task-meta"><span class="muted">+${esc(item.wa_phone)} · ${ago(item.created_at)}</span>${item.detail ? `<span class="muted">${esc(item.detail.slice(0, 180))}</span>` : ""}${item.suggested_action ? `<span class="muted">Prochaine étape : ${esc(item.suggested_action)}</span>` : ""}</div>
    ${done && item.resolution_note ? `<p class="internal-note"><b>Note :</b> ${esc(item.resolution_note)}</p>` : ""}
  </div>
  <div class="task-action"><a class="act act--ghost act--sm" href="/admin/conversations/${esc(item.client_id)}">Voir le client</a>${done ? `<span class="muted">${esc(item.done_by ?? "équipe")} · ${fmtDate(item.done_at)}</span>` : resolutionForm(item, "/admin/suivi")}</div>
</article>`;
}

export function renderFollowUpPage(args: {
  result: PageResult<AdminQueueItem>;
  source: FollowUpSource | "all";
  status: "OPEN" | "DONE";
  period: string;
  banner: string;
}): string {
  const filters = { source: args.source, status: args.status, period: args.period };
  const rows = args.result.rows.map(queueItem).join("");
  return `${args.banner}
<header class="page-header"><div class="page-header-copy"><span class="eyebrow">Clients</span><h2>Suivi clients</h2><p>Une file partagée pour les demandes transmises et les conversations à reprendre.</p></div><div class="page-header-actions"><span class="badge ${args.status === "OPEN" && args.result.total ? "badge--amber" : "badge--gray"}">${args.result.total} élément(s)</span></div></header>
<form class="card follow-up-filters" method="get" action="/admin/suivi">
  <label>Source<select name="source"><option value="all"${args.source === "all" ? " selected" : ""}>Toutes</option><option value="handoff"${args.source === "handoff" ? " selected" : ""}>Handoffs</option><option value="review"${args.source === "review" ? " selected" : ""}>À reprendre</option></select></label>
  <label>État<select name="status"><option value="OPEN"${args.status === "OPEN" ? " selected" : ""}>Ouverts</option><option value="DONE"${args.status === "DONE" ? " selected" : ""}>Historique traité</option></select></label>
  <label>Période<select name="period"><option value="all"${args.period === "all" ? " selected" : ""}>Toute la période</option><option value="7"${args.period === "7" ? " selected" : ""}>7 jours</option><option value="30"${args.period === "30" ? " selected" : ""}>30 jours</option></select></label>
  <button class="act act--ghost" type="submit">Appliquer</button>
</form>
<div class="task-list">${rows || `<div class="card success"><div class="empty"><span class="empty-icon" aria-hidden="true">✓</span><b>Aucun suivi dans cette vue</b><p>Modifiez les filtres ou revenez plus tard.</p></div></div>`}</div>
${pagination(args.result, filters)}`;
}
