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
  if (item.no_recipe_needed) return `<span class="badge badge--gray">Sans recette</span>`;
  return isRecipeComplete(item)
    ? `<span class="badge badge--green">Recette complète</span>`
    : `<span class="badge badge--amber">Recette à compléter</span>`;
}

function price(value: number): string {
  return `${Math.round(value).toLocaleString("fr-FR").replace(/ /g, " ")} F`;
}

/** Anchor slug for a category section (lowercase, accents stripped, dashes). */
function anchorSlug(category: string): string {
  return (
    normalized(category)
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "autres"
  );
}

/**
 * Compact clickable row: the whole line links to the item page (data-href +
 * page script), badges replace the old Statut/Actions columns, and data-search
 * carries the server-normalized haystack the live filter matches against.
 */
function itemRow(item: MenuItemView): string {
  return `<tr class="rowlink" data-href="/admin/menu/items/${query(item.id)}" data-search="${esc(normalized(`${item.name} ${item.category} ${item.id}`))}">
<td data-label="Article"><a href="/admin/menu/items/${query(item.id)}"><b>${esc(item.name)}</b></a>${item.favourite ? ` <span class="badge badge--violet">Incontournable</span>` : ""}${item.enabled ? "" : ` <span class="badge badge--gray">Retiré</span>`}<div class="muted">${esc(item.id)} · ${esc(item.category)}</div></td>
<td data-label="Recette">${recipeBadge(item)}</td>
<td data-label="Prix" class="nowrap right"><b>${esc(price(item.price_xof))}</b></td>
</tr>`;
}

/**
 * Category tabs + global live search + row click. One category shows at a time;
 * typing in the search overrides the active tab and matches across ALL
 * categories; clearing the search returns to the active tab. norm() mirrors
 * normalized() above. No framework.
 */
const MENU_PAGE_SCRIPT = `<script>
(function(){
  var norm=function(s){return s.normalize('NFD').replace(/[\\u0300-\\u036f]/g,'').toLowerCase()};
  var input=document.getElementById('menu-live-search');
  var count=document.getElementById('menu-live-count');
  var empty=document.getElementById('menu-live-empty');
  var nav=document.getElementById('menu-jumpnav');
  var sections=[].slice.call(document.querySelectorAll('[data-cat-section]'));
  var pills=nav?[].slice.call(nav.querySelectorAll('a[data-cat]')):[];
  var activeCat=sections.length?sections[0].dataset.catSection:null;
  function setCount(n){if(count)count.textContent=n+' article'+(n===1?'':'s')}
  // Category mode: only activeCat visible, all its rows shown.
  function showCategory(slug){
    activeCat=slug;var shown=0;
    sections.forEach(function(sec){
      var on=sec.dataset.catSection===slug;
      sec.hidden=!on;
      sec.querySelectorAll('tr[data-search]').forEach(function(tr){tr.hidden=false});
      if(on)shown=sec.querySelectorAll('tr[data-search]').length;
    });
    pills.forEach(function(p){var on=p.dataset.cat===slug;p.hidden=false;p.classList.toggle('active',on);p.setAttribute('aria-pressed',on)});
    setCount(shown);if(empty)empty.hidden=true;
  }
  // Search mode: match across all categories, active tab ignored.
  function runSearch(q){
    var total=0;
    sections.forEach(function(sec){
      var vis=0;
      sec.querySelectorAll('tr[data-search]').forEach(function(tr){
        var show=tr.dataset.search.indexOf(q)>-1;tr.hidden=!show;if(show)vis++;
      });
      sec.hidden=vis===0;
      var pill=nav&&nav.querySelector('a[data-cat="'+sec.dataset.catSection+'"]');
      if(pill){pill.hidden=vis===0;pill.classList.remove('active');pill.setAttribute('aria-pressed','false')}
      total+=vis;
    });
    setCount(total);if(empty)empty.hidden=total!==0;
  }
  function apply(){
    var q=norm(input?input.value.trim():'');
    if(q)runSearch(q);else showCategory(activeCat);
  }
  if(input)input.addEventListener('input',apply);
  if(nav)nav.addEventListener('click',function(e){
    var a=e.target.closest('a[data-cat]');if(!a)return;
    e.preventDefault();if(input)input.value='';showCategory(a.dataset.cat);
  });
  document.addEventListener('click',function(e){
    var tr=e.target.closest('tr[data-href]');
    if(!tr||e.target.closest('a,button,form,input,select'))return;
    location.href=tr.dataset.href;
  });
  apply();
})();
</script>`;

export function renderMenuPage(opts: {
  items: MenuItemView[];
  filters: MenuFilters;
  banner: string;
}): string {
  const { items, filters, banner } = opts;
  const visible = filterMenuItems(items, filters);
  const active = items.filter((item) => item.enabled);
  const missing = active.filter((item) => !isRecipeComplete(item));
  const complete = active.length - missing.length;

  // Category tabs: only one category shows at a time. The first is the default
  // active tab (rendered server-side so there's no flash); the rest are `hidden`
  // and revealed as full list by the <noscript> fallback below.
  const visibleCategories = menuCategories(visible);
  const jumpNav = visibleCategories.length
    ? `<nav class="jump-nav menu-jumpnav" id="menu-jumpnav">${visibleCategories
        .map((category, i) => {
          const n = visible.filter((item) => item.category === category).length;
          const active = i === 0 ? " active" : "";
          return `<a class="menu-tab${active}" href="#cat-${anchorSlug(category)}" data-cat="${anchorSlug(category)}" aria-pressed="${i === 0}">${esc(category)} <span class="badge badge--gray">${n}</span></a>`;
        })
        .join("")}</nav>`
    : "";

  const groups = visibleCategories
    .map((category, i) => {
      const categoryItems = visible.filter((item) => item.category === category);
      const slug = anchorSlug(category);
      return `<div data-cat-section="${slug}"${i === 0 ? "" : " hidden"}>
<div class="section-header"><h2 id="cat-${slug}">${esc(category)}</h2><span class="badge badge--gray">${categoryItems.length}</span></div>
<div class="card"><div class="table-wrap"><table class="responsive-table"><thead><tr><th>Article</th><th>Recette</th><th class="right">Prix</th></tr></thead><tbody>${categoryItems.map(itemRow).join("")}</tbody></table></div></div>
</div>`;
    })
    .join("");

  // Autofocus the search only on the untouched default view (no deep-linked
  // filter to preserve, no scroll to steal).
  const pristine =
    !filters.q?.trim() && (filters.status ?? "active") === "active" && (filters.recipe ?? "all") === "all" && !filters.category?.trim();

  // Default view shows only the first category, so the count starts on it (not
  // the whole menu) — JS keeps it in sync as tabs switch / search runs.
  const firstCatCount = visibleCategories.length
    ? visible.filter((item) => item.category === visibleCategories[0]).length
    : visible.length;

  return `${banner}
<header class="page-header"><div class="page-header-copy"><span class="eyebrow">Bar</span><h2>Menu et recettes</h2><p>Gérez les articles vendus par Awa et les fiches de préparation réservées à l’équipe.</p></div><div class="page-header-actions"><a class="act" href="/admin/menu/new">Ajouter un article</a></div></header>
<div class="stat-grid menu-stats">
  <div class="stat"><span>Articles actifs</span><b>${active.length}</b><span>visibles par Awa</span></div>
  <div class="stat"><span>Recettes complètes</span><b>${complete}</b><span>ingrédients et étapes</span></div>
  <div class="stat"><span>À compléter</span><b>${missing.length}</b><span>sans impact sur la vente</span></div>
</div>
<form class="card menu-filters" method="get" action="/admin/menu">
  <label class="menu-search">Rechercher<input type="search" name="q" id="menu-live-search" value="${esc(filters.q)}" placeholder="Nom, catégorie ou ID…"${pristine ? " autofocus" : ""}></label>
  <label>Statut<select name="status" onchange="this.form.submit()"><option value="active"${selected(filters.status ?? "active", "active")}>Actifs</option><option value="retired"${selected(filters.status, "retired")}>Retirés</option><option value="all"${selected(filters.status, "all")}>Tous</option></select></label>
  <label>Recette<select name="recipe" onchange="this.form.submit()"><option value="all"${selected(filters.recipe ?? "all", "all")}>Toutes</option><option value="missing"${selected(filters.recipe, "missing")}>À compléter</option><option value="complete"${selected(filters.recipe, "complete")}>Complètes</option></select></label>
  <div class="menu-filter-actions"><span class="badge badge--gray" id="menu-live-count">${firstCatCount} article${firstCatCount === 1 ? "" : "s"}</span><a href="/admin/menu">Réinitialiser</a></div>
</form>
<noscript><style>[data-cat-section][hidden]{display:block!important}</style></noscript>
${jumpNav}
${groups || `<div class="card"><div class="empty"><b>Aucun article trouvé</b><p>Modifiez les filtres ou ajoutez un nouvel article.</p></div></div>`}
<div class="card" id="menu-live-empty" hidden><div class="empty"><b>Aucun article trouvé</b><p>Aucun article ne correspond à cette recherche.</p></div></div>
${MENU_PAGE_SCRIPT}`;
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
  const noRecipeNeeded = item?.no_recipe_needed ? " checked" : "";

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
    <label class="menu-favourite"><input type="checkbox" name="no_recipe_needed"${noRecipeNeeded}> Article sans recette (ex. supplément) — ne compte pas dans «&nbsp;À compléter&nbsp;»</label>
  </section>
  <div class="actionbar"><button class="act" type="submit">${creating ? "Créer l’article" : "Enregistrer les modifications"}</button><a class="act act--ghost" href="/admin/menu">Retour au menu</a></div>
</form>
${item ? `<div class="card menu-danger-zone"><div><b>${item.enabled ? "Retirer cet article" : "Remettre cet article au menu"}</b><p class="muted">La recette et l’historique sont conservés.</p></div><form class="inline" method="post" action="/admin/menu/items/${query(item.id)}/toggle"${item.enabled ? ` data-confirm="Retirer « ${esc(item.name)} » du menu ? L’article pourra être restauré plus tard."` : ""}><button class="act ${item.enabled ? "act--danger" : "act--ok"}" type="submit">${item.enabled ? "Retirer du menu" : "Remettre au menu"}</button></form></div>` : ""}`;
}
