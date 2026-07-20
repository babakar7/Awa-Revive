import type {
  CoachPaymentProfile,
  CoachPaymentStatement,
  StatementDetail,
} from "../domain/coachPaymentRepo.js";
import { monthBounds, monthIsClosed, storedMonthKey, tariffFromJson, tariffFromProfile, tariffLabel } from "../domain/coachPaymentRules.js";
import type { WixStaffResource } from "../lib/wix.js";

const BASE = "/admin/paiements-coachs";

function esc(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function xof(value: number): string {
  return `${Math.round(value).toLocaleString("fr-FR").replace(/ /g, " ")} FCFA`;
}

function date(value: Date | string | null): string {
  if (!value) return "—";
  return new Date(value).toLocaleString("fr-FR", {
    timeZone: "Africa/Dakar",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

function monthLabel(value: string | Date): string {
  const month = storedMonthKey(value);
  const [year, number] = month.split("-").map(Number);
  return new Date(Date.UTC(year, number - 1, 1)).toLocaleDateString("fr-FR", {
    timeZone: "Africa/Dakar",
    month: "long",
    year: "numeric",
  });
}

function statusBadge(status: string): string {
  const label = status === "draft" ? "Brouillon" : status === "validated" ? "Validé" : "Payé";
  const cls = status === "draft" ? "badge--gray" : status === "validated" ? "badge--blue" : "badge--green";
  return `<span class="badge ${cls}">${label}</span>`;
}

export function coachPaymentBanner(done?: string, error?: string): string {
  const messages: Record<string, string> = {
    profile: "Réglages enregistrés.",
    created: "Brouillon créé avec son instantané Wix.",
    synced: "Instantané Wix actualisé.",
    toggled: "Séance corrigée.",
    manual: "Cours manuel ajouté.",
    adjustment: "Ajustement ajouté.",
    removed: "Ajustement retiré.",
    tariff: "Conditions tarifaires du brouillon mises à jour.",
    validated: "État validé. Son contenu est désormais immuable.",
    correction: "Nouvelle version corrective créée.",
    sent: "PDF envoyé par e-mail et envoi journalisé.",
    paid: "État marqué comme payé.",
  };
  if (error) return `<div class="card warn">⚠️ ${esc(error)}</div>`;
  if (done && messages[done]) return `<div class="card success"><span class="ok">✓ ${esc(messages[done])}</span></div>`;
  return "";
}

export function renderCoachPaymentsDashboard(args: {
  month: string;
  profiles: CoachPaymentProfile[];
  statements: CoachPaymentStatement[];
  banner: string;
}): string {
  const byProfile = new Map(args.statements.map((s) => [s.coach_profile_id, s]));
  const cards = args.profiles
    .map((profile) => {
      const statement = byProfile.get(profile.id);
      const resource = profile.wix_resource_id
        ? `<span class="ok">Ressource Wix associée</span>`
        : `<span class="danger-text">Ressource Wix manquante</span>`;
      const action = statement
        ? `<a class="act" href="${BASE}/etats/${esc(statement.id)}">Ouvrir la version ${statement.version}</a>`
        : `<form method="post" action="${BASE}/etats"><input type="hidden" name="profile_id" value="${esc(profile.id)}"><input type="hidden" name="month" value="${esc(args.month)}"><button class="act" type="submit">Créer le brouillon</button></form>`;
      return `<article class="card finance-card"><div class="row between"><div><span class="eyebrow">Coach</span><h2>${esc(profile.display_name)}</h2><div class="muted">${esc(tariffLabel(tariffFromProfile(profile)))}</div><div class="muted">${resource} · ${esc(profile.email ?? "e-mail non renseigné")}</div></div><div class="finance-total">${statement ? `${statusBadge(statement.status)}<b>${xof(statement.total_xof)}</b><span>${statement.course_count} cours · v${statement.version}</span>` : `<span class="muted">Aucun état pour ce mois</span>`}</div></div><div class="card-actions">${action}</div></article>`;
    })
    .join("");
  return `<header class="page-header"><div class="page-header-copy"><span class="eyebrow">Studio · Propriétaire</span><h2>Paiements coachs</h2><p>Préparez, contrôlez et validez les états mensuels à partir des séances Wix.</p></div><div class="page-header-actions"><a class="act act--ghost" href="${BASE}/reglages">Réglages coachs</a></div></header>${args.banner}<div class="card filter-bar"><form method="get" action="${BASE}" class="row"><label>Mois<input type="month" name="month" value="${esc(args.month)}" required></label><button class="act act--ghost" type="submit">Afficher le mois</button></form></div><div class="section-header"><h2>${esc(monthLabel(args.month))}</h2><span class="badge badge--gray">${args.profiles.length} coach(s)</span></div>${cards || `<div class="card empty"><b>Aucune fiche coach active</b><p>Ajoutez ou réactivez une fiche depuis les réglages.</p></div>`}`;
}

export function renderCoachPaymentSettings(args: {
  profiles: CoachPaymentProfile[];
  resources: WixStaffResource[];
  wixError?: string;
  banner: string;
}): string {
  const resourceOptions = (selected: string | null) =>
    `<option value="">— Non associée —</option>${args.resources.map((r) => `<option value="${esc(r.id)}"${r.id === selected ? " selected" : ""}>${esc(r.name)}${r.email ? ` — ${esc(r.email)}` : ""}</option>`).join("")}`;
  const cards = args.profiles.map((p) => {
    const ratio = p.formula_type === "monthly_ratio";
    const wixEmail = args.resources.find((r) => r.id === p.wix_resource_id)?.email ?? null;
    return `<form class="card" method="post" action="${BASE}/reglages/${esc(p.id)}">
      <h2 style="margin:.1rem 0 .8rem">${esc(p.display_name)}</h2>
      <div class="row"><label style="flex:1">Nom affiché<input name="display_name" value="${esc(p.display_name)}" required></label><label style="flex:2">Ressource coach Wix<select name="wix_resource_id" data-email-target="email-${esc(p.id)}">${resourceOptions(p.wix_resource_id)}</select></label></div>
      <label>E-mail mémorisé<input id="email-${esc(p.id)}" name="email" type="email" value="${esc(p.email ?? wixEmail ?? "")}" placeholder="coach@exemple.com"></label>
      <label>Formule<select name="formula_type" onchange="this.form.querySelector('[data-ratio]').style.display=this.value==='monthly_ratio'?'flex':'none';this.form.querySelector('[data-session]').style.display=this.value==='per_session'?'block':'none'"><option value="monthly_ratio"${ratio ? " selected" : ""}>Forfait mensuel au prorata</option><option value="per_session"${!ratio ? " selected" : ""}>Montant par cours</option></select></label>
      <div class="row" data-ratio style="${ratio ? "" : "display:none"}"><label>Montant de référence (FCFA)<input name="base_amount_xof" type="number" min="0" step="1" value="${esc(p.base_amount_xof ?? 800000)}"></label><label>Nombre de cours de référence<input name="base_session_count" type="number" min="1" step="1" value="${esc(p.base_session_count ?? 84)}"></label></div>
      <label data-session style="${ratio ? "display:none" : ""}">Montant par cours (FCFA)<input name="per_session_xof" type="number" min="0" step="1" value="${esc(p.per_session_xof ?? 9000)}"></label>
      <button class="act" type="submit">Enregistrer la fiche</button>
    </form>`;
  }).join("");
  const script = `<script>document.querySelectorAll('select[data-email-target]').forEach(function(s){s.addEventListener('change',function(){var o=s.options[s.selectedIndex];var text=o?o.textContent:'';var m=text.match(/—\s+([^\s]+@[^\s]+)$/);var input=document.getElementById(s.dataset.emailTarget);if(m&&input&&!input.value)input.value=m[1];});});</script>`;
  return `<header class="page-header"><div class="page-header-copy"><span class="eyebrow">Paiements coachs · Propriétaire</span><h2>Réglages des coachs</h2><p>Associez chaque coach à Wix et définissez ses conditions pour les prochains brouillons.</p></div><div class="page-header-actions"><a class="act act--ghost" href="${BASE}">États mensuels</a></div></header>${args.banner}${args.wixError ? `<div class="card warn">Ressources Wix indisponibles : ${esc(args.wixError)}</div>` : ""}<p class="subhead">Les états déjà créés conservent les conditions figées lors de leur création.</p>${cards || `<div class="card empty"><b>Aucune fiche coach</b><p>Créez une fiche en base pour commencer.</p></div>`}${script}`;
}

function tariffFields(detail: StatementDetail): string {
  const tariff = tariffFromJson(detail.statement.tariff_json);
  if (tariff.type === "monthly_ratio") {
    return `<input type="hidden" name="formula_type" value="monthly_ratio"><div class="row"><label>Montant de référence<input name="base_amount_xof" type="number" min="0" value="${tariff.baseAmountXof}" required></label><label>Cours de référence<input name="base_session_count" type="number" min="1" value="${tariff.baseSessionCount}" required></label></div>`;
  }
  return `<input type="hidden" name="formula_type" value="per_session"><label>Montant par cours<input name="per_session_xof" type="number" min="0" value="${tariff.perSessionXof}" required></label>`;
}

export function renderCoachPaymentStatement(args: {
  detail: StatementDetail;
  banner: string;
  emailEnabled: boolean;
  now?: Date;
}): string {
  const { statement, profile, courses, adjustments, sends, versions } = args.detail;
  const draft = statement.status === "draft";
  const month = storedMonthKey(statement.month);
  const closed = monthIsClosed(month, args.now ?? new Date());
  const syncAfterClose =
    !closed ||
    Boolean(
      statement.synced_at &&
        new Date(statement.synced_at).getTime() >= monthBounds(month).end.getTime(),
    );
  const syncOk =
    statement.sync_status === "ok" &&
    Boolean(statement.wix_resource_id_snapshot) &&
    syncAfterClose;
  const syncLabel = statement.sync_status === "ok"
    ? `Synchronisé le ${date(statement.synced_at)}`
    : statement.sync_status === "unlinked"
      ? "Coach non associée à une ressource Wix"
      : statement.sync_status === "failed"
        ? `Échec Wix : ${statement.sync_error ?? "erreur inconnue"}`
        : "Synchronisation en attente";
  const courseRows = courses.map((c) => `<tr style="${c.included ? "" : "opacity:.55"}"><td>${date(c.starts_at)}<div class="muted">${c.source === "manual" ? `Manuel · ${esc(c.manual_reason)}` : `Wix · ${esc(c.wix_event_id)}`}</div></td><td>${esc(c.service_name)}</td><td>${c.included ? "Oui" : "Non"}</td>${draft ? `<td><form method="post" action="${BASE}/etats/${esc(statement.id)}/cours/${esc(c.id)}/toggle"><button class="act act--ghost act--sm" type="submit">${c.included ? "Exclure" : "Inclure"}</button></form></td>` : ""}</tr>`).join("");
  const adjustmentRows = adjustments.map((a) => `<tr><td>${a.kind === "bonus" ? "Prime" : "Retenue"}</td><td>${esc(a.reason)}</td><td class="right"><b>${a.kind === "bonus" ? "+" : "−"} ${xof(a.amount_xof)}</b></td>${draft ? `<td><form method="post" action="${BASE}/etats/${esc(statement.id)}/ajustements/${esc(a.id)}/supprimer"><button class="act act--ghost act--sm" type="submit">Retirer</button></form></td>` : ""}</tr>`).join("");
  const draftTools = draft ? `<div class="card"><h2>Actions sur le brouillon</h2><div class="row"><form method="post" action="${BASE}/etats/${esc(statement.id)}/synchroniser"><button class="act act--ghost" type="submit">Synchroniser Wix</button></form><form method="post" action="${BASE}/etats/${esc(statement.id)}/valider" data-confirm="Une dernière synchronisation Wix sera faite. Valider définitivement cet état ? Son contenu ne sera plus modifiable."><button class="act act--ok" type="submit"${!closed || !syncOk || statement.total_xof < 0 ? " disabled" : ""}>Valider l'état</button></form></div>${!closed ? `<p class="muted">Validation disponible après la clôture de ${esc(monthLabel(month))}.</p>` : ""}${!syncOk ? `<p class="muted">Validation bloquée tant que Wix n'est pas synchronisé après la clôture et la ressource coach associée.</p>` : ""}</div>
  <div class="card"><h2>Conditions tarifaires du brouillon</h2><p class="muted">${esc(tariffLabel(tariffFromJson(statement.tariff_json)))}</p><form method="post" action="${BASE}/etats/${esc(statement.id)}/tarif">${tariffFields(args.detail)}<button class="act act--ghost" type="submit">Mettre à jour le calcul</button></form></div>
  <div class="card"><h2>Ajouter un cours manuel</h2><form method="post" action="${BASE}/etats/${esc(statement.id)}/cours-manuel"><div class="row"><label>Date et heure<input name="starts_at" type="datetime-local" required></label><label style="flex:1">Séance<input name="service_name" value="Reformer" required></label></div><label>Motif obligatoire<input name="reason" maxlength="300" required placeholder="Pourquoi cette séance n'est-elle pas dans Wix ?"></label><button class="act act--ghost" type="submit">Ajouter le cours</button></form></div>
  <div class="card"><h2>Ajouter une prime ou retenue</h2><form method="post" action="${BASE}/etats/${esc(statement.id)}/ajustements"><div class="row"><label>Type<select name="kind"><option value="bonus">Prime</option><option value="deduction">Retenue</option></select></label><label>Montant FCFA<input name="amount_xof" type="number" min="1" step="1" required></label><label style="flex:1">Motif<input name="reason" maxlength="300" required></label></div><button class="act act--ghost" type="submit">Ajouter l'ajustement</button></form></div>` : "";

  const sendBlock = !draft ? `<div class="card"><h2>Envoyer par e-mail</h2>${args.emailEnabled ? `<form method="post" action="${BASE}/etats/${esc(statement.id)}/envoyer" data-confirm="Envoyer ce relevé PDF à la coach ?"><div class="row"><label style="flex:1">Destinataire<input name="recipient_email" type="email" value="${esc(profile.email ?? statement.coach_email_snapshot ?? "")}" required></label><button class="act" type="submit">${sends.length ? "Renvoyer" : "Envoyer"} le PDF</button></div></form>` : `<p class="muted">Envoi désactivé : BREVO_API_KEY n'est pas configurée.</p>`}</div>` : "";
  const paidBlock = statement.status === "validated" ? `<div class="card"><h2>Règlement</h2><form method="post" action="${BASE}/etats/${esc(statement.id)}/payer" data-confirm="Confirmer que ce règlement a été effectué ?"><div class="row"><label>Date de règlement<input name="paid_on" type="date" value="${new Date().toISOString().slice(0, 10)}" required></label><button class="act act--ok" type="submit">Marquer payé</button></div></form></div>` : statement.status === "paid" ? `<div class="card success"><b>✓ Payé le ${date(statement.paid_at)}</b>${statement.paid_by ? `<div class="muted">Pointé par ${esc(statement.paid_by)}</div>` : ""}</div>` : "";
  const correction = !draft && statement.is_current ? `<form class="inline" method="post" action="${BASE}/etats/${esc(statement.id)}/correction" data-confirm="Créer une nouvelle version corrective ?"><button class="act act--ghost" type="submit">Créer une version corrective</button></form>` : "";
  const versionsHtml = versions.map((v) => `<li><a href="${BASE}/etats/${esc(v.id)}">Version ${v.version}</a> — ${statusBadge(v.status)}${v.is_current ? " · active" : ""} · ${xof(v.total_xof)}</li>`).join("");
  const sendsHtml = sends.length ? `<div class="table-wrap"><table><thead><tr><th>Date</th><th>Destinataire</th><th>Résultat</th><th>Erreur</th></tr></thead><tbody>${sends.map((s) => `<tr><td>${date(s.attempted_at)}</td><td>${esc(s.recipient_email)}</td><td>${s.status === "success" ? `<span class="ok">Succès</span>` : `<span class="danger-text">Erreur</span>`}</td><td class="muted">${esc(s.error ?? "—")}</td></tr>`).join("")}</tbody></table></div>` : `<div class="empty"><b>Aucun envoi</b><p>Les tentatives apparaîtront ici avec leur résultat.</p></div>`;

  return `<header class="page-header"><div class="page-header-copy"><span class="eyebrow">État mensuel · version ${statement.version} · Propriétaire</span><h2>${esc(statement.coach_name_snapshot)} — ${esc(monthLabel(month))}</h2><p>${esc(tariffLabel(tariffFromJson(statement.tariff_json)))}</p></div><div class="page-header-actions"><a class="act act--ghost" href="${BASE}?month=${esc(month)}">États du mois</a><a class="act act--ghost" href="${BASE}/etats/${esc(statement.id)}/pdf" target="_blank">PDF ${draft ? "brouillon" : "validé"}</a>${correction}</div></header>${args.banner}
  <div class="card statement-summary"><div><span class="muted">Montant de l’état</span><b>${xof(statement.total_xof)}</b></div><div>${statusBadge(statement.status)}<p class="${syncOk ? "muted" : "danger-text"}">${esc(syncLabel)}</p></div></div>
  ${draftTools}
  <div class="card"><h2>Séances (${statement.course_count} comptées)</h2><div class="table-wrap"><table><thead><tr><th>Date</th><th>Séance</th><th>Comptée</th>${draft ? "<th></th>" : ""}</tr></thead><tbody>${courseRows || `<tr><td colspan="4"><div class="empty"><b>Aucune séance</b><p>Synchronisez Wix ou ajoutez une séance manuelle.</p></div></td></tr>`}</tbody></table></div></div>
  <div class="card"><h2>Calcul</h2><div class="table-wrap"><table><tbody><tr><td>${statement.course_count} séance(s) selon la formule figée</td><td class="right"><b>${xof(statement.base_total_xof)}</b></td>${draft ? "<td></td>" : ""}</tr>${adjustmentRows}<tr><td><b>Total à payer</b></td><td class="right"><b style="font-size:1.12rem">${xof(statement.total_xof)}</b></td>${draft ? "<td></td>" : ""}</tr></tbody></table></div></div>
  ${sendBlock}${paidBlock}<div class="card"><h2>Versions</h2><ul>${versionsHtml}</ul></div><div class="card"><h2>Historique des envois</h2>${sendsHtml}</div>`;
}
