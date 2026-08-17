import { config } from "../config.js";
import type { AutoCancelRuleRow, LedgerJournalRow } from "../domain/autoCancelRepo.js";

/**
 * Auto-cancellation section of /admin/notifications (server-rendered, no
 * framework — same posture as notificationsPage.ts). Rule CRUD, activation
 * checks surfaced as visible errors, recent-cancellation journal, and a global
 * pause. The main page appends this section's HTML after the staff-alert UI.
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

// JS getUTCDay convention (0=Sunday), rendered Monday-first.
const WEEKDAYS: Array<{ v: number; label: string }> = [
  { v: 1, label: "Lun" },
  { v: 2, label: "Mar" },
  { v: 3, label: "Mer" },
  { v: 4, label: "Jeu" },
  { v: 5, label: "Ven" },
  { v: 6, label: "Sam" },
  { v: 0, label: "Dim" },
];

function minutesToHHMM(min: number | null): string {
  if (min == null) return "";
  const h = Math.floor(min / 60);
  const m = min % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

export interface AutoCancelRuleView {
  rule: AutoCancelRuleRow;
  activationError: string | null;
  /** Resolved names for each targeted service id (unknown id → null placeholder). */
  serviceNames: Array<{ id: string; name: string | null }>;
  ownerName: string | null;
  managerName: string | null;
}

export interface AutoCancelServiceOption {
  id: string;
  name: string;
}
export interface AutoCancelContactOption {
  id: string;
  name: string;
  muted: boolean;
}

export interface AutoCancelSectionData {
  views: AutoCancelRuleView[];
  ledger: LedgerJournalRow[];
  serviceOptions: AutoCancelServiceOption[];
  contacts: AutoCancelContactOption[];
  paused: boolean;
  editRule: AutoCancelRuleRow | null;
  showNewForm: boolean;
}

function weekdaysSummary(weekdays: number[]): string {
  if (weekdays.length === 0) return "tous les jours";
  return WEEKDAYS.filter((d) => weekdays.includes(d.v))
    .map((d) => d.label)
    .join(" ");
}

function timeRangeSummary(from: number | null, to: number | null): string {
  if (from == null && to == null) return "toute heure";
  return `${from == null ? "…" : minutesToHHMM(from)}–${to == null ? "…" : minutesToHHMM(to)}`;
}

function ruleForm(
  edit: AutoCancelRuleRow | null,
  serviceOptions: AutoCancelServiceOption[],
  contacts: AutoCancelContactOption[],
): string {
  const v = (x: unknown) => esc(x ?? "");
  const action = edit
    ? `/admin/notifications/autocancel/rules/${edit.id}/update`
    : "/admin/notifications/autocancel/rules";
  const selectedDays = new Set(edit?.weekdays ?? []);
  const selectedSvc = new Set(edit?.service_ids ?? []);
  // Any targeted id absent from the live catalogue still gets a (checked) chip.
  const knownIds = new Set(serviceOptions.map((s) => s.id));
  const extraSvc = (edit?.service_ids ?? [])
    .filter((id) => !knownIds.has(id))
    .map((id) => ({ id, name: "Cours indisponible dans Wix" }));
  const svcCheckboxes = [...serviceOptions, ...extraSvc]
    .map(
      (s) =>
        `<label class="chip-check"><input type="checkbox" name="service_ids" value="${v(s.id)}"${selectedSvc.has(s.id) ? " checked" : ""}> ${v(s.name)}</label>`,
    )
    .join("");
  const contactOptions = (selectedId: string | null) =>
    `<option value="">—</option>` +
    contacts
      .map(
        (c) =>
          `<option value="${v(c.id)}"${selectedId === c.id ? " selected" : ""}>${v(c.name)}${c.muted ? " (muet)" : ""}</option>`,
      )
      .join("");
  const dayChecks = WEEKDAYS.map(
    (d) =>
      `<label class="chip-check"><input type="checkbox" name="weekdays" value="${d.v}"${selectedDays.has(d.v) ? " checked" : ""}> ${d.label}</label>`,
  ).join("");

  return `
<form method="post" action="${action}" style="display:flex;flex-direction:column;gap:.9rem">
  <label>Nom de la règle
    <input name="label" required value="${v(edit?.label)}" placeholder="Reformer matin — annuler si vide">
  </label>
  <fieldset style="display:flex;flex-direction:column;gap:.5rem">
    <legend class="muted">Cours concernés <span class="muted">(coche un ou plusieurs — ex : tous les niveaux Reformer)</span></legend>
    ${serviceOptions.length === 0 && extraSvc.length === 0 ? `<div class="card warn" style="margin:0">Catalogue Wix momentanément indisponible. Réessaie pour choisir des cours.</div>` : `<div class="svc-grid">${svcCheckboxes}</div>`}
  </fieldset>
  <fieldset style="display:flex;flex-direction:column;gap:.5rem">
    <legend class="muted">Jours concernés <span class="muted">(aucun coché = tous les jours)</span></legend>
    <div class="cluster">${dayChecks}</div>
  </fieldset>
  <div class="row">
    <label style="flex:1;min-width:150px">Heure de début — de
      <input name="start_from" type="time" value="${minutesToHHMM(edit?.start_min_from ?? null)}">
    </label>
    <label style="flex:1;min-width:150px">à
      <input name="start_to" type="time" value="${minutesToHHMM(edit?.start_min_to ?? null)}">
    </label>
  </div>
  <p class="muted" style="margin:0">Vide = toute heure. La règle ne cible que les cours dont le début tombe dans cette plage.</p>
  <div class="row">
    <label style="flex:1;min-width:180px">Destinataire « owner »
      <select name="owner_contact_id" required>${contactOptions(edit?.owner_contact_id ?? null)}</select>
    </label>
    <label style="flex:1;min-width:180px">Destinataire « manager »
      <select name="manager_contact_id" required>${contactOptions(edit?.manager_contact_id ?? null)}</select>
    </label>
  </div>
  <p class="muted" style="margin:0">Le coach du cours est prévenu automatiquement (numéro Wix). Owner et manager doivent être deux contacts <b>distincts</b>, actifs, avec un numéro valide — sinon la règle ne peut pas être activée.</p>
  <label class="chip-check" style="align-self:flex-start"><input type="checkbox" name="enabled" value="1"${edit?.enabled ? " checked" : ""}> Activer cette règle</label>
  <div class="cluster">
    <button class="act" type="submit">${edit ? "Enregistrer" : "Créer la règle"}</button>
    <a class="act act--ghost" href="/admin/notifications#autocancel">Annuler</a>
  </div>
</form>`;
}

export function renderAutoCancelSection(d: AutoCancelSectionData): string {
  const showForm = Boolean(d.editRule) || d.showNewForm;

  const masterSwitch = d.paused
    ? `<div class="card warn row between"><div><b>Annulation auto en pause</b><div class="muted">Aucun cours vide n'est annulé automatiquement.</div></div><form class="inline" method="post" action="/admin/notifications/autocancel/pause"><input type="hidden" name="value" value="0"><button class="act act--ok">Réactiver</button></form></div>`
    : `<div class="card success row between"><div><span class="ok">Annulation auto active</span><div class="muted">Les règles activées annulent les cours restés vides 15 min après leur cutoff (préavis min ${config.AUTO_CANCEL_MIN_NOTICE_MINUTES} min).</div></div><form class="inline" method="post" action="/admin/notifications/autocancel/pause" data-confirm="Mettre l'annulation automatique en pause ?"><input type="hidden" name="value" value="1"><button class="act act--sm act--ghost">Tout mettre en pause</button></form></div>`;

  const cards = d.views
    .map((view) => {
      const r = view.rule;
      const stateBadge = !r.enabled
        ? `<span class="badge badge--gray">En pause</span>`
        : view.activationError
          ? `<span class="badge badge--red">Inactive (config)</span>`
          : `<span class="badge badge--green">Active</span>`;
      const errLine = view.activationError
        ? `<div class="danger-text">⚠️ ${esc(view.activationError)} — la règle n'annulera rien tant que ce n'est pas corrigé.</div>`
        : "";
      const svc = view.serviceNames.length
        ? view.serviceNames
            .map((s) =>
              s.name
                ? `<span class="badge">${esc(s.name)}</span>`
                : `<span class="badge badge--amber" title="${esc(s.id)}">cours supprimé de Wix</span>`,
            )
            .join(" ")
        : `<span class="badge badge--amber">aucun cours ciblé</span>`;
      return `<article class="task-item${r.enabled && !view.activationError ? "" : " is-complete"}">
  <div class="task-copy">
    <div class="cluster">${stateBadge}${svc}</div>
    <b>${esc(r.label)}</b>
    <p class="muted">${esc(weekdaysSummary(r.weekdays))} · ${esc(timeRangeSummary(r.start_min_from, r.start_min_to))} → coach + ${esc(view.ownerName ?? "owner ?")} + ${esc(view.managerName ?? "manager ?")}</p>
    ${errLine}
  </div>
  <div class="task-action">
    <form class="inline" method="post" action="/admin/notifications/autocancel/rules/${r.id}/toggle"><button class="act act--sm ${r.enabled ? "act--ghost" : "act--ok"}">${r.enabled ? "Mettre en pause" : "Activer"}</button></form>
    <a class="act act--sm act--ghost" href="/admin/notifications?ac_edit=${r.id}#autocancel-form">Éditer</a>
    <form class="inline" method="post" action="/admin/notifications/autocancel/rules/${r.id}/delete" data-confirm="Supprimer cette règle d'annulation ?"><button class="act act--sm act--danger">Supprimer</button></form>
  </div>
</article>`;
    })
    .join("");

  const STATE_BADGE: Record<string, string> = {
    CANCELLED: "badge--green",
    CANCELLING: "badge--amber",
    FAILED: "badge--red",
    OBSERVING: "badge--gray",
  };
  const ledgerRows = d.ledger
    .map(
      (l) => `<tr>
<td data-label="Cours">${esc(l.service_id ?? "—")}</td>
<td data-label="Début">${fmtDate(l.start_at)}</td>
<td data-label="État"><span class="badge ${STATE_BADGE[l.state] ?? "badge--gray"}">${esc(l.state)}</span></td>
<td data-label="Annulé">${fmtDate(l.cancelled_at)}</td>
<td data-label="Erreur">${l.error ? `<span class="danger-text">${esc(l.error.slice(0, 80))}</span>` : "—"}</td>
</tr>`,
    )
    .join("");

  const formSection = showForm
    ? `<h3 id="autocancel-form">${d.editRule ? `Modifier « ${esc(d.editRule.label)} »` : "Nouvelle règle d'annulation"}</h3>
<div class="card">${ruleForm(d.editRule, d.serviceOptions, d.contacts)}</div>`
    : "";
  const newButton = showForm
    ? ""
    : `<a class="act act--ghost" href="/admin/notifications?ac_new=1#autocancel-form">+ Nouvelle règle d'annulation</a>`;

  return `
<hr style="margin:2rem 0;border:none;border-top:1px solid var(--border,#e5e7eb)">
<header class="page-header" id="autocancel"><div class="page-header-copy"><span class="eyebrow">Configuration</span><h2>Annulation automatique des cours vides</h2><p>Annule un cours resté vide 15 min après son cutoff (matin ≤09:15 : la veille 23h ; sinon 3 h avant), et prévient le coach, l'owner et le manager. Seul le cours concerné est annulé, jamais la série.</p></div><div class="page-header-actions"><span class="badge ${d.paused ? "badge--amber" : "badge--green"}">${d.paused ? "En pause" : "Active"}</span>${newButton}</div></header>
${masterSwitch}
${formSection}
<h3>Règles (${d.views.length})</h3>
${d.views.length ? `<div class="task-list">${cards}</div>` : `<div class="card"><div class="empty"><b>Aucune règle</b><p>Crée la première avec « + Nouvelle règle d'annulation ».</p></div></div>`}
<details class="card" style="margin-top:1rem">
<summary style="cursor:pointer;font-weight:650">Annulations récentes (${d.ledger.length})</summary>
<div style="margin-top:.8rem">
${d.ledger.length ? `<div class="table-wrap"><table class="responsive-table"><thead><tr><th>Cours</th><th>Début</th><th>État</th><th>Annulé</th><th>Erreur</th></tr></thead><tbody>${ledgerRows}</tbody></table></div>` : `<div class="empty"><b>Aucune annulation</b><p>Les cours annulés automatiquement apparaîtront ici.</p></div>`}
</div>
</details>`;
}
