import { config } from "../config.js";
import {
  excludes,
  matchesPattern,
  renderMessage,
} from "../domain/notificationRules.js";
import type {
  NotificationLogRow,
  NotificationRuleRow,
  StaffContactRow,
} from "./queries.js";

/**
 * Body HTML for /admin/notifications — server-rendered like the rest of the
 * admin (no framework). Self-contained escaping/formatting so it doesn't import
 * from routes.ts (which imports this file). routes.ts wraps the returned string
 * in layout() and owns all the POST handlers.
 *
 * Refonte UX 2026 : les alertes vivantes s'affichent en cartes d'abord ; le
 * formulaire n'apparaît qu'à la demande (?new=1 / ?edit=<id>). Le ciblage des
 * cours se fait par cases à cocher sur le vrai catalogue Wix (multi-sélection),
 * plus de filtres texte. Les contacts et le journal sont repliés en dessous.
 */

function esc(s: unknown): string {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function fmtDate(d: Date | string | null): string {
  if (!d) return "—";
  return new Date(d).toLocaleString("fr-FR", {
    timeZone: config.TIMEZONE,
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function ago(d: Date | string | null): string {
  if (!d) return "—";
  const mins = Math.round((Date.now() - new Date(d).getTime()) / 60000);
  if (mins < 1) return "à l'instant";
  if (mins < 60) return `il y a ${mins} min`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `il y a ${hours} h`;
  return `il y a ${Math.round(hours / 24)} j`;
}

const LOG_CLASSES: Record<string, string> = {
  sent: "badge--green",
  sent_template: "badge--blue",
  failed: "badge--red",
  suppressed: "badge--gray",
};

/** Human labels for notification_log.source — raw key stays the title attribute. */
const SOURCE_LABELS: Record<string, string> = {
  reception: "réception",
  owner_alert: "alerte gérant",
  new_chat: "nouvelle conv",
  delivery: "livraison",
  invoice: "facture",
  gift_card: "carte cadeau",
  staff_planning: "planning staff",
  fiche_poste: "fiche de poste",
  ops_ticket: "ticket salle",
  test: "test",
  rule: "règle",
  technical: "relais technique",
};

function statusBadge(status: string): string {
  const cls = LOG_CLASSES[status] ?? "badge--gray";
  return `<span class="badge ${cls}">${esc(status)}</span>`;
}

function sourceLabel(source: string): string {
  const label = SOURCE_LABELS[source] ?? source;
  return `<span title="${esc(source)}">${esc(label)}</span>`;
}

/** Sample values so the owner sees how a rule reads before it fires. */
const SAMPLE_VARS: Record<string, string> = {
  class_name: "Aquabike",
  date: "samedi 18 juillet",
  start_time: "10:00",
  end_time: "10:45",
  coach: "Awa",
  booked_count: "8",
  open_spots: "2",
  total_spots: "10",
  classes: "• Aquabike à 10:00 — 8 inscrit(s)\n• Power Yoga à 11:00 — 5 inscrit(s)",
};

export interface NotificationServiceOption {
  id: string;
  name: string;
}

// ---------- targeting: shared read of a rule's courses ----------

interface Targeting {
  /** true = "Tous les cours" (no course restriction). */
  all: boolean;
  /** Explicit service ids the rule targets (empty when `all`). */
  ids: string[];
  /** A legacy pattern rule not yet migrated — its filter text, for a hint. */
  legacyPattern: string | null;
  legacyExclude: string | null;
}

/**
 * Read a rule's course targeting the same way the engine does
 * (matchesRuleService): service_ids wins; then a legacy single service_id; then
 * legacy name patterns; nothing set = all courses. For a legacy pattern rule we
 * resolve the matching catalogue ids so the UI can pre-check them.
 */
function readTargeting(
  r: Pick<NotificationRuleRow, "service_ids" | "service_id" | "class_pattern" | "exclude_pattern">,
  serviceOptions: NotificationServiceOption[],
): Targeting {
  if (r.service_ids && r.service_ids.length > 0) {
    return { all: false, ids: [...r.service_ids], legacyPattern: null, legacyExclude: null };
  }
  if (r.service_id) {
    return { all: false, ids: [r.service_id], legacyPattern: null, legacyExclude: null };
  }
  const pattern = r.class_pattern?.trim() || null;
  const exclude = r.exclude_pattern?.trim() || null;
  if (pattern || exclude) {
    const ids = serviceOptions
      .filter((s) => matchesPattern(s.name, pattern) && !excludes(s.name, exclude))
      .map((s) => s.id);
    return { all: false, ids, legacyPattern: pattern, legacyExclude: exclude };
  }
  return { all: true, ids: [], legacyPattern: null, legacyExclude: null };
}

/** Course chips shown on a rule card (resolved names; unknown id → amber). */
function classChips(
  r: NotificationRuleRow,
  serviceNames: Map<string, string>,
  serviceOptions: NotificationServiceOption[],
): string {
  const t = readTargeting(r, serviceOptions);
  if (t.all) return `<span class="badge badge--gray">Tous les cours</span>`;
  if (t.legacyPattern !== null || (t.ids.length === 0 && r.class_pattern)) {
    // Legacy pattern rule (possibly matching nothing right now) — flag to migrate.
    const filter = `filtre « ${esc(t.legacyPattern ?? r.class_pattern ?? "")} »`;
    const sauf = t.legacyExclude ? ` sauf « ${esc(t.legacyExclude)} »` : "";
    return `<span class="badge badge--violet" title="Règle héritée — éditez-la pour migrer vers une sélection de cours">${filter}${sauf} · à migrer</span>`;
  }
  if (t.ids.length === 0) return `<span class="badge badge--amber">aucun cours ciblé</span>`;
  return t.ids
    .map((id) => {
      const name = serviceNames.get(id);
      return name
        ? `<span class="badge">${esc(name)}</span>`
        : `<span class="badge badge--amber" title="${esc(id)}">cours supprimé de Wix</span>`;
    })
    .join(" ");
}

/** One-line human summary of a rule (used under the label on a card). */
function ruleSummary(r: NotificationRuleRow): string {
  const to =
    r.recipient_kind === "coach"
      ? "coach du cours"
      : `+${esc((r.recipient_phone ?? "").replace(/^\+/, ""))}`;
  const gap = r.suppress_gap_minutes ? ` · regroupe si enchaîné ≤ ${r.suppress_gap_minutes} min` : "";
  const group = r.group_only ? " · cours collectifs" : "";
  return `${r.lead_minutes ?? "?"} min avant le cours${group}${gap} → ${to}`;
}

// ---------- rule form (create + edit) ----------

const LEAD_PRESETS: Array<{ v: number; label: string }> = [
  { v: 15, label: "15 min" },
  { v: 30, label: "30 min" },
  { v: 60, label: "1 h" },
  { v: 120, label: "2 h" },
  { v: 360, label: "6 h" },
];

/** Pre-filled message for a NEW alert — editable, shows the variables in action. */
const DEFAULT_MESSAGE =
  "Bonjour {coach}, rappel pour le cours {class_name} du {date} à {start_time} : {booked_count} inscrit(s).";

function ruleForm(
  edit: NotificationRuleRow | null,
  serviceOptions: NotificationServiceOption[],
): string {
  const v = (x: unknown) => esc(x ?? "");
  const action = edit ? `/admin/notifications/rules/${edit.id}/update` : "/admin/notifications/rules";
  const rkind = edit?.recipient_kind === "phone" ? "phone" : "coach";

  const target = edit
    ? readTargeting(edit, serviceOptions)
    : { all: false, ids: [], legacyPattern: null, legacyExclude: null };
  const checkedIds = new Set(target.ids);
  // Any targeted id absent from the live catalogue still gets a (checked) chip.
  const knownIds = new Set(serviceOptions.map((s) => s.id));
  const extraOptions: NotificationServiceOption[] = target.ids
    .filter((id) => !knownIds.has(id))
    .map((id) => ({ id, name: "Cours indisponible dans Wix" }));
  const allOptions = [...serviceOptions, ...extraOptions];

  const legacyNote = target.legacyPattern
    ? `<p class="internal-note">Règle migrée depuis l'ancien filtre « ${v(target.legacyPattern)} »${target.legacyExclude ? ` (sauf « ${v(target.legacyExclude)} »)` : ""} — vérifiez la sélection puis enregistrez pour la convertir.</p>`
    : "";

  const svcCheckboxes = allOptions
    .map(
      (s) =>
        `<label class="chip-check"><input type="checkbox" name="service_ids" value="${v(s.id)}"${checkedIds.has(s.id) ? " checked" : ""}> ${v(s.name)}</label>`,
    )
    .join("");

  const leadValue = edit?.lead_minutes ?? "";
  const presetChips = LEAD_PRESETS.map(
    (p) =>
      `<button type="button" class="act act--sm act--ghost lead-preset" data-min="${p.v}">${p.label}</button>`,
  ).join("");

  return `
<form method="post" action="${action}" class="notif-form" style="display:flex;flex-direction:column;gap:.9rem">
  <label>Nom de l'alerte
    <input name="label" required value="${v(edit?.label)}" placeholder="Effectif Aquabike — coach H-6">
  </label>

  <fieldset style="display:flex;flex-direction:column;gap:.5rem">
    <legend class="muted">Cours concernés</legend>
    <label class="chip-check chip-check--all"><input type="checkbox" name="all_services" id="all-svcs" value="1"${target.all ? " checked" : ""}> <b>Tous les cours</b></label>
    ${serviceOptions.length === 0 && extraOptions.length === 0 ? `<div class="card warn" style="margin:0">Catalogue Wix momentanément indisponible. Les alertes existantes restent actives ; réessayez pour choisir des cours.</div>` : `<div class="svc-grid" id="svc-grid">${svcCheckboxes}</div>`}
    ${legacyNote}
  </fieldset>

  <div class="row">
    <label style="flex:1;min-width:200px">Prévenir combien de temps avant le cours ?
      <input name="lead_minutes" id="lead-input" type="number" min="0" max="1440" required value="${v(leadValue)}" placeholder="30">
      <span class="muted" style="display:block;margin-top:.35rem">en minutes — <span class="cluster" style="display:inline-flex">${presetChips}</span></span>
    </label>
  </div>

  <fieldset style="display:flex;flex-direction:column;gap:.5rem">
    <legend class="muted">Destinataire</legend>
    <label class="chip-check"><input type="radio" name="recipient_kind" value="coach" id="rk-coach"${rkind === "coach" ? " checked" : ""}> Le coach du cours <span class="muted">(numéro Wix / répertoire)</span></label>
    <label class="chip-check"><input type="radio" name="recipient_kind" value="phone" id="rk-phone"${rkind === "phone" ? " checked" : ""}> Un numéro fixe <span class="muted">(gardien, accueil…)</span></label>
    <label class="phone-field" style="${rkind === "phone" ? "" : "display:none"}">Numéro
      <input name="recipient_phone" value="${v(edit?.recipient_phone)}" placeholder="+221 78 464 43 29">
    </label>
  </fieldset>

  <label>Message
    <textarea name="message_template" id="msg-input" rows="3">${v(edit ? edit.message_template : DEFAULT_MESSAGE)}</textarea>
  </label>
  <p class="muted" style="margin:.1rem 0">Variables : <code>{class_name} {date} {start_time} {end_time} {coach} {booked_count} {open_spots} {total_spots}</code>. La signature « ${esc("merci de ne pas répondre")} » est ajoutée automatiquement.</p>
  <div class="internal-note" id="msg-preview" style="white-space:pre-wrap"></div>

  <details class="resolution-panel">
    <summary class="act act--sm act--ghost" style="cursor:pointer;display:inline-flex">Options avancées</summary>
    <div style="display:flex;flex-direction:column;gap:.6rem;margin-top:.6rem">
      <label>Regrouper les cours enchaînés <span class="muted">(minutes, vide = off)</span>
        <input name="suppress_gap_minutes" type="number" min="0" max="240" value="${v(edit?.suppress_gap_minutes)}" placeholder="60">
        <span class="muted" style="display:block;margin-top:.35rem">N'envoie qu'une alerte si un autre cours du même coach se termine moins de N minutes avant — les cours enchaînés sont listés dans <code>{classes}</code>.</span>
      </label>
      <label class="chip-check" style="align-self:flex-start"><input type="checkbox" name="group_only" value="1"${edit?.group_only ? " checked" : ""}> Cours collectifs uniquement <span class="muted">(exclut les rendez-vous individuels)</span></label>
    </div>
  </details>

  <div class="cluster">
    <button class="act" type="submit">${edit ? "Enregistrer" : "Créer l'alerte"}</button>
    <a class="act act--ghost" href="/admin/notifications">Annuler</a>
  </div>
</form>
<script>
(function(){
  var f=document.querySelector('.notif-form'); if(!f) return;
  var all=f.querySelector('#all-svcs'), grid=f.querySelector('#svc-grid');
  function updGrid(){ if(!grid) return; var off=all&&all.checked; grid.classList.toggle('is-disabled',off);
    grid.querySelectorAll('input').forEach(function(i){ i.disabled=off; }); }
  if(all) all.addEventListener('change',updGrid);
  // Checking a course clears "Tous les cours".
  if(grid) grid.addEventListener('change',function(){ if(all&&all.checked&&f.querySelector('#svc-grid input:checked')){ all.checked=false; updGrid(); } });
  updGrid();

  var rc=f.querySelector('#rk-coach'), rp=f.querySelector('#rk-phone'), pf=f.querySelector('.phone-field');
  function updPhone(){ if(pf) pf.style.display=(rp&&rp.checked)?'':'none'; }
  if(rc) rc.addEventListener('change',updPhone); if(rp) rp.addEventListener('change',updPhone); updPhone();

  var lead=f.querySelector('#lead-input');
  f.querySelectorAll('.lead-preset').forEach(function(b){ b.addEventListener('click',function(){ if(lead) lead.value=b.getAttribute('data-min'); }); });

  var msg=f.querySelector('#msg-input'), prev=f.querySelector('#msg-preview');
  var SAMPLE=${JSON.stringify(SAMPLE_VARS)};
  function updPrev(){ if(!msg||!prev) return; var t=msg.value||'';
    prev.textContent=t ? ('Aperçu : '+t.replace(/\\{(\\w+)\\}/g,function(w,k){ return Object.prototype.hasOwnProperty.call(SAMPLE,k)?SAMPLE[k]:w; })) : ''; }
  if(msg) msg.addEventListener('input',updPrev); updPrev();
})();
</script>`;
}

// ---------- page ----------

export interface NotificationsPageData {
  rules: NotificationRuleRow[];
  contacts: StaffContactRow[];
  log: NotificationLogRow[];
  lastByRule: Map<string, { status: string; error: string | null; created_at: Date }>;
  coachHints: string[];
  serviceOptions: NotificationServiceOption[];
  editRule: NotificationRuleRow | null;
  showNewForm: boolean;
  openSection: "contacts" | "journal" | null;
  banner: string;
  testPhone: string;
  alertsPaused: boolean;
}

export function renderNotificationsPage(d: NotificationsPageData): string {
  const serviceNames = new Map(d.serviceOptions.map((s) => [s.id, s.name]));
  const showForm = Boolean(d.editRule) || d.showNewForm;

  const ruleCards = d.rules
    .map((r) => {
      const preview = esc(renderMessage(r.message_template, SAMPLE_VARS));
      const last = d.lastByRule.get(r.id);
      const lastLine = last
        ? `${statusBadge(last.status)} <span class="muted">${ago(last.created_at)}${last.error ? ` · ${esc(last.error.slice(0, 40))}` : ""}</span>`
        : `<span class="muted">jamais envoyée</span>`;
      const stateBadge = r.enabled
        ? `<span class="badge badge--green">Active</span>`
        : `<span class="badge badge--gray">En pause</span>`;
      const recipientBadge =
        r.recipient_kind === "coach"
          ? `<span class="badge badge--violet">coach du cours</span>`
          : `<span class="badge badge--blue">+${esc((r.recipient_phone ?? "").replace(/^\+/, ""))}</span>`;
      return `<article class="task-item${r.enabled ? "" : " is-complete"}">
  <span class="task-priority${r.enabled ? "" : ""}" aria-hidden="true"></span>
  <div class="task-copy">
    <div class="cluster">${stateBadge}<span class="badge badge--blue">${r.lead_minutes ?? "?"} min avant</span>${recipientBadge}</div>
    <b>${esc(r.label)}</b>
    <div class="cluster" style="margin-top:.3rem">${classChips(r, serviceNames, d.serviceOptions)}</div>
    <p class="muted">${ruleSummary(r)}</p>
    <div class="task-meta">Dernier envoi : ${lastLine}</div>
    <details class="resolution-panel"><summary class="muted" style="cursor:pointer">Voir le message</summary><p class="internal-note">${preview}</p></details>
  </div>
  <div class="task-action">
    <form class="inline" method="post" action="/admin/notifications/rules/${r.id}/toggle"><button class="act act--sm ${r.enabled ? "act--ghost" : "act--ok"}">${r.enabled ? "Mettre en pause" : "Activer"}</button></form>
    <form class="inline" method="post" action="/admin/notifications/rules/${r.id}/test"><button class="act act--sm act--ghost">Test</button></form>
    <a class="act act--sm act--ghost" href="/admin/notifications?edit=${r.id}#rule-form">Éditer</a>
    <form class="inline" method="post" action="/admin/notifications/rules/${r.id}/delete" data-confirm="Supprimer définitivement cette alerte ?"><button class="act act--sm act--danger">Supprimer</button></form>
  </div>
</article>`;
    })
    .join("");

  const contactRows = d.contacts
    .map(
      (c) => `<tr class="${c.muted ? "is-complete" : ""}">
<td data-label="Nom"><b>${esc(c.name)}</b> ${c.muted ? `<span class="badge badge--gray">muet</span>` : ""}</td>
<td data-label="Numéro">+${esc(c.phone.replace(/^\+/, ""))}</td>
<td data-label="Rôle">${esc(c.role)}</td>
<td data-label="Actions" class="nowrap">
  <form class="inline" method="post" action="/admin/notifications/contacts/${c.id}/mute"><button class="act act--sm act--ghost">${c.muted ? "Réactiver" : "Muter"}</button></form>
  <form class="inline" method="post" action="/admin/notifications/contacts/${c.id}/delete" data-confirm="Supprimer ce contact du répertoire staff ?"><button class="act act--sm act--danger">Supprimer</button></form>
</td>
</tr>`,
    )
    .join("");

  const logRows = d.log
    .map(
      (l) => `<tr>
<td data-label="Quand">${fmtDate(l.created_at)}</td>
<td data-label="Source">${sourceLabel(l.source)}</td>
<td data-label="Statut">${statusBadge(l.status)}</td>
<td data-label="Destinataire">+${esc((l.recipient_phone ?? "").replace(/^\+/, "")) || "—"}</td>
<td data-label="Message">${esc((l.body ?? "").slice(0, 80))}${l.error ? `<div class="danger-text">${esc(l.error.slice(0, 80))}</div>` : ""}</td>
</tr>`,
    )
    .join("");

  const coachHint = d.coachHints.length
    ? `<p class="muted">Coachs vus dans le planning : ${d.coachHints.map((n) => `<code>${esc(n)}</code>`).join(" · ")} — le nom d'un contact « coach » doit correspondre.</p>`
    : `<p class="muted">Astuce : le nom d'un contact « coach » doit correspondre exactement au nom du coach dans Wix.</p>`;

  const templateNote = config.WA_RECEPTION_TEMPLATE
    ? ""
    : `<div class="card warn">⚠️ Aucun template WhatsApp configuré (<code>WA_RECEPTION_TEMPLATE</code>). Les envois au staff hors fenêtre 24h échoueront (erreur 131047) — visibles dans le journal ci-dessous. À activer une fois le template Meta approuvé.</div>`;

  const masterSwitch = d.alertsPaused
    ? `<div class="card warn row between"><div><b>Alertes staff en pause</b><div class="muted">Aucun rappel n'est envoyé. Les occurrences pendant la pause sont ignorées et ne sont pas mises en attente.</div></div><form class="inline" method="post" action="/admin/notifications/pause">
<input type="hidden" name="value" value="0">
<button class="act act--ok">Activer les alertes</button></form></div>`
    : `<div class="card success row between"><div><span class="ok">Alertes staff actives</span><div class="muted">Les alertes activées envoient leurs rappels normalement.</div></div><form class="inline" method="post" action="/admin/notifications/pause" data-confirm="Mettre toutes les alertes staff en pause ? Les occurrences pendant la pause seront ignorées.">
<input type="hidden" name="value" value="1">
<button class="act act--sm act--ghost">Tout mettre en pause</button></form></div>`;

  // Copie propriétaire des interventions : l'état + un bouton pour vérifier
  // que le template arrive VRAIMENT (la fenêtre 24h du gérant est fermée en
  // permanence, donc seul un envoi réel prouve la chaîne de bout en bout).
  const ownerAlertCard = !config.OWNER_ALERT_ENABLED
    ? `<div class="card warn"><b>Alertes gérant désactivées</b><div class="muted">Les interventions ne partent qu'à la réception (<code>OWNER_ALERT_ENABLED=false</code>).</div></div>`
    : !config.OWNER_PHONE
      ? `<div class="card warn"><b>Alertes gérant sans destinataire</b><div class="muted">Renseignez <code>OWNER_PHONE</code> pour recevoir les interventions.</div></div>`
      : `<div class="card row between"><div><b>Alertes gérant</b><div class="muted">Toute alerte demandant une intervention part aussi sur WhatsApp au <b>+${esc(config.OWNER_PHONE.replace(/^\+/, ""))}</b>, template d'abord (<code>${esc(config.WA_OWNER_ALERT_TEMPLATE || "aucun template configuré")}</code>).</div></div><form class="inline" method="post" action="/admin/notifications/owner-test">
<button class="act act--sm act--ghost">Tester l'alerte gérant</button></form></div>`;

  const formSection = showForm
    ? `<h2 id="rule-form">${d.editRule ? `Modifier « ${esc(d.editRule.label)} »` : "Nouvelle alerte"}</h2>
<div class="card">${ruleForm(d.editRule, d.serviceOptions)}</div>`
    : "";

  const newButton = showForm
    ? ""
    : `<a class="act" href="/admin/notifications?new=1#rule-form">+ Nouvelle alerte</a>`;

  // The routine "actives + tout mettre en pause / alertes gérant" controls live
  // in the collapsed Réglages section so the alerts list comes first. A paused
  // state still stands out: amber header badge + the section auto-opens below.
  return `
${d.banner}
<header class="page-header"><div class="page-header-copy"><span class="eyebrow">Configuration</span><h2>Alertes staff</h2><p>Prévenez automatiquement les coachs (ou un numéro fixe) avant les cours choisis.</p></div><div class="page-header-actions"><span class="badge ${d.alertsPaused ? "badge--amber" : "badge--green"}">${d.alertsPaused ? "En pause" : "Actives"}</span>${newButton}</div></header>
${templateNote}
${formSection}

<div class="row between" style="align-items:baseline;flex-wrap:wrap;gap:.5rem"><h2 style="margin:0">Alertes (${d.rules.length})</h2><span class="muted">« Test » envoie un exemple à ${d.testPhone ? `<b>+${esc(d.testPhone.replace(/^\+/, ""))}</b>` : "un numéro non configuré"} (jamais au vrai coach).</span></div>
${d.rules.length ? `<div class="task-list alert-grid">${ruleCards}</div>` : `<div class="card"><div class="empty"><b>Aucune alerte</b><p>Créez la première avec « + Nouvelle alerte ».</p></div></div>`}

<details class="card" style="margin-top:1rem"${d.alertsPaused ? " open" : ""}>
<summary style="cursor:pointer;font-weight:650">Réglages &amp; alertes gérant</summary>
<div style="margin-top:.8rem;display:flex;flex-direction:column;gap:.2rem">
${masterSwitch}
${ownerAlertCard}
</div>
</details>

<details class="card"${d.openSection === "contacts" ? " open" : ""}>
<summary style="cursor:pointer;font-weight:650">Répertoire staff (${d.contacts.length})</summary>
<div style="margin-top:.8rem">
${coachHint}
<p class="muted">⚠️ Un numéro ici sera traité comme un client s'il écrit à Awa.</p>
<form method="post" action="/admin/notifications/contacts" style="display:flex;gap:.5rem;flex-wrap:wrap;margin-bottom:.7rem">
  <input name="name" required placeholder="Nom (ex : Gardien, ou nom exact du coach)" style="flex:1;min-width:200px">
  <input name="phone" required placeholder="+221 78 464 43 29" style="min-width:170px">
  <input name="role" placeholder="gardien / coach" style="min-width:120px">
  <label class="chip-check"><input type="checkbox" name="muted" value="1"> muet</label>
  <button class="act" type="submit">Ajouter</button>
</form>
${d.contacts.length ? `<div class="table-wrap"><table class="responsive-table"><thead><tr><th>Nom</th><th>Numéro</th><th>Rôle</th><th>Actions</th></tr></thead><tbody>${contactRows}</tbody></table></div>` : `<div class="empty"><b>Aucun contact</b></div>`}
</div>
</details>

<details class="card"${d.openSection === "journal" ? " open" : ""}>
<summary style="cursor:pointer;font-weight:650">Journal des envois (${d.log.length})</summary>
<div style="margin-top:.8rem">
${d.log.length ? `<div class="table-wrap"><table class="responsive-table"><thead><tr><th>Quand</th><th>Source</th><th>Statut</th><th>Destinataire</th><th>Message</th></tr></thead><tbody>${logRows}</tbody></table></div>` : `<div class="empty"><b>Aucun envoi</b><p>Les prochaines tentatives apparaîtront ici.</p></div>`}
</div>
</details>`;
}
