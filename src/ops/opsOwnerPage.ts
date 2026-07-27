import type { FastifyReply } from "fastify";
import {
  OPS_BASE,
  OPS_BG_COLOR,
  OPS_LOGO_SVG,
  OPS_PAIR_STYLE,
  OPS_THEME_COLOR,
  OPS_TOKENS,
  esc,
  opsHead,
} from "./opsTheme.js";

/**
 * The owner supervision PWA (owner.revive.sn) — a READ-ONLY overview of all live
 * activity for the manager: today's KPIs, device status, and every in-progress
 * ticket (cuisine + salle + livraison), urgents first. Same house style as the
 * cuisine kiosque (inline strings, DOM via textContent, shared Revive theme) but
 * with NO actions — the owner watches, never operates. Subscribes to the cuisine
 * channel (which already carries every ticket) and polls /stats for the aggregates.
 */

const BASE = "/ops/owner";
const ASSET_VERSION = "v1";

/** Same relaxed-but-sandboxed CSP as the other ops PWAs. */
export function hardenOwner(reply: FastifyReply): void {
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

// ── Pairing screen ───────────────────────────────────────────────────────────
export function ownerPairingPage(error?: string): string {
  return `<!doctype html><html lang="fr"><head>${opsHead(BASE, "Supervision")}<title>Appairer — Supervision Revive</title>
<style>${OPS_TOKENS}${OPS_BASE}${OPS_PAIR_STYLE}</style></head><body><main>
<span class="logo">${OPS_LOGO_SVG}</span>
<h1>Supervision Revive</h1>
<p>Entrez le code d'appairage affiché dans l'administration (appareil de type « propriétaire »).</p>
<form method="post" action="${BASE}/pair" autocomplete="off">
<input name="code" inputmode="latin" autocapitalize="characters" maxlength="12" placeholder="CODE" required autofocus>
<button type="submit">Appairer cet écran</button>
${error ? `<p class="err">${esc(error)}</p>` : ""}
</form></main></body></html>`;
}

// ── Board (paired) ───────────────────────────────────────────────────────────
const APP_STYLE = `.kpi-bar{display:grid;grid-template-columns:repeat(auto-fit,minmax(9rem,1fr));gap:.7rem;padding:.9rem 1rem 0}
.kpi{background:var(--surface-raised);border:1px solid var(--border-soft);border-radius:var(--radius-lg);
padding:.7rem .9rem;box-shadow:var(--shadow-1);border-top:3px solid var(--plum-400)}
.kpi .kv{font-family:var(--serif);font-size:1.7rem;font-weight:600;letter-spacing:-.02em;color:var(--ink-900);font-variant-numeric:tabular-nums}
.kpi .kl{font-size:.78rem;color:var(--ink-500);text-transform:uppercase;letter-spacing:.05em;margin-top:.1rem}
.dev-bar{display:flex;flex-wrap:wrap;gap:.5rem;padding:.7rem 1rem 0}
.dev{display:inline-flex;align-items:center;gap:.4rem;background:var(--cream-100);color:var(--ink-500);
border-radius:999px;padding:.28rem .7rem;font-size:.8rem;font-weight:600}
.dev .ddot{width:.55rem;height:.55rem;border-radius:50%;background:var(--ink-300)}
.dev.on{background:var(--ok-bg);color:var(--ok)}
.dev.on .ddot{background:var(--ok-strong)}
main{padding:.9rem 1rem 1rem;display:grid;gap:.9rem;grid-template-columns:repeat(auto-fill,minmax(18rem,1fr));align-content:start}
.card{background:var(--surface-raised);border:1px solid var(--border-soft);border-left:6px solid var(--plum-600);
border-radius:var(--radius-lg);padding:.9rem 1rem;display:flex;flex-direction:column;gap:.5rem;box-shadow:var(--shadow-1)}
.card.src-delivery{border-left-color:var(--info)}
.card.test{border-left-color:var(--danger)}
.card.ready{background:var(--ok-bg);border-color:var(--ok-border);box-shadow:0 0 0 1px var(--ok-border)}
.card.urgent{border-color:var(--danger);border-left-color:var(--danger);box-shadow:0 0 0 3px var(--danger-bg)}
.top{display:flex;align-items:center;gap:.5rem}
.badge{font-size:.66rem;font-weight:700;letter-spacing:.06em;text-transform:uppercase;
padding:.2rem .55rem;border-radius:999px;background:var(--info-bg);color:var(--info);white-space:nowrap}
.badge.table{background:var(--rose);color:var(--plum-700)}
.badge.test{background:var(--danger-bg);color:var(--danger)}
.badge.away{background:var(--info);color:#fff}
.badge.urgent{background:var(--danger);color:#fff;animation:pulse 1.2s ease-in-out infinite}
.age{margin-left:auto;font-size:1.25rem;font-weight:800;font-variant-numeric:tabular-nums;color:var(--ok-strong)}
.age.warn{color:var(--warn)}
.age.late{color:var(--danger);animation:pulse 1.2s ease-in-out infinite}
.age.done{color:var(--ok);animation:none;font-size:1.05rem}
.heading{font-family:var(--serif);font-size:1.15rem;font-weight:600;letter-spacing:-.02em;line-height:1.2}
.sub{font-size:.85rem;color:var(--ink-500)}
ul.items{list-style:none;margin:.1rem 0;padding:0;display:flex;flex-direction:column;gap:.15rem}
ul.items li{font-size:1rem}
ul.items .q{font-weight:800;color:var(--plum-600)}
.note{font-size:.88rem;color:var(--warn);background:var(--warn-bg);border:1px solid var(--warn-border);
border-radius:var(--radius-sm);padding:.4rem .55rem}
.pill{align-self:flex-start;font-size:.7rem;font-weight:700;text-transform:uppercase;letter-spacing:.05em;
padding:.22rem .6rem;border-radius:999px;background:var(--plum-50);color:var(--plum-700)}
.pill.preparing{background:var(--warn-bg);color:var(--warn)}
.pill.ready{background:var(--ok-bg);color:var(--ok)}
#clock{font-variant-numeric:tabular-nums;font-weight:600;font-size:.95rem;color:var(--ink-500)}
.empty{grid-column:1/-1;text-align:center;color:var(--ink-500);margin-top:16vh;font-family:var(--serif);font-size:1.3rem;font-style:italic}`;

export function ownerBoardPage(bootJson: string): string {
  return `<!doctype html><html lang="fr"><head>${opsHead(BASE, "Supervision")}<title>Supervision Revive</title>
<style>${OPS_TOKENS}${OPS_BASE}${APP_STYLE}</style></head><body>
<div id="offline">Hors ligne — reconnexion…</div>
<header><span id="dot" class="dot"></span><span class="logo">${OPS_LOGO_SVG}</span><h1>Supervision</h1><span id="clock"></span><span class="spacer"></span>
<span class="count" id="count"></span></header>
<section id="kpi" class="kpi-bar"></section>
<section id="devs" class="dev-bar"></section>
<main id="board"><p class="empty" id="empty">Chargement…</p></main>
<noscript>Activez JavaScript pour la supervision.</noscript>
<script>window.__BOOT__=${bootJson}</script>
<script src="${BASE}/app.js?b=${ASSET_VERSION}"></script>
</body></html>`;
}

// ── Manifest ─────────────────────────────────────────────────────────────────
export const OWNER_MANIFEST = JSON.stringify({
  name: "Supervision Revive",
  short_name: "Supervision",
  description: "Vue d'ensemble temps réel — Revive",
  start_url: `${BASE}/`,
  scope: `${BASE}/`,
  display: "standalone",
  orientation: "landscape",
  background_color: OPS_BG_COLOR,
  theme_color: OPS_THEME_COLOR,
  icons: [
    { src: `${BASE}/icon-192.png`, sizes: "192x192", type: "image/png", purpose: "any" },
    { src: `${BASE}/icon-512.png`, sizes: "512x512", type: "image/png", purpose: "any maskable" },
  ],
});

// ── Service worker (shell/assets only; never a mutation or the SSE stream) ────
export const OWNER_SW = `const CACHE='owner-${ASSET_VERSION}';
const SHELL=['${BASE}/app.js','${BASE}/manifest.webmanifest','${BASE}/icon-192.png','${BASE}/icon-512.png'];
self.addEventListener('install',e=>{e.waitUntil(caches.open(CACHE).then(c=>c.addAll(SHELL)).then(()=>self.skipWaiting()));});
// Prune only THIS app's old caches (shared origin during dev review).
self.addEventListener('activate',e=>{e.waitUntil(caches.keys().then(ks=>Promise.all(ks.filter(k=>k.startsWith('owner-')&&k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim()));});
self.addEventListener('fetch',e=>{
  const url=new URL(e.request.url);
  if(e.request.method==='GET' && SHELL.includes(url.pathname)){
    e.respondWith(fetch(e.request).then(r=>{const c=r.clone();caches.open(CACHE).then(cc=>cc.put(e.request,c));return r;}).catch(()=>caches.match(e.request)));
  }
});`;

// ── Client app (read-only; SSE cuisine channel + /stats poll) ────────────────
export const OWNER_APP_JS = String.raw`(function(){
  var BASE=${JSON.stringify(BASE)};
  var boot=window.__BOOT__||{cursor:0,tickets:[],stats:{},devices:[]};
  var cursor=boot.cursor||0;
  var model=new Map();
  (boot.tickets||[]).forEach(function(t){model.set(t.id,t);});
  var board=document.getElementById('board');
  var countEl=document.getElementById('count');
  var dot=document.getElementById('dot');
  var offline=document.getElementById('offline');
  var clockEl=document.getElementById('clock');
  var kpiEl=document.getElementById('kpi');
  var devEl=document.getElementById('devs');

  function el(tag,cls,txt){ var e=document.createElement(tag); if(cls)e.className=cls; if(txt!=null)e.textContent=txt; return e; }
  function fmtSecs(s){ s=Math.max(0,Math.floor(s)); var m=Math.floor(s/60), r=s%60; return (m<10?'0':'')+m+':'+(r<10?'0':'')+r; }
  function fmtElapsed(iso){ return fmtSecs((Date.now()-new Date(iso).getTime())/1000); }
  function betweenSecs(a,b){ return (new Date(b).getTime()-new Date(a).getTime())/1000; }
  function elapsedMins(iso){ return (Date.now()-new Date(iso).getTime())/60000; }
  function ageClass(iso){ var m=elapsedMins(iso); return m>=10?'age late':m>=5?'age warn':'age'; }
  function ago(iso){ if(!iso) return 'jamais'; var s=Math.floor((Date.now()-new Date(iso).getTime())/1000);
    if(s<60) return 'il y a '+s+' s'; if(s<3600) return 'il y a '+Math.floor(s/60)+' min';
    if(s<86400) return 'il y a '+Math.floor(s/3600)+' h'; return 'il y a '+Math.floor(s/86400)+' j'; }

  function card(t){
    var c=el('div','card src-'+(t.source==='TABLE'?'table':'delivery')+(t.status==='READY'?' ready':'')+(t.is_test?' test':'')+(t.urgent?' urgent':''));
    c.dataset.id=t.id;
    var top=el('div','top');
    if(t.urgent) top.appendChild(el('span','badge urgent','⚡ URGENT'));
    var b;
    if(t.source!=='TABLE') b=el('span','badge','🛵 Livraison');
    else if(t.takeaway) b=el('span','badge away','📦 À emporter');
    else b=el('span','badge table','🍽️ Sur place');
    top.appendChild(b);
    if(t.is_test) top.appendChild(el('span','badge test','Test'));
    var a;
    if(t.status==='READY' && t.ready_at){ a=el('span','age done','✓ '+fmtSecs(betweenSecs(t.created_at,t.ready_at))); }
    else { a=el('span',ageClass(t.created_at),fmtElapsed(t.created_at)); a.dataset.age=t.created_at; }
    top.appendChild(a);
    c.appendChild(top);
    c.appendChild(el('div','heading',t.heading||'—'));
    if(t.subheading) c.appendChild(el('div','sub',t.subheading));
    var ul=el('ul','items');
    (t.items||[]).forEach(function(l){ var li=el('li'); li.appendChild(el('span','q',l.qty+'× '));
      li.appendChild(document.createTextNode(l.name+(l.choice?' ('+l.choice+')':''))); ul.appendChild(li); });
    c.appendChild(ul);
    if(t.note) c.appendChild(el('div','note','📝 '+t.note));
    var stTxt=t.status==='READY'?'Prête':t.status==='PREPARING'?'En préparation':'Nouveau';
    c.appendChild(el('span','pill '+t.status.toLowerCase(), stTxt));
    return c;
  }

  function render(){
    var list=Array.from(model.values()).sort(function(x,y){
      var u=(y.urgent?1:0)-(x.urgent?1:0);
      return u || (new Date(x.created_at)-new Date(y.created_at));
    });
    board.textContent='';
    if(!list.length){ board.appendChild(el('p','empty','Aucune commande en cours')); }
    else list.forEach(function(t){ board.appendChild(card(t)); });
    countEl.textContent=list.length? list.length+(list.length>1?' commandes':' commande') : '';
  }

  function kpi(label,val){ var d=el('div','kpi'); d.appendChild(el('div','kv',val)); d.appendChild(el('div','kl',label)); return d; }
  function renderStats(s){ s=s||{}; kpiEl.textContent='';
    kpiEl.appendChild(kpi('Commandes du jour', String(s.totalToday!=null?s.totalToday:0)));
    kpiEl.appendChild(kpi('Prépa moyenne', s.avgPrepSecs!=null?Math.round(s.avgPrepSecs/60)+' min':'—'));
    kpiEl.appendChild(kpi('Urgences', String(s.urgentToday!=null?s.urgentToday:0)));
    kpiEl.appendChild(kpi('En cours', String(s.inProgress!=null?s.inProgress:0)));
  }
  function renderDevices(list){ devEl.textContent='';
    (list||[]).forEach(function(d){ if(d.revoked_at) return;
      var online=d.last_seen_at && (Date.now()-new Date(d.last_seen_at).getTime()<120000);
      var chip=el('div','dev'+(online?' on':'')); chip.appendChild(el('span','ddot'));
      chip.appendChild(document.createTextNode(d.label+' · '+ago(d.last_seen_at))); devEl.appendChild(chip);
    });
  }
  renderStats(boot.stats); renderDevices(boot.devices);

  function tickClock(){ if(!clockEl)return; var d=new Date();
    clockEl.textContent=(d.getHours()<10?'0':'')+d.getHours()+':'+(d.getMinutes()<10?'0':'')+d.getMinutes(); }
  setInterval(function(){ tickClock(); document.querySelectorAll('[data-age]').forEach(function(a){
    a.textContent=fmtElapsed(a.dataset.age); a.className=ageClass(a.dataset.age); }); },1000);
  tickClock();

  // Anti false "offline": the SSE stream blips + auto-reconnects (~3s); only warn
  // after a real few-second outage, clear it instantly on reconnect.
  var downTimer=null;
  function setOnline(on){
    if(on){ if(downTimer){clearTimeout(downTimer);downTimer=null;} dot.classList.add('on'); offline.classList.remove('show'); }
    else if(!downTimer){ downTimer=setTimeout(function(){ downTimer=null; dot.classList.remove('on'); offline.classList.add('show'); },5000); }
  }

  function refreshState(){
    fetch(BASE+'/state',{headers:{'X-Requested-With':'fetch'}}).then(function(r){return r.ok?r.json():null;}).then(function(d){
      if(!d)return; model=new Map(); (d.tickets||[]).forEach(function(t){model.set(t.id,t);});
      if(d.stats)renderStats(d.stats); if(d.devices)renderDevices(d.devices); render();
    }).catch(function(){});
  }
  function pollStats(){
    fetch(BASE+'/stats',{headers:{'X-Requested-With':'fetch'}}).then(function(r){return r.ok?r.json():null;}).then(function(d){
      if(!d)return; if(d.stats)renderStats(d.stats); if(d.devices)renderDevices(d.devices);
    }).catch(function(){});
  }
  setInterval(pollStats,60000);

  render(); refreshState();

  var es=new EventSource(BASE+'/events?since='+cursor);
  es.onopen=function(){setOnline(true);};
  es.onerror=function(){setOnline(false);};
  function bump(e){ if(e.lastEventId)cursor=+e.lastEventId; }
  es.addEventListener('ticket_new',function(e){ var t=JSON.parse(e.data); model.set(t.id,t); bump(e); render(); });
  es.addEventListener('ticket_update',function(e){ var t=JSON.parse(e.data); model.set(t.id,t); bump(e); render(); });
  es.addEventListener('ticket_removed',function(e){ var d=JSON.parse(e.data); model.delete(d.id); bump(e); render(); });

  // Keep the supervision screen awake while open; re-acquire on visibility return.
  var wakeLock=null;
  function keepAwake(){ if(!('wakeLock' in navigator)||document.visibilityState!=='visible') return;
    navigator.wakeLock.request('screen').then(function(w){ wakeLock=w; }).catch(function(){}); }
  document.addEventListener('visibilitychange',function(){ if(document.visibilityState==='visible') keepAwake(); });
  keepAwake();

  if('serviceWorker' in navigator){ navigator.serviceWorker.register(BASE+'/sw.js').catch(function(){}); }
})();`;
