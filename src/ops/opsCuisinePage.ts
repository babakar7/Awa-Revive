import type { FastifyReply } from "fastify";

/**
 * The cuisine kiosque PWA (cuisine.revive.sn) — HTML shell, web manifest, and
 * service worker + client JS, all served as strings (no bundler, no @fastify/
 * static, matching the house style). The page shell renders nothing itself: the
 * client JS builds every ticket card from window.__BOOT__ and then live-updates
 * over SSE, constructing DOM with textContent (order data is never interpolated
 * into HTML — no XSS surface). The service worker caches ONLY the shell/assets;
 * it never caches a business mutation, an SSE stream, or the ticket API.
 */

const BASE = "/ops/cuisine";

/** PWA pages need script-src 'self' (app.js) + worker-src 'self' (the SW) —
 *  looser than the strict delivery-page CSP, which forbids all script. Still no
 *  external origin: connect-src 'self' only, so SSE/fetch stay same-origin. */
export function hardenCuisine(reply: FastifyReply): void {
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
<meta name="apple-mobile-web-app-title" content="Cuisine">
<link rel="manifest" href="${BASE}/manifest.webmanifest">
<link rel="apple-touch-icon" href="${BASE}/icon-192.png">
<link rel="icon" href="${BASE}/icon-192.png">`;

// ── Pairing screen (unpaired device) ─────────────────────────────────────────
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

export function cuisinePairingPage(error?: string): string {
  return `<!doctype html><html lang="fr"><head>${HEAD}<title>Appairer — Cuisine Revive</title>
<style>${PAIR_STYLE}</style></head><body><main>
<h1>Cuisine Revive</h1>
<p>Entrez le code d'appairage affiché dans l'administration (Réglages → Appareils).</p>
<form method="post" action="${BASE}/pair" autocomplete="off">
<input name="code" inputmode="latin" autocapitalize="characters" maxlength="12" placeholder="CODE" required autofocus>
<button type="submit">Appairer cet écran</button>
${error ? `<p class="err">${esc(error)}</p>` : ""}
</form></main></body></html>`;
}

// ── Kiosque (paired device) ──────────────────────────────────────────────────
const APP_STYLE = `*{box-sizing:border-box}
html,body{margin:0;height:100%}
body{background:#161016;color:#fbf6f0;font-family:system-ui,-apple-system,"Segoe UI",sans-serif;
padding-top:env(safe-area-inset-top)}
header{position:sticky;top:0;z-index:5;display:flex;align-items:center;gap:.6rem;
padding:.7rem 1rem;background:#211921;border-bottom:1px solid #3a2f3a}
header h1{font-size:1.05rem;margin:0;font-weight:700;letter-spacing:.02em}
.dot{width:.7rem;height:.7rem;border-radius:50%;background:#e5484d;box-shadow:0 0 0 3px rgba(229,72,77,.18)}
.dot.on{background:#30a46c;box-shadow:0 0 0 3px rgba(48,164,108,.18)}
.spacer{flex:1}
.count{font-size:.85rem;color:#c9bcc9}
main{padding:.8rem;display:grid;gap:.8rem;grid-template-columns:repeat(auto-fill,minmax(19rem,1fr));align-content:start}
.card{background:#211921;border:1px solid #3a2f3a;border-left:6px solid #7c547d;border-radius:14px;
padding:.9rem 1rem;display:flex;flex-direction:column;gap:.5rem}
.card.src-delivery{border-left-color:#1f8fff}
.card.src-table{border-left-color:#e2a63a}
.card.ready{border-color:#30a46c;box-shadow:0 0 0 1px rgba(48,164,108,.4)}
.card.flash{animation:flash 1.1s ease-out}
@keyframes flash{0%{background:#3a2f3a}100%{background:#211921}}
.top{display:flex;align-items:center;gap:.5rem}
.badge{font-size:.7rem;font-weight:800;letter-spacing:.05em;text-transform:uppercase;
padding:.18rem .5rem;border-radius:999px;background:#0e2f52;color:#8fc3ff;white-space:nowrap}
.badge.table{background:#3a2c10;color:#f0c579}
.badge.test{background:#4a1d1d;color:#f6a5a5}
.age{margin-left:auto;font-size:.8rem;color:#9a8c9a}
.heading{font-size:1.15rem;font-weight:700;line-height:1.2}
.sub{font-size:.88rem;color:#c9bcc9}
ul.items{list-style:none;margin:.2rem 0;padding:0;display:flex;flex-direction:column;gap:.15rem}
ul.items li{font-size:1.02rem}
ul.items .q{font-weight:800;color:#f0c579}
.note{font-size:.9rem;color:#ffd7a8;background:#2c2012;border-radius:8px;padding:.4rem .55rem}
.pill{align-self:flex-start;font-size:.75rem;font-weight:700;text-transform:uppercase;letter-spacing:.04em;
padding:.2rem .55rem;border-radius:999px;background:#3a2f3a;color:#c9bcc9}
.pill.preparing{background:#3a2c10;color:#f0c579}
.pill.ready{background:#123524;color:#6ee7a8}
.actions{display:flex;gap:.5rem;margin-top:.2rem}
button.act{flex:1;padding:.85rem;font-size:1.05rem;font-weight:800;border:none;border-radius:12px;color:#fff}
button.prep{background:#b5711a}
button.ready{background:#1a7f37}
button.act:active{filter:brightness(.9)}
button.act:disabled{opacity:.5}
.empty{grid-column:1/-1;text-align:center;color:#7a6d7a;margin-top:20vh;font-size:1.1rem}
#offline{position:fixed;left:0;right:0;bottom:0;background:#7a2020;color:#fff;text-align:center;
padding:.6rem;font-weight:700;transform:translateY(100%);transition:transform .2s}
#offline.show{transform:translateY(0)}
noscript{display:block;padding:2rem;text-align:center}`;

export function cuisineKitchenPage(bootJson: string): string {
  return `<!doctype html><html lang="fr"><head>${HEAD}<title>Cuisine Revive</title>
<style>${APP_STYLE}</style></head><body>
<header><span id="dot" class="dot"></span><h1>Cuisine</h1><span class="spacer"></span>
<span class="count" id="count"></span></header>
<main id="board"><p class="empty" id="empty">Chargement…</p></main>
<div id="offline">Hors ligne — reconnexion…</div>
<noscript>Activez JavaScript pour afficher les tickets cuisine.</noscript>
<script>window.__BOOT__=${bootJson}</script>
<script src="${BASE}/app.js"></script>
</body></html>`;
}

// ── Web app manifest ─────────────────────────────────────────────────────────
export const CUISINE_MANIFEST = JSON.stringify({
  name: "Cuisine Revive",
  short_name: "Cuisine",
  description: "Tickets cuisine en temps réel — Revive",
  start_url: `${BASE}/`,
  scope: `${BASE}/`,
  display: "standalone",
  orientation: "landscape",
  background_color: "#161016",
  theme_color: "#211921",
  icons: [
    { src: `${BASE}/icon-192.png`, sizes: "192x192", type: "image/png", purpose: "any" },
    { src: `${BASE}/icon-512.png`, sizes: "512x512", type: "image/png", purpose: "any maskable" },
  ],
});

// ── Service worker (shell/assets only; never a mutation or the SSE stream) ────
export const CUISINE_SW = `const CACHE='cuisine-v1';
const SHELL=['${BASE}/app.js','${BASE}/manifest.webmanifest','${BASE}/icon-192.png','${BASE}/icon-512.png'];
self.addEventListener('install',e=>{e.waitUntil(caches.open(CACHE).then(c=>c.addAll(SHELL)).then(()=>self.skipWaiting()));});
self.addEventListener('activate',e=>{e.waitUntil(caches.keys().then(ks=>Promise.all(ks.filter(k=>k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim()));});
self.addEventListener('fetch',e=>{
  const url=new URL(e.request.url);
  // Only ever touch our own static shell assets. Everything else — the page
  // navigation, the SSE stream, and every POST mutation — goes straight to the
  // network (never cached), so the kitchen never acts on stale data.
  if(e.request.method==='GET' && SHELL.includes(url.pathname)){
    e.respondWith(caches.match(e.request).then(r=>r||fetch(e.request)));
  }
});`;

// ── Client app (SSE-driven board; DOM built with textContent) ────────────────
export const CUISINE_APP_JS = String.raw`(function(){
  var BASE=${JSON.stringify(BASE)};
  var boot=window.__BOOT__||{cursor:0,tickets:[]};
  var cursor=boot.cursor||0;
  var model=new Map();
  (boot.tickets||[]).forEach(function(t){model.set(t.id,t);});
  var board=document.getElementById('board');
  var countEl=document.getElementById('count');
  var dot=document.getElementById('dot');
  var offline=document.getElementById('offline');

  // ---- audio (unlocked on first user gesture; iOS requirement) ----
  var actx=null;
  function unlock(){ if(!actx){ try{ actx=new (window.AudioContext||window.webkitAudioContext)(); }catch(e){} } if(actx&&actx.state==='suspended'){ actx.resume(); } }
  document.addEventListener('touchstart',unlock,{once:false});
  document.addEventListener('click',unlock,{once:false});
  function beep(){ if(!actx) return; try{ var o=actx.createOscillator(),g=actx.createGain();
    o.type='sine'; o.frequency.value=880; g.gain.value=.001; o.connect(g); g.connect(actx.destination);
    var t=actx.currentTime; g.gain.exponentialRampToValueAtTime(.25,t+.02); g.gain.exponentialRampToValueAtTime(.001,t+.5);
    o.start(t); o.stop(t+.5);}catch(e){} }

  function age(iso){ var s=Math.max(0,Math.floor((Date.now()-new Date(iso).getTime())/1000));
    var m=Math.floor(s/60); return m<1? s+' s' : m+' min'; }

  function el(tag,cls,txt){ var e=document.createElement(tag); if(cls)e.className=cls; if(txt!=null)e.textContent=txt; return e; }

  function card(t){
    var c=el('div','card src-'+(t.source==='TABLE'?'table':'delivery')+(t.status==='READY'?' ready':''));
    c.dataset.id=t.id;
    var top=el('div','top');
    var b=el('span','badge'+(t.source==='TABLE'?' table':''), t.source==='TABLE'?'🪑 Salle':'🛵 Livraison');
    top.appendChild(b);
    if(t.is_test) top.appendChild(el('span','badge test','Test'));
    var a=el('span','age',age(t.created_at)); a.dataset.age=t.created_at; top.appendChild(a);
    c.appendChild(top);
    c.appendChild(el('div','heading',t.heading||'—'));
    if(t.subheading) c.appendChild(el('div','sub',t.subheading));
    var ul=el('ul','items');
    (t.items||[]).forEach(function(l){ var li=el('li'); li.appendChild(el('span','q',l.qty+'× '));
      li.appendChild(document.createTextNode(l.name+(l.choice?' ('+l.choice+')':''))); ul.appendChild(li); });
    c.appendChild(ul);
    if(t.note) c.appendChild(el('div','note','📝 '+t.note));
    if(t.status==='READY'){ c.appendChild(el('span','pill ready','Prête — à récupérer')); }
    else {
      if(t.status==='PREPARING') c.appendChild(el('span','pill preparing','En préparation'));
      var acts=el('div','actions');
      if(t.status==='NEW'){ var p=el('button','act prep','Commencer'); p.onclick=function(){move(t.id,'preparing',p);}; acts.appendChild(p); }
      var r=el('button','act ready','Prête'); r.onclick=function(){move(t.id,'ready',r);}; acts.appendChild(r);
      c.appendChild(acts);
    }
    return c;
  }

  function render(){
    var list=Array.from(model.values()).sort(function(x,y){return new Date(x.created_at)-new Date(y.created_at);});
    board.textContent='';
    if(!list.length){ board.appendChild(el('p','empty','Aucun ticket en cours ✅')); }
    else list.forEach(function(t){ board.appendChild(card(t)); });
    countEl.textContent=list.length? list.length+(list.length>1?' tickets':' ticket') : '';
  }

  function move(id,action,btn){ if(btn){btn.disabled=true;} unlock();
    fetch(BASE+'/tickets/'+id+'/'+action,{method:'POST',headers:{'X-Requested-With':'fetch'}})
      .then(function(r){ if(!r.ok&&btn) btn.disabled=false; })
      .catch(function(){ if(btn) btn.disabled=false; }); }

  function ack(id){ fetch(BASE+'/tickets/'+id+'/ack',{method:'POST',headers:{'X-Requested-With':'fetch'}}).catch(function(){}); }
  function ackAll(){ model.forEach(function(t){ack(t.id);}); }

  function setOnline(on){ dot.classList.toggle('on',on); offline.classList.toggle('show',!on); }

  // Refresh the little age labels every 20s without a full re-render.
  setInterval(function(){ document.querySelectorAll('.age').forEach(function(a){ if(a.dataset.age) a.textContent=age(a.dataset.age); }); },20000);

  render(); ackAll();

  var es=new EventSource(BASE+'/events?since='+cursor);
  es.onopen=function(){setOnline(true);};
  es.onerror=function(){setOnline(false);};
  es.addEventListener('ticket_new',function(e){ var t=JSON.parse(e.data); var isNew=!model.has(t.id); model.set(t.id,t); if(e.lastEventId)cursor=+e.lastEventId; render(); if(isNew){beep(); var c=board.querySelector('[data-id="'+t.id+'"]'); if(c)c.classList.add('flash'); ack(t.id);} });
  es.addEventListener('ticket_update',function(e){ var t=JSON.parse(e.data); model.set(t.id,t); if(e.lastEventId)cursor=+e.lastEventId; render(); });
  es.addEventListener('ticket_removed',function(e){ var d=JSON.parse(e.data); model.delete(d.id); if(e.lastEventId)cursor=+e.lastEventId; render(); });

  if('serviceWorker' in navigator){ navigator.serviceWorker.register(BASE+'/sw.js').catch(function(){}); }
})();`;
