import { isRecipeComplete, type MenuItemView } from "../domain/cafeMenuRepo.js";

/** Server-rendered menu catalogue and internal recipe editor. */

function esc(value: unknown): string {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function query(value: unknown): string {
  return encodeURIComponent(String(value ?? ""));
}

const BANNERS: Record<string, string> = {
  created: "Article ajouté au menu.",
  updated: "Article et recette mis à jour.",
  retired: "Article retiré du menu.",
  restored: "Article remis au menu.",
};

export function menuBanner(done?: string, err?: string): string {
  if (done && BANNERS[done])
    return `<div class="card success"><span class="ok">✓ ${esc(BANNERS[done])}</span></div>`;
  if (err) return `<div class="card warn">${esc(err)}</div>`;
  return "";
}

export type MenuFilters = {
  q?: string;
  status?: "active" | "retired" | "all";
  recipe?: "all" | "complete" | "missing";
  category?: string;
};

function normalized(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLocaleLowerCase("fr-FR");
}

export function filterMenuItems(items: MenuItemView[], filters: MenuFilters): MenuItemView[] {
  const q = normalized(filters.q?.trim() ?? "");
  const status = filters.status ?? "active";
  const recipe = filters.recipe ?? "all";
  const category = filters.category?.trim() ?? "";
  return items.filter((item) => {
    if (status === "active" && !item.enabled) return false;
    if (status === "retired" && item.enabled) return false;
    if (recipe === "complete" && !isRecipeComplete(item)) return false;
    if (recipe === "missing" && isRecipeComplete(item)) return false;
    if (category && item.category !== category) return false;
    if (q && !normalized(`${item.name} ${item.category} ${item.id}`).includes(q)) return false;
    return true;
  });
}

/** Ordered unique categories used by the catalogue and editor datalist. */
export function menuCategories(items: MenuItemView[]): string[] {
  const seen: string[] = [];
  for (const item of items) if (!seen.includes(item.category)) seen.push(item.category);
  return seen;
}

function selected(value: string | undefined, expected: string): string {
  return (value ?? "") === expected ? " selected" : "";
}

function recipeBadge(item: MenuItemView): string {
  return isRecipeComplete(item)
    ? `<span class="badge badge--green">Recette complète</span>`
    : `<span class="badge badge--amber">Recette à compléter</span>`;
}

function price(value: number): string {
  return `${Math.round(value).toLocaleString("fr-FR").replace(/ /g, " ")} F`;
}

function itemRow(item: MenuItemView): string {
  return `<tr>
<td data-label="Article"><a href="/admin/menu/items/${query(item.id)}"><b>${esc(item.name)}</b></a>${item.favourite ? ` <span class="badge badge--violet">Incontournable</span>` : ""}<div class="muted">${esc(item.id)}</div></td>
<td data-label="Prix" class="nowrap"><b>${esc(price(item.price_xof))}</b></td>
<td data-label="Recette">${recipeBadge(item)}</td>
<td data-label="Statut">${item.enabled ? `<span class="badge badge--green">Actif</span>` : `<span class="badge badge--gray">Retiré</span>`}</td>
<td data-label="Actions" class="nowrap"><a class="act act--sm act--ghost" href="/admin/menu/items/${query(item.id)}">Ouvrir la fiche</a></td>
</tr>`;
}

export function renderMenuPage(opts: {
  items: MenuItemView[];
  filters: MenuFilters;
  banner: string;
}): string {
  const { items, filters, banner } = opts;
  const categories = menuCategories(items);
  const visible = filterMenuItems(items, filters);
  const active = items.filter((item) => item.enabled);
  const missing = active.filter((item) => !isRecipeComplete(item));
  const complete = active.length - missing.length;

  const groups = menuCategories(visible)
    .map((category) => {
      const categoryItems = visible.filter((item) => item.category === category);
      return `<div class="section-header"><h2>${esc(category)}</h2><span class="badge badge--gray">${categoryItems.length}</span></div>
<div class="card"><div class="table-wrap"><table class="responsive-table"><thead><tr><th>Article</th><th>Prix</th><th>Recette</th><th>Statut</th><th>Actions</th></tr></thead><tbody>${categoryItems.map(itemRow).join("")}</tbody></table></div></div>`;
    })
    .join("");

  return `${banner}
<header class="page-header"><div class="page-header-copy"><span class="eyebrow">Bar</span><h2>Menu et recettes</h2><p>Gérez les articles vendus par Awa et les fiches de préparation réservées à l’équipe.</p></div><div class="page-header-actions"><a class="act" href="/admin/menu/new">Ajouter un article</a></div></header>
<div class="stat-grid menu-stats">
  <div class="stat"><span>Articles actifs</span><b>${active.length}</b><span>visibles par Awa</span></div>
  <div class="stat"><span>Recettes complètes</span><b>${complete}</b><span>ingrédients et étapes</span></div>
  <div class="stat"><span>À compléter</span><b>${missing.length}</b><span>sans impact sur la vente</span></div>
</div>
<form class="card menu-filters" method="get" action="/admin/menu">
  <label class="menu-search">Rechercher<input type="search" name="q" value="${esc(filters.q)}" placeholder="Nom, catégorie ou ID…"></label>
  <label>Statut<select name="status"><option value="active"${selected(filters.status ?? "active", "active")}>Actifs</option><option value="retired"${selected(filters.status, "retired")}>Retirés</option><option value="all"${selected(filters.status, "all")}>Tous</option></select></label>
  <label>Recette<select name="recipe"><option value="all"${selected(filters.recipe ?? "all", "all")}>Toutes</option><option value="missing"${selected(filters.recipe, "missing")}>À compléter</option><option value="complete"${selected(filters.recipe, "complete")}>Complètes</option></select></label>
  <label>Catégorie<select name="category"><option value="">Toutes</option>${categories.map((category) => `<option value="${esc(category)}"${selected(filters.category, category)}>${esc(category)}</option>`).join("")}</select></label>
  <div class="menu-filter-actions"><button class="act act--ghost" type="submit">Filtrer</button><a href="/admin/menu">Réinitialiser</a></div>
</form>
<div class="section-header"><div><span class="eyebrow">Catalogue</span><h2>${visible.length} article(s)</h2></div></div>
${groups || `<div class="card"><div class="empty"><b>Aucun article trouvé</b><p>Modifiez les filtres ou ajoutez un nouvel article.</p></div></div>`}`;
}

function recipeState(item: MenuItemView | null): string {
  if (!item) return `<span class="badge badge--gray">Nouvelle fiche</span>`;
  return recipeBadge(item);
}

export function renderMenuItemForm(opts: {
  item: MenuItemView | null;
  categories: string[];
  banner: string;
}): string {
  const { item, categories, banner } = opts;
  const creating = item === null;
  const action = creating ? "/admin/menu/items" : `/admin/menu/items/${query(item.id)}/update`;
  const name = esc(item?.name);
  const category = esc(item?.category);
  const description = esc(item?.description);
  const ingredients = esc(item?.recipe_ingredients);
  const steps = esc(item?.recipe_steps);
  const optionLabel = esc(item?.option_label);
  const optionChoices = esc(item?.option_choices);
  const favourite = item?.favourite ? " checked" : "";

  return `${banner}
<header class="page-header"><div class="page-header-copy"><span class="eyebrow">Menu du bar</span><h2>${creating ? "Nouvel article" : esc(item.name)}</h2><p>${creating ? "Créez l’article vendu et sa fiche de préparation interne." : "Mettez à jour les informations commerciales et la recette utilisée par l’équipe."}</p></div><div class="page-header-actions">${recipeState(item)}${item ? (item.enabled ? `<span class="badge badge--green">Actif</span>` : `<span class="badge badge--gray">Retiré</span>`) : ""}</div></header>
<form method="post" action="${action}" class="menu-editor">
  <section class="card form-card">
    <div class="section-header menu-editor-heading"><div><span class="eyebrow">Catalogue</span><h2>Informations de vente</h2></div></div>
    <div class="menu-form-grid">
      <label class="menu-name">Nom de l’article<input name="name" required maxlength="80" value="${name}" placeholder="Ex. Smoothie Jant Bi"></label>
      <label>Prix en FCFA<input name="price_xof" required type="number" min="1" max="1000000" step="1" value="${item ? esc(item.price_xof) : ""}" placeholder="3000"></label>
      <label>Catégorie<input name="category" required maxlength="40" list="menu-categories" value="${category}" placeholder="Ex. Smoothies"></label>
      <datalist id="menu-categories">${categories.map((value) => `<option value="${esc(value)}">`).join("")}</datalist>
      <label class="menu-description">Description commerciale<span class="field-help">Courte présentation visible par Awa et les clients.</span><textarea name="description" rows="3" maxlength="200" placeholder="Goût, ingrédients principaux ou bénéfice client…">${description}</textarea></label>
      <label>Choix — libellé<span class="field-help">Laissez vide si l’article n’a pas de choix. Ex. « Boisson », « Lait ».</span><input name="option_label" maxlength="40" value="${optionLabel}" placeholder="Boisson"></label>
      <label>Choix — options<span class="field-help">Séparez les options par une barre «&nbsp;|&nbsp;». Ex. « Jus d’orange | Boisson chaude ». À la commande, le choix devient obligatoire.</span><input name="option_choices" maxlength="200" value="${optionChoices}" placeholder="Jus d’orange | Boisson chaude"></label>
      <label class="menu-favourite"><input type="checkbox" name="favourite"${favourite}> Incontournable proposé sur WhatsApp</label>
    </div>
  </section>
  <section class="card form-card recipe-editor">
    <div class="section-header menu-editor-heading"><div><span class="eyebrow">Interne équipe</span><h2>Fiche recette</h2><p class="muted">Ces informations ne sont jamais envoyées à Awa ni aux clients.</p></div></div>
    <label>Ingrédients et quantités<span class="field-help">Indiquez les quantités pour une portion vendue, ou précisez le rendement si la préparation se fait en lot.</span><textarea name="recipe_ingredients" rows="10" maxlength="5000" placeholder="Pour 1 portion :&#10;• 150 g de mangue&#10;• 100 ml de lait de coco">${ingredients}</textarea></label>
    <label>Étapes de préparation<span class="field-help">Écrivez les étapes dans l’ordre, avec les temps ou points de contrôle utiles.</span><textarea name="recipe_steps" rows="10" maxlength="5000" placeholder="1. Ajouter les ingrédients dans le blender.&#10;2. Mixer 45 secondes.&#10;3. Servir immédiatement.">${steps}</textarea></label>
  </section>
  <div class="actionbar"><button class="act" type="submit">${creating ? "Créer l’article" : "Enregistrer les modifications"}</button><a class="act act--ghost" href="/admin/menu">Retour au menu</a></div>
</form>
${item ? `<div class="card menu-danger-zone"><div><b>${item.enabled ? "Retirer cet article" : "Remettre cet article au menu"}</b><p class="muted">La recette et l’historique sont conservés.</p></div><form class="inline" method="post" action="/admin/menu/items/${query(item.id)}/toggle"${item.enabled ? ` data-confirm="Retirer « ${esc(item.name)} » du menu ? L’article pourra être restauré plus tard."` : ""}><button class="act ${item.enabled ? "act--danger" : "act--ok"}" type="submit">${item.enabled ? "Retirer du menu" : "Remettre au menu"}</button></form></div>` : ""}`;
}
