import {
  isRecipeComplete,
  MAX_MENU_OPTION_GROUPS,
  MAX_MENU_OPTION_RESPONSES,
  type CategoryView,
  type MenuItemView,
} from "../domain/cafeMenuRepo.js";
import { parseOptionGroups, type MenuOptionGroup } from "../lib/cafeMenu.js";
import { menuPhotoUrl } from "../lib/cafeMenuPhoto.js";

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
  photo_uploaded: "Photo de l’article mise à jour.",
  photo_removed: "Photo de l’article supprimée.",
  cat_created: "Catégorie ajoutée.",
  cat_renamed: "Catégorie renommée — les articles ont suivi.",
  cat_deleted: "Catégorie supprimée.",
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
<header class="page-header"><div class="page-header-copy"><span class="eyebrow">Bar</span><h2>Menu et recettes</h2><p>Gérez les articles vendus par Awa et les fiches de préparation réservées à l’équipe.</p></div><div class="page-header-actions"><a class="act act--ghost" href="/admin/menu/categories">Catégories</a><a class="act" href="/admin/menu/new">Ajouter un article</a></div></header>
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

function optionResponseRow(value: string, groupIndex: number, index: number): string {
  const number = index + 1;
  return `<div class="choice-response-row" data-choice-row>
  <span class="choice-response-number" aria-hidden="true">${number}</span>
  <label class="visually-hidden" for="option-group-${groupIndex}-choice-${index}">Réponse proposée ${number}</label>
  <input id="option-group-${groupIndex}-choice-${index}" name="option_groups[${groupIndex}][choices][${index}]" maxlength="200" value="${esc(value)}" placeholder="Ex. Lait d’avoine" autocomplete="off">
  <button class="act act--sm act--ghost choice-remove" type="button" aria-label="Supprimer la réponse ${number}">Supprimer</button>
</div>`;
}

function optionGroupEditor(group: MenuOptionGroup, groupIndex: number): string {
  const rows = group.choices.length ? group.choices : [""];
  return `<section class="choice-group" data-choice-group>
  <div class="choice-group-heading">
    <h4 data-choice-group-title>Type de choix ${groupIndex + 1}</h4>
    <button class="act act--sm act--ghost choice-group-remove" type="button" aria-label="Supprimer le type de choix ${groupIndex + 1}">Supprimer ce type</button>
  </div>
  <label class="choice-label">Intitulé du choix<span class="field-help">Par exemple « Type de lait » ou « Type de fromage ».</span><input data-choice-label name="option_groups[${groupIndex}][label]" maxlength="40" value="${esc(group.label)}" placeholder="Type de lait" autocomplete="off"></label>
  <div class="choice-responses">
    <div class="choice-responses-heading"><div><b>Réponses proposées</b><span class="field-help">Une réponse par ligne, dans l’ordre présenté au client.</span></div><span class="badge badge--gray" data-choice-count aria-live="polite">${group.choices.length} réponse${group.choices.length === 1 ? "" : "s"} enregistrée${group.choices.length === 1 ? "" : "s"}</span></div>
    <div class="choice-response-list" data-choice-rows>${rows.map((value, index) => optionResponseRow(value, groupIndex, index)).join("")}</div>
    <div class="choice-response-actions"><button class="act act--ghost" type="button" data-choice-add>Ajouter une réponse</button><span class="field-help">${MAX_MENU_OPTION_RESPONSES} réponses maximum.</span></div>
  </div>
</section>`;
}

const MENU_OPTION_EDITOR_SCRIPT = `<script>
(function(){
  var editor=document.querySelector('[data-choice-editor]');
  if(!editor)return;
  var groups=editor.querySelector('[data-choice-groups]');
  var addGroup=editor.querySelector('[data-choice-group-add]');
  var groupCount=editor.querySelector('[data-choice-group-count]');
  var maxResponses=${MAX_MENU_OPTION_RESPONSES};
  var maxGroups=${MAX_MENU_OPTION_GROUPS};
  function rowHtml(){
    var row=document.createElement('div');
    row.className='choice-response-row';
    row.setAttribute('data-choice-row','');
    row.innerHTML='<span class="choice-response-number" aria-hidden="true"></span><label class="visually-hidden"></label><input maxlength="200" placeholder="Ex. Lait d’avoine" autocomplete="off"><button class="act act--sm act--ghost choice-remove" type="button">Supprimer</button>';
    return row;
  }
  function groupHtml(){
    var group=document.createElement('section');
    group.className='choice-group';group.setAttribute('data-choice-group','');
    group.innerHTML='<div class="choice-group-heading"><h4 data-choice-group-title></h4><button class="act act--sm act--ghost choice-group-remove" type="button">Supprimer ce type</button></div><label class="choice-label">Intitulé du choix<span class="field-help">Par exemple « Type de lait » ou « Type de fromage ».</span><input data-choice-label maxlength="40" placeholder="Type de lait" autocomplete="off"></label><div class="choice-responses"><div class="choice-responses-heading"><div><b>Réponses proposées</b><span class="field-help">Une réponse par ligne, dans l’ordre présenté au client.</span></div><span class="badge badge--gray" data-choice-count aria-live="polite"></span></div><div class="choice-response-list" data-choice-rows></div><div class="choice-response-actions"><button class="act act--ghost" type="button" data-choice-add>Ajouter une réponse</button><span class="field-help">${MAX_MENU_OPTION_RESPONSES} réponses maximum.</span></div></div>';
    group.querySelector('[data-choice-rows]').appendChild(rowHtml());
    return group;
  }
  function update(){
    var allGroups=[].slice.call(groups.querySelectorAll('[data-choice-group]'));
    var savedGroups=0;
    allGroups.forEach(function(group,groupIndex){
      var title=group.querySelector('[data-choice-group-title]');
      var labelInput=group.querySelector('[data-choice-label]');
      var removeGroup=group.querySelector('.choice-group-remove');
      title.textContent='Type de choix '+(groupIndex+1);
      labelInput.name='option_groups['+groupIndex+'][label]';
      removeGroup.setAttribute('aria-label','Supprimer le type de choix '+(groupIndex+1));
      var rows=group.querySelector('[data-choice-rows]');
      var all=[].slice.call(rows.querySelectorAll('[data-choice-row]'));
      var saved=0;
      all.forEach(function(row,index){
        var number=index+1;
        var input=row.querySelector('input');
        var label=row.querySelector('label');
        var remove=row.querySelector('.choice-remove');
        var id='option-group-'+groupIndex+'-choice-'+index;
        row.querySelector('.choice-response-number').textContent=number;
        input.id=id;input.name='option_groups['+groupIndex+'][choices]['+index+']';
        label.htmlFor=id;label.textContent='Réponse proposée '+number;
        remove.setAttribute('aria-label','Supprimer la réponse '+number+' du type '+(groupIndex+1));
        if(input.value.trim())saved++;
      });
      group.querySelector('[data-choice-count]').textContent=saved+' réponse'+(saved===1?'':'s')+' enregistrée'+(saved===1?'':'s');
      var add=group.querySelector('[data-choice-add]');
      add.disabled=all.length>=maxResponses;
      add.setAttribute('aria-disabled',add.disabled?'true':'false');
      if(labelInput.value.trim()||saved)savedGroups++;
    });
    groupCount.textContent=savedGroups+' type'+(savedGroups===1?'':'s')+' de choix enregistré'+(savedGroups===1?'':'s');
    addGroup.disabled=allGroups.length>=maxGroups;
    addGroup.setAttribute('aria-disabled',addGroup.disabled?'true':'false');
  }
  addGroup.addEventListener('click',function(){
    if(groups.querySelectorAll('[data-choice-group]').length>=maxGroups)return;
    var group=groupHtml();groups.appendChild(group);update();group.querySelector('[data-choice-label]').focus();
  });
  groups.addEventListener('click',function(event){
    var add=event.target.closest('[data-choice-add]');
    if(add){
      var rows=add.closest('[data-choice-group]').querySelector('[data-choice-rows]');
      if(rows.querySelectorAll('[data-choice-row]').length>=maxResponses)return;
      var newRow=rowHtml();rows.appendChild(newRow);update();newRow.querySelector('input').focus();return;
    }
    var button=event.target.closest('.choice-remove');
    if(button){
      var row=button.closest('[data-choice-row]');
      var rows=row.closest('[data-choice-rows]');
      var all=rows.querySelectorAll('[data-choice-row]');
      if(all.length===1){row.querySelector('input').value='';row.querySelector('input').focus();}
      else row.remove();
      update();return;
    }
    var removeGroup=event.target.closest('.choice-group-remove');
    if(removeGroup){
      var group=removeGroup.closest('[data-choice-group]');
      var allGroups=groups.querySelectorAll('[data-choice-group]');
      if(allGroups.length===1){
        group.querySelector('[data-choice-label]').value='';
        group.querySelectorAll('[data-choice-row]').forEach(function(row,index){if(index)row.remove();else row.querySelector('input').value='';});
        group.querySelector('[data-choice-label]').focus();
      }else{group.remove();groups.querySelector('[data-choice-group] [data-choice-label]').focus();}
      update();
    }
  });
  groups.addEventListener('input',update);
  editor.closest('form').addEventListener('submit',update);
  update();
})();
</script>`;

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
  const configuredGroups = parseOptionGroups(
    item?.option_groups,
    item?.option_label,
    item?.option_choices,
  );
  const optionGroups = configuredGroups.length
    ? configuredGroups
    : [{ label: "", choices: [] }];
  const favourite = item?.favourite ? " checked" : "";
  const noRecipeNeeded = item?.no_recipe_needed ? " checked" : "";
  const photoEditor = item
    ? `<section class="card form-card menu-photo-editor">
    <div class="section-header menu-editor-heading"><div><span class="eyebrow">Photo</span><h2>Visuel de l’article</h2><p class="muted">Affiché en grand sur le menu public et en miniature dans la commande en ligne.</p></div></div>
    ${item.photo_version ? `<img src="${esc(menuPhotoUrl(item.id, item.photo_version))}" alt="${esc(item.name)}" width="900" height="600" loading="lazy" decoding="async" style="display:block;width:min(100%,28rem);height:auto;aspect-ratio:3/2;object-fit:cover;border-radius:12px;margin-bottom:1rem">` : `<p class="muted">Aucune photo pour cet article.</p>`}
    <form method="post" enctype="multipart/form-data" action="/admin/menu/items/${query(item.id)}/photo">
      <label>Ajouter ou remplacer la photo<span class="field-help">JPEG, PNG ou WebP · 10 Mo maximum. L’image sera recadrée au centre au format 3:2.</span><input type="file" name="photo" accept="image/jpeg,image/png,image/webp" required></label>
      <div class="actionbar"><button class="act" type="submit">${item.photo_version ? "Remplacer la photo" : "Ajouter la photo"}</button></div>
    </form>
    ${item.photo_version ? `<form method="post" action="/admin/menu/items/${query(item.id)}/photo/remove" data-confirm="Supprimer la photo de « ${esc(item.name)} » ?"><button class="act act--danger" type="submit">Supprimer la photo</button></form>` : ""}
  </section>`
    : "";

  return `${banner}
<header class="page-header"><div class="page-header-copy"><span class="eyebrow">Menu du bar</span><h2>${creating ? "Nouvel article" : esc(item.name)}</h2><p>${creating ? "Créez l’article vendu et sa fiche de préparation interne." : "Mettez à jour les informations commerciales et la recette utilisée par l’équipe."}</p></div><div class="page-header-actions">${recipeState(item)}${item ? (item.enabled ? `<span class="badge badge--green">Actif</span>` : `<span class="badge badge--gray">Retiré</span>`) : ""}</div></header>
<form method="post" action="${action}" class="menu-editor">
  <section class="card form-card">
    <div class="section-header menu-editor-heading"><div><span class="eyebrow">Catalogue</span><h2>Informations de vente</h2></div></div>
    <div class="menu-form-grid">
      <label class="menu-name">Nom de l’article<input name="name" required maxlength="80" value="${name}" placeholder="Ex. Smoothie Jant Bi"></label>
      <label>Prix en FCFA<input name="price_xof" required type="number" min="1" max="1000000" step="1" value="${item ? esc(item.price_xof) : ""}" placeholder="3000"></label>
      <label>Catégorie<span class="field-help">Gérez la liste sur <a href="/admin/menu/categories">Catégories</a>.</span><select name="category" required>${
        // Keep the item's current category selectable even if (defensively) it's
        // not in the managed list.
        (item && item.category && !categories.includes(item.category)
          ? [item.category, ...categories]
          : categories
        )
          .map((value) => `<option value="${esc(value)}"${item && item.category === value ? " selected" : ""}>${esc(value)}</option>`)
          .join("")
      }</select></label>
      <label class="menu-description">Description commerciale<span class="field-help">Courte présentation visible par Awa et les clients.</span><textarea name="description" rows="3" maxlength="200" placeholder="Goût, ingrédients principaux ou bénéfice client…">${description}</textarea></label>
      <section class="choice-editor" data-choice-editor aria-labelledby="choice-editor-title">
        <div class="choice-editor-heading">
          <div><h3 id="choice-editor-title">Choix demandés au client (facultatif)</h3><p class="field-help">Ajoutez plusieurs questions indépendantes si nécessaire. Exemple : « Type de lait » (entier, avoine) puis « Type de fromage » (chèvre, emmental).</p></div>
          <span class="badge badge--gray" data-choice-group-count aria-live="polite">${configuredGroups.length} type${configuredGroups.length === 1 ? "" : "s"} de choix enregistré${configuredGroups.length === 1 ? "" : "s"}</span>
        </div>
        <div class="choice-groups" data-choice-groups>${optionGroups.map(optionGroupEditor).join("")}</div>
        <div class="choice-group-actions"><button class="act act--ghost" type="button" data-choice-group-add>Ajouter un type de choix</button><span class="field-help">${MAX_MENU_OPTION_GROUPS} types maximum par article.</span></div>
      </section>
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
${photoEditor}
${item ? `<div class="card menu-danger-zone"><div><b>${item.enabled ? "Retirer cet article" : "Remettre cet article au menu"}</b><p class="muted">La recette et l’historique sont conservés.</p></div><form class="inline" method="post" action="/admin/menu/items/${query(item.id)}/toggle"${item.enabled ? ` data-confirm="Retirer « ${esc(item.name)} » du menu ? L’article pourra être restauré plus tard."` : ""}><button class="act ${item.enabled ? "act--danger" : "act--ok"}" type="submit">${item.enabled ? "Retirer du menu" : "Remettre au menu"}</button></form></div>` : ""}
${MENU_OPTION_EDITOR_SCRIPT}`;
}

/** Category manager: add + per-row rename / delete (delete disabled when used). */
export function renderCategoriesPage(opts: { categories: CategoryView[]; banner: string }): string {
  const { categories, banner } = opts;
  const rows = categories
    .map((c) => {
      const used = c.itemCount > 0;
      const del = used
        ? `<span class="muted" title="Déplacez d'abord les ${c.itemCount} article(s)">Utilisée</span>`
        : `<form class="inline" method="post" action="/admin/menu/categories/delete" data-confirm="Supprimer la catégorie « ${esc(c.name)} » ?"><input type="hidden" name="name" value="${esc(c.name)}"><button class="act act--sm act--danger" type="submit">Supprimer</button></form>`;
      return `<tr>
<td data-label="Catégorie"><b>${esc(c.name)}</b></td>
<td data-label="Articles" class="nowrap">${c.itemCount}</td>
<td data-label="Renommer"><form class="inline row" method="post" action="/admin/menu/categories/rename"><input type="hidden" name="old" value="${esc(c.name)}"><input name="new" maxlength="40" value="${esc(c.name)}" required style="width:11rem"><button class="act act--sm act--ghost" type="submit">Renommer</button></form></td>
<td data-label="Actions" class="nowrap">${del}</td>
</tr>`;
    })
    .join("");
  const table = categories.length
    ? `<div class="card"><div class="table-wrap"><table class="responsive-table"><thead><tr><th>Catégorie</th><th>Articles</th><th>Renommer</th><th>Actions</th></tr></thead><tbody>${rows}</tbody></table></div></div>`
    : `<div class="card"><div class="empty"><b>Aucune catégorie</b><p>Ajoutez-en une ci-dessous.</p></div></div>`;
  return `${banner}
<header class="page-header"><div class="page-header-copy"><span class="eyebrow">Bar</span><h2>Catégories du menu</h2><p>La liste dans laquelle la fiche article choisit sa catégorie. Renommer met à jour tous les articles concernés ; on ne peut supprimer qu'une catégorie inutilisée.</p></div><div class="page-header-actions"><a class="act act--ghost" href="/admin/menu">Retour au menu</a></div></header>
${table}
<div class="card form-card"><form class="row" method="post" action="/admin/menu/categories"><label style="flex:1">Nouvelle catégorie<input name="name" maxlength="40" required placeholder="Ex. Pâtisseries"></label><button class="act" type="submit">Ajouter</button></form></div>`;
}
