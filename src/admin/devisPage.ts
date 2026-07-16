import type { Quote } from "../domain/quoteRepo.js";
import { quoteItems } from "../domain/quoteRepo.js";
import {
  DEFAULT_CONDITIONS,
  DEFAULT_LOCATION,
  QUOTE_STATUSES,
  QUOTE_STATUS_LABELS,
  quoteTotal,
  type QuoteItem,
  type QuoteStatus,
} from "../domain/quoteRules.js";

/**
 * Body HTML for /admin/devis — server-rendered, self-contained escaping so it
 * doesn't import from routes.ts (which imports this). routes.ts wraps list/form
 * in layout() and owns the POST handlers + the /pdf download. No client JS: the
 * prestation lines are a fixed grid of rows (extra blanks appended so the
 * manager can add more by saving).
 */

function esc(s: unknown): string {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function fcfa(n: number): string {
  return `${Number(n).toLocaleString("fr-FR")} F`;
}

function fmtDay(d: Date | string | null): string {
  if (!d) return "—";
  return new Date(d).toLocaleDateString("fr-FR", {
    timeZone: "Africa/Dakar",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });
}

const BANNERS: Record<string, string> = {
  created: "Devis créé.",
  saved: "Devis enregistré.",
  status: "Statut mis à jour.",
};

export function devisBanner(done?: string, err?: string): string {
  if (done && BANNERS[done])
    return `<div class="card" style="border-color:#1a7f37"><span class="ok">✓ ${esc(BANNERS[done])}</span></div>`;
  if (err) return `<div class="card warn">⚠️ ${esc(err)}</div>`;
  return "";
}

const STATUS_COLORS: Record<QuoteStatus, string> = {
  DRAFT: "#6e7781",
  SENT: "#0969da",
  ACCEPTED: "#1a7f37",
  EXPIRED: "#9a6700",
};

function statusBadge(status: QuoteStatus): string {
  const color = STATUS_COLORS[status] ?? "#6e7781";
  return `<span class="badge" style="background:${color}">${esc(QUOTE_STATUS_LABELS[status] ?? status)}</span>`;
}

/** Expiry = issued_on + validity_days; overdue shown in red. */
function validityCell(q: Quote): string {
  const issued = new Date(q.issued_on);
  const exp = new Date(issued.getTime());
  exp.setDate(exp.getDate() + q.validity_days);
  const overdue = exp.getTime() < Date.now() && q.status !== "ACCEPTED";
  const label = fmtDay(exp);
  return overdue
    ? `<span style="color:#cf222e;font-weight:600">${esc(label)}</span>`
    : esc(label);
}

// ---------- list ----------

export function renderQuotesList(quotes: Quote[], banner: string): string {
  const rows = quotes
    .map((q) => {
      const total = quoteTotal(quoteItems(q));
      return `<tr class="rowlink" onclick="location='/admin/devis/${esc(q.id)}'">
<td><b>${esc(q.number)}</b></td>
<td>${esc(q.event_title)}</td>
<td>${esc(q.client_name)}${q.client_company ? `<br><span class="muted">${esc(q.client_company)}</span>` : ""}</td>
<td class="hide-sm">${esc(fmtDay(q.event_date))}</td>
<td style="white-space:nowrap">${esc(fcfa(total))}</td>
<td class="hide-sm">${validityCell(q)}</td>
<td>${statusBadge(q.status)}</td>
</tr>`;
    })
    .join("");
  const table = quotes.length
    ? `<table><thead><tr><th>N°</th><th>Événement</th><th>Client</th><th class="hide-sm">Date évén.</th><th>Total</th><th class="hide-sm">Expire le</th><th>Statut</th></tr></thead><tbody>${rows}</tbody></table>`
    : `<p class="muted">Aucun devis pour l'instant.</p>`;
  return `${banner}
<div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:.5rem">
  <h2 style="margin:.4rem 0">Devis 📄</h2>
  <a href="/admin/devis/new" class="act" style="text-decoration:none;padding:.5rem .9rem;border-radius:8px">➕ Nouveau devis</a>
</div>
<div class="card">${table}</div>`;
}

// ---------- form ----------

const INPUT = 'style="width:100%;padding:.55rem;border:1px solid #e4ddd3;border-radius:8px"';

function itemRow(i: number, item: QuoteItem | null): string {
  const label = item ? esc(item.label) : "";
  const detail = item?.detail ? esc(item.detail) : "";
  const amount = item && item.amount_xof != null ? String(item.amount_xof) : "";
  return `<tr>
<td><input name="item_label_${i}" value="${label}" placeholder="Prestation" style="width:100%;padding:.45rem;border:1px solid #e4ddd3;border-radius:8px"></td>
<td><input name="item_detail_${i}" value="${detail}" placeholder="Détail (optionnel)" style="width:100%;padding:.45rem;border:1px solid #e4ddd3;border-radius:8px"></td>
<td><input name="item_amount_${i}" value="${amount}" type="number" min="0" placeholder="vide = inclus" style="width:100%;padding:.45rem;border:1px solid #e4ddd3;border-radius:8px"></td>
</tr>`;
}

function inlineStatusForm(id: string, s: QuoteStatus, current: QuoteStatus): string {
  const isCurrent = s === current;
  const style = isCurrent
    ? "padding:.35rem .6rem;font-size:.8rem;opacity:.5;cursor:default"
    : "padding:.35rem .6rem;font-size:.8rem";
  const disabled = isCurrent ? " disabled" : "";
  return `<form method="post" action="/admin/devis/${esc(id)}/status" style="display:inline">
<input type="hidden" name="status" value="${s}">
<button class="act" type="submit" style="${style}"${disabled}>${esc(QUOTE_STATUS_LABELS[s])}</button></form>`;
}

export function renderQuoteForm(quote: Quote | null, banner: string): string {
  const isEdit = !!quote;
  const action = isEdit ? `/admin/devis/${esc(quote!.id)}` : "/admin/devis";
  const existing = quote ? quoteItems(quote) : [];
  const blanks = isEdit ? 3 : 6;
  const total = isEdit ? existing.length + blanks : blanks;
  const rows: string[] = [];
  for (let i = 0; i < total; i++) rows.push(itemRow(i, existing[i] ?? null));

  const val = (v: unknown) => esc(v ?? "");
  const dateVal = quote?.event_date
    ? new Date(quote.event_date).toISOString().slice(0, 10)
    : "";

  const header = isEdit
    ? `<div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:.5rem">
  <h2 style="margin:.4rem 0">Devis ${esc(quote!.number)} ${statusBadge(quote!.status)}</h2>
  <a href="/admin/devis/${esc(quote!.id)}/pdf" class="act" style="text-decoration:none;padding:.5rem .9rem;border-radius:8px">⬇️ Télécharger le PDF</a>
</div>
<div class="card" style="display:flex;gap:.4rem;flex-wrap:wrap;align-items:center">
  <span class="muted">Statut :</span>${QUOTE_STATUSES.map((s) => inlineStatusForm(quote!.id, s, quote!.status)).join("")}
</div>`
    : `<h2 style="margin:.4rem 0">➕ Nouveau devis</h2>`;

  return `${banner}
${header}
<form method="post" action="${action}" style="display:flex;flex-direction:column;gap:.7rem">
  <div class="card" style="display:flex;flex-direction:column;gap:.6rem">
    <b>Client</b>
    <label>Nom <span class="muted">(requis)</span><input name="client_name" required value="${val(quote?.client_name)}" ${INPUT}></label>
    <label>Société / structure<input name="client_company" value="${val(quote?.client_company)}" ${INPUT}></label>
    <label>Rôle <span class="muted">(ex. Fondatrice)</span><input name="client_role" value="${val(quote?.client_role)}" ${INPUT}></label>
    <label>Téléphone<input name="client_phone" value="${val(quote?.client_phone)}" ${INPUT}></label>
  </div>
  <div class="card" style="display:flex;flex-direction:column;gap:.6rem">
    <b>Événement</b>
    <label>Titre <span class="muted">(requis)</span><input name="event_title" required value="${val(quote?.event_title)}" placeholder="Événement privé « … »" ${INPUT}></label>
    <label>Description<textarea name="description" rows="2" ${INPUT}>${val(quote?.description)}</textarea></label>
    <div style="display:flex;gap:.6rem;flex-wrap:wrap">
      <label style="flex:1;min-width:8rem">Date<input name="event_date" type="date" value="${val(dateVal)}" ${INPUT}></label>
      <label style="flex:1;min-width:8rem">Horaire<input name="event_time" value="${val(quote?.event_time)}" placeholder="À partir de 11h" ${INPUT}></label>
    </div>
    <div style="display:flex;gap:.6rem;flex-wrap:wrap">
      <label style="flex:1;min-width:8rem">Participants<input name="participants" value="${val(quote?.participants)}" placeholder="7 personnes" ${INPUT}></label>
      <label style="flex:1;min-width:8rem">Lieu<input name="location" value="${val(quote?.location ?? DEFAULT_LOCATION)}" ${INPUT}></label>
    </div>
  </div>
  <div class="card">
    <b>Prestations</b>
    <p class="muted" style="margin:.3rem 0">Montant vide = « Inclus / 0 ». Les lignes vides sont ignorées.</p>
    <table><thead><tr><th>Prestation</th><th>Détail</th><th style="width:9rem">Montant (XOF)</th></tr></thead><tbody>${rows.join("")}</tbody></table>
  </div>
  <div class="card">
    <label><b>Conditions</b> <span class="muted">(une par ligne)</span>
    <textarea name="conditions" rows="4" ${INPUT}>${val(quote?.conditions ?? DEFAULT_CONDITIONS)}</textarea></label>
    <label style="display:block;margin-top:.6rem">Validité (jours)<input name="validity_days" type="number" min="1" max="365" value="${val(quote?.validity_days ?? 15)}" style="width:6rem;padding:.55rem;border:1px solid #e4ddd3;border-radius:8px"></label>
  </div>
  <div style="display:flex;align-items:center;gap:1rem">
    <button class="act" type="submit" style="padding:.6rem 1.1rem">${isEdit ? "Enregistrer" : "Créer le devis"}</button>
    <a href="/admin/devis">Annuler</a>
  </div>
</form>`;
}
