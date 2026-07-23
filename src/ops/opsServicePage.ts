import type { FastifyReply } from "fastify";

/**
 * The reception PWA (service.revive.sn) — HTML shell, manifest, service worker
 * and client JS, all served as strings (house style, no bundler). Same security
 * stance as the cuisine kiosque: the client builds every card with textContent
 * (order/first-name data is never interpolated into HTML — no XSS), the SW caches
 * ONLY the shell/assets (never a mutation, the SSE stream, or the sessions API).
 *
 * The reception phones own the on-site (TABLE) flow: open a session in an area,
 * push an order to the kitchen, then "Je prends" / "Servie" when it's READY, and
 * close the session (refused server-side while a ticket is still open).
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
padding-top:env(safe-area-inset-top);padding-bottom:6rem}
header{position:sticky;top:0;z-index:5;display:flex;align-items:center;gap:.6rem;
padding:.7rem 1rem;background:#211921;border-bottom:1px solid #3a2f3a}
header h1{font-size:1.05rem;margin:0;font-weight:700}
.dot{width:.7rem;height:.7rem;border-radius:50%;background:#e5484d;box-shadow:0 0 0 3px rgba(229,72,77,.18)}
.dot.on{background:#30a46c;box-shadow:0 0 0 3px rgba(48,164,108,.18)}
.spacer{flex:1}.count{font-size:.85rem;color:#c9bcc9}
main{padding:.8rem;display:flex;flex-direction:column;gap:.8rem}
.sess{background:#211921;border:1px solid #3a2f3a;border-left:6px solid #e2a63a;border-radius:14px;padding:.85rem .95rem}
.sess.flash{animation:flash 1.1s ease-out}
@keyframes flash{0%{background:#3a2f3a}100%{background:#211921}}
.shead{display:flex;align-items:baseline;gap:.5rem}
.code{font-size:1.35rem;font-weight:800;letter-spacing:.02em}
.area{font-size:.9rem;color:#c9bcc9}.who{font-size:.9rem;color:#f0c579;margin-left:auto}
.warn{font-size:.8rem;color:#f0b74a;margin-top:.2rem}
.tk{margin-top:.55rem;padding:.55rem .6rem;border:1px solid #3a2f3a;border-radius:10px;background:#1a141a}
.tk .line{display:flex;align-items:center;gap:.4rem}
.tk .q{font-weight:800;color:#f0c579}
.tk .st{margin-left:auto;font-size:.72rem;font-weight:800;text-transform:uppercase;letter-spacing:.04em;
padding:.16rem .5rem;border-radius:999px}
.st.new{background:#3a2f3a;color:#c9bcc9}.st.preparing{background:#3a2c10;color:#f0c579}
.st.ready{background:#123524;color:#6ee7a8}
.tk .tnote{font-size:.82rem;color:#ffd7a8;margin-top:.2rem}
.tk .taken{font-size:.8rem;color:#8fc3ff;margin-top:.2rem}
.tacts{display:flex;gap:.45rem;margin-top:.5rem}
button{font-family:inherit}
button.act{flex:1;padding:.7rem;font-size:.98rem;font-weight:800;border:none;border-radius:10px;color:#fff}
button.take{background:#2864b5}button.serve{background:#1a7f37}button.cancel{background:#5a2530}
button.act:active{filter:brightness(.9)}button.act:disabled{opacity:.5}
.sacts{display:flex;gap:.45rem;margin-top:.7rem}
button.sec{flex:1;padding:.7rem;font-size:.95rem;font-weight:700;border-radius:10px;border:1px solid #4a3d4a;background:#2c222c;color:#fbf6f0}
button.add{background:#7c547d;border-color:#7c547d}
.empty{text-align:center;color:#7a6d7a;margin-top:18vh;font-size:1.05rem}
.fab{position:fixed;left:0;right:0;bottom:0;padding:.8rem;padding-bottom:calc(.8rem + env(safe-area-inset-bottom));
background:linear-gradient(to top,#161016 60%,transparent);display:flex;justify-content:center}
.fab button{width:100%;max-width:32rem;padding:1rem;font-size:1.1rem;font-weight:800;border:none;border-radius:14px;background:#e2a63a;color:#211921}
/* Overlay (session composer + order composer) */
.ov{position:fixed;inset:0;z-index:20;background:rgba(10,7,10,.6);display:flex;align-items:flex-end;justify-content:center}
.sheet{background:#1c151c;width:100%;max-width:34rem;max-height:92vh;overflow:auto;border-radius:18px 18px 0 0;
padding:1rem;padding-bottom:calc(1rem + env(safe-area-inset-bottom))}
.sheet h2{margin:.1rem 0 .8rem;font-size:1.2rem}
.areas{display:flex;gap:.5rem;flex-wrap:wrap;margin-bottom:.8rem}
.areas button{flex:1;min-width:5rem;padding:.9rem;border-radius:12px;border:1px solid #4a3d4a;background:#2c222c;color:#fbf6f0;font-weight:700;font-size:1rem}
.areas button.sel{background:#7c547d;border-color:#7c547d}
.sheet input,.sheet textarea{width:100%;padding:.8rem;border-radius:12px;border:1px solid #4a3d4a;background:#2c222c;color:#fbf6f0;font-size:1rem;margin-bottom:.7rem;font-family:inherit}
.sheet textarea{min-height:3rem}
.cat{font-size:.78rem;font-weight:800;letter-spacing:.06em;text-transform:uppercase;color:#a98fa9;margin:.7rem 0 .3rem}
.mi{display:flex;align-items:center;gap:.5rem;padding:.5rem 0;border-bottom:1px solid #2a212a}
.mi .nm{flex:1}.mi .pr{color:#c9bcc9;font-size:.85rem}
.stepper{display:flex;align-items:center;gap:.5rem}
.stepper button{width:2.2rem;height:2.2rem;border-radius:50%;border:1px solid #4a3d4a;background:#2c222c;color:#fbf6f0;font-size:1.3rem;font-weight:800;line-height:1}
.stepper .qv{min-width:1.3rem;text-align:center;font-weight:800}
.mi .opt{width:100%;margin-top:.4rem}
.mi select{width:100%;padding:.55rem;border-radius:10px;border:1px solid #4a3d4a;background:#2c222c;color:#fbf6f0;font-size:.92rem;margin-top:.35rem}
.mi .ln{margin-top:.35rem;font-size:.9rem;padding:.5rem;margin-bottom:0}
.wrap{padding:.5rem 0}
.foot{position:sticky;bottom:0;background:#1c151c;padding-top:.6rem;display:flex;gap:.5rem;align-items:center}
.total{font-weight:800;font-size:1.05rem}.total small{color:#8a7d8a;font-weight:500}
.foot button.go{flex:1;padding:.9rem;border:none;border-radius:12px;background:#1a7f37;color:#fff;font-weight:800;font-size:1.02rem}
.foot button.go:disabled{opacity:.5}
.close-x{position:sticky;top:0;float:right;background:none;border:none;color:#c9bcc9;font-size:1.6rem;line-height:1}
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
<div class="fab"><button id="newSession">＋ Nouvelle table</button></div>
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
export const SERVICE_SW = `const CACHE='service-v1';
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
  var boot=window.__BOOT__||{cursor:0,sessions:[],tickets:[],areas:[],menu:[]};
  var cursor=boot.cursor||0;
  var AREAS=boot.areas||[];
  var MENU=boot.menu||[];
  var sessions=new Map(); (boot.sessions||[]).forEach(function(s){sessions.set(s.id,s);});
  var tickets=new Map(); (boot.tickets||[]).forEach(function(t){ if(t.source==='TABLE') tickets.set(t.id,t); });
  var board=document.getElementById('board');
  var countEl=document.getElementById('count');
  var dot=document.getElementById('dot');
  var offline=document.getElementById('offline');

  function el(tag,cls,txt){ var e=document.createElement(tag); if(cls)e.className=cls; if(txt!=null)e.textContent=txt; return e; }
  function uuid(){ try{ return crypto.randomUUID(); }catch(e){ return 'r-'+Date.now()+'-'+Math.round(Math.random()*1e9); } }

  // ---- audio (unlocked on first gesture) ----
  var actx=null;
  function unlock(){ if(!actx){ try{ actx=new (window.AudioContext||window.webkitAudioContext)(); }catch(e){} } if(actx&&actx.state==='suspended'){ actx.resume(); } }
  document.addEventListener('touchstart',unlock);
  document.addEventListener('click',unlock);
  function beep(){ if(!actx) return; try{ var o=actx.createOscillator(),g=actx.createGain();
    o.type='sine';o.frequency.value=760;g.gain.value=.001;o.connect(g);g.connect(actx.destination);
    var t=actx.currentTime;g.gain.exponentialRampToValueAtTime(.25,t+.02);g.gain.exponentialRampToValueAtTime(.001,t+.5);o.start(t);o.stop(t+.5);}catch(e){} }

  function post(path,body){ return fetch(BASE+path,{method:'POST',headers:{'Content-Type':'application/json','X-Requested-With':'fetch'},body:JSON.stringify(body||{})}); }

  function ticketsOf(sid){ var out=[]; tickets.forEach(function(t){ if(t.session_id===sid) out.push(t); }); return out.sort(function(a,b){return new Date(a.created_at)-new Date(b.created_at);}); }

  function ticketCard(t){
    var d=el('div','tk'); d.dataset.id=t.id;
    (t.items||[]).forEach(function(l){ var ln=el('div','line');
      ln.appendChild(el('span','q',l.qty+'×'));
      ln.appendChild(document.createTextNode(' '+l.name+(l.choice?' ('+l.choice+')':'')));
      if(l===t.items[0]){ var st=el('span','st '+t.status.toLowerCase(), t.status==='READY'?'Prête':t.status==='PREPARING'?'En prépa':'Envoyée'); ln.appendChild(st); }
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
    }
    return d;
  }

  function sessionCard(s){
    var c=el('div','sess'); c.dataset.id=s.id;
    var h=el('div','shead');
    h.appendChild(el('span','code',s.short_code));
    h.appendChild(el('span','area',s.area_name));
    if(s.first_name) h.appendChild(el('span','who',s.first_name));
    c.appendChild(h);
    var tks=ticketsOf(s.id);
    var anyReady=tks.some(function(t){return t.status==='READY';});
    if(anyReady && s.pos_x==null) c.appendChild(el('div','warn','⚠️ emplacement non renseigné — repère : '+s.short_code+' · '+s.area_name+(s.first_name?' · '+s.first_name:'')));
    tks.forEach(function(t){ c.appendChild(ticketCard(t)); });
    var sa=el('div','sacts');
    var add=el('button','sec add','＋ Commande'); add.onclick=function(){ openOrder(s); }; sa.appendChild(add);
    var close=el('button','sec','Fermer'); close.onclick=function(){ closeSession(s,close); }; sa.appendChild(close);
    c.appendChild(sa);
    return c;
  }

  function render(){
    var list=Array.from(sessions.values()).sort(function(a,b){return new Date(a.opened_at)-new Date(b.opened_at);});
    board.textContent='';
    if(!list.length){ board.appendChild(el('p','empty','Aucune table ouverte. Touchez « Nouvelle table ».')); }
    else list.forEach(function(s){ board.appendChild(sessionCard(s)); });
    var n=list.length; countEl.textContent=n? n+(n>1?' tables':' table') : '';
  }

  function closeSession(s,btn){
    btn.disabled=true;
    post('/sessions/'+s.id+'/close',{}).then(function(r){return r.json().catch(function(){return {};});}).then(function(j){
      if(j&&j.ok){ /* removed via SSE */ }
      else { btn.disabled=false; alert(j&&j.reason==='open_tickets'?'Servez ou annulez d\'abord les commandes en cours.':'Fermeture impossible.'); }
    }).catch(function(){ btn.disabled=false; });
  }

  // ---- overlays ----
  function overlay(){ var ov=el('div','ov'); ov.onclick=function(e){ if(e.target===ov) document.body.removeChild(ov); }; return ov; }

  function openNewSession(){
    unlock();
    var ov=overlay(); var sh=el('div','sheet');
    var x=el('button','close-x','×'); x.onclick=function(){document.body.removeChild(ov);}; sh.appendChild(x);
    sh.appendChild(el('h2','Nouvelle table'));
    var sel={id:null};
    var ar=el('div','areas');
    AREAS.forEach(function(a){ var b=el('button',null,a.name); b.onclick=function(){ sel.id=a.id; Array.from(ar.children).forEach(function(c){c.classList.remove('sel');}); b.classList.add('sel'); }; ar.appendChild(b); });
    sh.appendChild(ar);
    var fn=el('input'); fn.placeholder='Prénom (optionnel)'; fn.maxLength=40; sh.appendChild(fn);
    var msg=el('div','msg'); msg.style.display='none'; sh.appendChild(msg);
    var go=el('button','go','Ouvrir la table'); go.style.width='100%'; go.style.padding='.9rem'; go.style.border='none'; go.style.borderRadius='12px'; go.style.background='#e2a63a'; go.style.color='#211921'; go.style.fontWeight='800'; go.style.fontSize='1.05rem';
    go.onclick=function(){ if(!sel.id){ msg.textContent='Choisissez un espace.'; msg.style.display='block'; return; } go.disabled=true;
      post('/sessions',{area_id:sel.id,first_name:fn.value}).then(function(r){return r.json().catch(function(){return{};});}).then(function(j){
        if(j&&j.id){ document.body.removeChild(ov); } else { go.disabled=false; msg.textContent='Impossible d\'ouvrir la table.'; msg.style.display='block'; }
      }).catch(function(){ go.disabled=false; });
    };
    sh.appendChild(go);
    ov.appendChild(sh); document.body.appendChild(ov);
  }

  function openOrder(s){
    unlock();
    var ov=overlay(); var sh=el('div','sheet');
    var x=el('button','close-x','×'); x.onclick=function(){document.body.removeChild(ov);}; sh.appendChild(x);
    sh.appendChild(el('h2','Commande — '+s.short_code));
    var draft={}; // id -> {qty, choice, note}
    var totalEl;
    function recompute(){ var tot=0; Object.keys(draft).forEach(function(id){ var it=findItem(id); if(it&&draft[id].qty>0) tot+=it.price*draft[id].qty; });
      totalEl.textContent=''; totalEl.appendChild(document.createTextNode(tot+' F ')); totalEl.appendChild(el('small','','(indicatif)')); }
    MENU.forEach(function(cat){
      sh.appendChild(el('div','cat',cat.category));
      cat.items.forEach(function(it){
        var row=el('div','mi');
        var nm=el('div','nm'); nm.appendChild(el('span',null,it.name)); nm.appendChild(document.createElement('br')); nm.appendChild(el('span','pr',it.price+' F')); row.appendChild(nm);
        var stp=el('div','stepper');
        var minus=el('button',null,'−'); var qv=el('span','qv','0'); var plus=el('button',null,'+');
        var extra=el('div','wrap'); extra.style.display='none';
        function sync(){ var d=draft[it.id]||{qty:0}; qv.textContent=d.qty; extra.style.display=d.qty>0?'block':'none'; recompute(); }
        minus.onclick=function(){ var d=draft[it.id]||{qty:0,choice:'',note:''}; d.qty=Math.max(0,d.qty-1); draft[it.id]=d; sync(); };
        plus.onclick=function(){ var d=draft[it.id]||{qty:0,choice:'',note:''}; d.qty=Math.min(10,d.qty+1); draft[it.id]=d; sync(); };
        stp.appendChild(minus); stp.appendChild(qv); stp.appendChild(plus); row.appendChild(stp);
        // choice + note appear once qty>0
        if(it.choices && it.choices.length){ var selc=document.createElement('select');
          var op0=document.createElement('option'); op0.value=''; op0.textContent=(it.optionLabel||'Choix')+'…'; selc.appendChild(op0);
          it.choices.forEach(function(ch){ var o=document.createElement('option'); o.value=ch; o.textContent=ch; selc.appendChild(o); });
          selc.onchange=function(){ var d=draft[it.id]||{qty:0}; d.choice=selc.value; draft[it.id]=d; }; extra.appendChild(selc); }
        var ntn=el('input','ln'); ntn.placeholder='Note (ex: sans sucre)'; ntn.maxLength=140; ntn.oninput=function(){ var d=draft[it.id]||{qty:0}; d.note=ntn.value; draft[it.id]=d; }; extra.appendChild(ntn);
        row.appendChild(extra);
        sh.appendChild(row);
      });
    });
    var gnote=el('textarea'); gnote.placeholder='Note générale (optionnel)'; gnote.maxLength=280; gnote.style.marginTop='.8rem'; sh.appendChild(gnote);
    var msg=el('div','msg'); msg.style.display='none'; sh.appendChild(msg);
    var foot=el('div','foot'); totalEl=el('div','total'); foot.appendChild(totalEl);
    var go=el('button','go','Envoyer en cuisine');
    go.onclick=function(){
      var items=[]; Object.keys(draft).forEach(function(id){ var d=draft[id]; if(d.qty>0){ var e={item_id:id,qty:d.qty}; if(d.choice)e.choice=d.choice; if(d.note)e.note=d.note; items.push(e); } });
      if(!items.length){ msg.textContent='Ajoutez au moins un article.'; msg.style.display='block'; return; }
      go.disabled=true; msg.style.display='none';
      post('/sessions/'+s.id+'/orders',{items:items,note:gnote.value,client_request_id:uuid()}).then(function(r){return r.json().catch(function(){return{};});}).then(function(j){
        if(j&&j.ok){ document.body.removeChild(ov); } else { go.disabled=false; msg.textContent=(j&&j.message)||'Commande refusée. Vérifiez les choix requis.'; msg.style.display='block'; }
      }).catch(function(){ go.disabled=false; msg.textContent='Erreur réseau.'; msg.style.display='block'; });
    };
    foot.appendChild(go); sh.appendChild(foot);
    ov.appendChild(sh); document.body.appendChild(ov);
    recompute();
  }

  function findItem(id){ for(var i=0;i<MENU.length;i++){ for(var j=0;j<MENU[i].items.length;j++){ if(MENU[i].items[j].id===id) return MENU[i].items[j]; } } return null; }

  function setOnline(on){ dot.classList.toggle('on',on); offline.classList.toggle('show',!on); }

  document.getElementById('newSession').onclick=openNewSession;
  render();

  var es=new EventSource(BASE+'/events?since='+cursor);
  es.onopen=function(){setOnline(true);};
  es.onerror=function(){setOnline(false);};
  function bump(e){ if(e.lastEventId)cursor=+e.lastEventId; }
  es.addEventListener('session_new',function(e){ var s=JSON.parse(e.data); sessions.set(s.id,s); bump(e); render(); var c=board.querySelector('[data-id="'+s.id+'"]'); if(c)c.classList.add('flash'); });
  es.addEventListener('session_update',function(e){ var s=JSON.parse(e.data); sessions.set(s.id,s); bump(e); render(); });
  es.addEventListener('session_closed',function(e){ var d=JSON.parse(e.data); sessions.delete(d.id); bump(e); render(); });
  es.addEventListener('ticket_new',function(e){ var t=JSON.parse(e.data); bump(e); if(t.source!=='TABLE')return; tickets.set(t.id,t); render(); });
  es.addEventListener('ticket_update',function(e){ var t=JSON.parse(e.data); bump(e); if(t.source!=='TABLE')return; var was=tickets.get(t.id); tickets.set(t.id,t); render(); if(t.status==='READY' && (!was||was.status!=='READY')) beep(); });
  es.addEventListener('ticket_removed',function(e){ var d=JSON.parse(e.data); bump(e); tickets.delete(d.id); render(); });

  if('serviceWorker' in navigator){ navigator.serviceWorker.register(BASE+'/sw.js').catch(function(){}); }
})();`;
