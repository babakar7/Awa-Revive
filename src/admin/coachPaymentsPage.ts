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
    unlocked: "Section déverrouillée pour 8 heures.",
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

export function renderOwnerUnlockPage(args: {
  error?: string;
  next: string;
  configured: boolean;
}): string {
  const error = args.error ? `<div class="err">⚠️ ${esc(args.error)}</div>` : "";
  const form = args.configured
    ? `<form method="post" action="${BASE}/unlock">
        <input type="hidden" name="next" value="${esc(args.next)}">
        <label for="owner_password">Mot de passe propriétaire</label>
        <input id="owner_password" name="password" type="password" autocomplete="current-password" required autofocus>
        <button type="submit">Déverrouiller</button>
      </form>`
    : `<div class="err">OWNER_PAYMENTS_PASSWORD n'est pas configuré. La section reste fermée.</div>`;
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow">
<title>Déverrouillage — Paiements coachs</title><style>
*{box-sizing:border-box}body{font-family:system-ui,sans-serif;margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#faf7f2;color:#241c24;padding:1rem}
.card{background:#fff;border:1px solid #e8e0d8;border-radius:12px;padding:1.5rem;width:100%;max-width:400px;box-shadow:0 8px 24px rgba(36,28,36,.07)}
h1{font-size:1.18rem;margin:0 0 .35rem}p{font-size:.88rem;color:#716771;margin:.2rem 0 1rem}.err{background:#fff8f0;border:1px solid #f0d8b6;border-radius:8px;padding:.65rem;margin:.8rem 0;font-size:.86rem}
label{display:block;font-size:.84rem;font-weight:600;margin:.8rem 0 .3rem}input{width:100%;padding:.6rem;border:1px solid #d9cfd8;border-radius:8px;font-size:1rem}button{width:100%;margin-top:1rem;padding:.65rem;border:0;border-radius:8px;background:#6b4a6f;color:#fff;font-weight:600;cursor:pointer}a{color:#6b4a6f;font-size:.82rem}
</style></head><body><div class="card"><h1>Paiements coachs 🔒</h1><p>Données financières réservées au propriétaire. Le déverrouillage expire après 8 heures.</p>${error}${form}<p style="margin-top:1rem"><a href="/admin">Retour à l'administration</a></p></div></body></html>`;
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
        : `<span style="color:var(--danger);font-weight:600">Ressource Wix manquante</span>`;
      const action = statement
        ? `<a class="act" href="${BASE}/etats/${esc(statement.id)}">Ouvrir la version ${statement.version}</a>`
        : `<form method="post" action="${BASE}/etats"><input type="hidden" name="profile_id" value="${esc(profile.id)}"><input type="hidden" name="month" value="${esc(args.month)}"><button class="act" type="submit">Créer le brouillon</button></form>`;
      return `<div class="card"><div class="row between"><div><h2 style="margin:.1rem 0">${esc(profile.display_name)}</h2><div class="muted">${esc(tariffLabel(tariffFromProfile(profile)))}</div><div class="muted">${resource} · ${esc(profile.email ?? "e-mail non renseigné")}</div></div><div style="text-align:right">${statement ? `${statusBadge(statement.status)}<div style="font-size:1.25rem;font-weight:650;margin:.35rem 0">${xof(statement.total_xof)}</div><div class="muted">${statement.course_count} cours · v${statement.version}</div>` : `<span class="muted">Aucun état</span>`}</div></div><div style="margin-top:.8rem">${action}</div></div>`;
    })
    .join("");
  return `${args.banner}<div class="row between"><form method="get" action="${BASE}" class="row"><label>Mois <input type="month" name="month" value="${esc(args.month)}" required></label><button class="act act--ghost" type="submit">Afficher</button></form><div class="row"><a class="act act--ghost" href="${BASE}/reglages">⚙️ Réglages coachs</a><form method="post" action="${BASE}/lock"><button class="act act--danger" type="submit">Verrouiller</button></form></div></div><h2>${esc(monthLabel(args.month))}</h2>${cards || `<div class="card muted">Aucune fiche coach active.</div>`}`;
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
  return `${args.banner}<div class="row between"><a href="${BASE}">← États mensuels</a><form method="post" action="${BASE}/lock"><button class="act act--danger" type="submit">Verrouiller</button></form></div>${args.wixError ? `<div class="card warn">⚠️ Ressources Wix indisponibles : ${esc(args.wixError)}</div>` : ""}<p class="subhead">Les modifications s'appliquent aux prochains brouillons. Les états déjà créés conservent leurs conditions.</p>${cards}${script}`;
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
  const draftTools = draft ? `<div class="card"><h2>Actions sur le brouillon</h2><div class="row"><form method="post" action="${BASE}/etats/${esc(statement.id)}/synchroniser"><button class="act act--ghost" type="submit">↻ Synchroniser Wix</button></form><form method="post" action="${BASE}/etats/${esc(statement.id)}/valider" onsubmit="return confirm('Une dernière synchronisation Wix sera faite. Valider définitivement cet état ? Son contenu ne sera plus modifiable.')"><button class="act act--ok" type="submit"${!closed || !syncOk || statement.total_xof < 0 ? " disabled" : ""}>Valider l'état</button></form></div>${!closed ? `<p class="muted">Validation disponible après la clôture de ${esc(monthLabel(month))}.</p>` : ""}${!syncOk ? `<p class="muted">Validation bloquée tant que Wix n'est pas synchronisé après la clôture et la ressource coach associée.</p>` : ""}</div>
  <div class="card"><h2>Conditions tarifaires du brouillon</h2><p class="muted">${esc(tariffLabel(tariffFromJson(statement.tariff_json)))}</p><form method="post" action="${BASE}/etats/${esc(statement.id)}/tarif">${tariffFields(args.detail)}<button class="act act--ghost" type="submit">Mettre à jour le calcul</button></form></div>
  <div class="card"><h2>Ajouter un cours manuel</h2><form method="post" action="${BASE}/etats/${esc(statement.id)}/cours-manuel"><div class="row"><label>Date et heure<input name="starts_at" type="datetime-local" required></label><label style="flex:1">Séance<input name="service_name" value="Reformer" required></label></div><label>Motif obligatoire<input name="reason" maxlength="300" required placeholder="Pourquoi cette séance n'est-elle pas dans Wix ?"></label><button class="act act--ghost" type="submit">Ajouter le cours</button></form></div>
  <div class="card"><h2>Ajouter une prime ou retenue</h2><form method="post" action="${BASE}/etats/${esc(statement.id)}/ajustements"><div class="row"><label>Type<select name="kind"><option value="bonus">Prime</option><option value="deduction">Retenue</option></select></label><label>Montant FCFA<input name="amount_xof" type="number" min="1" step="1" required></label><label style="flex:1">Motif<input name="reason" maxlength="300" required></label></div><button class="act act--ghost" type="submit">Ajouter l'ajustement</button></form></div>` : "";

  const sendBlock = !draft ? `<div class="card"><h2>Envoyer par e-mail</h2>${args.emailEnabled ? `<form method="post" action="${BASE}/etats/${esc(statement.id)}/envoyer" onsubmit="return confirm('Envoyer ce PDF à ' + this.recipient_email.value + ' ?')"><div class="row"><label style="flex:1">Destinataire<input name="recipient_email" type="email" value="${esc(profile.email ?? statement.coach_email_snapshot ?? "")}" required></label><button class="act" type="submit">✉️ ${sends.length ? "Renvoyer" : "Envoyer"} le PDF</button></div></form>` : `<p class="muted">Envoi désactivé : BREVO_API_KEY n'est pas configurée.</p>`}</div>` : "";
  const paidBlock = statement.status === "validated" ? `<div class="card"><h2>Règlement</h2><form method="post" action="${BASE}/etats/${esc(statement.id)}/payer" onsubmit="return confirm('Confirmer que ce règlement a été effectué ?')"><div class="row"><label>Date de règlement<input name="paid_on" type="date" value="${new Date().toISOString().slice(0, 10)}" required></label><button class="act act--ok" type="submit">Marquer payé</button></div></form></div>` : statement.status === "paid" ? `<div class="card success"><b>✓ Payé le ${date(statement.paid_at)}</b>${statement.paid_by ? `<div class="muted">Pointé par ${esc(statement.paid_by)}</div>` : ""}</div>` : "";
  const correction = !draft && statement.is_current ? `<form method="post" action="${BASE}/etats/${esc(statement.id)}/correction" onsubmit="return confirm('Créer une nouvelle version corrective ?')"><button class="act act--ghost" type="submit">Créer une version corrective</button></form>` : "";
  const versionsHtml = versions.map((v) => `<li><a href="${BASE}/etats/${esc(v.id)}">Version ${v.version}</a> — ${statusBadge(v.status)}${v.is_current ? " · active" : ""} · ${xof(v.total_xof)}</li>`).join("");
  const sendsHtml = sends.length ? `<table><thead><tr><th>Date</th><th>Destinataire</th><th>Résultat</th><th>Erreur</th></tr></thead><tbody>${sends.map((s) => `<tr><td>${date(s.attempted_at)}</td><td>${esc(s.recipient_email)}</td><td>${s.status === "success" ? `<span class="ok">Succès</span>` : `<span style="color:var(--danger)">Erreur</span>`}</td><td class="muted">${esc(s.error ?? "—")}</td></tr>`).join("")}</tbody></table>` : `<p class="muted">Aucun envoi.</p>`;

  return `${args.banner}<div class="row between"><a href="${BASE}?month=${esc(month)}">← ${esc(monthLabel(month))}</a><div class="row"><a class="act act--ghost" href="${BASE}/etats/${esc(statement.id)}/pdf" target="_blank">PDF ${draft ? "brouillon" : "validé"}</a>${correction}<form method="post" action="${BASE}/lock"><button class="act act--danger" type="submit">Verrouiller</button></form></div></div>
  <div class="card"><div class="row between"><div><h2 style="margin:.1rem 0">${esc(statement.coach_name_snapshot)} — ${esc(monthLabel(month))}</h2><div class="muted">Version ${statement.version} · ${esc(tariffLabel(tariffFromJson(statement.tariff_json)))}</div></div><div>${statusBadge(statement.status)}<div style="font-size:1.45rem;font-weight:700;margin-top:.35rem">${xof(statement.total_xof)}</div></div></div><p class="${syncOk ? "muted" : ""}" style="${syncOk ? "" : "color:var(--danger);font-weight:600"}">${esc(syncLabel)}</p></div>
  ${draftTools}
  <div class="card"><h2>Séances (${statement.course_count} comptées)</h2><table><thead><tr><th>Date</th><th>Séance</th><th>Comptée</th>${draft ? "<th></th>" : ""}</tr></thead><tbody>${courseRows || `<tr><td colspan="4" class="muted">Aucune séance.</td></tr>`}</tbody></table></div>
  <div class="card"><h2>Calcul</h2><table><tbody><tr><td>${statement.course_count} séance(s) selon la formule figée</td><td class="right"><b>${xof(statement.base_total_xof)}</b></td>${draft ? "<td></td>" : ""}</tr>${adjustmentRows}<tr><td><b>Total à payer</b></td><td class="right"><b style="font-size:1.12rem">${xof(statement.total_xof)}</b></td>${draft ? "<td></td>" : ""}</tr></tbody></table></div>
  ${sendBlock}${paidBlock}<div class="card"><h2>Versions</h2><ul>${versionsHtml}</ul></div><div class="card"><h2>Historique des envois</h2>${sendsHtml}</div>`;
}
