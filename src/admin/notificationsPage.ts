import { config } from "../config.js";
import { renderMessage } from "../domain/notificationRules.js";
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

const DAYS = ["dim", "lun", "mar", "mer", "jeu", "ven", "sam"];

const LOG_COLORS: Record<string, string> = {
  sent: "#1a7f37",
  sent_template: "#0969da",
  failed: "#cf222e",
  suppressed: "#6e7781",
};

/** Human labels for notification_log.source — raw key stays the title attribute. */
const SOURCE_LABELS: Record<string, string> = {
  reception: "réception",
  new_chat: "nouvelle conv",
  delivery: "livraison",
  invoice: "facture",
  gift_card: "carte cadeau",
  staff_planning: "planning staff",
  test: "test",
  rule: "règle",
};

function statusBadge(status: string): string {
  const color = LOG_COLORS[status] ?? "#6e7781";
  return `<span class="badge" style="background:${color}">${esc(status)}</span>`;
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

function daysLabel(csv: string | null): string {
  if (!csv) return "—";
  return csv
    .split(",")
    .map((s) => DAYS[parseInt(s.trim(), 10)] ?? "?")
    .join(", ");
}

function ruleSummary(r: NotificationRuleRow): string {
  if (r.kind === "class_reminder") {
    let pat = r.class_pattern?.trim() ? `« ${esc(r.class_pattern)} »` : "tous les cours";
    if (r.group_only) pat += " (collectifs)";
    if (r.exclude_pattern?.trim()) pat += ` sauf « ${esc(r.exclude_pattern)} »`;
    const gap = r.suppress_gap_minutes ? ` · anti dos-à-dos ${r.suppress_gap_minutes} min` : "";
    const to =
      r.recipient_kind === "coach" ? "coach du cours" : `+${esc((r.recipient_phone ?? "").replace(/^\+/, ""))}`;
    return `${r.lead_minutes ?? "?"} min avant ${pat}${gap} → ${to}`;
  }
  return `${daysLabel(r.days_of_week)} à ${esc(r.send_time ?? "?")} → +${esc((r.recipient_phone ?? "").replace(/^\+/, ""))}`;
}

// ---------- rule form (create + edit) ----------

function ruleForm(edit: NotificationRuleRow | null): string {
  const v = (x: unknown) => esc(x ?? "");
  const action = edit ? `/admin/notifications/rules/${edit.id}/update` : "/admin/notifications/rules";
  const kind = edit?.kind ?? "class_reminder";
  const rkind = edit?.recipient_kind ?? "phone";
  const sel = (a: string, b: string) => (a === b ? " selected" : "");
  return `
<form method="post" action="${action}" class="notif-form" style="display:flex;flex-direction:column;gap:.6rem">
  <div class="row">
    <label style="flex:1;min-width:200px">Nom de la règle
      <input name="label" required value="${v(edit?.label)}" placeholder="Aquabikes à l'eau" style="width:100%">
    </label>
    <label style="min-width:180px">Type
      <select name="kind" id="kind-select" style="width:100%">
        <option value="class_reminder"${sel("class_reminder", kind)}>Avant un cours</option>
        <option value="fixed_schedule"${sel("fixed_schedule", kind)}>Jour + heure fixes</option>
      </select>
    </label>
  </div>

  <fieldset class="kf class-fields" style="border:1px solid var(--border);border-radius:8px;padding:.6rem">
    <legend class="muted">Avant un cours</legend>
    <div class="row">
      <label style="flex:1;min-width:160px">Motif du nom de cours <span class="muted">(vide = tous)</span>
        <input name="class_pattern" value="${v(edit?.class_pattern)}" placeholder="aquabike" style="width:100%">
      </label>
      <label style="flex:1;min-width:160px">Exclure les cours contenant <span class="muted">(vide = aucun)</span>
        <input name="exclude_pattern" value="${v(edit?.exclude_pattern)}" placeholder="reformer" style="width:100%">
      </label>
      <label style="min-width:120px">Minutes avant
        <input name="lead_minutes" type="number" min="0" max="1440" value="${v(edit?.lead_minutes)}" placeholder="15" style="width:100%">
      </label>
      <label style="min-width:150px">Anti dos-à-dos (min) <span class="muted">(vide = off)</span>
        <input name="suppress_gap_minutes" type="number" min="0" max="240" value="${v(edit?.suppress_gap_minutes)}" placeholder="15" style="width:100%">
      </label>
    </div>
    <label style="display:flex;align-items:center;gap:.4rem;margin-top:.5rem">
      <input type="checkbox" name="group_only" value="1"${edit?.group_only ? " checked" : ""}>
      Cours collectifs uniquement <span class="muted">(exclut les rendez-vous individuels)</span>
    </label>
    <label style="display:block;margin-top:.5rem">Destinataire
      <select name="recipient_kind" id="rkind-select" style="width:100%">
        <option value="phone"${sel("phone", rkind)}>Un numéro fixe (gardien…)</option>
        <option value="coach"${sel("coach", rkind)}>Le coach du cours (via répertoire)</option>
      </select>
    </label>
  </fieldset>

  <fieldset class="kf fixed-fields" style="border:1px solid var(--border);border-radius:8px;padding:.6rem">
    <legend class="muted">Jour + heure fixes</legend>
    <div class="row">
      <label style="flex:1;min-width:200px">Jours <span class="muted">(0=dim … 6=sam, séparés par des virgules)</span>
        <input name="days_of_week" value="${v(edit?.days_of_week)}" placeholder="6" style="width:100%">
      </label>
      <label style="min-width:120px">Heure (HH:MM)
        <input name="send_time" value="${v(edit?.send_time)}" placeholder="10:00" style="width:100%">
      </label>
    </div>
  </fieldset>

  <label class="phone-field">Numéro destinataire <span class="muted">(pour un numéro fixe ou une règle horaire)</span>
    <input name="recipient_phone" value="${v(edit?.recipient_phone)}" placeholder="+224 620 95 51 30" style="width:100%">
  </label>

  <label>Message
    <textarea name="message_template" rows="3" style="width:100%">${v(edit?.message_template)}</textarea>
  </label>
  <p class="muted" style="margin:.1rem 0">Variables : <code>{class_name} {date} {start_time} {end_time} {coach} {booked_count} {open_spots} {total_spots}</code>.
  Ne PAS retaper « ${esc("merci de ne pas répondre")} » : la signature automatique est ajoutée à chaque envoi.</p>

  <div>
    <button class="act" type="submit">${edit ? "Enregistrer" : "Créer la règle"}</button>
    ${edit ? `<a href="/admin/notifications" style="margin-left:.6rem">Annuler</a>` : ""}
  </div>
</form>
<script>
(function(){
  var f=document.querySelector('.notif-form'); if(!f) return;
  var k=f.querySelector('#kind-select'), rk=f.querySelector('#rkind-select');
  function upd(){
    var isClass=k.value==='class_reminder';
    f.querySelector('.class-fields').style.display=isClass?'':'none';
    f.querySelector('.fixed-fields').style.display=isClass?'none':'';
    // Phone field hidden only when a class rule targets the coach.
    var needsPhone=!(isClass && rk.value==='coach');
    f.querySelector('.phone-field').style.display=needsPhone?'':'none';
  }
  k.addEventListener('change',upd); rk.addEventListener('change',upd); upd();
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
  editRule: NotificationRuleRow | null;
  banner: string;
  testPhone: string;
  alertsPaused: boolean;
}

export function renderNotificationsPage(d: NotificationsPageData): string {
  const ruleRows = d.rules
    .map((r) => {
      const preview = esc(renderMessage(r.message_template, SAMPLE_VARS));
      const last = d.lastByRule.get(r.id);
      const lastLine = last
        ? `${statusBadge(last.status)} <span class="muted">${ago(last.created_at)}${last.error ? ` · ${esc(last.error.slice(0, 40))}` : ""}</span>`
        : `<span class="muted">jamais envoyée</span>`;
      return `<tr${r.enabled ? "" : ' style="opacity:.5"'}>
<td><b>${esc(r.label)}</b><div class="muted">${ruleSummary(r)}</div><div class="muted" style="margin-top:.2rem">📝 ${preview}</div></td>
<td>${lastLine}</td>
<td style="white-space:nowrap">
  <form class="inline" method="post" action="/admin/notifications/rules/${r.id}/toggle"><button class="act act--sm ${r.enabled ? "act--ghost" : "act--ok"}">${r.enabled ? "Pause" : "Activer"}</button></form>
  <form class="inline" method="post" action="/admin/notifications/rules/${r.id}/test" style="margin-left:.3rem"><button class="act act--sm act--ghost">Test</button></form>
  <a href="/admin/notifications?edit=${r.id}" style="margin-left:.3rem">Éditer</a>
  <form class="inline" method="post" action="/admin/notifications/rules/${r.id}/delete" style="margin-left:.3rem" onsubmit="return confirm('Supprimer cette règle ?')"><button class="act act--sm act--danger">✕</button></form>
</td>
</tr>`;
    })
    .join("");

  const contactRows = d.contacts
    .map(
      (c) => `<tr${c.muted ? ' style="opacity:.5"' : ""}>
<td><b>${esc(c.name)}</b> ${c.muted ? `<span class="badge badge--gray">muet</span>` : ""}</td>
<td>+${esc(c.phone.replace(/^\+/, ""))}</td>
<td>${esc(c.role)}</td>
<td style="white-space:nowrap">
  <form class="inline" method="post" action="/admin/notifications/contacts/${c.id}/mute"><button class="act act--sm act--ghost">${c.muted ? "Réactiver" : "Muter"}</button></form>
  <form class="inline" method="post" action="/admin/notifications/contacts/${c.id}/delete" style="margin-left:.3rem" onsubmit="return confirm('Supprimer ce contact ?')"><button class="act act--sm act--danger">✕</button></form>
</td>
</tr>`,
    )
    .join("");

  const logRows = d.log
    .map(
      (l) => `<tr>
<td>${fmtDate(l.created_at)}</td>
<td>${sourceLabel(l.source)}</td>
<td>${statusBadge(l.status)}</td>
<td>+${esc((l.recipient_phone ?? "").replace(/^\+/, "")) || "—"}</td>
<td>${esc((l.body ?? "").slice(0, 80))}${l.error ? `<div class="muted">⚠️ ${esc(l.error.slice(0, 80))}</div>` : ""}</td>
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
    ? `<div class="card warn"><form class="inline" method="post" action="/admin/notifications/pause" style="float:right">
<input type="hidden" name="value" value="0">
<button class="act act--ok">▶️ Activer les alertes</button></form>
<b>⏸️ Alertes staff EN PAUSE</b>
<div class="muted">Aucun rappel (gardien, coachs, horaires fixes) n'est envoyé, quel que soit l'état des règles ci-dessous. Les occurrences pendant la pause sont ignorées, pas mises en attente.</div></div>`
    : `<div class="card success"><form class="inline" method="post" action="/admin/notifications/pause" style="float:right" onsubmit="return confirm('Mettre TOUTES les alertes staff en pause ?')">
<input type="hidden" name="value" value="1">
<button class="act act--sm act--ghost">⏸️ Tout mettre en pause</button></form>
<span class="ok">✓ Alertes staff actives</span>
<div class="muted">Les règles activées ci-dessous envoient leurs rappels normalement.</div></div>`;

  return `
${d.banner}
${masterSwitch}
${templateNote}
<nav class="jump-nav" aria-label="Sections notifications">
  <a href="#regles">Règles</a>
  <a href="#contacts">Contacts staff</a>
  <a href="#journal">Journal</a>
</nav>

<h2 id="regles">➕ ${d.editRule ? "Modifier la règle" : "Nouvelle règle"}</h2>
<div class="card">${ruleForm(d.editRule)}</div>

<h2>🔔 Règles (${d.rules.length})</h2>
<p class="muted">« Test » envoie le message avec des valeurs d'exemple à ${d.testPhone ? `<b>+${esc(d.testPhone.replace(/^\+/, ""))}</b>` : "un numéro non configuré"} (jamais au vrai gardien / coach).</p>
<div class="card">
${d.rules.length ? `<table><tr><th>Règle</th><th>Dernier envoi</th><th></th></tr>${ruleRows}</table>` : `<span class="muted">Aucune règle. Créez-en une ci-dessus.</span>`}
</div>

<h2 id="contacts">👥 Répertoire staff (${d.contacts.length})</h2>
${coachHint}
<p class="muted">⚠️ Un numéro ici sera traité comme un client s'il écrit à Awa.</p>
<div class="card">
<form method="post" action="/admin/notifications/contacts" style="display:flex;gap:.5rem;flex-wrap:wrap;margin-bottom:.7rem">
  <input name="name" required placeholder="Nom (ex : Gardien, ou nom exact du coach)" style="flex:1;min-width:200px">
  <input name="phone" required placeholder="+224 620 95 51 30" style="min-width:170px">
  <input name="role" placeholder="gardien / coach" style="min-width:120px">
  <label style="display:flex;align-items:center;gap:.3rem"><input type="checkbox" name="muted" value="1"> muet</label>
  <button class="act" type="submit">Ajouter</button>
</form>
${d.contacts.length ? `<table><tr><th>Nom</th><th>Numéro</th><th>Rôle</th><th></th></tr>${contactRows}</table>` : `<span class="muted">Aucun contact.</span>`}
</div>

<h2 id="journal">📜 Journal (${d.log.length})</h2>
<div class="card">
${d.log.length ? `<table><tr><th>Quand</th><th>Source</th><th>Statut</th><th>Destinataire</th><th>Message</th></tr>${logRows}</table>` : `<span class="muted">Rien envoyé pour l'instant.</span>`}
</div>`;
}
