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
  return `<input name="name" required maxlength="80" value="${nameV}" placeholder="Nom" style="flex:2;min-width:9rem">
<input name="price_xof" required type="number" min="1" value="${priceV}" placeholder="Prix" style="width:6rem">
<input name="category" required maxlength="40" list="${prefix}-cats" value="${catV}" placeholder="Catégorie" style="flex:1;min-width:8rem">
<input name="description" maxlength="200" value="${descV}" placeholder="Description (optionnel)" style="flex:3;min-width:10rem">
<label style="display:flex;align-items:center;gap:.3rem;white-space:nowrap"><input type="checkbox" name="favourite"${fav}> ⭐</label>
<datalist id="${prefix}-cats">${cats.map((c) => `<option value="${esc(c)}">`).join("")}</datalist>`;
}

function editRow(it: MenuItemView, cats: string[]): string {
  return `<tr><td colspan="5">
<form method="post" action="/admin/menu/items/${esc(it.id)}/update" class="row">
  ${fieldsRow("edit", it, cats)}
  <button class="act act--sm" type="submit">Enregistrer</button>
  <a href="/admin/menu">Annuler</a>
  <span class="muted" style="font-size:.75rem">id ${esc(it.id)}</span>
</form></td></tr>`;
}

function viewRow(it: MenuItemView): string {
  return `<tr>
<td><b>${esc(it.name)}</b>${it.favourite ? " ⭐" : ""}</td>
<td style="white-space:nowrap">${esc(it.price_xof)} F</td>
<td class="hide-sm">${esc(it.description)}</td>
<td class="hide-sm"><span class="muted" style="font-size:.72rem">${esc(it.id)}</span></td>
<td style="white-space:nowrap">
  <a class="act act--sm act--ghost" href="/admin/menu?edit=${esc(it.id)}">Modifier</a>
  <form method="post" action="/admin/menu/items/${esc(it.id)}/toggle" style="display:inline" onsubmit="return confirm('Retirer « ${esc(it.name)} » du menu ?')">
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
      return `<h3 style="margin:1rem 0 .3rem">${esc(cat)}</h3>
<div class="card"><table><thead><tr><th>Article</th><th>Prix</th><th class="hide-sm">Description</th><th class="hide-sm">ID</th><th>Actions</th></tr></thead><tbody>${rows}</tbody></table></div>`;
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
<h2 style="margin:.4rem 0">Menu bar ☕</h2>
<p class="muted">Modifie prix, noms et descriptions ici — Awa et le formulaire livraisons se mettent à jour tout de suite, sans redéploiement. Les prix sont toujours calculés côté serveur. « Retirer » archive l'article (restaurable) ; l'ID n'est jamais réutilisé.</p>
${groups || `<p class="muted">Menu vide.</p>`}
${retiredBlock}
<h3 style="margin:1.4rem 0 .3rem">➕ Ajouter un article</h3>
<div class="card">
  <form method="post" action="/admin/menu/items" class="row">
    ${fieldsRow("add", null, cats)}
    <button class="act" type="submit">Ajouter</button>
  </form>
  <p class="muted" style="font-size:.75rem;margin:.5rem 0 0">⭐ = incontournable (proposé sur WhatsApp après une réservation, max 10). L'ID est généré automatiquement depuis le nom.</p>
</div>`;
}
