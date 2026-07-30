import { escapeHtml as esc, fmtDate } from "./helpers.js";
import type { FaqEntry } from "../domain/faqRepo.js";

/**
 * Base de connaissances FAQ d'Awa. Alimentée depuis la résolution d'un handoff
 * (« Enregistrer la réponse en FAQ ») ou saisie ici. Seules les entrées
 * publiées ET activées sont injectées au prompt d'Awa comme données factuelles.
 * Évite de répéter 3 handoffs pour la même question (ex. télétravail).
 */
export interface FaqPageData {
  entries: FaqEntry[];
  notice?: string | null;
  error?: string | null;
}

export function renderFaqPage(d: FaqPageData): string {
  const banner = d.error
    ? `<div class="card card--danger">${esc(d.error)}</div>`
    : d.notice
      ? `<div class="card card--accent">${esc(d.notice)}</div>`
      : "";

  const rows = d.entries.length
    ? d.entries
        .map((e) => {
          const live = e.status === "published" && e.enabled;
          const state = live
            ? `<span class="pill pill--ok">Publiée</span>`
            : e.status === "published"
              ? `<span class="pill pill--muted">Désactivée</span>`
              : `<span class="pill pill--warn">Brouillon</span>`;
          return `<tr>
<td>${state}</td>
<td>
<form method="post" action="/admin/faq/${esc(e.id)}" class="stack">
<label>Question<br><input name="question" value="${esc(e.question)}" required maxlength="240"></label>
<label>Réponse<br><textarea name="answer" rows="3" required maxlength="1000">${esc(e.answer)}</textarea></label>
<div class="row">
<button class="act act--primary" name="op" value="save" type="submit">Enregistrer</button>
${e.status === "draft" || !e.enabled
  ? `<button class="act act--ghost" name="op" value="publish" type="submit">Publier</button>`
  : `<button class="act act--ghost" name="op" value="unpublish" type="submit">Retirer</button>`}
</div>
</form>
<span class="muted">Maj ${esc(fmtDate(e.updated_at))}${e.source_handoff ? " · depuis un handoff" : ""}</span>
</td></tr>`;
        })
        .join("")
    : `<tr><td colspan="2" class="muted">Aucune entrée. Créez-en une, ou enregistrez une réponse depuis un handoff résolu.</td></tr>`;

  return `${banner}
<div class="card">
<h3>Nouvelle entrée</h3>
<form method="post" action="/admin/faq" class="stack">
<label>Question<br><input name="question" required maxlength="240" placeholder="Avez-vous un espace de télétravail ?"></label>
<label>Réponse<br><textarea name="answer" rows="3" required maxlength="1000" placeholder="Oui, dans le jardin (terrasse + pergola), extérieur avec grand ventilateur…"></textarea></label>
<button class="act act--primary" name="op" value="publish" type="submit">Créer et publier</button>
</form>
</div>

<div class="card">
<h3>Entrées</h3>
<table class="tbl">
<thead><tr><th>État</th><th>Contenu</th></tr></thead>
<tbody>${rows}</tbody>
</table>
</div>`;
}
