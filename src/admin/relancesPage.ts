import { ago, escapeHtml as esc, fmtDate } from "./helpers.js";
import { silentLeadNudgeMessage } from "../domain/leadNudge.js";
import type { SilentLeadCandidate, RecentLeadNudge } from "../domain/leadNudgeRepo.js";

/**
 * /admin/relances — reception reviews Pack Découverte leads who clicked, got
 * Awa's pitch, and never replied, then sends one nudge per lead or skips it.
 * Nothing is sent automatically; every send is a human click.
 */

function windowLeft(lastUserAt: Date, maxAgeHours: number): string {
  const closeMs = new Date(lastUserAt).getTime() + maxAgeHours * 3_600_000;
  const mins = Math.round((closeMs - Date.now()) / 60000);
  if (mins <= 0) return `<span class="badge badge--red">fenêtre fermée</span>`;
  if (mins < 120) return `<span class="badge badge--red">ferme dans ${mins} min</span>`;
  return `<span class="badge badge--violet">ferme dans ${Math.round(mins / 60)} h</span>`;
}

function candidateCard(c: SilentLeadCandidate, maxAgeHours: number): string {
  const preview = silentLeadNudgeMessage(c.language, c.name);
  const exchanges = `${c.replies_after_trigger} réponse${c.replies_after_trigger > 1 ? "s" : ""}`;
  return `<article class="task-item">
  <span class="task-priority warn" aria-hidden="true"></span>
  <div class="task-copy">
    <div class="cluster">
      <span class="badge badge--green">${exchanges}, puis silence</span>
      ${windowLeft(c.last_user_at, maxAgeHours)}
      <span class="badge">${esc((c.language ?? "fr").toUpperCase())}</span>
    </div>
    <b><a href="/admin/conversations/${esc(c.client_id)}">${esc(c.name ?? "Lead")}</a></b>
    <div class="task-meta"><span class="muted">+${esc(c.wa_phone)} · a écrit ${ago(c.last_user_at)} · clic pub ${ago(c.trigger_at)}</span></div>
    <details class="resolution-panel">
      <summary class="muted" style="cursor:pointer">Voir le message qui sera envoyé</summary>
      <p class="internal-note">${esc(preview)}</p>
    </details>
  </div>
  <div class="task-action">
    <a class="act act--ghost act--sm" href="/admin/conversations/${esc(c.client_id)}">Voir la conversation</a>
    <form method="post" action="/admin/relances/${esc(c.client_id)}/send" class="inline">
      <button class="act act--ok act--sm" type="submit">Envoyer la relance</button>
    </form>
    <form method="post" action="/admin/relances/${esc(c.client_id)}/skip" class="inline"
          onsubmit="return confirm('Ignorer ce lead ? Il ne réapparaîtra plus dans la liste.')">
      <button class="act act--ghost act--sm" type="submit">Ignorer</button>
    </form>
  </div>
</article>`;
}

function outcomeBadge(outcome: string): string {
  switch (outcome) {
    case "SENT":
      return `<span class="badge badge--green">Relance envoyée</span>`;
    case "SUPPRESSED":
      return `<span class="badge">Ignoré</span>`;
    case "FAILED":
      return `<span class="badge badge--red">Échec d'envoi</span>`;
    default:
      return `<span class="badge badge--violet">En cours</span>`;
  }
}

function recentRow(r: RecentLeadNudge): string {
  const who = r.detail?.split(":")[1] ?? "équipe";
  return `<article class="task-item is-complete">
  <div class="task-copy">
    <div class="cluster">${outcomeBadge(r.outcome)}</div>
    <b><a href="/admin/conversations/${esc(r.client_id)}">${esc(r.name ?? "Lead")}</a></b>
    <div class="task-meta"><span class="muted">+${esc(r.wa_phone)} · ${esc(who)} · ${fmtDate(r.sent_at ?? r.assigned_at)}</span></div>
  </div>
</article>`;
}

export function renderRelancesPage(args: {
  candidates: SilentLeadCandidate[];
  recent: RecentLeadNudge[];
  maxAgeHours: number;
  banner: string;
}): string {
  const { candidates, recent, maxAgeHours, banner } = args;
  const list = candidates.length
    ? candidates.map((c) => candidateCard(c, maxAgeHours)).join("")
    : `<div class="card"><b>Aucun lead à relancer</b><p class="muted">Les leads qui ont vraiment échangé avec Awa (plusieurs messages) puis se sont arrêtés sans réserver apparaîtront ici.</p></div>`;

  const history = recent.length
    ? `<details class="resolution-panel"><summary class="act act--ghost act--sm">Historique des relances (${recent.length})</summary><div class="task-list">${recent.map(recentRow).join("")}</div></details>`
    : "";

  return `${banner}
<div class="card">
  <b>Relancer les leads pub tièdes</b>
  <p class="muted">Ces clients ont cliqué la pub « L'Invitée » et <b>échangé plusieurs messages avec Awa</b>,
  puis se sont arrêtés sans réserver — un vrai intérêt resté sans suite. (Ceux qui n'ont fait que cliquer
  sans jamais répondre ne sont volontairement pas listés.) Tu peux envoyer une relance — un seul message,
  dans la fenêtre WhatsApp de 24 h — ou ignorer le lead. Rien n'est envoyé automatiquement.</p>
</div>
<div class="task-list">${list}</div>
${history}`;
}
