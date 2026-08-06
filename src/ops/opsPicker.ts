/**
 * Shared client-side findability helpers for the three order pickers (salle
 * composer, owner composer, /commander). Inlined as a string into each PWA
 * bundle so the VOLATILE ranking/sort logic lives in ONE place and can't drift
 * between surfaces. Pure DOM-free functions attached to `window.__pick`.
 *
 * - pkTop(menu, ids): the "🔥 Populaires" list — items resolved from best-seller
 *   ids (server-computed), unknown/absent ids skipped, capped for a glanceable
 *   section. Returns [] when there's no signal so callers can omit the section.
 * - pkSortItems(items): within-category display order — ⭐ favourites first,
 *   "Supplément…" add-ons last, everything else in the server order. Presentation
 *   only; never changes prices or the server menu.
 */
export const OPS_PICKER_HELPERS = String.raw`(function(){
  function isSupp(it){ return /^suppl/i.test((it&&it.name||'').normalize('NFD').replace(/[̀-ͯ]/g,'')); }
  function pkTop(menu,ids,cap){
    if(!ids||!ids.length) return [];
    var byId={}; (menu||[]).forEach(function(c){ (c.items||[]).forEach(function(it){ byId[it.id]=it; }); });
    var out=[]; for(var i=0;i<ids.length;i++){ var it=byId[ids[i]]; if(it&&!isSupp(it)){ out.push(it); if(out.length>=(cap||8)) break; } }
    return out;
  }
  function pkSortItems(items){
    // Stable: favourites up, suppléments down, original order otherwise.
    return (items||[]).map(function(it,i){return {it:it,i:i};}).sort(function(a,b){
      var af=a.it.fav?0:1, bf=b.it.fav?0:1; if(af!==bf) return af-bf;
      var as=isSupp(a.it)?1:0, bs=isSupp(b.it)?1:0; if(as!==bs) return as-bs;
      return a.i-b.i;
    }).map(function(x){return x.it;});
  }
  window.__pick={ top:pkTop, sortItems:pkSortItems, isSupp:isSupp };
})();`;
