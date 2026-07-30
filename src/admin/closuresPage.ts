import { escapeHtml as esc, fmtDate } from "./helpers.js";
import type { StudioClosure } from "../domain/closuresRepo.js";

/**
 * Éditeur des fermetures studio (jours fériés, Maggal, travaux…). Awa filtre les
 * créneaux ces jours-là et refuse tout paiement dessus. Demi-journée possible
 * (début/fin à l'heure près). Soft-disable — une fermeture désactivée reste
 * visible et réactivable.
 */
export interface ClosuresPageData {
  closures: StudioClosure[];
  notice?: string | null;
  error?: string | null;
}

function localInput(d: Date): string {
  // datetime-local expects YYYY-MM-DDTHH:mm in the *studio* wall clock. Dakar is
  // UTC+0, so the ISO string (sliced) is already the local value.
  return new Date(d).toISOString().slice(0, 16);
}

export function renderClosuresPage(d: ClosuresPageData): string {
  const banner = d.error
    ? `<div class="card card--danger">${esc(d.error)}</div>`
    : d.notice
      ? `<div class="card card--accent">${esc(d.notice)}</div>`
      : "";

  const now = Date.now();
  const rows = d.closures.length
    ? d.closures
        .map((c) => {
          const past = new Date(c.ends_at).getTime() < now;
          const state = !c.enabled
            ? `<span class="pill pill--muted">Désactivée</span>`
            : past
              ? `<span class="pill pill--muted">Passée</span>`
              : `<span class="pill pill--warn">Active</span>`;
          return `<tr>
<td><b>${esc(c.reason)}</b>${c.note ? `<br><span class="muted">${esc(c.note)}</span>` : ""}</td>
<td>${esc(fmtDate(c.starts_at))}</td>
<td>${esc(fmtDate(c.ends_at))}</td>
<td>${state}</td>
<td class="row-actions">
<form method="post" action="/admin/fermetures/${esc(c.id)}/toggle">
<button class="act act--ghost" type="submit">${c.enabled ? "Désactiver" : "Réactiver"}</button>
</form></td></tr>`;
        })
        .join("")
    : `<tr><td colspan="5" class="muted">Aucune fermeture enregistrée.</td></tr>`;

  return `${banner}
<div class="card">
<h3>Nouvelle fermeture</h3>
<form method="post" action="/admin/fermetures" class="stack">
<label>Motif (visible par les clients)<br><input name="reason" required maxlength="120" placeholder="Maggal de Touba"></label>
<label>Note interne (optionnelle)<br><input name="note" maxlength="200"></label>
<div class="row">
<label>Début<br><input type="datetime-local" name="starts_at" required></label>
<label>Fin<br><input type="datetime-local" name="ends_at" required></label>
</div>
<p class="muted">Journée entière : mettre le début à 00:00 et la fin le lendemain à 00:00. Une séance qui commence pile à l'heure de fin n'est PAS fermée.</p>
<button class="act act--primary" type="submit">Ajouter</button>
</form>
</div>

<div class="card">
<h3>Fermetures</h3>
<table class="tbl">
<thead><tr><th>Motif</th><th>Début</th><th>Fin</th><th>État</th><th></th></tr></thead>
<tbody>${rows}</tbody>
</table>
</div>`;
}
