import type { MenuItemView } from "../domain/cafeMenuRepo.js";

/**
 * Body HTML for /admin/menu — server-rendered, self-contained escaping so it
 * doesn't import from routes.ts (which imports this). routes.ts wraps it in
 * layout() and owns the POST handlers (create / update / toggle), each of which
 * calls refreshCafeMenu() so Awa's prompt + the delivery form pick up the edit
 * with no redeploy. Editing a row is inline via ?edit=<id>.
 */

function esc(s: unknown): string {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

const BANNERS: Record<string, string> = {
  created: "Article ajouté au menu.",
  updated: "Article mis à jour.",
  retired: "Article retiré du menu.",
  restored: "Article remis au menu.",
};

export function menuBanner(done?: string, err?: string): string {
  if (done && BANNERS[done])
    return `<div class="card success"><span class="ok">✓ ${esc(BANNERS[done])}</span></div>`;
  if (err) return `<div class="card warn">⚠️ ${esc(err)}</div>`;
  return "";
}

/** Ordered unique categories (for the datalist + group order). */
function categoriesInOrder(items: MenuItemView[]): string[] {
  const seen: string[] = [];
  for (const it of items) if (!seen.includes(it.category)) seen.push(it.category);
  return seen;
}

function fieldsRow(prefix: string, it: MenuItemView | null, cats: string[]): string {
  const nameV = it ? esc(it.name) : "";
  const priceV = it ? String(it.price_xof) : "";
  const catV = it ? esc(it.category) : "";
  const descV = it ? esc(it.description) : "";
  const fav = it?.favourite ? " checked" : "";
  return `<input name="name" required maxlength="80" value="${nameV}" placeholder="Nom" aria-label="Nom de l’article" style="flex:2;min-width:9rem">
<input name="price_xof" required type="number" min="1" value="${priceV}" placeholder="Prix" aria-label="Prix en francs CFA" style="width:7rem">
<input name="category" required maxlength="40" list="${prefix}-cats" value="${catV}" placeholder="Catégorie" aria-label="Catégorie" style="flex:1;min-width:8rem">
<input name="description" maxlength="200" value="${descV}" placeholder="Description (optionnel)" aria-label="Description" style="flex:3;min-width:10rem">
<label class="cluster nowrap"><input type="checkbox" name="favourite"${fav}> Incontournable</label>
<datalist id="${prefix}-cats">${cats.map((c) => `<option value="${esc(c)}">`).join("")}</datalist>`;
}

function editRow(it: MenuItemView, cats: string[]): string {
  return `<tr><td colspan="5" data-label="">
<form method="post" action="/admin/menu/items/${esc(it.id)}/update" class="row">
  ${fieldsRow("edit", it, cats)}
  <button class="act act--sm" type="submit">Enregistrer</button>
  <a href="/admin/menu">Annuler</a>
  <span class="muted">id ${esc(it.id)}</span>
</form></td></tr>`;
}

function viewRow(it: MenuItemView): string {
  return `<tr>
<td data-label="Article"><b>${esc(it.name)}</b>${it.favourite ? ` <span class="badge badge--violet">Incontournable</span>` : ""}</td>
<td data-label="Prix" class="nowrap"><b>${esc(it.price_xof)} F</b></td>
<td data-label="Description" class="hide-sm">${esc(it.description) || "—"}</td>
<td data-label="ID" class="hide-sm"><span class="muted">${esc(it.id)}</span></td>
<td data-label="Actions" class="nowrap">
  <a class="act act--sm act--ghost" href="/admin/menu?edit=${esc(it.id)}">Modifier</a>
  <form method="post" action="/admin/menu/items/${esc(it.id)}/toggle" class="inline" data-confirm="Retirer « ${esc(it.name)} » du menu ? L’article pourra être restauré plus tard.">
    <button class="act act--sm act--ghost" type="submit">Retirer</button>
  </form>
</td></tr>`;
}

export function renderMenuPage(opts: { items: MenuItemView[]; editId?: string; banner: string }): string {
  const { items, editId, banner } = opts;
  const cats = categoriesInOrder(items.filter((i) => i.enabled));
  const enabled = items.filter((i) => i.enabled);
  const retired = items.filter((i) => !i.enabled);

  const groups = cats
    .map((cat) => {
      const rows = enabled
        .filter((i) => i.category === cat)
        .map((it) => (it.id === editId ? editRow(it, cats) : viewRow(it)))
        .join("");
      return `<div class="section-header"><h3>${esc(cat)}</h3><span class="badge badge--gray">${enabled.filter((i) => i.category === cat).length}</span></div>
<div class="card"><div class="table-wrap"><table class="responsive-table"><thead><tr><th>Article</th><th>Prix</th><th class="hide-sm">Description</th><th class="hide-sm">ID</th><th>Actions</th></tr></thead><tbody>${rows}</tbody></table></div></div>`;
    })
    .join("");

  const retiredBlock = retired.length
    ? `<details style="margin-top:1rem"><summary style="cursor:pointer;font-weight:600">Articles retirés (${retired.length})</summary>
<div class="card"><table><tbody>${retired
        .map(
          (it) => `<tr><td><b>${esc(it.name)}</b> <span class="muted">— ${esc(it.price_xof)} F · ${esc(it.category)}</span></td>
<td style="white-space:nowrap"><form method="post" action="/admin/menu/items/${esc(it.id)}/toggle" style="display:inline"><button class="act act--ok act--sm" type="submit">Remettre au menu</button></form></td></tr>`,
        )
        .join("")}</tbody></table></div></details>`
    : "";

  return `${banner}
<header class="page-header"><div class="page-header-copy"><span class="eyebrow">Bar</span><h2>Menu</h2><p>Les modifications sont immédiatement visibles par Awa et dans le formulaire de livraison. Retirer un article l’archive sans supprimer son historique.</p></div><div class="page-header-actions"><span class="badge badge--green">${enabled.length} actif(s)</span></div></header>
${groups || `<div class="card"><div class="empty"><b>Menu vide</b><p>Ajoutez le premier article ci-dessous.</p></div></div>`}
${retiredBlock}
<div class="section-header"><div><span class="eyebrow">Catalogue</span><h3>Ajouter un article</h3></div></div>
<div class="card">
  <form method="post" action="/admin/menu/items" class="row">
    ${fieldsRow("add", null, cats)}
    <button class="act" type="submit">Ajouter</button>
  </form>
  <p class="muted">Un incontournable peut être proposé sur WhatsApp après une réservation, avec un maximum de dix. L’ID technique est généré automatiquement.</p>
</div>`;
}
