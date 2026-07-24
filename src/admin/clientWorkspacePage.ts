import crypto from "node:crypto";
import { config } from "../config.js";
import type { ClientWorkspace, AdminTurn, AdminQueueItem } from "./queries.js";
import { badge, escapeHtml as esc, fmtDate, fmtFcfa } from "./helpers.js";
import { isAwaDisengaged, isHumanTakeoverActive } from "../domain/adminOperations.js";
import { resolutionForm } from "./followUpPage.js";

function empty(text: string): string {
  return `<div class="empty compact-empty"><b>Rien à afficher</b><p>${esc(text)}</p></div>`;
}

export function renderThread(turns: AdminTurn[], clientId: string, canRetry: boolean): string {
  return timeline(turns, clientId, canRetry) || empty("Cette conversation ne contient encore aucun message.");
}

/** Change signature of a thread: new turn or delivery-status flip ⇒ new value. */
export function threadSignature(turns: AdminTurn[]): string {
  const h = crypto.createHash("sha1");
  for (const turn of turns) {
    h.update(`${new Date(turn.created_at).getTime()}|${turn.delivery_status ?? ""}|${turn.error ?? ""};`);
  }
  return h.digest("hex").slice(0, 16);
}

function timeline(turns: AdminTurn[], clientId: string, canRetry: boolean): string {
  return turns.map((turn) => {
    if (turn.role === "tool") {
      return `<details class="tool"><summary>Détail technique · ${esc(turn.content.slice(0, 72))}…</summary><pre>${esc(turn.content)}</pre></details>`;
    }
    const human = turn.source === "admin";
    const side = turn.role === "user" ? "user" : "assistant";
    const delivery = human && turn.delivery_status !== "sent"
      ? `<span class="badge ${turn.delivery_status === "failed" ? "badge--red" : "badge--amber"}">${turn.delivery_status === "failed" ? "Échec" : "Envoi…"}</span>`
      : "";
    const retry = human && turn.delivery_status === "failed" && canRetry && !turn.content.startsWith("Relance Revive (")
      ? `<form method="post" action="/admin/conversations/${esc(clientId)}/reply" class="inline retry-send"><input type="hidden" name="request_key" value="${crypto.randomUUID()}"><input type="hidden" name="mode" value="text"><input type="hidden" name="body" value="${esc(turn.content)}"><button class="act act--ghost act--sm" type="submit">Réessayer</button></form>`
      : "";
    return `<div class="turnrow ${side}${human ? " human-turn" : ""}"><div class="bubble ${side}">${human ? `<span class="human-label">${esc(turn.sent_by ?? "Équipe Revive")}</span>` : ""}${esc(turn.content)}</div><span class="muted">${fmtDate(turn.created_at)} ${delivery}${turn.error ? ` · ${esc(turn.error)}` : ""} ${retry}</span></div>`;
  }).join("");
}

function operationalHistory(data: ClientWorkspace): string {
  const bookings = data.bookings.map((row) => `<tr><td>${fmtDate(row.created_at)}</td><td><b>${esc(row.service_name)}</b><div class="muted">${fmtDate(row.slot_start)}</div></td><td>${fmtFcfa(row.amount_xof)}</td><td>${badge(row.status)}</td></tr>`).join("");
  const plans = data.plans.map((row) => `<tr><td>${fmtDate(row.created_at)}</td><td><b>${esc(row.plan_name)}</b></td><td>${fmtFcfa(row.amount_xof)}</td><td>${badge(row.status)}</td></tr>`).join("");
  const orders = [...data.cafeOrders.map((row) => ({ ...row, kind: "Commande bar" })), ...data.deliveries.map((row) => ({ ...row, kind: "Livraison" }))]
    .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
    .map((row) => `<tr><td>${fmtDate(row.created_at)}</td><td><b>${esc(row.kind)}</b>${row.service_name ? `<div class="muted">${esc(row.service_name)}</div>` : ""}</td><td>${fmtFcfa(row.amount_xof)}</td><td>${badge(row.status)}</td></tr>`).join("");
  const docs = [
    ...data.invoices.map((row) => ({ label: `Facture ${row.number}`, href: `/admin/factures/${row.id}`, at: row.created_at })),
    ...data.quotes.map((row) => ({ label: `Devis ${row.number}`, href: `/admin/devis/${row.id}`, at: row.created_at })),
    ...data.giftCards.map((row) => ({ label: `Carte cadeau — ${row.recipient_name}`, href: `/admin/cartes-cadeaux/${row.id}`, at: row.created_at })),
  ].sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime())
    .map((row) => `<li><a href="${esc(row.href)}"><b>${esc(row.label)}</b></a><span class="muted">${fmtDate(row.at)}</span></li>`).join("");
  const table = (rows: string, emptyText: string) => rows ? `<div class="table-wrap"><table><tbody>${rows}</tbody></table></div>` : empty(emptyText);
  return `<div class="workspace-history-grid">
  <details class="card" open><summary><b>Réservations (${data.bookings.length})</b></summary>${table(bookings, "Aucune réservation locale pour ce client.")}</details>
  <details class="card"><summary><b>Abonnements (${data.plans.length})</b></summary>${table(plans, "Aucun abonnement vendu par Awa.")}</details>
  <details class="card"><summary><b>Bar et livraisons (${data.cafeOrders.length + data.deliveries.length})</b></summary>${table(orders, "Aucune commande associée.")}</details>
  <details class="card"><summary><b>Documents (${docs ? docs.split("<li>").length - 1 : 0})</b></summary>${docs ? `<ul class="document-list">${docs}</ul>` : empty("Aucun document associé à ce numéro.")}</details>
</div>`;
}

function followUps(data: ClientWorkspace, clientId: string): string {
  const items: AdminQueueItem[] = [
    ...data.handoffs.filter((row) => row.status === "OPEN").map((row) => ({ ...row, source: "handoff", priority: "normal", title: row.reason ?? "Intervention humaine", detail: row.transcript_excerpt, suggested_action: null })),
    ...data.reviews.filter((row) => row.status === "OPEN").map((row) => ({ ...row, source: "review", priority: row.severity === "severe" ? "high" : "normal", title: row.summary ?? "Conversation à reprendre", detail: row.need_category })),
  ] as AdminQueueItem[];
  if (!items.length) return "";
  return `<section><div class="section-header"><div><span class="eyebrow">À faire</span><h2>Suivi ouvert pour ce client</h2></div><span class="badge badge--amber">${items.length}</span></div><div class="task-list">${items.map((item) => `<article class="task-item"><span class="task-priority ${item.priority === "high" ? "danger" : "warn"}"></span><div class="task-copy"><b>${esc(item.title)}</b><p>${esc(item.suggested_action ?? item.detail ?? "À traiter avec le client")}</p></div><div class="task-action">${resolutionForm(item, `/admin/conversations/${clientId}`)}</div></article>`).join("")}</div></section>`;
}

export function renderClientWorkspace(args: {
  client: any;
  turns: AdminTurn[];
  workspace: ClientWorkspace;
  lastClientMessage: Date | null;
  whatsappWindowOpen: boolean;
  banner: string;
}): string {
  const client = args.client;
  const takeover = isHumanTakeoverActive(client);
  const disengaged = isAwaDisengaged(client);
  const requestKey = crypto.randomUUID();
  const returnPath = `/admin/conversations/${client.id}`;
  // A single "Rendre à Awa" lifts either pause (resumeAwa clears both states).
  // When neither is active, offer both taking over AND silencing a non-serious contact.
  const takeoverControls = takeover || disengaged
    ? `<form method="post" action="${returnPath}/resume" class="inline" data-confirm="Rendre la conversation à Awa maintenant ?"><button class="act act--ghost" type="submit">Rendre à Awa</button></form>`
    : `<form method="post" action="${returnPath}/takeover" class="inline" data-confirm="Awa sera mise en pause pour ce client pendant 12 heures maximum."><button class="act" type="submit">Prendre le relais</button></form><form method="post" action="${returnPath}/disengage" class="inline" data-confirm="Awa cessera de répondre à ce contact (non sérieux) pendant 24 h maximum."><button class="act act--ghost" type="submit">Mettre en pause</button></form>`;
  let composer = "";
  if (takeover) {
    if (!config.ADMIN_HUMAN_REPLY_ENABLED) {
      composer = `<div class="card warn"><b>Réponse admin désactivée</b><p class="muted">Le relais est actif, mais activez ADMIN_HUMAN_REPLY_ENABLED après la recette Meta pour envoyer depuis cette page.</p></div>`;
    } else if (args.whatsappWindowOpen) {
      composer = `<form class="card admin-composer" method="post" action="${returnPath}/reply"><input type="hidden" name="request_key" value="${requestKey}"><input type="hidden" name="mode" value="text"><label>Répondre en tant qu’équipe Revive<textarea name="body" maxlength="1500" required placeholder="Votre message au client…"></textarea></label><div class="row between"><span class="muted">Fenêtre WhatsApp ouverte · envoyé depuis le numéro Awa</span><button class="act" type="submit">Envoyer</button></div></form>`;
    } else if (config.WA_ADMIN_FOLLOWUP_TEMPLATE) {
      composer = `<form class="card admin-composer" method="post" action="${returnPath}/reply" data-confirm="Envoyer le modèle de relance approuvé au client ?"><input type="hidden" name="request_key" value="${requestKey}"><input type="hidden" name="mode" value="template"><p><b>Fenêtre WhatsApp fermée</b></p><p class="muted">Le texte libre n’est plus autorisé. Envoyez le modèle de relance approuvé pour inviter le client à répondre.</p><button class="act" type="submit">Envoyer la relance</button></form>`;
    } else {
      composer = `<div class="card warn"><b>Fenêtre WhatsApp fermée</b><p class="muted">Le client doit écrire à nouveau, ou un modèle WA_ADMIN_FOLLOWUP_TEMPLATE doit être approuvé et configuré.</p></div>`;
    }
  }
  return `${args.banner}
<header class="page-header"><div class="page-header-copy"><span class="eyebrow">Espace client</span><h2>${esc(client.name ?? "(sans nom)")}</h2><p>Conversation, opérations et suivis réunis au même endroit.</p></div><div class="page-header-actions"><a class="act act--ghost" href="https://wa.me/${esc(client.wa_phone)}" target="_blank" rel="noreferrer">Ouvrir WhatsApp</a>${takeoverControls}</div></header>
${takeover ? `<div class="card warn takeover-banner"><b>Relais humain actif</b><span>Awa est en pause jusqu’au ${fmtDate(client.human_takeover_until)} · démarré par ${esc(client.human_takeover_by ?? "l’équipe")}</span></div>` : ""}
${!takeover && disengaged ? `<div class="card warn takeover-banner"><b>Awa en pause — contact non sérieux</b><span>Awa ne répond plus à ce contact jusqu’au ${fmtDate(client.awa_disengaged_until)}${client.awa_disengaged_reason ? ` · ${esc(client.awa_disengaged_reason)}` : ""}</span></div>` : ""}
${followUps(args.workspace, client.id)}
<div class="conversation-shell client-workspace-shell">
  <aside class="card client-summary"><div class="row between"><b>${esc(client.name ?? "(sans nom)")}</b>${client.is_test ? `<span class="badge badge--gray">Équipe</span>` : ""}</div><dl class="client-facts"><div><dt>WhatsApp</dt><dd><a href="https://wa.me/${esc(client.wa_phone)}" target="_blank" rel="noreferrer">+${esc(client.wa_phone)}</a></dd></div><div><dt>Langue</dt><dd>${esc(client.language ?? "—")}</dd></div><div><dt>Email déclaré</dt><dd>${esc(client.claimed_email ?? "—")}</dd></div><div><dt>Dernier message</dt><dd>${fmtDate(args.lastClientMessage)}</dd></div><div><dt>Client depuis</dt><dd>${fmtDate(client.created_at)}</dd></div></dl><form method="post" action="${returnPath}/toggle-test"><input type="hidden" name="value" value="${client.is_test ? "0" : "1"}"><button class="act act--ghost act--sm" type="submit">${client.is_test ? "Retirer le tag Équipe" : "Marquer Équipe/test"}</button></form></aside>
  <div><section class="card thread" id="thread" aria-label="Messages">${renderThread(args.turns, client.id, takeover && config.ADMIN_HUMAN_REPLY_ENABLED && args.whatsappWindowOpen)}</section>${composer}</div>
</div>
<div class="section-header"><div><span class="eyebrow">Historique</span><h2>Activité liée au client</h2></div></div>
${operationalHistory(args.workspace)}
${threadPollScript(returnPath, threadSignature(args.turns))}`;
}

/** Rafraîchit le fil de messages sans recharger la page (le composer et le scroll restent intacts). */
function threadPollScript(returnPath: string, sig: string): string {
  return `<script>
(function(){
  var sig=${JSON.stringify(sig)};
  var url=${JSON.stringify(`${returnPath}/thread`)};
  var base=3500,delay=base,timer=null;
  function nearBottom(){return window.innerHeight+window.scrollY>=document.body.scrollHeight-160;}
  function schedule(ms){clearTimeout(timer);timer=setTimeout(poll,ms);}
  function poll(){
    if(document.visibilityState!=="visible"){schedule(base);return;}
    fetch(url+"?sig="+encodeURIComponent(sig),{headers:{accept:"application/json"}})
      .then(function(res){if(!res.ok)throw new Error(String(res.status));return res.json();})
      .then(function(data){
        delay=base;
        var el=document.getElementById("thread");
        if(el&&data&&data.sig&&data.sig!==sig&&typeof data.html==="string"){
          var stick=nearBottom();
          el.innerHTML=data.html;
          sig=data.sig;
          if(stick)window.scrollTo(0,document.body.scrollHeight);
        }
        schedule(delay);
      })
      .catch(function(){delay=Math.min(delay*2,30000);schedule(delay);});
  }
  document.addEventListener("visibilitychange",function(){if(document.visibilityState==="visible"){delay=base;schedule(250);}});
  schedule(base);
})();
</script>`;
}
