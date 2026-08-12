import type { FastifyReply } from "fastify";
import {
  OPS_BASE,
  OPS_LOGO_SVG,
  OPS_TOKENS,
  opsHead,
} from "../ops/opsTheme.js";
import { OPS_PICKER_HELPERS } from "../ops/opsPicker.js";

/**
 * The customer-facing ordering app (/commander) — the QR-in-the-changing-rooms
 * page. Same house style as the ops PWAs (inline template strings, no bundler),
 * but NOT an installable app: it's a transactional page scanned fresh each time,
 * so there is no manifest/service-worker. Under the strict CSP (script-src 'self')
 * an inline boot <script> would be blocked, so the client fetches /commander/menu.json
 * for its data. The browser DISPLAYS prices (server-provided) but the POST only ever
 * carries {item_id, qty, selections, note} — computeExtras re-prices authoritatively.
 */

const BASE = "/commander";
const ASSET_VERSION = "v2";

/** noindex, no-store, same relaxed-but-sandboxed CSP as the ops PWAs (script/
 *  connect/style 'self' only; no external origin). */
export function hardenCommande(reply: FastifyReply): void {
  reply.header("Cache-Control", "no-store");
  reply.header("X-Robots-Tag", "noindex, nofollow");
  reply.header("Referrer-Policy", "no-referrer");
  reply.header(
    "Content-Security-Policy",
    "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; " +
      "connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'self'",
  );
}

const PAGE_CSS = `body{padding-bottom:env(safe-area-inset-bottom)}
main{max-width:34rem;margin:0 auto;padding:1rem 1rem 8rem}
.brand{display:flex;align-items:center;gap:.55rem;margin:.4rem 0 1rem}
.brand h1{font-family:var(--serif);font-size:1.5rem;font-weight:600;letter-spacing:-.02em}
.brand .sub{font-size:.85rem;color:var(--ink-500)}
.closed{background:var(--warn-bg);border:1px solid var(--warn-border);color:var(--warn);
border-radius:var(--radius);padding:.8rem 1rem;font-weight:600;margin-bottom:1rem}
.modeseg{display:flex;flex-wrap:wrap;gap:.45rem;margin:0 0 1rem}
.modeseg .mode{flex:1 1 40%;min-height:2.9rem;padding:.6rem;border-radius:var(--radius);border:1px solid var(--border);
background:var(--surface-raised);color:var(--ink-700);font-weight:700;font-size:.92rem}
.modeseg .mode.sel{background:var(--plum-600);border-color:var(--plum-600);color:#fff}
.modeseg .mode.away.sel{background:var(--info);border-color:var(--info);color:#fff}
.modeseg .mode:disabled{opacity:.4}
.fld{margin:0 0 .7rem}
.fld label{display:block;font-size:.8rem;color:var(--ink-500);margin-bottom:.25rem;font-weight:600}
input,textarea,select{width:100%;padding:.8rem;border-radius:var(--radius);border:1px solid var(--border);
background:#fff;color:var(--ink-900);font-size:1rem;font-family:inherit}
textarea{min-height:2.6rem}
.feebar{background:var(--info-bg,#eaf2fb);color:var(--info);border:1px solid var(--info);border-radius:var(--radius);
padding:.6rem .8rem;font-size:.88rem;font-weight:600;margin:0 0 .7rem}
.toolbar{position:sticky;top:0;z-index:3;background:var(--bg);padding:.4rem 0 .5rem}
.chips{display:flex;gap:.4rem;overflow-x:auto;-webkit-overflow-scrolling:touch;padding-bottom:.2rem;scrollbar-width:none}
.chips::-webkit-scrollbar{display:none}
.chip{flex:0 0 auto;padding:.55rem .95rem;border-radius:999px;background:var(--rose);border:1px solid transparent;
color:var(--plum-600);font-size:.88rem;font-weight:600;white-space:nowrap}
.chip.sel{background:var(--plum-600);border-color:var(--plum-600);color:#fff}
.chip.fav{background:var(--warn-bg);color:var(--warn)}
.chip.fav.sel{background:var(--warn);border-color:var(--warn);color:#fff}
.search{margin-bottom:.5rem}
.cat{font-family:var(--serif);font-size:.95rem;font-weight:600;letter-spacing:.14em;text-transform:uppercase;
color:var(--plum-600);border-bottom:1px solid var(--rose);padding-bottom:.35rem;margin:1rem 0 .3rem}
.mi{display:flex;align-items:center;gap:.6rem;padding:.6rem 0;border-bottom:1px solid var(--border-soft);flex-wrap:wrap}
.mi.on{background:var(--plum-50);border-radius:var(--radius);padding:.6rem;margin:.2rem 0;border-bottom:0}
.mi-thumb{flex:0 0 auto;width:72px;height:48px;object-fit:cover;border-radius:9px;background:var(--rose)}
.mi .nm{flex:1;min-width:8rem;font-size:1.02rem}
.mi .nm .pr{display:block;color:var(--ink-500);font-size:.82rem;font-weight:500}
.mi .qbadge{background:var(--ok-strong);color:#fff;border-radius:999px;font-size:.8rem;font-weight:800;
padding:.12rem .5rem;margin-left:.4rem}
.stepper{display:flex;align-items:center;gap:.55rem}
.stepper button{width:2.75rem;height:2.75rem;border-radius:50%;border:1px solid var(--border-strong);
background:#fff;color:var(--ink-900);font-size:1.35rem;font-weight:700;line-height:1}
.stepper button.plus{background:var(--plum-600);border-color:var(--plum-600);color:#fff}
.stepper .qv{min-width:1.3rem;text-align:center;font-weight:800;font-size:1.1rem}
.wrap{width:100%}
.creq{margin-top:.5rem;border:1px solid var(--border-soft);border-radius:var(--radius);padding:.55rem .65rem;background:var(--surface-raised)}
.creq.missing{border-color:var(--warn-border);background:var(--warn-bg)}
.clab{font-size:.75rem;font-weight:700;color:var(--ink-500);margin-bottom:.4rem;text-transform:uppercase;letter-spacing:.05em}
.creq.missing .clab{color:var(--warn)}
.cpills{display:flex;gap:.45rem;flex-wrap:wrap}
.cpill{padding:.55rem .9rem;border-radius:999px;border:1px solid var(--border-strong);background:#fff;color:var(--ink-700);font-weight:600;font-size:.95rem}
.cpill.sel{background:var(--ok-strong);border-color:var(--ok-strong);color:#fff}
.ln{margin-top:.5rem;font-size:.92rem;padding:.55rem}
.lnlab{font-size:.75rem;color:var(--ink-500);margin-top:.5rem}
.nores{color:var(--ink-500);text-align:center;padding:2rem 0}
.pay{display:flex;gap:.45rem;margin:.4rem 0 .2rem}
.pay .pm{flex:1;min-height:2.75rem;border-radius:var(--radius);border:1px solid var(--border);background:var(--surface-raised);
color:var(--ink-700);font-weight:700;font-size:.9rem}
.pay .pm.sel{background:var(--plum-600);border-color:var(--plum-600);color:#fff}
.foot{position:fixed;left:0;right:0;bottom:0;background:var(--surface);border-top:1px solid var(--border-soft);
padding:.7rem 1rem calc(.7rem + env(safe-area-inset-bottom));box-shadow:0 -4px 16px rgba(33,25,33,.08)}
.foot .row{max-width:34rem;margin:0 auto;display:flex;gap:.7rem;align-items:center}
.total{font-weight:800;font-size:1.05rem;white-space:nowrap}
.total small{color:var(--ink-500);font-weight:500}
button.go{flex:1;padding:.95rem;border:none;border-radius:12px;background:var(--ok-strong);color:#fff;
font-weight:800;font-size:1.02rem;box-shadow:var(--shadow-1)}
button.go:disabled{opacity:.45}
.msg{color:var(--danger);font-size:.9rem;margin:.4rem 0}
.big{text-align:center;padding:3rem 1.5rem;max-width:30rem;margin:0 auto}
.big .ico{font-size:3rem}
.big h1{font-family:var(--serif);font-size:1.6rem;font-weight:600;margin:.6rem 0}
.big p{color:var(--ink-500);font-size:1.05rem;line-height:1.5}`;

export function commanderPage(): string {
  return `<!doctype html><html lang="fr"><head>${opsHead(BASE, "Commander")}<title>Commander — Revive</title>
<style>${OPS_TOKENS}${OPS_BASE}${PAGE_CSS}</style></head><body>
<main id="app"><p class="nores" id="boot">Chargement du menu…</p></main>
<div class="foot" id="foot" hidden><div class="row"><div class="total" id="total"></div>
<button class="go" id="go" disabled>Payer</button></div></div>
<noscript>Activez JavaScript pour commander.</noscript>
<script src="${BASE}/app.js?b=${ASSET_VERSION}"></script>
</body></html>`;
}

/** Confirmation page after a successful payment (static, no JS). */
export function commandeMerciPage(): string {
  return `<!doctype html><html lang="fr"><head>${opsHead(BASE, "Merci")}<title>Merci — Revive</title>
<style>${OPS_TOKENS}${OPS_BASE}${PAGE_CSS}</style></head><body><main>
<div class="big"><div class="ico">✅</div><h1>Paiement reçu, merci !</h1>
<p>On prépare ta commande tout de suite. On te l'apporte, ou passe la récupérer au comptoir. À tout de suite 🌿</p></div>
</main></body></html>`;
}

/** Payment-error / cancelled return page (static, no JS). */
export function commandeErreurPage(): string {
  return `<!doctype html><html lang="fr"><head>${opsHead(BASE, "Paiement")}<title>Paiement — Revive</title>
<style>${OPS_TOKENS}${OPS_BASE}${PAGE_CSS}</style></head><body><main>
<div class="big"><div class="ico">😕</div><h1>Paiement non abouti</h1>
<p>Ta commande n'a pas été payée. Tu peux réessayer en rescannant le QR ou en rechargeant la page de commande.</p>
<p style="margin-top:1.2rem"><a href="${BASE}" style="color:var(--plum-600);font-weight:700">← Revenir à la commande</a></p></div>
</main></body></html>`;
}

export const COMMANDER_MENU_VERSION = ASSET_VERSION;
export { BASE as COMMANDER_BASE };

// ── Client app (composer; DOM built with textContent; prices shown, never sent) ──
export const COMMANDER_APP_JS = OPS_PICKER_HELPERS + String.raw`(function(){
  var BASE=${JSON.stringify(BASE)};
  var app=document.getElementById('app');
  var foot=document.getElementById('foot');
  var totalEl=document.getElementById('total');
  var goBtn=document.getElementById('go');
  var MENU=[], TOP=[], OM=false, FEE=0, HOURS={open:false,deliveryOpen:false,reopensLabel:null};
  var draft={};                 // id -> {qty, selections:{label:value}, note}
  var state={cat:'__ALL__', q:'', mode:'SUR_PLACE', method:'wave'};
  // Idempotency: one request id for this page load survives double-tap / retry.
  var REQ_ID; try{ REQ_ID=sessionStorage.getItem('commander.req'); }catch(e){}
  if(!REQ_ID){ try{ REQ_ID=crypto.randomUUID(); }catch(e){ REQ_ID='r-'+Date.now()+'-'+Math.round(Math.random()*1e9); }
    try{ sessionStorage.setItem('commander.req', REQ_ID); }catch(e){} }

  function el(tag,cls,txt){ var e=document.createElement(tag); if(cls)e.className=cls; if(txt!=null)e.textContent=txt; return e; }
  function norm(s){ return String(s||'').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g,''); }
  function findItem(id){ for(var i=0;i<MENU.length;i++){ for(var j=0;j<MENU[i].items.length;j++){ if(MENU[i].items[j].id===id) return MENU[i].items[j]; } } return null; }
  function anyFav(){ return MENU.some(function(c){ return c.items.some(function(it){ return it.fav; }); }); }
  function cartCount(){ var n=0; Object.keys(draft).forEach(function(id){ if(draft[id].qty>0) n+=draft[id].qty; }); return n; }
  function total(){ var t=0; Object.keys(draft).forEach(function(id){ var it=findItem(id); if(it&&draft[id].qty>0) t+=it.price*draft[id].qty; }); return t; }
  function isDelivery(){ return state.mode==='LIVRAISON'; }

  // ---- header + mode + fields ----
  var fnInput, phInput, addrInput, gnoteInput, msgEl, listEl, feeEl;
  function header(){
    var b=el('div','brand'); var lg=el('span'); lg.innerHTML=${JSON.stringify(OPS_LOGO_SVG)};
    var box=el('div'); box.appendChild(el('h1','','Commander')); box.appendChild(el('div','sub','Bar Revive — paiement en ligne'));
    b.appendChild(lg); b.appendChild(box); return b;
  }
  function modeSeg(){
    var seg=el('div','modeseg');
    var modes=[['SUR_PLACE','🍽️ Sur place',false],['A_EMPORTER','📦 À emporter',true],['RETRAIT','🛍️ À venir chercher',false],['LIVRAISON','🛵 Livraison',false]];
    modes.forEach(function(m){
      var btn=el('button','mode'+(m[2]?' away':'')+(state.mode===m[0]?' sel':''),m[1]); btn.type='button';
      if(m[0]==='LIVRAISON' && !HOURS.deliveryOpen){ btn.disabled=true; btn.title='Livraisons terminées pour aujourd’hui'; }
      btn.onclick=function(){ state.mode=m[0]; renderControls(); };
      seg.appendChild(btn);
    });
    return seg;
  }
  function field(labelText, input){ var f=el('div','fld'); var l=el('label'); l.textContent=labelText; f.appendChild(l); f.appendChild(input); return f; }

  function renderControls(){
    // Re-render the sticky controls region (mode + fields + fee) in place.
    controls.textContent='';
    controls.appendChild(modeSeg());
    if(isDelivery()){
      feeEl=el('div','feebar', FEE>0
        ? 'Frais de livraison : '+FEE+' F, à régler en espèces au livreur à l’arrivée.'
        : 'Frais de livraison réglés en espèces au livreur à l’arrivée.');
      controls.appendChild(feeEl);
    }
    controls.appendChild(field('Prénom', fnInput));
    controls.appendChild(field('Numéro mobile (WhatsApp)', phInput));
    if(isDelivery()) controls.appendChild(field('Adresse de livraison', addrInput));
    paint();
  }

  // ---- item list ----
  function itemRow(it){
    var d=draft[it.id]||{qty:0,selections:{},note:''};
    var groups=it.optionGroups||[];
    var row=el('div','mi'+(d.qty>0?' on':'')); row.dataset.id=it.id;
    if(it.photoUrl){ var pic=el('img','mi-thumb'); pic.src=it.photoUrl; pic.alt=it.name; pic.loading='lazy'; pic.decoding='async'; pic.width=72; pic.height=48; row.appendChild(pic); }
    var nm=el('div','nm'); nm.appendChild(el('span',null,it.name));
    if(d.qty>0){ nm.appendChild(el('span','qbadge','×'+d.qty)); }
    nm.appendChild(el('span','pr',it.price+' F')); row.appendChild(nm);
    var stp=el('div','stepper');
    var minus=el('button',null,'−'); var qv=el('span','qv',String(d.qty)); var plus=el('button','plus','+');
    var extra=el('div','wrap'); extra.style.display=d.qty>0?'block':'none';
    function sync(){ var dd=draft[it.id]||{qty:0,selections:{},note:''}; qv.textContent=dd.qty;
      extra.style.display=dd.qty>0?'block':'none'; row.classList.toggle('on',dd.qty>0);
      var old=nm.querySelector('.qbadge'); if(old) nm.removeChild(old);
      if(dd.qty>0){ var bb=el('span','qbadge','×'+dd.qty); nm.insertBefore(bb,nm.querySelector('.pr')); }
      markChoices(); paint(); }
    minus.onclick=function(){ var dd=draft[it.id]||{qty:0,selections:{},note:''}; dd.qty=Math.max(0,dd.qty-1); draft[it.id]=dd; sync(); };
    plus.onclick=function(){ var dd=draft[it.id]||{qty:0,selections:{},note:''}; dd.qty=Math.min(10,dd.qty+1); draft[it.id]=dd; sync(); };
    stp.appendChild(minus); stp.appendChild(qv); stp.appendChild(plus); row.appendChild(stp);
    var creqs=[];
    function markChoices(){ creqs.forEach(function(c){ var dd=draft[it.id]||{qty:0,selections:{}}; var miss=dd.qty>0 && !(dd.selections||{})[c.label];
      c.box.classList.toggle('missing',miss); }); }
    groups.forEach(function(g){
      var creq=el('div','creq'); creq.appendChild(el('div','clab',g.label+' · obligatoire'));
      var pills=el('div','cpills');
      g.choices.forEach(function(ch){
        var sel=(d.selections||{})[g.label]===ch;
        var p=el('button','cpill'+(sel?' sel':''),ch); p.type='button';
        p.onclick=function(){ var dd=draft[it.id]||{qty:0,selections:{},note:''}; dd.selections=dd.selections||{}; dd.selections[g.label]=ch; draft[it.id]=dd;
          Array.prototype.forEach.call(pills.children,function(c){c.classList.remove('sel');}); p.classList.add('sel'); markChoices(); };
        pills.appendChild(p);
      });
      creq.appendChild(pills); extra.appendChild(creq); creqs.push({label:g.label,box:creq});
    });
    extra.appendChild(el('div','lnlab','Note (optionnel)'));
    var ntn=el('input','ln'); ntn.placeholder='ex: sans sucre, bien chaud…'; ntn.maxLength=140; ntn.value=d.note||'';
    ntn.oninput=function(){ var dd=draft[it.id]||{qty:0,selections:{}}; dd.note=ntn.value; draft[it.id]=dd; }; extra.appendChild(ntn);
    row.appendChild(extra); markChoices();
    return row;
  }
  function section(label,items){ if(!items.length) return; listEl.appendChild(el('div','cat',label));
    items.forEach(function(it){ listEl.appendChild(itemRow(it)); }); }
  function renderList(){
    if(chipAll) chipAll.classList.toggle('sel',state.cat==='__ALL__'&&!state.q);
    if(chipFav) chipFav.classList.toggle('sel',state.cat==='__FAV__'&&!state.q);
    Object.keys(catChips).forEach(function(k){ catChips[k].classList.toggle('sel',state.cat===k&&!state.q); });
    listEl.textContent='';
    var q=norm(state.q); var any=false;
    // Default view leads with 🔥 Populaires (server best-sellers), each item shown
    // once (skipped in its category below), then favourites-first / add-ons-last.
    var isDefault=!q && state.cat==='__ALL__'; var popIds={};
    if(isDefault){
      var pop=window.__pick.top(MENU,TOP,8); pop.forEach(function(it){ popIds[it.id]=1; });
      if(pop.length){ section('🔥 Populaires',pop); any=true; }
    }
    MENU.forEach(function(cat){
      var items=cat.items.filter(function(it){
        if(q) return norm(it.name).indexOf(q)>=0;
        if(state.cat==='__FAV__') return !!it.fav;
        if(state.cat!=='__ALL__') return cat.category===state.cat;
        return !popIds[it.id];
      });
      if(!items.length) return;
      section(cat.category, window.__pick.sortItems(items)); any=true;
    });
    if(!any) listEl.appendChild(el('div','nores','Aucun article.'));
  }

  var chipAll,chipFav,catChips={},controls;
  function build(){
    app.textContent='';
    app.appendChild(header());
    if(!HOURS.open){
      var c=el('div','closed', HOURS.reason==='no_schedule'
        ? 'Commande en ligne momentanément indisponible.'
        : 'Le bar est fermé'+(HOURS.reopensLabel?' — réouvre '+HOURS.reopensLabel+'.':'.'));
      app.appendChild(c);
      return; // ordering disabled
    }
    // shared inputs (persist across control re-renders)
    fnInput=el('input'); fnInput.placeholder='Ton prénom'; fnInput.maxLength=40; fnInput.autocomplete='given-name';
    phInput=el('input'); phInput.placeholder='77 123 45 67'; phInput.maxLength=20; phInput.setAttribute('inputmode','tel');
    addrInput=el('input'); addrInput.placeholder='Quartier, rue, repère…'; addrInput.maxLength=200;
    controls=el('div'); app.appendChild(controls);

    var toolbar=el('div','toolbar');
    var search=el('input','search'); search.placeholder='🔍 Rechercher un article…'; search.setAttribute('inputmode','search'); search.setAttribute('enterkeyhint','search'); search.setAttribute('autocomplete','off');
    search.oninput=function(){ state.q=search.value; renderList(); }; toolbar.appendChild(search);
    var chips=el('div','chips');
    chipAll=el('button','chip','Tout'); chipAll.onclick=function(){ state.cat='__ALL__'; state.q=''; search.value=''; renderList(); }; chips.appendChild(chipAll);
    if(anyFav()){ chipFav=el('button','chip fav','⭐ Favoris'); chipFav.onclick=function(){ state.cat='__FAV__'; state.q=''; search.value=''; renderList(); }; chips.appendChild(chipFav); }
    catChips={};
    MENU.forEach(function(cat){ var ch=el('button','chip',cat.category); ch.onclick=(function(n){return function(){ state.cat=n; state.q=''; search.value=''; renderList(); };})(cat.category); catChips[cat.category]=ch; chips.appendChild(ch); });
    toolbar.appendChild(chips); app.appendChild(toolbar);

    listEl=el('div'); app.appendChild(listEl);
    // payment method + general note + inline message
    gnoteInput=el('textarea'); gnoteInput.placeholder='Note générale (optionnel)'; gnoteInput.maxLength=280;
    app.appendChild(field('Note générale', gnoteInput));
    var pay=el('div','pay');
    var methods=[['wave','Wave']]; if(OM){ methods.push(['orange_money','Orange Money']); methods.push(['maxit','Max It']); }
    methods.forEach(function(m){ var btn=el('button','pm'+(state.method===m[0]?' sel':''),m[1]); btn.type='button';
      btn.onclick=function(){ state.method=m[0]; Array.prototype.forEach.call(pay.children,function(c){c.classList.remove('sel');}); btn.classList.add('sel'); }; pay.appendChild(btn); });
    app.appendChild(field('Paiement', pay));
    msgEl=el('div','msg'); msgEl.style.display='none'; app.appendChild(msgEl);

    renderControls();
    renderList();
    foot.hidden=false;
  }

  function paint(){
    var n=cartCount(); var t=total();
    totalEl.textContent=''; totalEl.appendChild(document.createTextNode((isDelivery()&&FEE>0? t+FEE : t)+' F '));
    totalEl.appendChild(el('small','', isDelivery()? '(+ frais au livreur)' : n? '('+n+' article'+(n>1?'s':'')+')' : ''));
    goBtn.disabled=n<1;
    goBtn.textContent = n<1 ? 'Payer' : 'Payer '+t+' F';
  }

  function submit(){
    if(msgEl){ msgEl.style.display='none'; }
    var fn=(fnInput.value||'').trim();
    if(fn.length<1){ return showMsg('Indique ton prénom.'); }
    var phone=(phInput.value||'').replace(/\D/g,'');
    if(!/^(221)?(7[05678])\d{7}$/.test(phone)){ return showMsg('Numéro mobile sénégalais invalide (ex : 77 123 45 67).'); }
    if(isDelivery() && (addrInput.value||'').trim().length<5){ return showMsg('Indique une adresse de livraison.'); }
    // Build items — send ids/qty/selections/note only, NEVER a price.
    var items=[], missing=null;
    Object.keys(draft).forEach(function(id){ var d=draft[id]; if(!d||d.qty<1) return;
      var it=findItem(id); var groups=(it&&it.optionGroups)||[];
      var selections=[];
      groups.forEach(function(g){ var v=(d.selections||{})[g.label]; if(!v){ if(!missing) missing=it; } else selections.push({label:g.label,value:v}); });
      var e={item_id:id,qty:d.qty}; if(selections.length) e.selections=selections; if(d.note) e.note=d.note; items.push(e);
    });
    if(missing){ return showMsg('Choisis les options pour « '+missing.name+' ».'); }
    if(!items.length){ return showMsg('Ajoute au moins un article.'); }
    goBtn.disabled=true; goBtn.textContent='Redirection…';
    var body={ items:items, mode:state.mode, method:state.method, first_name:fn, phone:phone,
      note:(gnoteInput.value||'').trim(), client_request_id:REQ_ID };
    if(isDelivery()) body.address=(addrInput.value||'').trim();
    fetch(BASE+'/api/order',{method:'POST',headers:{'Content-Type':'application/json','X-Requested-With':'fetch'},body:JSON.stringify(body)})
      .then(function(r){ return r.json().catch(function(){return{};}).then(function(j){ return {status:r.status,j:j}; }); })
      .then(function(res){
        if(res.j&&res.j.ok&&res.j.payment_link){ window.location=res.j.payment_link; return; }
        goBtn.disabled=false; paint();
        showMsg((res.j&&res.j.message)||'Commande refusée. Réessaie.');
      })
      .catch(function(){ goBtn.disabled=false; paint(); showMsg('Erreur réseau. Réessaie.'); });
  }
  function showMsg(t){ if(!msgEl){ alert(t); return; } msgEl.textContent=t; msgEl.style.display='block'; try{ msgEl.scrollIntoView({block:'center'}); }catch(e){} }
  goBtn.onclick=submit;

  fetch(BASE+'/menu.json',{headers:{'X-Requested-With':'fetch'}}).then(function(r){return r.ok?r.json():null;}).then(function(d){
    if(!d){ app.textContent=''; app.appendChild(el('p','nores','Menu indisponible. Recharge la page.')); return; }
    MENU=d.menu||[]; TOP=d.top||[]; OM=!!d.om; FEE=d.deliveryFeeXof||0; HOURS=d.hours||HOURS;
    build();
  }).catch(function(){ app.textContent=''; app.appendChild(el('p','nores','Menu indisponible. Recharge la page.')); });
})();`;
