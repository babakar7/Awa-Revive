import type {
  OrderChannel,
  OrderChannelRow,
  OrderDailyPoint,
  OrderHistoryFilters,
  OrderHistoryRow,
  OrderHistoryStats,
  OrderStatusNorm,
  PageResult,
} from "./queries.js";
import { escapeHtml as esc, fmtDate, fmtFcfa } from "./helpers.js";
import { extrasFromJson } from "../lib/cafeMenu.js";

const CHANNEL_LABELS: Record<OrderChannel, string> = {
  SUR_PLACE: "Sur place",
  A_EMPORTER: "À emporter",
  RETRAIT: "À emporter (retrait)",
  LIVRAISON: "Livraison",
};

const CHANNEL_BADGE: Record<OrderChannel, string> = {
  SUR_PLACE: "badge--green",
  A_EMPORTER: "badge--blue",
  RETRAIT: "badge--violet",
  LIVRAISON: "badge--amber",
};

const STATUS_LABELS: Record<OrderStatusNorm, string> = {
  COMPLETED: "Terminée",
  OPEN: "En cours",
  CANCELLED: "Annulée",
};

const STATUS_BADGE: Record<OrderStatusNorm, string> = {
  COMPLETED: "badge--green",
  OPEN: "badge--blue",
  CANCELLED: "badge--gray",
};

export interface HistoriqueCommandesData {
  result: PageResult<OrderHistoryRow>;
  stats: OrderHistoryStats;
  byChannel: OrderChannelRow[];
  daily: OrderDailyPoint[];
  filters: OrderHistoryFilters;
}

function query(args: Record<string, string | number | undefined>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(args)) {
    if (value !== undefined && value !== "" && value !== "all") params.set(key, String(value));
  }
  const out = params.toString();
  return out ? `?${out}` : "";
}

function filterTabs(
  label: string,
  param: "period" | "channel" | "status",
  options: Array<{ value: string; label: string }>,
  filters: OrderHistoryFilters,
): string {
  const current = String(filters[param]);
  const links = options
    .map((opt) => {
      const active = current === opt.value;
      const href = `/admin/historique-commandes${query({
        period: filters.period,
        channel: filters.channel,
        status: filters.status,
        [param]: opt.value,
        page: undefined,
      })}`;
      return `<a href="${href}" class="${active ? "active" : ""}"${active ? ' aria-current="page"' : ""}>${esc(opt.label)}</a>`;
    })
    .join("");
  return `<nav class="filters" aria-label="${esc(label)}">${links}</nav>`;
}

function pagination(page: PageResult<unknown>, filters: OrderHistoryFilters): string {
  if (page.pages <= 1) return "";
  const base = { period: filters.period, channel: filters.channel, status: filters.status };
  return `<nav class="pagination" aria-label="Pagination">
    ${page.page > 1 ? `<a class="act act--ghost act--sm" href="/admin/historique-commandes${query({ ...base, page: page.page - 1 })}">Précédent</a>` : "<span></span>"}
    <span>Page <b>${page.page}</b> sur ${page.pages}</span>
    ${page.page < page.pages ? `<a class="act act--ghost act--sm" href="/admin/historique-commandes${query({ ...base, page: page.page + 1 })}">Suivant</a>` : "<span></span>"}
  </nav>`;
}

function trend(current: number, previous: number, period: string): string {
  if (period === "all") return "sur tout l’historique";
  if (previous === 0) return current === 0 ? "stable" : "nouvelle activité";
  const value = Math.round(((current - previous) / previous) * 100);
  return `${value >= 0 ? "+" : ""}${value} % vs période précédente`;
}

/** Compact "2× Café · 1× Jus… +2" summary from an items_json blob. */
function itemsSummary(itemsJson: unknown): string {
  const lines = extrasFromJson(itemsJson);
  if (lines.length === 0) return "<span class=\"muted\">—</span>";
  const shown = lines.slice(0, 3).map((l) => `${l.qty}× ${esc(l.name)}`);
  const extra = lines.length - shown.length;
  return `${shown.join(" · ")}${extra > 0 ? ` <span class="muted">+${extra}</span>` : ""}`;
}

function trendBars(daily: OrderDailyPoint[]): string {
  if (daily.length === 0) return "";
  const max = Math.max(1, ...daily.map((d) => d.revenueXof));
  const bars = daily
    .map((d) => {
      const pct = d.revenueXof > 0 ? Math.max(4, Math.round((d.revenueXof / max) * 100)) : 0;
      const zero = d.revenueXof === 0;
      const label = d.day.slice(8, 10); // day-of-month
      const title = `${d.day} · ${d.orders} cmd · ${fmtFcfa(d.revenueXof)}`;
      return `<div class="trend-col"><div class="trend-track"><div class="trend-bar${zero ? " is-zero" : ""}" style="height:${pct}%" title="${esc(title)}"></div></div><span class="trend-label">${esc(label)}</span></div>`;
    })
    .join("");
  return `<div class="section-header"><div><span class="eyebrow">Tendance</span><h2>Revenu par jour</h2></div></div>
<div class="card"><div class="trend-bars">${bars}</div></div>`;
}

function orderRow(row: OrderHistoryRow): string {
  const client = row.client_id
    ? `<a href="/admin/conversations/${esc(row.client_id)}">${esc(row.heading || "Client")}</a>`
    : esc(row.heading || "Client");
  const detail = row.detail ? `<div class="muted">${esc(row.detail)}</div>` : "";
  return `<tr>
<td data-label="Quand">${fmtDate(row.created_at)}</td>
<td data-label="Canal"><span class="badge ${CHANNEL_BADGE[row.channel]}">${esc(CHANNEL_LABELS[row.channel])}</span></td>
<td data-label="Client"><b>${client}</b>${detail}</td>
<td data-label="Articles">${itemsSummary(row.items_json)}</td>
<td data-label="Montant"><b>${fmtFcfa(row.amount_xof)}</b></td>
<td data-label="Statut"><span class="badge ${STATUS_BADGE[row.status]}">${esc(STATUS_LABELS[row.status])}</span></td>
</tr>`;
}

function renderHistoriqueBody(data: HistoriqueCommandesData): string {
  const { result, stats, byChannel, daily, filters } = data;
  const periodOptions = [
    { value: "today", label: "Aujourd’hui" },
    { value: "7", label: "7 jours" },
    { value: "30", label: "30 jours" },
    { value: "all", label: "Tout" },
  ];
  const channelOptions = [
    { value: "all", label: "Tous canaux" },
    { value: "SUR_PLACE", label: "Sur place" },
    { value: "A_EMPORTER", label: "À emporter" },
    { value: "RETRAIT", label: "Retrait" },
    { value: "LIVRAISON", label: "Livraison" },
  ];
  const statusOptions = [
    { value: "all", label: "Tous statuts" },
    { value: "COMPLETED", label: "Terminées" },
    { value: "OPEN", label: "En cours" },
    { value: "CANCELLED", label: "Annulées" },
  ];

  const channelCards = byChannel
    .map(
      (c) =>
        `<div><span>${esc(CHANNEL_LABELS[c.channel])}</span><b>${fmtFcfa(c.revenueXof)}</b><span>${c.orders} commande${c.orders > 1 ? "s" : ""}</span></div>`,
    )
    .join("");

  const rows = result.rows.map(orderRow).join("");
  const table = rows
    ? `<div class="table-wrap"><table class="responsive-table"><thead><tr><th>Quand</th><th>Canal</th><th>Client</th><th>Articles</th><th>Montant</th><th>Statut</th></tr></thead><tbody>${rows}</tbody></table></div>`
    : `<div class="empty"><b>Aucune commande</b><p>Aucune commande ne correspond à ces filtres.</p></div>`;

  const qs = query({
    period: filters.period,
    channel: filters.channel,
    status: filters.status,
    page: filters.page > 1 ? filters.page : undefined,
  });
  return `<div id="oh-fragment" data-qs="${esc(qs)}">
${filterTabs("Filtrer par période", "period", periodOptions, filters)}
${filterTabs("Filtrer par canal", "channel", channelOptions, filters)}
${filterTabs("Filtrer par statut", "status", statusOptions, filters)}
<div class="stat-grid report-stat-grid">
  <div class="stat"><span>Commandes terminées</span><b>${stats.completed}</b><span>${trend(stats.completed, stats.previousCompleted, filters.period)}</span></div>
  <div class="stat"><span>Revenu articles</span><b>${fmtFcfa(stats.revenueXof)}</b><span>${trend(stats.revenueXof, stats.previousRevenueXof, filters.period)}</span></div>
  <div class="stat"><span>Panier moyen</span><b>${fmtFcfa(stats.avgTicketXof)}</b><span>par commande terminée</span></div>
  <div class="stat"><span>Annulées / en cours</span><b>${stats.cancelled} / ${stats.open}</b><span>sur la période</span></div>
</div>
<div class="section-header"><div><span class="eyebrow">Financier</span><h2>Revenu par canal</h2></div><b>${fmtFcfa(stats.revenueXof)}</b></div>
<div class="card report-breakdown">${channelCards}</div>
${trendBars(daily)}
<div class="section-header"><div><span class="eyebrow">Détail</span><h2>Commandes</h2></div><span class="badge badge--gray">${result.total}</span></div>
<div class="card">${table}</div>
${pagination(result, filters)}
<p class="muted" style="margin-top:1rem;font-size:.8rem;line-height:1.5">Les montants des commandes en salle (sur place) sont indicatifs — le POS reste la seule source comptable. Le revenu articles exclut les frais de livraison.${stats.firstOrderAt ? ` Historique unifié depuis le ${fmtDate(stats.firstOrderAt)} ; les commandes plus anciennes figurent avec un détail réduit.` : ""}</p>
</div>`;
}

const OH_BASE = "/admin/historique-commandes";

/** Just the filter-driven content — served on its own for in-place updates. */
export function renderHistoriqueFragment(data: HistoriqueCommandesData): string {
  return renderHistoriqueBody(data);
}

/** Full page: static header + the swappable fragment + the client enhancer. */
export function renderHistoriqueCommandes(data: HistoriqueCommandesData): string {
  return `<header class="page-header"><div class="page-header-copy"><span class="eyebrow">Bar &amp; restaurant</span><h2>Historique des commandes</h2><p>Toutes les commandes — sur place, à emporter, retrait, livraison — avec leur chiffre d’affaires.</p></div></header>
<div id="oh-root" aria-busy="false">${renderHistoriqueBody(data)}</div>
<script>
(function(){
  var root=document.getElementById('oh-root');
  if(!root||!window.history||!window.fetch)return; // no-JS / old browser → plain links still work
  var base=${JSON.stringify(OH_BASE)};
  var loading=false;
  function fragment(){return document.getElementById('oh-fragment');}
  function load(search,push){
    if(loading)return;
    loading=true;root.setAttribute('aria-busy','true');
    fetch(base+'/fragment'+search,{headers:{Accept:'text/html'},credentials:'same-origin'})
      .then(function(r){if(!r.ok)throw new Error('bad');return r.text();})
      .then(function(html){
        var cur=fragment();
        if(cur)cur.outerHTML=html;
        if(push)history.pushState({ohSearch:search},'',base+search);
      })
      .catch(function(){window.location.href=base+search;}) // fall back to a real navigation
      .finally(function(){loading=false;root.setAttribute('aria-busy','false');});
  }
  root.addEventListener('click',function(ev){
    if(ev.defaultPrevented||ev.button!==0||ev.metaKey||ev.ctrlKey||ev.shiftKey||ev.altKey)return;
    var a=ev.target.closest&&ev.target.closest('a');
    if(!a)return;
    var href=a.getAttribute('href')||'';
    if(href.indexOf(base)!==0)return; // only our filter/pagination links
    ev.preventDefault();
    load(href.slice(base.length),true);
  });
  window.addEventListener('popstate',function(ev){
    var search=(ev.state&&ev.state.ohSearch)||window.location.search||'';
    load(search,false);
  });
})();
</script>`;
}
