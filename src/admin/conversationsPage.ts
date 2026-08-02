import type { AdminClientRow, PageResult } from "./queries.js";
import { highlightedConversationExcerpt, normalizeConversationSearch } from "./conversationSearch.js";
import { ago, escapeHtml } from "./helpers.js";

export type ConversationPeriod = "all" | "7" | "30";

export interface ConversationListFilters {
  search: string;
  period: ConversationPeriod;
  page: number;
}

const SOURCE_LABEL = { client: "Client", awa: "Awa", team: "Équipe" } as const;

function resultQuery(filters: ConversationListFilters, page = filters.page): string {
  return new URLSearchParams({
    ...(filters.search ? { q: filters.search } : {}),
    ...(filters.period !== "all" ? { period: filters.period } : {}),
    ...(page > 1 ? { page: String(page) } : {}),
  }).toString();
}

function conversationRows(rows: AdminClientRow[], search: string): string {
  const searchTerms = normalizeConversationSearch(search);
  return rows
    .map((client) => {
      const hasMatch = Boolean(client.matched_message && searchTerms.length);
      const message = hasMatch
        ? highlightedConversationExcerpt(client.matched_message ?? "", searchTerms)
        : `${escapeHtml((client.last_message ?? "").slice(0, 110))}${(client.last_message ?? "").length > 110 ? "…" : ""}`;
      const messageMeta = hasMatch
        ? `<span class="badge badge--gray">${SOURCE_LABEL[client.matched_source ?? "awa"]}</span> · ${ago(client.matched_at ?? null)} · ${client.message_count} messages`
        : `${ago(client.last_message_at)} · ${client.message_count} messages`;
      const takeover = client.human_takeover_until && new Date(client.human_takeover_until).getTime() > Date.now();
      return `<tr>
<td data-label="Client"><a class="rowlink" href="/admin/conversations/${client.id}"><b>${escapeHtml(client.name ?? "(sans nom)")}</b>${client.is_test ? ` <span class="badge badge--gray">Équipe</span>` : ""}${takeover ? ` <span class="badge badge--amber">${client.human_takeover_by === "awa-technical-failure" ? "Relais technique Awa" : "Relais humain"}</span>` : ""}${client.awa_disengaged_until && new Date(client.awa_disengaged_until).getTime() > Date.now() ? ` <span class="badge badge--gray">${client.awa_disengaged_kind === "no_intent" ? "Boucle sans intention" : "Awa en pause"}</span>` : ""}<div class="muted">+${escapeHtml(client.wa_phone)}</div></a></td>
<td data-label="${hasMatch ? "Correspondance" : "Dernier message"}" class="${hasMatch ? "conversation-match" : ""}">${message}<div class="muted">${messageMeta}</div></td>
<td data-label="Langue" class="hide-sm"><span class="badge badge--gray">${escapeHtml(client.language ?? "—")}</span></td>
<td data-label=""><a class="act act--ghost act--sm" href="/admin/conversations/${client.id}">Ouvrir</a></td>
</tr>`;
    })
    .join("");
}

/** Shared by the initial SSR page and the live fragment endpoint. */
export function renderConversationResults(
  result: PageResult<AdminClientRow>,
  filters: ConversationListFilters,
): string {
  const rows = conversationRows(result.rows, filters.search);
  const terms = normalizeConversationSearch(filters.search);
  const summary = filters.search
    ? `${result.total} client${result.total === 1 ? "" : "s"} pour « ${escapeHtml(filters.search)} »`
    : `${result.total} client${result.total === 1 ? "" : "s"} classé${result.total === 1 ? "" : "s"} par dernière activité`;
  const previous = result.page > 1
    ? `<a class="act act--ghost act--sm" data-conversation-page href="/admin/conversations?${resultQuery(filters, result.page - 1)}">Précédent</a>`
    : "";
  const next = result.page < result.pages
    ? `<a class="act act--ghost act--sm" data-conversation-page href="/admin/conversations?${resultQuery(filters, result.page + 1)}">Suivant</a>`
    : "";
  return `<section id="conversation-results" class="conversation-results" data-conversation-results data-query="${escapeHtml(filters.search)}" data-period="${filters.period}" data-page="${result.page}" data-total="${result.total}" aria-live="polite">
<p class="conversation-result-summary"><b>${summary}</b></p>
<div class="card">${rows ? `<div class="table-wrap"><table class="responsive-table"><thead><tr><th>Client</th><th>${terms.length ? "Correspondance" : "Dernier message"}</th><th class="hide-sm">Langue</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>` : `<div class="empty"><span class="empty-icon" aria-hidden="true">⌕</span><b>Aucun client trouvé</b><p>Essayez un autre nom, quelques chiffres du numéro ou moins de mots-clés.</p></div>`}</div>
${result.pages > 1 ? `<nav class="pagination" aria-label="Pagination"><span>${previous}</span><span>Page <b>${result.page}</b> sur ${result.pages}</span><span>${next}</span></nav>` : ""}
</section>`;
}

const CONVERSATION_SEARCH_SCRIPT = `<script>
(function(){
  var form=document.querySelector('[data-conversation-search-form]');
  if(!form)return;
  var input=form.querySelector('[data-conversation-search-input]');
  var period=form.querySelector('[data-conversation-period]');
  var clear=form.querySelector('[data-conversation-clear]');
  var status=form.querySelector('[data-conversation-search-status]');
  var reload=form.querySelector('[data-conversation-search-reload]');
  var timer=null,running=false,queued=null,desired='',sequence=0;
  form.classList.add('is-live');

  function useful(value){
    var folded=String(value||'').normalize('NFD').replace(/[\\u0300-\\u036f]/g,'');
    var letters=(folded.match(/[a-z]/gi)||[]).length;
    var digits=(folded.match(/[0-9]/g)||[]).length;
    return letters?letters+digits>=2:digits>=4;
  }
  function state(page){
    var q=input.value.trim();
    return {q:q,period:period.value,page:page||1,valid:!q||useful(q)};
  }
  function params(value,includePage){
    var p=new URLSearchParams();
    if(value.q)p.set('q',value.q);
    if(value.period!=='all')p.set('period',value.period);
    if(includePage&&value.page>1)p.set('page',String(value.page));
    return p;
  }
  function signature(value){return params(value,true).toString()}
  function canonical(value){var q=params(value,true).toString();return '/admin/conversations'+(q?'?'+q:'')}
  function setStatus(message,error){
    status.textContent=message||'';
    status.classList.toggle('conversation-search-error',!!error);
  }
  function syncActions(value){
    var hasQuery=!!value.q,hasPeriod=value.period!=='all';
    clear.hidden=!hasQuery&&!hasPeriod;
    clear.textContent=hasQuery?'Effacer la recherche':'Effacer la période';
    var target={q:hasQuery?'':value.q,period:hasQuery?value.period:'all',page:1};
    clear.href=canonical(target);
  }
  function replaceResults(html,value){
    var template=document.createElement('template');template.innerHTML=html.trim();
    var next=template.content.querySelector('[data-conversation-results]');
    var current=document.querySelector('[data-conversation-results]');
    if(!next||!current)throw new Error('invalid_fragment');
    current.replaceChildren.apply(current,Array.from(next.childNodes));
    Array.from(next.attributes).forEach(function(attr){current.setAttribute(attr.name,attr.value)});
    current.removeAttribute('aria-busy');
    history.replaceState(null,'',canonical(value));
    reload.hidden=true;setStatus('',false);syncActions(value);
  }
  function run(){
    if(running||!queued)return;
    var request=queued;queued=null;running=true;
    var requestSequence=++sequence;
    var results=document.querySelector('[data-conversation-results]');
    if(results)results.setAttribute('aria-busy','true');
    setStatus('Recherche…',false);reload.hidden=true;
    fetch('/admin/conversations/results?'+params(request,true).toString(),{headers:{Accept:'text/html'},credentials:'same-origin'})
      .then(function(response){if(!response.ok)throw new Error(response.status===503?'search_timeout':'search_failed');return response.text()})
      .then(function(html){if(requestSequence===sequence&&signature(request)===desired)replaceResults(html,request)})
      .catch(function(error){
        if(requestSequence!==sequence||signature(request)!==desired)return;
        var current=document.querySelector('[data-conversation-results]');if(current)current.removeAttribute('aria-busy');
        setStatus(error.message==='search_timeout'?'Recherche trop longue. Rechargez la page pour réessayer.':'Recherche momentanément indisponible.',true);
        reload.href=canonical(request);reload.hidden=false;
      })
      .finally(function(){running=false;if(queued&&signature(queued)!==signature(request))run()});
  }
  function enqueue(value){queued=value;run()}
  function schedule(value,immediate){
    clearTimeout(timer);syncActions(value);
    if(!value.valid){
      queued=null;desired='invalid:'+signature(value);reload.hidden=true;
      var current=document.querySelector('[data-conversation-results]');if(current)current.removeAttribute('aria-busy');
      setStatus('Saisissez au moins 2 caractères, ou 4 chiffres pour un numéro.',false);return
    }
    desired=signature(value);
    timer=setTimeout(function(){enqueue(value)},immediate?0:350);
  }
  input.addEventListener('input',function(){schedule(state(1),false)});
  period.addEventListener('change',function(){
    var value=state(1);if(!value.valid){input.value='';value={q:'',period:value.period,page:1,valid:true}}schedule(value,true);
  });
  form.addEventListener('submit',function(event){
    var value=state(1);event.preventDefault();
    if(!value.valid){schedule(value,true);return}
    schedule(value,true);
  });
  clear.addEventListener('click',function(event){
    event.preventDefault();
    if(input.value.trim())input.value='';else period.value='all';
    schedule(state(1),true);input.focus();
  });
  document.addEventListener('click',function(event){
    var link=event.target.closest('[data-conversation-page]');if(!link)return;
    event.preventDefault();var url=new URL(link.href,location.origin);
    input.value=url.searchParams.get('q')||'';period.value=url.searchParams.get('period')||'all';
    var value=state(Number(url.searchParams.get('page')||'1'));schedule(value,true);
  });
  input.addEventListener('keydown',function(event){
    if(event.key==='Escape'&&input.value){event.preventDefault();input.value='';schedule(state(1),true)}
  });
  syncActions(state(1));
})();
</script>`;

export function renderConversationsPage(
  result: PageResult<AdminClientRow>,
  filters: ConversationListFilters,
): string {
  const clearQuery = resultQuery({ ...filters, search: "", page: 1 });
  const clearHref = filters.search
    ? `/admin/conversations${clearQuery ? `?${clearQuery}` : ""}`
    : "/admin/conversations";
  const clearLabel = filters.search ? "Effacer la recherche" : "Effacer la période";
  return `<header class="page-header"><div class="page-header-copy"><span class="eyebrow">Clients</span><h2>Conversations</h2><p>Retrouvez une cliente par son identité ou par le contenu de ses échanges.</p></div></header>
<form method="get" action="/admin/conversations" class="card conversation-filters" data-conversation-search-form role="search">
  <label>Rechercher par nom, numéro ou mots-clés<input type="search" name="q" data-conversation-search-input placeholder="Ex. Marie, 77 123… ou remboursement" value="${escapeHtml(filters.search)}" autocomplete="off"></label>
  <label>Période<select name="period" data-conversation-period><option value="all"${filters.period === "all" ? " selected" : ""}>Toutes</option><option value="7"${filters.period === "7" ? " selected" : ""}>7 jours</option><option value="30"${filters.period === "30" ? " selected" : ""}>30 jours</option></select></label>
  <button class="act conversation-submit" type="submit">Appliquer</button>
  <a class="act act--ghost" data-conversation-clear href="${clearHref}"${!filters.search && filters.period === "all" ? " hidden" : ""}>${clearLabel}</a>
  <span class="conversation-live-status muted" data-conversation-search-status aria-live="polite"></span>
  <a class="conversation-search-reload" data-conversation-search-reload href="/admin/conversations" hidden>Recharger la page</a>
</form>
${renderConversationResults(result, filters)}
${CONVERSATION_SEARCH_SCRIPT}`;
}
