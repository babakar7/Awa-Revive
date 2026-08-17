import type {
  CoachPaymentCockpitStatement,
  CoachPaymentCourse,
  CoachPaymentHoliday,
  CoachPaymentProfile,
  StatementDetail,
} from "../domain/coachPaymentRepo.js";
import {
  coachPaymentCourseBuckets,
  coachPaymentCourseNeedsReview,
  coachPaymentState,
  storedMonthKey,
  tariffFromJson,
  tariffFromProfile,
  tariffLabel,
  type CoachPaymentUiStatus,
} from "../domain/coachPaymentRules.js";
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

function cockpitStatusBadge(status: CoachPaymentUiStatus): string {
  const cls = status === "Payé"
    ? "badge--green"
    : status === "Validé" || status === "Prêt à valider"
      ? "badge--blue"
      : status === "Erreur Wix" || status === "À corriger"
        ? "badge--red"
        : status === "À préparer" || status === "Brouillon en cours"
          ? "badge--gray"
          : "badge--amber";
  return `<span class="badge ${cls}">${esc(status)}</span>`;
}

/** Attendance verdicts that pull a course into the "à vérifier" panel. */
const ATTENTION_CATEGORIES = new Set(["empty", "all_no_show", "incomplete", "unavailable"]);

/** True when a Wix course carries an attendance verdict the owner should see,
 * with a legacy fallback for rows synced before classification existed. */
function courseNeedsAttendanceReview(c: CoachPaymentCourse): boolean {
  if (c.source !== "wix" || c.wix_status === "CANCELLED") return false;
  if (c.attendance_category) return ATTENTION_CATEGORIES.has(c.attendance_category);
  return c.participant_count === 0;
}

/** Participants/attendance cell for a course row: the Wix verdict plus counts. */
function attendanceCell(c: CoachPaymentCourse): string {
  if (c.source === "wix" && c.wix_status === "CANCELLED") {
    return `<span class="badge badge--red">Séance annulée</span>`;
  }
  if (c.source === "manual") return `<span class="badge badge--gray">Manuel</span>`;
  const confirmed = c.attendance_confirmed_count ?? 0;
  const counts = `<div class="muted">${c.attendance_attended_count ?? 0} présent(s) · ${c.attendance_no_show_count ?? 0} no-show · ${confirmed} réservé(s)</div>`;
  switch (c.attendance_category) {
    case "empty":
      return `<span class="badge badge--amber">Aucune réservation</span>`;
    case "all_no_show":
      return `<span class="badge badge--amber">Non-présentations uniquement</span>${counts}`;
    case "attended":
      return `<span class="badge badge--green">Présence confirmée</span>${counts}`;
    case "incomplete":
      return `<span class="badge badge--gray">Présences incomplètes</span>${counts}`;
    case "unavailable":
      return `<span class="badge badge--gray">Présences Wix indisponibles</span>`;
    default:
      // Legacy rows without a verdict: fall back to the calendar capacity.
      return c.participant_count === 0
        ? `<span class="badge badge--amber">Séance vide · 0 participant</span>`
        : c.participant_count === null
          ? `<span class="badge badge--gray">Participants inconnus</span>`
          : `<span>${c.participant_count} participant${c.participant_count > 1 ? "s" : ""}</span>`;
  }
}

function shiftedMonth(month: string, delta: number): string {
  const [year, number] = month.split("-").map(Number);
  const value = new Date(Date.UTC(year, number - 1 + delta, 1));
  return `${value.getUTCFullYear()}-${String(value.getUTCMonth() + 1).padStart(2, "0")}`;
}

export function coachPaymentBanner(
  done?: string,
  error?: string,
  counters: Record<string, string | undefined> = {},
): string {
  const messages: Record<string, string> = {
    profile: "Réglages enregistrés.",
    "profile-created": "Coach ajoutée depuis Wix.",
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
    "holiday-added": "Jour férié ajouté. Les brouillons concernés ont été recalculés.",
    "holiday-removed": "Jour férié retiré. Les brouillons concernés ont été recalculés.",
  };
  if (error) return `<div class="card warn">⚠️ ${esc(error)}</div>`;
  if (done === "prepared") {
    const count = (key: string) => /^\d+$/.test(counters[key] ?? "") ? Number(counters[key]) : 0;
    return `<div class="card success"><span class="ok">✓ Préparation terminée.</span><div class="payment-bulk-result"><span>${count("created")} créé(s)</span><span>${count("synced")} resynchronisé(s)</span><span>${count("failed")} échec(s)</span><span>${count("skipped")} ignoré(s)</span></div></div>`;
  }
  if (done && messages[done]) return `<div class="card success"><span class="ok">✓ ${esc(messages[done])}</span></div>`;
  return "";
}

export function renderCoachPaymentsDashboard(args: {
  month: string;
  profiles: CoachPaymentProfile[];
  statements: CoachPaymentCockpitStatement[];
  banner: string;
  now?: Date;
}): string {
  const byProfile = new Map(args.statements.map((s) => [s.coach_profile_id, s]));
  const snapshotAvailable = (statement: CoachPaymentCockpitStatement | undefined) => Boolean(
    statement && (
      statement.sync_status === "ok" ||
      statement.synced_at ||
      statement.status === "validated" ||
      statement.status === "paid"
    ),
  );
  const coveredStatements = args.statements.filter((statement) => snapshotAvailable(statement));
  const coverage = coveredStatements.length;
  const coachCount = args.profiles.length;
  const coverageLabel = `${coverage} état${coverage > 1 ? "s" : ""} sur ${coachCount} coach${coachCount > 1 ? "s" : ""}`;
  const total = coveredStatements.reduce((sum, statement) => sum + statement.total_xof, 0);
  const courses = coveredStatements.reduce((sum, statement) => sum + statement.course_count, 0);
  const anomalies = coveredStatements.reduce((sum, statement) => sum + statement.anomaly_count, 0);
  const progressed = args.profiles.filter((profile) => {
    const statement = byProfile.get(profile.id);
    if (!statement) return false;
    const status = coachPaymentState({
      month: args.month,
      statement,
      coachLinked: Boolean(profile.wix_resource_id),
      now: args.now,
    }).status;
    return ["Prêt à valider", "Validé", "Payé"].includes(status);
  }).length;
  const value = (content: string) => coverage ? content : "—";
  const stats = `<div class="payment-stat-grid">
    <article><span>Total estimé</span><b>${value(xof(total))}</b><small>${coverageLabel}</small></article>
    <article><span>Cours comptés</span><b>${value(String(courses))}</b><small>${coverageLabel}</small></article>
    <article><span>Séances à vérifier</span><b>${value(String(anomalies))}</b><small>${coverageLabel}</small></article>
    <article><span>Progression</span><b>${coachCount ? `${progressed}/${coachCount}` : "—"}</b><small>${coverageLabel}</small></article>
  </div>`;
  const rows = args.profiles
    .map((profile) => {
      const statement = byProfile.get(profile.id);
      const hasSnapshot = snapshotAvailable(statement);
      const state = coachPaymentState({
        month: args.month,
        statement,
        coachLinked: Boolean(profile.wix_resource_id),
        now: args.now,
      });
      const action = statement
        ? `<a class="act act--ghost act--sm" href="${BASE}/etats/${esc(statement.id)}">${state.status === "Prêt à valider" ? "Contrôler et valider" : state.status === "Payé" ? "Voir le règlement" : "Ouvrir"}</a>`
        : `<form method="post" action="${BASE}/etats"><input type="hidden" name="profile_id" value="${esc(profile.id)}"><input type="hidden" name="month" value="${esc(args.month)}"><button class="act act--ghost act--sm" type="submit">Préparer</button></form>`;
      return `<tr><td data-label="Coach"><b>${esc(profile.display_name)}</b><div class="muted">${esc(profile.email ?? "e-mail non renseigné")}</div></td><td data-label="Statut">${cockpitStatusBadge(state.status)}</td><td data-label="Reformer">${hasSnapshot ? statement!.reformer_count : "—"}</td><td data-label="Mat">${hasSnapshot ? statement!.mat_count : "—"}</td><td data-label="Manuel">${hasSnapshot ? statement!.manual_count : "—"}</td><td data-label="Anomalies">${hasSnapshot ? (statement!.anomaly_count ? `<span class="badge badge--amber">${statement!.anomaly_count}</span>` : "0") : "—"}</td><td data-label="Montant" class="right">${hasSnapshot ? `<b>${xof(statement!.total_xof)}</b><div class="muted">v${statement!.version}</div>` : statement ? "—" : "À préparer"}</td><td data-label="Action">${action}</td></tr>`;
    })
    .join("");
  return `<header class="page-header"><div class="page-header-copy"><span class="eyebrow">Studio · Propriétaire</span><h2>Paiements coachs</h2><p>Couverture du mois, anomalies et prochaine action dans un seul cockpit.</p></div><div class="page-header-actions"><form method="post" action="${BASE}/preparer"><input type="hidden" name="month" value="${esc(args.month)}"><button class="act" type="submit">Préparer le mois</button></form><a class="act act--ghost" href="${BASE}/reglages">Réglages coachs</a></div></header>${args.banner}
  <div class="card payment-month-bar"><a class="act act--ghost act--sm" href="${BASE}?month=${shiftedMonth(args.month, -1)}" aria-label="Mois précédent">← Mois précédent</a><form method="get" action="${BASE}" class="row"><label>Mois<input type="month" name="month" value="${esc(args.month)}" onchange="this.form.requestSubmit()" required></label></form><a class="act act--ghost act--sm" href="${BASE}?month=${shiftedMonth(args.month, 1)}" aria-label="Mois suivant">Mois suivant →</a></div>
  <div class="section-header"><h2>${esc(monthLabel(args.month))}</h2><span class="badge badge--gray">${coachCount} coach(s)</span></div>${stats}
  ${rows ? `<div class="card payment-cockpit-table"><div class="table-wrap"><table class="responsive-table"><thead><tr><th>Coach</th><th>Statut</th><th>Reformer</th><th>Mat</th><th>Manuel</th><th>Anomalies</th><th class="right">Montant</th><th></th></tr></thead><tbody>${rows}</tbody></table></div></div>` : `<div class="card empty"><b>Aucune fiche coach active</b><p>Ajoutez ou réactivez une fiche depuis les réglages.</p></div>`}`;
}

function holidayDateLabel(isoDate: string): string {
  return new Date(`${isoDate}T00:00:00Z`).toLocaleDateString("fr-FR", {
    timeZone: "Africa/Dakar",
    weekday: "long",
    day: "2-digit",
    month: "long",
    year: "numeric",
  });
}

export function renderCoachPaymentSettings(args: {
  profiles: CoachPaymentProfile[];
  holidays: CoachPaymentHoliday[];
  resources: WixStaffResource[];
  wixError?: string;
  banner: string;
}): string {
  const associatedResourceIds = new Set(
    args.profiles.map((profile) => profile.wix_resource_id).filter(Boolean),
  );
  const availableResources = args.resources.filter(
    (resource) => !associatedResourceIds.has(resource.id),
  );
  const resourceOptions = (selected: string | null) =>
    `<option value="">— Non associée —</option>${args.resources.map((r) => `<option value="${esc(r.id)}" data-name="${esc(r.name)}" data-email="${esc(r.email ?? "")}"${r.id === selected ? " selected" : ""}>${esc(r.name)}${r.email ? ` — ${esc(r.email)}` : ""}</option>`).join("")}`;
  const addOptions = availableResources
    .map((r) => `<option value="${esc(r.id)}" data-name="${esc(r.name)}" data-email="${esc(r.email ?? "")}">${esc(r.name)}${r.email ? ` — ${esc(r.email)}` : ""}</option>`)
    .join("");
  const addCard = availableResources.length
    ? `<details class="payment-settings-item" id="ajouter-coach-panel"><summary><span><b>Ajouter une coach depuis Wix</b><small>${availableResources.length} ressource(s) disponible(s)</small></span><span class="act act--ghost act--sm">Ajouter</span></summary><form class="card" id="ajouter-coach" method="post" action="${BASE}/reglages" data-new-coach>
      <h2 style="margin:.1rem 0 .35rem">Ajouter une coach depuis Wix</h2>
      <p class="muted">Choisissez une ressource coach existante dans Wix, puis définissez son tarif.</p>
      <label>Coach Wix<select name="wix_resource_id" required><option value="">— Choisir une coach —</option>${addOptions}</select></label>
      <label>E-mail<input name="email" type="email" placeholder="Récupéré automatiquement depuis Wix"></label>
      <label>Formule<select name="formula_type" onchange="this.form.querySelector('[data-ratio]').style.display=this.value==='monthly_ratio'?'flex':'none';this.form.querySelector('[data-session]').style.display=this.value==='per_session'?'block':'none'"><option value="per_session">Montant par cours</option><option value="monthly_ratio">Forfait mensuel au prorata</option></select></label>
      <div class="row" data-ratio style="display:none"><label>Montant de référence (FCFA)<input name="base_amount_xof" type="number" min="0" step="1" value="800000"></label><label>Nombre de cours de référence<input name="base_session_count" type="number" min="1" step="1" value="84"></label></div>
      <label data-session>Montant par cours (FCFA)<input name="per_session_xof" type="number" min="0" step="1" value="9000" required></label>
      <button class="act" type="submit">Ajouter la coach</button>
    </form></details>`
    : `<div class="card empty"><b>Aucune nouvelle coach Wix à ajouter</b><p>${args.resources.length ? "Toutes les ressources coach Wix ont déjà une fiche de paiement." : "Aucune ressource coach n’est disponible depuis Wix."}</p></div>`;
  const cards = args.profiles.map((p) => {
    const ratio = p.formula_type === "monthly_ratio";
    const wixEmail = args.resources.find((r) => r.id === p.wix_resource_id)?.email ?? null;
    return `<details class="payment-settings-item"><summary><span><b>${esc(p.display_name)}</b><small>${p.wix_resource_id ? "Wix associé" : "Association Wix requise"} · ${esc(tariffLabel(tariffFromProfile(p)))}</small></span><span class="act act--ghost act--sm">Modifier</span></summary><form class="card" method="post" action="${BASE}/reglages/${esc(p.id)}">
      <h2 style="margin:.1rem 0 .8rem">${esc(p.display_name)}</h2>
      <div class="row"><label style="flex:1">Nom affiché<input name="display_name" value="${esc(p.display_name)}" required></label><label style="flex:2">Ressource coach Wix<select name="wix_resource_id" data-email-target="email-${esc(p.id)}">${resourceOptions(p.wix_resource_id)}</select></label></div>
      <label>E-mail mémorisé<input id="email-${esc(p.id)}" name="email" type="email" value="${esc(p.email ?? wixEmail ?? "")}" placeholder="coach@exemple.com"></label>
      <label>Formule<select name="formula_type" onchange="this.form.querySelector('[data-ratio]').style.display=this.value==='monthly_ratio'?'flex':'none';this.form.querySelector('[data-session]').style.display=this.value==='per_session'?'block':'none'"><option value="monthly_ratio"${ratio ? " selected" : ""}>Forfait mensuel au prorata</option><option value="per_session"${!ratio ? " selected" : ""}>Montant par cours</option></select></label>
      <div class="row" data-ratio style="${ratio ? "" : "display:none"}"><label>Montant de référence (FCFA)<input name="base_amount_xof" type="number" min="0" step="1" value="${esc(p.base_amount_xof ?? 800000)}"></label><label>Nombre de cours de référence<input name="base_session_count" type="number" min="1" step="1" value="${esc(p.base_session_count ?? 84)}"></label></div>
      <label data-session style="${ratio ? "display:none" : ""}">Montant par cours (FCFA)<input name="per_session_xof" type="number" min="0" step="1" value="${esc(p.per_session_xof ?? 9000)}"></label>
      <button class="act" type="submit">Enregistrer la fiche</button>
    </form></details>`;
  }).join("");
  const holidayRows = args.holidays
    .map((h) => `<tr><td data-label="Date"><b>${esc(holidayDateLabel(h.holiday_date))}</b><div class="muted">${esc(h.holiday_date)}</div></td><td data-label="Motif">${esc(h.label)}</td><td data-label="Action"><form method="post" action="${BASE}/reglages/feries/${esc(h.id)}/supprimer" data-confirm="Retirer ce jour férié ? Les brouillons concernés seront recalculés."><button class="act act--ghost act--sm" type="submit">Retirer</button></form></td></tr>`)
    .join("");
  const holidaysSection = `<div class="section-header"><h2>Jours fériés (+50 %)</h2><span class="badge badge--amber">${args.holidays.length}</span></div>
    <div class="card"><p class="muted" style="margin:.1rem 0 .7rem">Chaque séance donnée un jour férié est majorée de 50 % (calendrier de Dakar). Les états déjà validés ne sont pas recalculés.</p>
    <form class="row" method="post" action="${BASE}/reglages/feries"><label>Date<input type="date" name="holiday_date" required></label><label style="flex:1">Motif<input name="label" maxlength="100" required placeholder="Tabaski"></label><button class="act" type="submit">Ajouter le jour férié</button></form></div>
    ${holidayRows ? `<div class="card"><div class="table-wrap"><table class="responsive-table"><thead><tr><th>Date</th><th>Motif</th><th></th></tr></thead><tbody>${holidayRows}</tbody></table></div></div>` : `<div class="card empty"><b>Aucun jour férié défini</b><p>Ajoutez un jour ci-dessus pour appliquer la majoration de 50 %.</p></div>`}`;
  const script = `<script>document.querySelectorAll('select[data-email-target]').forEach(function(s){s.addEventListener('change',function(){var o=s.options[s.selectedIndex];var input=document.getElementById(s.dataset.emailTarget);if(o&&o.dataset.email&&input&&!input.value)input.value=o.dataset.email;});});var add=document.querySelector('[data-new-coach] select[name="wix_resource_id"]');if(add){add.addEventListener('change',function(){var o=add.options[add.selectedIndex];var input=add.form.querySelector('input[name="email"]');if(input)input.value=o&&o.dataset.email?o.dataset.email:'';});}</script>`;
  return `<header class="page-header"><div class="page-header-copy"><span class="eyebrow">Paiements coachs · Propriétaire</span><h2>Réglages des coachs</h2><p>Ajoutez une coach existante dans Wix et définissez ses conditions pour les prochains brouillons.</p></div><div class="page-header-actions"><a class="act act--ghost" href="${BASE}">États mensuels</a></div></header>${args.banner}${args.wixError ? `<div class="card warn">Ressources Wix indisponibles : ${esc(args.wixError)}</div>` : ""}<p class="subhead">Les états déjà créés conservent les conditions figées lors de leur création.</p>${addCard}<div class="section-header"><h2>Fiches coachs</h2><span class="badge badge--gray">${args.profiles.length}</span></div>${cards || `<div class="card empty"><b>Aucune fiche coach</b><p>Ajoutez une coach depuis Wix pour commencer.</p></div>`}${holidaysSection}${script}`;
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
  const state = coachPaymentState({
    month,
    statement,
    coachLinked: Boolean(profile.wix_resource_id),
    now: args.now,
  });
  const closed = !state.blockers.includes("month_open");
  const syncOk = !state.blockers.includes("coach_unlinked") &&
    !state.blockers.includes("sync_after_close_missing");
  const syncLabel = statement.sync_status === "ok"
    ? `Synchronisé le ${date(statement.synced_at)}`
    : statement.sync_status === "unlinked"
      ? "Coach non associée à une ressource Wix"
      : statement.sync_status === "failed"
        ? `Échec Wix : ${statement.sync_error ?? "erreur inconnue"}`
        : "Synchronisation en attente";
  const chronological = (a: typeof courses[number], b: typeof courses[number]) =>
    new Date(a.starts_at).getTime() - new Date(b.starts_at).getTime();
  const cancelledCourses = courses
    .filter((c) => c.source === "wix" && c.wix_status === "CANCELLED")
    .sort(chronological);
  const attentionCourses = courses
    .filter(courseNeedsAttendanceReview)
    .sort(chronological);
  const alreadyPriority = new Set([...cancelledCourses, ...attentionCourses].map((c) => c.id));
  const manuallyExcludedCourses = courses
    .filter((c) => c.manual_decision && !c.included && !alreadyPriority.has(c.id))
    .sort(chronological);
  const priorityIds = new Set([...alreadyPriority, ...manuallyExcludedCourses.map((c) => c.id)]);
  const priorityCourses = [...cancelledCourses, ...attentionCourses, ...manuallyExcludedCourses];
  const otherCourses = courses.filter((c) => !priorityIds.has(c.id)).sort(chronological);
  const buckets = coachPaymentCourseBuckets(courses);
  const reviewCount = courses.filter(coachPaymentCourseNeedsReview).length;
  const courseRows = (rows: typeof courses, priority: boolean) => rows.map((c) => {
    const cancelled = c.source === "wix" && c.wix_status === "CANCELLED";
    // A course excluded by the system (cancelled or an attendance verdict) can
    // be re-included by the owner as an exception; a manual exclusion is undone
    // with a plain "Inclure".
    const autoExcludable =
      cancelled ||
      c.attendance_category === "empty" ||
      c.attendance_category === "all_no_show";
    const counted = c.included
      ? c.manual_decision && autoExcludable
        ? `<span class="badge badge--green">Incluse exceptionnellement</span>`
        : "Oui"
      : "Non";
    const action = !c.included
      ? autoExcludable ? "Inclure exceptionnellement" : "Inclure"
      : "Exclure";
    const holidayBadge = c.holiday ? ` <span class="badge badge--amber">Férié +50 %</span>` : "";
    return `<tr style="${!priority && !c.included ? "opacity:.55" : ""}"><td>${date(c.starts_at)}${holidayBadge}<div class="muted">${c.source === "manual" ? `Manuel · ${esc(c.manual_reason)}` : `Wix · ${esc(c.wix_event_id)}`}</div></td><td>${esc(c.service_name)}</td><td>${attendanceCell(c)}</td><td>${counted}</td>${draft ? `<td><form method="post" action="${BASE}/etats/${esc(statement.id)}/cours/${esc(c.id)}/toggle"><button class="act act--ghost act--sm" type="submit">${action}</button></form></td>` : ""}</tr>`;
  }).join("");
  const columns = draft ? 5 : 4;
  const reviewSummary = priorityCourses.length
    ? `<div class="card warn"><b>${priorityCourses.length} séance${priorityCourses.length > 1 ? "s" : ""} à vérifier · ${cancelledCourses.length} annulée${cancelledCourses.length > 1 ? "s" : ""} · ${attentionCourses.length} présence${attentionCourses.length > 1 ? "s" : ""} à vérifier${manuallyExcludedCourses.length ? ` · ${manuallyExcludedCourses.length} exclue${manuallyExcludedCourses.length > 1 ? "s" : ""} manuellement` : ""}</b><div class="muted">Ces alertes n’empêchent pas la validation de l’état.</div></div>`
    : `<div class="card success"><span class="ok">✓ Aucune séance à vérifier.</span></div>`;
  const priorityBlock = priorityCourses.length
    ? `<details class="card payment-panel" open><summary><span><b>Séances à vérifier</b><small>${priorityCourses.length} anomalie(s)</small></span></summary><div class="table-wrap"><table><thead><tr><th>Date</th><th>Séance</th><th>Participants Wix</th><th>Comptée</th>${draft ? "<th></th>" : ""}</tr></thead><tbody>${courseRows(priorityCourses, true)}</tbody></table></div></details>`
    : "";
  const otherRows = courseRows(otherCourses, false);
  const adjustmentRows = adjustments.map((a) => `<tr><td>${a.kind === "bonus" ? "Prime" : "Retenue"}</td><td>${esc(a.reason)}</td><td class="right"><b>${a.kind === "bonus" ? "+" : "−"} ${xof(a.amount_xof)}</b></td>${draft ? `<td><form method="post" action="${BASE}/etats/${esc(statement.id)}/ajustements/${esc(a.id)}/supprimer"><button class="act act--ghost act--sm" type="submit">Retirer</button></form></td>` : ""}</tr>`).join("");
  const draftTools = draft ? `<details class="card payment-panel"><summary><span><b>Conditions tarifaires</b><small>${esc(tariffLabel(tariffFromJson(statement.tariff_json)))}</small></span></summary><form method="post" action="${BASE}/etats/${esc(statement.id)}/tarif">${tariffFields(args.detail)}<button class="act act--ghost" type="submit">Mettre à jour le calcul</button></form></details>
  <details class="card payment-panel"><summary><span><b>Ajouter un cours manuel</b><small>Avec date et motif obligatoires</small></span></summary><form method="post" action="${BASE}/etats/${esc(statement.id)}/cours-manuel"><div class="row"><label>Date et heure<input name="starts_at" type="datetime-local" required></label><label style="flex:1">Séance<input name="service_name" value="Reformer" required></label></div><label>Motif obligatoire<input name="reason" maxlength="300" required placeholder="Pourquoi cette séance n'est-elle pas dans Wix ?"></label><button class="act act--ghost" type="submit">Ajouter le cours</button></form></details>
  <details class="card payment-panel"><summary><span><b>Ajouter une prime ou retenue</b><small>Ajustement motivé du montant</small></span></summary><form method="post" action="${BASE}/etats/${esc(statement.id)}/ajustements"><div class="row"><label>Type<select name="kind"><option value="bonus">Prime</option><option value="deduction">Retenue</option></select></label><label>Montant FCFA<input name="amount_xof" type="number" min="1" step="1" required></label><label style="flex:1">Motif<input name="reason" maxlength="300" required></label></div><button class="act act--ghost" type="submit">Ajouter l'ajustement</button></form></details>` : "";

  const sendBlock = !draft ? `<div class="card"><h2>Envoyer par e-mail</h2>${args.emailEnabled ? `<form method="post" action="${BASE}/etats/${esc(statement.id)}/envoyer" data-confirm="Envoyer ce relevé PDF à la coach ?"><div class="row"><label style="flex:1">Destinataire<input name="recipient_email" type="email" value="${esc(profile.email ?? statement.coach_email_snapshot ?? "")}" required></label><button class="act" type="submit">${sends.length ? "Renvoyer" : "Envoyer"} le PDF</button></div></form>` : `<p class="muted">Envoi désactivé : BREVO_API_KEY n'est pas configurée.</p>`}</div>` : "";
  const paidBlock = statement.status === "validated" ? `<div class="card"><h2>Règlement</h2><form method="post" action="${BASE}/etats/${esc(statement.id)}/payer" data-confirm="Confirmer que ce règlement a été effectué ?"><div class="row"><label>Date de règlement<input name="paid_on" type="date" value="${new Date().toISOString().slice(0, 10)}" required></label><button class="act act--ok" type="submit">Marquer payé</button></div></form></div>` : statement.status === "paid" ? `<div class="card success"><b>✓ Payé le ${date(statement.paid_at)}</b>${statement.paid_by ? `<div class="muted">Pointé par ${esc(statement.paid_by)}</div>` : ""}</div>` : "";
  const correction = !draft && statement.is_current ? `<form class="inline" method="post" action="${BASE}/etats/${esc(statement.id)}/correction" data-confirm="Créer une nouvelle version corrective ?"><button class="act act--ghost" type="submit">Créer une version corrective</button></form>` : "";
  const versionsHtml = versions.map((v) => `<li><a href="${BASE}/etats/${esc(v.id)}">Version ${v.version}</a> — ${statusBadge(v.status)}${v.is_current ? " · active" : ""} · ${xof(v.total_xof)}</li>`).join("");
  const sendsHtml = sends.length ? `<div class="table-wrap"><table><thead><tr><th>Date</th><th>Destinataire</th><th>Résultat</th><th>Erreur</th></tr></thead><tbody>${sends.map((s) => `<tr><td>${date(s.attempted_at)}</td><td>${esc(s.recipient_email)}</td><td>${s.status === "success" ? `<span class="ok">Succès</span>` : `<span class="danger-text">Erreur</span>`}</td><td class="muted">${esc(s.error ?? "—")}</td></tr>`).join("")}</tbody></table></div>` : `<div class="empty"><b>Aucun envoi</b><p>Les tentatives apparaîtront ici avec leur résultat.</p></div>`;
  const checklistItem = (ok: boolean, label: string, detail: string) =>
    `<li class="${ok ? "is-ok" : "is-blocked"}"><span>${ok ? "✓" : "!"}</span><div><b>${esc(label)}</b><small>${esc(detail)}</small></div></li>`;
  const checklist = `<div class="card payment-checklist"><div class="section-header"><h2>Checklist de validation</h2>${cockpitStatusBadge(state.status)}</div><ul>
    ${checklistItem(!state.blockers.includes("month_open"), "Mois clôturé", closed ? "Le mois civil est terminé." : `Disponible après ${monthLabel(month)}.`)}
    ${checklistItem(!state.blockers.includes("coach_unlinked"), "Coach liée", profile.wix_resource_id ? "Ressource Wix associée." : "Associez la coach dans les réglages.")}
    ${checklistItem(!state.blockers.includes("sync_after_close_missing"), "Synchronisation après clôture", syncOk ? `Synchronisé le ${date(statement.synced_at)}.` : "Resynchronisez Wix après la fin du mois.")}
    ${checklistItem(!state.blockers.includes("negative_total"), "Total non négatif", statement.total_xof >= 0 ? xof(statement.total_xof) : "Corrigez les retenues ou le tarif.")}
  </ul></div>`;
  const primaryAction = draft
    ? state.canValidate
      ? `<form method="post" action="${BASE}/etats/${esc(statement.id)}/valider" data-confirm="Une dernière synchronisation Wix sera faite. Valider définitivement cet état ? Son contenu ne sera plus modifiable."><button class="act act--ok" type="submit">Valider l’état</button></form>`
      : state.blockers.includes("coach_unlinked")
        ? `<a class="act" href="${BASE}/reglages">Associer dans les réglages</a>`
        : `<form method="post" action="${BASE}/etats/${esc(statement.id)}/synchroniser"><button class="act" type="submit">Resynchroniser Wix</button></form>`
    : statement.status === "validated"
      ? `<a class="act act--ok" href="#reglement">Marquer payé</a>`
      : `<a class="act" href="${BASE}/etats/${esc(statement.id)}/pdf" target="_blank">Ouvrir le PDF</a>`;
  const bucketSummary = `<div class="payment-buckets"><article><span>Manuel</span><b>${buckets.manual}</b></article><article><span>Pilates Mat</span><b>${buckets.mat}</b></article><article><span>Reformer</span><b>${buckets.reformer}</b></article><article><span>Autres Wix</span><b>${buckets.otherWix}</b></article></div>`;
  const exclusionReason = (c: typeof courses[number]): string => {
    if (c.source === "wix" && c.wix_status === "CANCELLED") return "Séance annulée";
    if (c.manual_decision) return "Exclue manuellement";
    if (c.attendance_reason) return c.attendance_reason;
    if (c.source === "wix" && c.participant_count === 0) return "Séance vide (0 participant)";
    return "Non comptée";
  };
  const excludedCourses = courses.filter((c) => !c.included).sort(chronological);
  const excludedRecap = excludedCourses.length
    ? `<div class="card"><div class="section-header"><h2>Séances exclues du calcul</h2><span class="badge badge--gray">${excludedCourses.length}</span></div><p class="muted" style="margin:.1rem 0 .6rem">Ces séances ne sont pas comptées dans le total ci-dessus.</p><div class="table-wrap"><table><thead><tr><th>Date</th><th>Séance</th><th>Motif d'exclusion</th></tr></thead><tbody>${excludedCourses.map((c) => `<tr><td>${date(c.starts_at)}<div class="muted">${c.source === "manual" ? "Manuel" : `Wix · ${esc(c.wix_event_id)}`}</div></td><td>${esc(c.service_name)}</td><td>${esc(exclusionReason(c))}</td></tr>`).join("")}</tbody></table></div></div>`
    : "";

  return `<header class="page-header"><div class="page-header-copy"><span class="eyebrow">État mensuel · version ${statement.version} · Propriétaire</span><h2>${esc(statement.coach_name_snapshot)} — ${esc(monthLabel(month))}</h2><p>${esc(tariffLabel(tariffFromJson(statement.tariff_json)))}</p></div><div class="page-header-actions"><a class="act act--ghost" href="${BASE}?month=${esc(month)}">États du mois</a><a class="act act--ghost" href="${BASE}/etats/${esc(statement.id)}/pdf" target="_blank">PDF ${draft ? "brouillon" : "validé"}</a>${correction}</div></header>${args.banner}
  <div class="payment-sticky-summary"><div><span>Montant</span><b>${xof(statement.total_xof)}</b></div><div><span>Statut</span>${cockpitStatusBadge(state.status)}</div><div><span>Cours</span><b>${statement.course_count}</b></div><div><span>Anomalies</span><b>${reviewCount}</b></div><div class="payment-primary-action">${primaryAction}</div></div>
  <p class="payment-sync-line ${syncOk ? "muted" : "danger-text"}">${esc(syncLabel)}</p>
  ${checklist}${bucketSummary}
  ${reviewSummary}${priorityBlock}
  <details class="card payment-panel"><summary><span><b>Autres séances (${statement.course_count} comptées au total)</b><small>Séances normales repliées</small></span></summary><div class="table-wrap"><table><thead><tr><th>Date</th><th>Séance</th><th>Participants Wix</th><th>Comptée</th>${draft ? "<th></th>" : ""}</tr></thead><tbody>${otherRows || `<tr><td colspan="${columns}"><div class="empty"><b>Aucune autre séance</b><p>Synchronisez Wix ou ajoutez une séance manuelle.</p></div></td></tr>`}</tbody></table></div></details>
  <div class="card"><h2>Calcul</h2><div class="table-wrap"><table><tbody><tr><td>${statement.course_count} séance(s) selon la formule figée</td><td class="right"><b>${xof(statement.base_total_xof)}</b></td>${draft ? "<td></td>" : ""}</tr>${statement.holiday_course_count > 0 ? `<tr><td>Majoration jours fériés (+50 %) · ${statement.holiday_course_count} séance(s)</td><td class="right"><b>+ ${xof(statement.holiday_bonus_xof)}</b></td>${draft ? "<td></td>" : ""}</tr>` : ""}${adjustmentRows}<tr><td><b>Total à payer</b></td><td class="right"><b style="font-size:1.12rem">${xof(statement.total_xof)}</b></td>${draft ? "<td></td>" : ""}</tr></tbody></table></div></div>
  ${excludedRecap}
  ${draftTools}${sendBlock}<div id="reglement">${paidBlock}</div><details class="card payment-panel"><summary><span><b>Versions</b><small>${versions.length} version(s)</small></span></summary><ul>${versionsHtml}</ul></details><details class="card payment-panel"><summary><span><b>Historique des envois</b><small>${sends.length} tentative(s)</small></span></summary>${sendsHtml}</details>`;
}
