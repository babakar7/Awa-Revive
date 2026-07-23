import type { FastifyReply } from "fastify";

/**
 * The reception PWA (service.revive.sn) — HTML shell, manifest, service worker
 * and client JS, all served as strings (house style, no bundler). Same security
 * stance as the cuisine kiosque: the client builds every card with textContent
 * (order/first-name data is never interpolated into HTML — no XSS), the SW caches
 * ONLY the shell/assets (never a mutation, the SSE stream, or the sessions API).
 *
 * The reception phones own the on-site (TABLE) flow. The room is a small fixed
 * layout — one place per space (Canapé / Terrasse / Pergola) — so the board is a
 * tile per spot: tap a FREE spot to take an order there, tap an OCCUPIED one to
 * add more, serve ("Je prends" / "Servie"), or free it. No "create a table" step,
 * no codes: the spot label is the kitchen-ticket heading.
 */

const BASE = "/ops/service";

/** Same relaxed-but-sandboxed CSP as the cuisine PWA: script/worker/connect 'self'
 *  only, no external origin. */
export function hardenService(reply: FastifyReply): void {
  reply.header("Cache-Control", "no-store");
  reply.header("X-Robots-Tag", "noindex, nofollow");
  reply.header("Referrer-Policy", "no-referrer");
  reply.header(
    "Content-Security-Policy",
    "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; " +
      "connect-src 'self'; img-src 'self' data:; manifest-src 'self'; " +
      "worker-src 'self'; base-uri 'none'; form-action 'self'",
  );
}

function esc(s: unknown): string {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

const HEAD = `<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="#211921">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="apple-mobile-web-app-title" content="Salle">
<link rel="manifest" href="${BASE}/manifest.webmanifest">
<link rel="apple-touch-icon" href="${BASE}/icon-192.png">
<link rel="icon" href="${BASE}/icon-192.png">`;

// ── Pairing screen ───────────────────────────────────────────────────────────
const PAIR_STYLE = `*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
background:#211921;color:#fbf6f0;font-family:system-ui,-apple-system,"Segoe UI",sans-serif}
main{width:92%;max-width:24rem;text-align:center;padding:1.5rem}
h1{font-size:1.5rem;margin:.2rem 0 .4rem}
p{color:#c9bcc9;font-size:.95rem;margin:.2rem 0 1.4rem}
input{width:100%;font-size:1.8rem;letter-spacing:.35em;text-align:center;text-transform:uppercase;
padding:1rem;border-radius:14px;border:1px solid #4a3d4a;background:#2c222c;color:#fbf6f0;font-weight:700}
button{width:100%;margin-top:1rem;padding:1rem;font-size:1.15rem;font-weight:700;border:none;border-radius:14px;
background:#7c547d;color:#fbf6f0}
.err{color:#f6a5a5;margin-top:1rem;font-size:.9rem}`;

export function servicePairingPage(error?: string): string {
  return `<!doctype html><html lang="fr"><head>${HEAD}<title>Appairer — Salle Revive</title>
<style>${PAIR_STYLE}</style></head><body><main>
<h1>Salle Revive</h1>
<p>Entrez le code d'appairage affiché dans l'administration (Réglages → Appareils).</p>
<form method="post" action="${BASE}/pair" autocomplete="off">
<input name="code" inputmode="latin" autocapitalize="characters" maxlength="12" placeholder="CODE" required autofocus>
<button type="submit">Appairer ce téléphone</button>
${error ? `<p class="err">${esc(error)}</p>` : ""}
</form></main></body></html>`;
}

// ── Board (paired device) ────────────────────────────────────────────────────
const APP_STYLE = `*{box-sizing:border-box}
html,body{margin:0;min-height:100%}
body{background:#161016;color:#fbf6f0;font-family:system-ui,-apple-system,"Segoe UI",sans-serif;
padding-top:env(safe-area-inset-top);padding-bottom:env(safe-area-inset-bottom)}
header{position:sticky;top:0;z-index:5;display:flex;align-items:center;gap:.6rem;
padding:.7rem 1rem;background:#211921;border-bottom:1px solid #3a2f3a}
header h1{font-size:1.05rem;margin:0;font-weight:700}
.dot{width:.7rem;height:.7rem;border-radius:50%;background:#e5484d;box-shadow:0 0 0 3px rgba(229,72,77,.18)}
.dot.on{background:#30a46c;box-shadow:0 0 0 3px rgba(48,164,108,.18)}
.spacer{flex:1}.count{font-size:.85rem;color:#c9bcc9}
main{padding:.8rem;display:grid;gap:.8rem;grid-template-columns:repeat(auto-fill,minmax(15rem,1fr));align-content:start}
/* Spot tile */
.spot{background:#211921;border:1px solid #3a2f3a;border-radius:16px;padding:.9rem;display:flex;flex-direction:column;gap:.5rem;min-height:8rem}
.spot.free{border-style:dashed;border-color:#4a5a4a;cursor:pointer}
.spot.free:active{filter:brightness(1.15)}
.spot.occupied{border-left:6px solid #e2a63a}
.spot.ready{border-color:#30a46c;box-shadow:0 0 0 1px rgba(48,164,108,.5)}
.spot.flash{animation:flash 1.1s ease-out}
@keyframes flash{0%{background:#3a2f3a}100%{background:#211921}}
.sh{display:flex;align-items:baseline;gap:.5rem}
.nm{font-size:1.3rem;font-weight:800}
.cap{font-size:.82rem;color:#8a7d8a;margin-left:auto}
.who{font-size:.92rem;color:#f0c579}
.freehint{margin-top:auto;font-size:.95rem;color:#7fbf8f;font-weight:600}
.tk{padding:.55rem .6rem;border:1px solid #3a2f3a;border-radius:10px;background:#1a141a}
.tk .line{display:flex;align-items:center;gap:.4rem}
.tk .q{font-weight:800;color:#f0c579}
.tk .st{margin-left:auto;font-size:.72rem;font-weight:800;text-transform:uppercase;letter-spacing:.04em;padding:.16rem .5rem;border-radius:999px}
.st.new{background:#3a2f3a;color:#c9bcc9}.st.preparing{background:#3a2c10;color:#f0c579}
.st.ready{background:#123524;color:#6ee7a8}
.tk .tnote{font-size:.82rem;color:#ffd7a8;margin-top:.2rem}
.tk .taken{font-size:.8rem;color:#8fc3ff;margin-top:.2rem}
.tacts{display:flex;gap:.45rem;margin-top:.5rem}
button{font-family:inherit}
button.act{flex:1;padding:.7rem;font-size:.98rem;font-weight:800;border:none;border-radius:10px;color:#fff}
button.take{background:#2864b5}button.serve{background:#1a7f37}button.cancel{background:#5a2530;flex:0 0 auto;padding:.7rem .8rem}
button.act:active{filter:brightness(.9)}button.act:disabled{opacity:.5}
.sacts{display:flex;gap:.45rem;margin-top:auto;padding-top:.4rem}
button.sec{flex:1;padding:.7rem;font-size:.95rem;font-weight:700;border-radius:10px;border:1px solid #4a3d4a;background:#2c222c;color:#fbf6f0}
button.add{background:#7c547d;border-color:#7c547d}
.empty{grid-column:1/-1;text-align:center;color:#7a6d7a;margin-top:18vh;font-size:1.05rem}
/* Overlay (order composer) */
.ov{position:fixed;inset:0;z-index:20;background:rgba(10,7,10,.6);display:flex;align-items:flex-end;justify-content:center}
.sheet{background:#1c151c;width:100%;max-width:34rem;max-height:92vh;overflow:auto;border-radius:18px 18px 0 0;
padding:1rem;padding-bottom:calc(1rem + env(safe-area-inset-bottom))}
.sheet h2{margin:.1rem 0 .8rem;font-size:1.2rem}
.areas{display:flex;gap:.5rem;flex-wrap:wrap;margin-bottom:.8rem}
.sheet input,.sheet textarea{width:100%;padding:.8rem;border-radius:12px;border:1px solid #4a3d4a;background:#2c222c;color:#fbf6f0;font-size:1rem;font-family:inherit}
.sheet textarea{min-height:3rem;margin-top:.6rem}
/* sticky search + category chips */
.toolbar{position:sticky;top:0;z-index:3;background:#1c151c;padding:.2rem 0 .5rem}
.search{margin-bottom:.5rem}
.chips{display:flex;gap:.4rem;overflow-x:auto;-webkit-overflow-scrolling:touch;padding-bottom:.2rem;scrollbar-width:none}
.chips::-webkit-scrollbar{display:none}
.chip{flex:0 0 auto;padding:.5rem .85rem;border-radius:999px;background:#2c222c;border:1px solid #4a3d4a;color:#e7dbe7;font-size:.92rem;font-weight:700;white-space:nowrap}
.chip.sel{background:#7c547d;border-color:#7c547d;color:#fff}
.chip.cart{background:#26361f;border-color:#3f5a34;color:#bfe6ab}
.chip.cart.sel{background:#2f7650;border-color:#2f7650;color:#fff}
.cat{font-size:.78rem;font-weight:800;letter-spacing:.06em;text-transform:uppercase;color:#a98fa9;margin:.8rem 0 .3rem}
.mi{display:flex;align-items:center;gap:.6rem;padding:.6rem 0;border-bottom:1px solid #2a212a;flex-wrap:wrap}
.mi.on{background:#241b24;border-radius:10px;padding:.6rem;margin:.2rem 0;border-bottom:0}
.mi .nm{flex:1;min-width:8rem;font-size:1.02rem}
.mi .nm .pr{display:block;color:#9a8d9a;font-size:.82rem;font-weight:500}
.mi .qbadge{background:#2f7650;color:#fff;border-radius:999px;font-size:.8rem;font-weight:800;padding:.1rem .5rem;margin-left:.4rem}
.stepper{display:flex;align-items:center;gap:.55rem}
.stepper button{width:2.4rem;height:2.4rem;border-radius:50%;border:1px solid #4a3d4a;background:#2c222c;color:#fbf6f0;font-size:1.4rem;font-weight:800;line-height:1}
.stepper button.plus{background:#7c547d;border-color:#7c547d}
.stepper .qv{min-width:1.3rem;text-align:center;font-weight:800;font-size:1.1rem}
.mi select{width:100%;padding:.6rem;border-radius:10px;border:1px solid #4a3d4a;background:#2c222c;color:#fbf6f0;font-size:.95rem;margin-top:.45rem}
.mi .ln{margin-top:.4rem;font-size:.92rem;padding:.55rem}
.wrap{width:100%}
.nores{color:#8a7d8a;text-align:center;padding:2rem 0}
.foot{position:sticky;bottom:0;background:#1c151c;padding:.6rem 0 .2rem;display:flex;gap:.6rem;align-items:center;border-top:1px solid #2a212a}
.total{font-weight:800;font-size:1.05rem;white-space:nowrap}.total small{color:#8a7d8a;font-weight:500}
.foot button.go{flex:1;padding:.9rem;border:none;border-radius:12px;background:#2f7650;color:#fff;font-weight:800;font-size:1.02rem}
.foot button.go:disabled{opacity:.45}
.close-x{position:sticky;top:0;float:right;background:none;border:none;color:#c9bcc9;font-size:1.7rem;line-height:1;z-index:4}
.msg{color:#f6a5a5;font-size:.9rem;margin:.4rem 0}
#offline{position:fixed;left:0;right:0;top:0;background:#7a2020;color:#fff;text-align:center;padding:.5rem;font-weight:700;transform:translateY(-100%);transition:transform .2s;z-index:30}
#offline.show{transform:translateY(0)}
noscript{display:block;padding:2rem;text-align:center}`;

export function serviceBoardPage(bootJson: string): string {
  return `<!doctype html><html lang="fr"><head>${HEAD}<title>Salle Revive</title>
<style>${APP_STYLE}</style></head><body>
<div id="offline">Hors ligne — reconnexion…</div>
<header><span id="dot" class="dot"></span><h1>Salle</h1><span class="spacer"></span><span class="count" id="count"></span></header>
<main id="board"><p class="empty" id="empty">Chargement…</p></main>
<noscript>Activez JavaScript pour la prise de commande en salle.</noscript>
<script>window.__BOOT__=${bootJson}</script>
<script src="${BASE}/app.js"></script>
</body></html>`;
}

// ── Manifest ─────────────────────────────────────────────────────────────────
export const SERVICE_MANIFEST = JSON.stringify({
  name: "Salle Revive",
  short_name: "Salle",
  description: "Prise de commande en salle — Revive",
  start_url: `${BASE}/`,
  scope: `${BASE}/`,
  display: "standalone",
  orientation: "portrait",
  background_color: "#161016",
  theme_color: "#211921",
  icons: [
    { src: `${BASE}/icon-192.png`, sizes: "192x192", type: "image/png", purpose: "any" },
    { src: `${BASE}/icon-512.png`, sizes: "512x512", type: "image/png", purpose: "any maskable" },
  ],
});

// ── Service worker (shell/assets only) ───────────────────────────────────────
export const SERVICE_SW = `const CACHE='service-v3';
const SHELL=['${BASE}/app.js','${BASE}/manifest.webmanifest','${BASE}/icon-192.png','${BASE}/icon-512.png'];
self.addEventListener('install',e=>{e.waitUntil(caches.open(CACHE).then(c=>c.addAll(SHELL)).then(()=>self.skipWaiting()));});
self.addEventListener('activate',e=>{e.waitUntil(caches.keys().then(ks=>Promise.all(ks.filter(k=>k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim()));});
self.addEventListener('fetch',e=>{
  const url=new URL(e.request.url);
  if(e.request.method==='GET' && SHELL.includes(url.pathname)){
    e.respondWith(fetch(e.request).then(r=>{const c=r.clone();caches.open(CACHE).then(cc=>cc.put(e.request,c));return r;}).catch(()=>caches.match(e.request)));
  }
});`;

// ── Client app ───────────────────────────────────────────────────────────────
export const SERVICE_APP_JS = String.raw`(function(){
  var BASE=${JSON.stringify(BASE)};
  var boot=window.__BOOT__||{cursor:0,spots:[],sessions:[],tickets:[],menu:[]};
  var cursor=boot.cursor||0;
  var SPOTS=(boot.spots||[]).slice().sort(function(a,b){return (a.sort_order||0)-(b.sort_order||0);});
  var MENU=boot.menu||[];
  var sessions=new Map(); (boot.sessions||[]).forEach(function(s){sessions.set(s.id,s);});
  var tickets=new Map(); (boot.tickets||[]).forEach(function(t){ if(t.source==='TABLE') tickets.set(t.id,t); });
  var board=document.getElementById('board');
  var countEl=document.getElementById('count');
  var dot=document.getElementById('dot');
  var offline=document.getElementById('offline');

  function el(tag,cls,txt){ var e=document.createElement(tag); if(cls)e.className=cls; if(txt!=null)e.textContent=txt; return e; }
  function uuid(){ try{ return crypto.randomUUID(); }catch(e){ return 'r-'+Date.now()+'-'+Math.round(Math.random()*1e9); } }
  function findItem(id){ for(var i=0;i<MENU.length;i++){ for(var j=0;j<MENU[i].items.length;j++){ if(MENU[i].items[j].id===id) return MENU[i].items[j]; } } return null; }
  function sessionForSpot(spotId){ var found=null; sessions.forEach(function(s){ if(s.spot_id===spotId) found=s; }); return found; }
  function ticketsOf(sid){ var out=[]; tickets.forEach(function(t){ if(t.session_id===sid) out.push(t); }); return out.sort(function(a,b){return new Date(a.created_at)-new Date(b.created_at);}); }
  function capLabel(sp){ if(sp.capacity==null) return ''; return sp.capacity_max? sp.capacity+'–'+sp.capacity_max+' pers.' : sp.capacity+' pers.'; }

  // ---- audio (unlocked on first gesture) ----
  var actx=null;
  function unlock(){ if(!actx){ try{ actx=new (window.AudioContext||window.webkitAudioContext)(); }catch(e){} } if(actx&&actx.state==='suspended'){ actx.resume(); } }
  document.addEventListener('touchstart',unlock);
  document.addEventListener('click',unlock);
  function beep(){ if(!actx) return; try{ var o=actx.createOscillator(),g=actx.createGain();
    o.type='sine';o.frequency.value=760;g.gain.value=.001;o.connect(g);g.connect(actx.destination);
    var t=actx.currentTime;g.gain.exponentialRampToValueAtTime(.25,t+.02);g.gain.exponentialRampToValueAtTime(.001,t+.5);o.start(t);o.stop(t+.5);}catch(e){} }

  function post(path,body){ return fetch(BASE+path,{method:'POST',headers:{'Content-Type':'application/json','X-Requested-With':'fetch'},body:JSON.stringify(body||{})}); }

  function ticketCard(t){
    var d=el('div','tk'); d.dataset.id=t.id;
    (t.items||[]).forEach(function(l,i){ var ln=el('div','line');
      ln.appendChild(el('span','q',l.qty+'×'));
      ln.appendChild(document.createTextNode(' '+l.name+(l.choice?' ('+l.choice+')':'')));
      if(i===0){ var st=el('span','st '+t.status.toLowerCase(), t.status==='READY'?'Prête':t.status==='PREPARING'?'En prépa':'Envoyée'); ln.appendChild(st); }
      d.appendChild(ln);
      if(l.note) d.appendChild(el('div','tnote','• '+l.note));
    });
    if(t.note) d.appendChild(el('div','tnote','📝 '+t.note));
    if(t.serve_by) d.appendChild(el('div','taken','🙋 Pris par '+t.serve_by));
    if(t.status==='READY'){
      var acts=el('div','tacts');
      if(!t.serve_by){ var tk=el('button','act take','Je prends'); tk.onclick=function(){ tk.disabled=true; post('/tickets/'+t.id+'/take',{}).then(function(r){if(!r.ok)tk.disabled=false;}).catch(function(){tk.disabled=false;}); }; acts.appendChild(tk); }
      var sv=el('button','act serve','Servie'); sv.onclick=function(){ sv.disabled=true; post('/tickets/'+t.id+'/served',{}).then(function(r){if(!r.ok)sv.disabled=false;}).catch(function(){sv.disabled=false;}); }; acts.appendChild(sv);
      d.appendChild(acts);
    } else {
      var acts2=el('div','tacts');
      var cx=el('button','act cancel','✕'); cx.title='Annuler cette commande';
      cx.onclick=function(){ if(!confirm('Annuler cette commande ?'))return; cx.disabled=true; post('/tickets/'+t.id+'/cancel',{reason:'annulée en salle'}).then(function(r){if(!r.ok)cx.disabled=false;}).catch(function(){cx.disabled=false;}); };
      acts2.appendChild(cx); d.appendChild(acts2);
    }
    return d;
  }

  function spotTile(sp){
    var s=sessionForSpot(sp.id);
    var tks=s? ticketsOf(s.id) : [];
    var anyReady=tks.some(function(t){return t.status==='READY';});
    var c=el('div','spot '+(s?'occupied':'free')+(anyReady?' ready':'')); c.dataset.spot=sp.id; if(s)c.dataset.session=s.id;
    var h=el('div','sh'); h.appendChild(el('span','nm',sp.label)); var cap=capLabel(sp); if(cap)h.appendChild(el('span','cap',cap)); c.appendChild(h);
    if(!s){
      c.appendChild(el('div','freehint','Libre · touchez pour prendre la commande'));
      c.onclick=function(){ openOrder(sp,null); };
      return c;
    }
    if(s.first_name) c.appendChild(el('div','who','👤 '+s.first_name));
    tks.forEach(function(t){ c.appendChild(ticketCard(t)); });
    if(!tks.length) c.appendChild(el('div','who','Occupé — aucune commande en cours'));
    var sa=el('div','sacts');
    var add=el('button','sec add','＋ Commande'); add.onclick=function(){ openOrder(sp,s); }; sa.appendChild(add);
    var close=el('button','sec','Libérer'); close.onclick=function(){ freeSpot(s,close); }; sa.appendChild(close);
    c.appendChild(sa);
    return c;
  }

  function render(){
    board.textContent='';
    if(!SPOTS.length){
      // Spots come from the initial boot (not SSE); a tab opened before they were
      // available stays empty — offer a one-tap reload rather than a dead end.
      var e=el('p','empty','Aucun espace chargé.');
      e.appendChild(document.createElement('br'));
      var b=el('button','sec','↻ Recharger'); b.style.marginTop='1rem'; b.style.maxWidth='12rem';
      b.onclick=function(){ location.reload(); };
      e.appendChild(b);
      board.appendChild(e); return;
    }
    SPOTS.forEach(function(sp){ board.appendChild(spotTile(sp)); });
    var occ=0; SPOTS.forEach(function(sp){ if(sessionForSpot(sp.id)) occ++; });
    countEl.textContent=occ? occ+'/'+SPOTS.length+' occupé'+(occ>1?'s':'') : '';
  }

  function freeSpot(s,btn){
    btn.disabled=true;
    post('/sessions/'+s.id+'/close',{}).then(function(r){return r.json().catch(function(){return {};});}).then(function(j){
      if(j&&j.ok){ /* removed via SSE */ }
      else { btn.disabled=false; alert(j&&j.reason==='open_tickets'?'Servez ou annulez d\'abord les commandes en cours.':'Impossible de libérer.'); }
    }).catch(function(){ btn.disabled=false; });
  }

  // ---- order composer ----
  function overlay(){ var ov=el('div','ov'); ov.onclick=function(e){ if(e.target===ov) document.body.removeChild(ov); }; return ov; }

  function normalize(s){ return String(s||'').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g,''); }

  function openOrder(sp,session){
    unlock();
    var ov=overlay(); var sh=el('div','sheet');
    var x=el('button','close-x','×'); x.onclick=function(){document.body.removeChild(ov);}; sh.appendChild(x);
    sh.appendChild(el('h2','Commande — '+sp.label));
    var fn=null;
    if(!session){ fn=el('input'); fn.placeholder='Prénom (optionnel)'; fn.maxLength=40; fn.style.marginBottom='.6rem'; sh.appendChild(fn); }

    var draft={};       // id -> {qty, choice, note}
    var state={cat:'__ALL__', q:'', cartOnly:false};
    var totalEl, cartChip, listEl;

    function cartCount(){ var n=0; Object.keys(draft).forEach(function(id){ if(draft[id].qty>0) n+=draft[id].qty; }); return n; }
    function recompute(){
      var tot=0; Object.keys(draft).forEach(function(id){ var it=findItem(id); if(it&&draft[id].qty>0) tot+=it.price*draft[id].qty; });
      totalEl.textContent=''; totalEl.appendChild(document.createTextNode(tot+' F ')); totalEl.appendChild(el('small','','(indicatif)'));
      var n=cartCount(); cartChip.textContent='🛒 Panier'+(n?' ('+n+')':''); cartChip.classList.toggle('sel',state.cartOnly);
    }

    // ── sticky toolbar: search + category chips + cart ──
    var toolbar=el('div','toolbar');
    var search=el('input','search'); search.placeholder='🔍 Rechercher un article…'; search.setAttribute('inputmode','search');
    search.oninput=function(){ state.q=search.value; if(state.q) state.cartOnly=false; renderList(); };
    toolbar.appendChild(search);
    var chips=el('div','chips');
    function setCat(c){ state.cat=c; state.cartOnly=false; renderList(); }
    var chipAll=el('button','chip','Tout'); chipAll.onclick=function(){ setCat('__ALL__'); }; chips.appendChild(chipAll);
    var catChips={};
    MENU.forEach(function(cat){ var ch=el('button','chip',cat.category); ch.onclick=(function(name){return function(){ setCat(name); };})(cat.category); catChips[cat.category]=ch; chips.appendChild(ch); });
    cartChip=el('button','chip cart','🛒 Panier'); cartChip.onclick=function(){ state.cartOnly=!state.cartOnly; if(state.cartOnly){state.q='';search.value='';} renderList(); };
    chips.appendChild(cartChip);
    toolbar.appendChild(chips);
    sh.appendChild(toolbar);

    listEl=el('div'); sh.appendChild(listEl);

    function itemRow(it){
      var d=draft[it.id]||{qty:0,choice:'',note:''};
      var row=el('div','mi'+(d.qty>0?' on':''));
      var nm=el('div','nm'); var t=el('span',null,it.name); nm.appendChild(t);
      if(d.qty>0){ nm.appendChild(el('span','qbadge','×'+d.qty)); }
      nm.appendChild(el('span','pr',it.price+' F')); row.appendChild(nm);
      var stp=el('div','stepper');
      var minus=el('button',null,'−'); var qv=el('span','qv',String(d.qty)); var plus=el('button','plus','+');
      var extra=el('div','wrap'); extra.style.display=d.qty>0?'block':'none';
      function sync(){ var dd=draft[it.id]||{qty:0}; qv.textContent=dd.qty;
        extra.style.display=dd.qty>0?'block':'none'; row.classList.toggle('on',dd.qty>0);
        // refresh the qty badge
        var old=nm.querySelector('.qbadge'); if(old) nm.removeChild(old);
        if(dd.qty>0){ var b=el('span','qbadge','×'+dd.qty); nm.insertBefore(b,nm.querySelector('.pr')); }
        recompute();
      }
      minus.onclick=function(){ var dd=draft[it.id]||{qty:0,choice:'',note:''}; dd.qty=Math.max(0,dd.qty-1); draft[it.id]=dd; sync(); if(state.cartOnly&&dd.qty===0) renderList(); };
      plus.onclick=function(){ var dd=draft[it.id]||{qty:0,choice:'',note:''}; dd.qty=Math.min(10,dd.qty+1); draft[it.id]=dd; sync(); };
      stp.appendChild(minus); stp.appendChild(qv); stp.appendChild(plus); row.appendChild(stp);
      if(it.choices && it.choices.length){ var selc=document.createElement('select');
        var op0=document.createElement('option'); op0.value=''; op0.textContent=(it.optionLabel||'Choix')+'…'; selc.appendChild(op0);
        it.choices.forEach(function(ch){ var o=document.createElement('option'); o.value=ch; o.textContent=ch; if(d.choice===ch)o.selected=true; selc.appendChild(o); });
        selc.onchange=function(){ var dd=draft[it.id]||{qty:0}; dd.choice=selc.value; draft[it.id]=dd; }; extra.appendChild(selc); }
      var ntn=el('input','ln'); ntn.placeholder='Note (ex: sans sucre)'; ntn.maxLength=140; ntn.value=d.note||'';
      ntn.oninput=function(){ var dd=draft[it.id]||{qty:0}; dd.note=ntn.value; draft[it.id]=dd; }; extra.appendChild(ntn);
      row.appendChild(extra);
      return row;
    }

    function renderList(){
      // sync chip highlight
      chipAll.classList.toggle('sel',state.cat==='__ALL__'&&!state.q&&!state.cartOnly);
      Object.keys(catChips).forEach(function(k){ catChips[k].classList.toggle('sel',state.cat===k&&!state.q&&!state.cartOnly); });
      cartChip.classList.toggle('sel',state.cartOnly);
      listEl.textContent='';
      var q=normalize(state.q);
      var any=false;
      MENU.forEach(function(cat){
        var items=cat.items.filter(function(it){
          if(state.cartOnly) return (draft[it.id]&&draft[it.id].qty>0);
          if(q) return normalize(it.name).indexOf(q)>=0;
          if(state.cat!=='__ALL__') return cat.category===state.cat;
          return true;
        });
        if(!items.length) return;
        listEl.appendChild(el('div','cat',cat.category));
        items.forEach(function(it){ listEl.appendChild(itemRow(it)); any=true; });
      });
      if(!any){ listEl.appendChild(el('div','nores', state.cartOnly?'Panier vide — ajoutez des articles.':'Aucun article trouvé.')); }
    }

    var gnote=el('textarea'); gnote.placeholder='Note générale pour la table (optionnel)'; gnote.maxLength=280; sh.appendChild(gnote);
    var msg=el('div','msg'); msg.style.display='none'; sh.appendChild(msg);
    var foot=el('div','foot'); totalEl=el('div','total'); foot.appendChild(totalEl);
    var go=el('button','go','Envoyer en cuisine');
    go.onclick=function(){
      var items=[]; Object.keys(draft).forEach(function(id){ var d=draft[id]; if(d.qty>0){ var e={item_id:id,qty:d.qty}; if(d.choice)e.choice=d.choice; if(d.note)e.note=d.note; items.push(e); } });
      if(!items.length){ msg.textContent='Ajoutez au moins un article.'; msg.style.display='block'; return; }
      go.disabled=true; msg.style.display='none';
      var body={items:items,note:gnote.value,client_request_id:uuid()}; if(fn&&fn.value) body.first_name=fn.value;
      post('/spots/'+sp.id+'/orders',body).then(function(r){return r.json().catch(function(){return{};});}).then(function(j){
        if(j&&j.ok){ document.body.removeChild(ov); } else { go.disabled=false; msg.textContent=(j&&j.message)||'Commande refusée. Vérifiez les choix requis.'; msg.style.display='block'; }
      }).catch(function(){ go.disabled=false; msg.textContent='Erreur réseau.'; msg.style.display='block'; });
    };
    foot.appendChild(go); sh.appendChild(foot);
    ov.appendChild(sh); document.body.appendChild(ov);
    renderList(); recompute();
  }

  function setOnline(on){ dot.classList.toggle('on',on); offline.classList.toggle('show',!on); }

  // Re-fetch the authoritative board state on load, so a stale cached page (an old
  // inline boot without spots) self-heals to the current spots/sessions/menu.
  function refreshState(){
    fetch(BASE+'/state',{headers:{'X-Requested-With':'fetch'}}).then(function(r){return r.ok?r.json():null;}).then(function(d){
      if(!d)return;
      SPOTS=(d.spots||[]).slice().sort(function(a,b){return (a.sort_order||0)-(b.sort_order||0);});
      if(d.menu&&d.menu.length) MENU=d.menu;
      sessions=new Map(); (d.sessions||[]).forEach(function(s){sessions.set(s.id,s);});
      tickets=new Map(); (d.tickets||[]).forEach(function(t){ if(t.source==='TABLE') tickets.set(t.id,t); });
      render();
    }).catch(function(){});
  }

  render();
  refreshState();

  var es=new EventSource(BASE+'/events?since='+cursor);
  es.onopen=function(){setOnline(true);};
  es.onerror=function(){setOnline(false);};
  function bump(e){ if(e.lastEventId)cursor=+e.lastEventId; }
  function flashSpot(spotId){ var c=board.querySelector('[data-spot="'+spotId+'"]'); if(c)c.classList.add('flash'); }
  es.addEventListener('session_new',function(e){ var s=JSON.parse(e.data); sessions.set(s.id,s); bump(e); render(); flashSpot(s.spot_id); });
  es.addEventListener('session_update',function(e){ var s=JSON.parse(e.data); sessions.set(s.id,s); bump(e); render(); });
  es.addEventListener('session_closed',function(e){ var d=JSON.parse(e.data); sessions.delete(d.id); bump(e); render(); });
  es.addEventListener('ticket_new',function(e){ var t=JSON.parse(e.data); bump(e); if(t.source!=='TABLE')return; tickets.set(t.id,t); render(); });
  es.addEventListener('ticket_update',function(e){ var t=JSON.parse(e.data); bump(e); if(t.source!=='TABLE')return; var was=tickets.get(t.id); tickets.set(t.id,t); render(); if(t.status==='READY' && (!was||was.status!=='READY')) beep(); });
  es.addEventListener('ticket_removed',function(e){ var d=JSON.parse(e.data); bump(e); tickets.delete(d.id); render(); });

  if('serviceWorker' in navigator){ navigator.serviceWorker.register(BASE+'/sw.js').catch(function(){}); }
})();`;
