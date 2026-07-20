import type { GiftCard } from "../domain/giftCardRepo.js";

/**
 * Body HTML for /admin/cartes-cadeaux — server-rendered, self-contained
 * escaping so it doesn't import from routes.ts (which imports this). routes.ts
 * wraps list/form/view in layout() and owns the POST handlers + the /png render.
 */

function esc(s: unknown): string {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
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
  created: "Carte cadeau créée.",
  sent: "Carte envoyée sur WhatsApp.",
};

export function cartesCadeauxBanner(done?: string, err?: string): string {
  if (done && BANNERS[done])
    return `<div class="card success"><span class="ok">✓ ${esc(BANNERS[done])}</span></div>`;
  if (err) return `<div class="card warn">⚠️ ${esc(err)}</div>`;
  return "";
}

function sentCell(gc: GiftCard): string {
  if (gc.sent_status === "sent") return `<span class="ok">✓ envoyée</span>`;
  if (gc.sent_status === "window_closed") return `<span style="color:#9a6700">fenêtre fermée</span>`;
  if (gc.sent_status === "failed") return `<span style="color:#cf222e">✗ échec</span>`;
  return `<span class="muted">—</span>`;
}

// ---------- list ----------

export function renderGiftCardsList(rows: GiftCard[], banner: string): string {
  const table = rows.length
    ? `<div class="table-wrap"><table class="responsive-table"><thead><tr><th class="hide-sm">Date</th><th>Offre</th><th>Pour</th><th>De</th><th class="hide-sm">Envoi</th><th>Actions</th></tr></thead><tbody>${rows
        .map(
          (gc) => `<tr>
<td data-label="Date" class="hide-sm nowrap">${fmtDay(gc.created_at)}</td>
<td data-label="Offre"><b>${esc(gc.offer_line1)}</b>${gc.offer_line2 ? `<br><span class="muted">${esc(gc.offer_line2)}</span>` : ""}</td>
<td data-label="Pour">${esc(gc.recipient_name)}</td>
<td data-label="De">${esc(gc.from_name)}</td>
<td data-label="Envoi" class="hide-sm">${sentCell(gc)}</td>
<td data-label=""><a class="act act--sm act--ghost" href="/admin/cartes-cadeaux/${esc(gc.id)}">Consulter</a></td>
</tr>`,
        )
        .join("")}</tbody></table></div>`
    : `<div class="empty"><b>Aucune carte cadeau</b><p>Les cartes générées et leurs états d’envoi apparaîtront ici.</p></div>`;
  return `${banner}
<header class="page-header"><div class="page-header-copy"><span class="eyebrow">Documents</span><h2>Cartes cadeaux</h2><p>Générez le visuel Revive puis envoyez-le au destinataire sur WhatsApp.</p></div><div class="page-header-actions"><a href="/admin/cartes-cadeaux/new" class="act">Nouvelle carte</a></div></header>
<div class="card">${table}</div>`;
}

// ---------- create form ----------

export function renderGiftCardForm(banner: string): string {
  return `${banner}
<header class="page-header"><div class="page-header-copy"><span class="eyebrow">Cartes cadeaux</span><h2>Nouvelle carte</h2><p>Le visuel Revive est fixe ; seules l’offre et les informations du cadeau changent.</p></div></header>
<form method="post" action="/admin/cartes-cadeaux" class="col">
  <div class="card col">
    <b>Offre</b>
    <label>Ligne 1 <span class="muted">(requis)</span><input name="offer_line1" required maxlength="60" placeholder="PACK DECOUVERTE"></label>
    <label>Ligne 2 <span class="muted">(optionnel)</span><input name="offer_line2" maxlength="60" placeholder="3 SEANCES REFORMER"></label>
  </div>
  <div class="card col">
    <label>Pour <span class="muted">(destinataire — requis)</span><input name="recipient_name" required maxlength="60"></label>
    <label>De <span class="muted">(offreur — requis)</span><input name="from_name" required maxlength="60"></label>
    <label>Téléphone WhatsApp <span class="muted">(optionnel — pour l'envoi ; vide si tu l'envoies toi-même)</span><input name="send_phone" placeholder="77 123 45 67 ou +221…"></label>
  </div>
  <div class="actionbar">
    <button class="act" type="submit">Créer la carte</button>
    <a href="/admin/cartes-cadeaux">Annuler</a>
  </div>
</form>`;
}

// ---------- view ----------

export function renderGiftCardView(gc: GiftCard, banner: string): string {
  const base = `/admin/cartes-cadeaux/${esc(gc.id)}`;
  const sendBtn = gc.send_phone
    ? `<form method="post" action="${base}/send" style="display:inline" onsubmit="this.querySelector('button').disabled=true;this.querySelector('button').textContent='Envoi…'">
<button class="act" type="submit">Envoyer sur WhatsApp (+${esc(gc.send_phone)})</button></form>`
    : `<span class="muted">Aucun numéro enregistré — télécharge et envoie manuellement.</span>`;
  return `${banner}
<header class="page-header"><div class="page-header-copy"><span class="eyebrow">Carte cadeau</span><h2>${esc(gc.recipient_name)}</h2><p>${esc(gc.offer_line1)}${gc.offer_line2 ? ` · ${esc(gc.offer_line2)}` : ""}</p></div><div class="page-header-actions"><a class="act act--ghost" href="/admin/cartes-cadeaux">Retour</a></div></header>
<div class="card">
  <img src="${base}/png?inline=1" alt="Carte cadeau" style="max-width:100%;height:auto;border:1px solid #e8d9d2;border-radius:8px">
</div>
<div class="card row">
  <a class="act act--ghost" href="${base}/png">Télécharger</a>
  ${sendBtn}
  <span>${sentCell(gc)}</span>
</div>`;
}
