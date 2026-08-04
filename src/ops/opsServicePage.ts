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
 *
 * Look & feel comes from the shared Revive light theme (opsTheme.ts).
 */

const BASE = "/ops/service";
// Bumped whenever app.js/sw change — used as the SW cache name AND an app.js
// query string, so a fresh build can't be served stale from any cache.
const ASSET_VERSION = "v15";

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

// ── Pairing screen ───────────────────────────────────────────────────────────

export function servicePairingPage(error?: string): string {
  return `<!doctype html><html lang="fr"><head>${opsHead(BASE, "Salle")}<title>Appairer — Salle Revive</title>
<style>${OPS_TOKENS}${OPS_BASE}${OPS_PAIR_STYLE}</style></head><body><main>
<span class="logo">${OPS_LOGO_SVG}</span>
<h1>Salle Revive</h1>
<p>Entrez le code d'appairage affiché dans l'administration (Réglages → Appareils).</p>
<form method="post" action="${BASE}/pair" autocomplete="off">
<input name="code" inputmode="latin" autocapitalize="characters" maxlength="12" placeholder="CODE" required autofocus>
<button type="submit">Appairer ce téléphone</button>
${error ? `<p class="err">${esc(error)}</p>` : ""}
</form></main></body></html>`;
}

// ── Board (paired device) ────────────────────────────────────────────────────
const APP_STYLE = `body{padding-bottom:env(safe-area-inset-bottom)}
main{padding:.9rem;display:grid;gap:.9rem;grid-template-columns:repeat(auto-fill,minmax(15rem,1fr));align-content:start}
/* Spot tile */
.spot{background:var(--surface-raised);border:1px solid var(--border-soft);border-radius:var(--radius-lg);
padding:1rem;display:flex;flex-direction:column;gap:.55rem;min-height:8rem;box-shadow:var(--shadow-1);
transition:transform .15s var(--ease),background-color .2s,border-color .2s,box-shadow .2s}
.spot.free{background:var(--cream-25);border:1.5px dashed var(--border-strong);box-shadow:none;cursor:pointer;
width:100%;text-align:left;color:inherit;font:inherit;appearance:none;-webkit-appearance:none}
.spot.free:active{transform:scale(.98);background:var(--plum-50)}
.spot.occupied{border-left:6px solid var(--plum-600)}
.spot.ready{background:var(--ok-bg);border-color:var(--ok-border);box-shadow:0 0 0 1px var(--ok-border)}
.spot.flash{animation:arrive 1.2s var(--ease)}
.sh{display:flex;align-items:baseline;gap:.5rem}
.sh .nm{font-family:var(--serif);font-size:1.3rem;font-weight:600;letter-spacing:-.02em}
.cap{font-size:.8rem;color:var(--ink-500);margin-left:auto}
.who{font-size:.92rem;color:var(--plum-600);font-weight:600}
.freehint{margin-top:auto;font-size:.95rem;color:var(--ok-strong);font-weight:600}
.tk{padding:.6rem .7rem;border:1px solid var(--border-soft);border-radius:var(--radius);background:var(--surface)}
.tk .line{display:flex;align-items:center;gap:.4rem}
.tk .q{font-weight:800;color:var(--plum-600)}
.tk .st{margin-left:auto;font-size:.68rem;font-weight:700;text-transform:uppercase;letter-spacing:.05em;
padding:.2rem .55rem;border-radius:999px}
.st.new{background:var(--plum-50);color:var(--plum-700)}
.st.preparing{background:var(--warn-bg);color:var(--warn)}
.st.ready{background:var(--ok-bg);color:var(--ok)}
.st.ready.just-ready{animation:pop .2s var(--ease)}
.tk .tnote{font-size:.82rem;color:var(--warn);margin-top:.25rem}
.tk .away{display:inline-block;font-size:.75rem;font-weight:800;color:#fff;background:var(--info);
border-radius:999px;padding:.15rem .5rem;margin-top:.3rem;letter-spacing:.02em}
.tk.urgent{border-color:var(--danger);box-shadow:0 0 0 2px var(--danger-bg)}
.tk .urg{display:inline-block;font-size:.75rem;font-weight:800;color:#fff;background:var(--danger);
border-radius:999px;padding:.15rem .5rem;margin-top:.3rem;letter-spacing:.02em}
button.act.urg{flex:1;background:var(--warn-bg);color:var(--warn);border:1px solid var(--warn-border)}
button.act.urg.on{background:var(--danger);color:#fff;border-color:var(--danger)}
.tk .taken{font-size:.8rem;color:var(--info);margin-top:.25rem}
.tacts{display:flex;gap:.45rem;margin-top:.5rem}
button.act{flex:1;min-height:2.75rem;padding:.75rem;font-size:.98rem;font-weight:800;border:none;border-radius:var(--radius);color:#fff}
button.take{background:var(--info)}
button.serve{background:var(--ok-strong)}
button.cancel{background:none;border:1px solid var(--danger-border);color:var(--danger);flex:0 0 auto;min-width:2.75rem;padding:.75rem .85rem}
.sacts{display:flex;gap:.45rem;margin-top:auto;padding-top:.4rem}
button.sec{flex:1;padding:.75rem;font-size:.95rem;font-weight:700;border-radius:var(--radius);
border:1px solid var(--border-strong);background:var(--surface-raised);color:var(--ink-700)}
button.add{background:var(--plum-600);border-color:var(--plum-600);color:#fff}
.empty{grid-column:1/-1;text-align:center;color:var(--ink-500);margin-top:18vh;font-family:var(--serif);font-size:1.2rem;font-style:italic}
.empty button{font-family:var(--sans);font-style:normal}
#bell{background:var(--warn-bg);color:var(--warn);border:1px solid var(--warn-border);border-radius:999px;
min-height:2.75rem;padding:.45rem .9rem;font-size:.85rem;font-weight:700}
#bell[hidden]{display:none}
#hist{background:var(--rose);color:var(--plum-700);border:1px solid var(--plum-200);border-radius:999px;
min-height:2.75rem;padding:.45rem .8rem;font-size:1rem;font-weight:700}
.sndbtn{background:var(--rose);color:var(--plum-700);border:1px solid var(--plum-200);border-radius:999px;
min-height:2.75rem;padding:.45rem .8rem;font-size:1rem;font-weight:700}
.sndbtn.off{background:var(--cream-100);color:var(--ink-500);border-color:var(--border)}
/* Occupied-tile indicative subtotal (a service aid; the POS is the ledger). */
.subtot{display:flex;align-items:baseline;gap:.5rem;margin-top:.5rem;padding-top:.5rem;border-top:1px solid var(--border-soft)}
.subtot .sl{font-size:.8rem;color:var(--ink-500)}
.subtot .sv{margin-left:auto;font-weight:800;font-size:1.02rem;color:var(--plum-700)}
.chip.fav{background:var(--warn-bg);border-color:transparent;color:var(--warn)}
.chip.fav.sel{background:var(--warn);border-color:var(--warn);color:#fff}
/* Recent-history rows (read-only): today's closed tables + indicative subtotal. */
.hempty{text-align:center;color:var(--ink-500);font-style:italic;font-family:var(--serif);padding:2rem 0}
.hsess{border:1px solid var(--border-soft);border-radius:var(--radius);padding:.6rem .75rem;background:var(--surface-raised)}
.hsh{display:flex;align-items:baseline;gap:.5rem;margin-bottom:.35rem}
.hsh .hnm{font-family:var(--serif);font-size:1.1rem;font-weight:600}
.hsh .hwho{font-size:.85rem;color:var(--plum-600)}
.hsh .htime{margin-left:auto;font-size:.82rem;color:var(--ink-500)}
.hline{font-size:.95rem;color:var(--ink-700);padding:.1rem 0}
.hline.cx{color:var(--danger);text-decoration:line-through}
.htot{display:flex;align-items:baseline;gap:.5rem;margin-top:.4rem;padding-top:.4rem;border-top:1px solid var(--border-soft);font-size:.82rem;color:var(--ink-500)}
.htot .htotv{margin-left:auto;font-weight:800;font-size:1rem;color:var(--plum-700)}
/* Overlay (order composer) */
.ov{position:fixed;inset:0;z-index:20;background:rgba(33,25,33,.45);display:flex;align-items:flex-end;justify-content:center;
animation:ov-in .2s var(--ease)}
@keyframes ov-in{0%{opacity:0}100%{opacity:1}}
/* Confirm dialog — the verb lives ON each button. The native confirm() showed
   OK/Annuler, ambiguous when the question itself is « Annuler ? ». */
.ov.center{align-items:center;padding:1rem}
.cfm{background:var(--surface);border-radius:var(--radius-xl);box-shadow:var(--shadow-2);padding:1.2rem;
width:100%;max-width:22rem;animation:sheet-up .25s var(--ease)}
.cfm p{font-size:1.05rem;font-weight:600;margin:.1rem 0 1rem;color:var(--ink-900)}
.cfm .cfmacts{display:flex;flex-direction:column;gap:.55rem}
.cfm button{min-height:3rem;border-radius:var(--radius);border:1px solid var(--border-strong);
background:#fff;color:var(--ink-700);font-weight:700;font-size:1rem}
.cfm button.danger{background:var(--danger);border-color:var(--danger);color:#fff}
/* Stable height + internal scroll: switching categories changes only the inner
   list, never the sheet box, so the sheet never jumps as list size varies. */
.sheet{position:relative;display:flex;flex-direction:column;background:var(--surface);width:100%;max-width:34rem;
height:90vh;height:90dvh;overflow:hidden;overscroll-behavior:contain;
border-radius:var(--radius-xl) var(--radius-xl) 0 0;box-shadow:var(--shadow-2);
padding:1rem;padding-bottom:calc(1rem + env(safe-area-inset-bottom));animation:sheet-up .3s var(--ease)}
.list{flex:1 1 auto;min-height:0;overflow-y:auto;-webkit-overflow-scrolling:touch;overscroll-behavior:contain}
@keyframes sheet-up{0%{transform:translateY(24px);opacity:.5}100%{transform:none;opacity:1}}
.sheet::before{content:"";display:block;width:2.6rem;height:.3rem;border-radius:99px;background:var(--border-strong);margin:0 auto .7rem}
.sheet h2{font-family:var(--serif);font-size:1.3rem;font-weight:600;letter-spacing:-.02em;margin:.1rem 0 .8rem}
.modeseg{display:flex;gap:.45rem;margin:0 0 .7rem}
.modeseg .mode{flex:1;min-height:2.75rem;padding:.7rem;border-radius:var(--radius);border:1px solid var(--border);
background:var(--surface-raised);color:var(--ink-700);font-weight:700;font-size:.95rem}
.modeseg .mode.sel{background:var(--plum-600);border-color:var(--plum-600);color:#fff}
.modeseg .mode.away.sel{background:var(--info);border-color:var(--info);color:#fff}
.sheet input,.sheet textarea{width:100%;padding:.8rem;border-radius:var(--radius);border:1px solid var(--border);
background:#fff;color:var(--ink-900);font-size:1rem;font-family:inherit}
.sheet textarea{min-height:3rem;margin-top:.6rem}
/* sticky search + category chips */
.toolbar{position:sticky;top:0;z-index:3;background:var(--surface);padding:.2rem 0 .5rem}
.search{margin-bottom:.5rem}
.chips{display:flex;gap:.4rem;overflow-x:auto;-webkit-overflow-scrolling:touch;padding-bottom:.2rem;scrollbar-width:none}
.chips::-webkit-scrollbar{display:none}
.chip{flex:0 0 auto;padding:.55rem .95rem;border-radius:999px;background:var(--rose);border:1px solid transparent;
color:var(--plum-600);font-size:.88rem;font-weight:600;white-space:nowrap}
.chip.sel{background:var(--plum-600);border-color:var(--plum-600);color:#fff}
.chip.cart{background:var(--ok-bg);border-color:var(--ok-border);color:var(--ok-strong)}
.chip.cart.sel{background:var(--ok-strong);border-color:var(--ok-strong);color:#fff}
.cat{font-family:var(--serif);font-size:.95rem;font-weight:600;letter-spacing:.14em;text-transform:uppercase;
color:var(--plum-600);border-bottom:1px solid var(--rose);padding-bottom:.35rem;margin:.9rem 0 .3rem}
.mi{display:flex;align-items:center;gap:.6rem;padding:.6rem 0;border-bottom:1px solid var(--border-soft);flex-wrap:wrap}
.mi.on{background:var(--plum-50);border-radius:var(--radius);padding:.6rem;margin:.2rem 0;border-bottom:0}
.mi .nm{flex:1;min-width:8rem;font-size:1.02rem}
.mi .nm .pr{display:block;color:var(--ink-500);font-size:.82rem;font-weight:500}
.mi .qbadge{background:var(--ok-strong);color:#fff;border-radius:999px;font-size:.8rem;font-weight:800;
padding:.12rem .5rem;margin-left:.4rem;animation:pop .18s var(--ease)}
.stepper{display:flex;align-items:center;gap:.55rem}
.stepper button{width:2.75rem;height:2.75rem;border-radius:50%;border:1px solid var(--border-strong);
background:#fff;color:var(--ink-900);font-size:1.35rem;font-weight:700;line-height:1}
.stepper button.plus{background:var(--plum-600);border-color:var(--plum-600);color:#fff}
.stepper button:active{transform:scale(.88)}
.stepper .qv{min-width:1.3rem;text-align:center;font-weight:800;font-size:1.1rem}
.creq{margin-top:.5rem;border:1px solid var(--border-soft);border-radius:var(--radius);padding:.55rem .65rem;background:var(--surface-raised)}
.creq.missing{border-color:var(--warn-border);background:var(--warn-bg)}
.clab{font-size:.75rem;font-weight:700;color:var(--ink-500);margin-bottom:.4rem;text-transform:uppercase;letter-spacing:.05em}
.creq.missing .clab{color:var(--warn)}
.cpills{display:flex;gap:.45rem;flex-wrap:wrap}
.cpill{padding:.55rem .9rem;border-radius:999px;border:1px solid var(--border-strong);background:#fff;color:var(--ink-700);font-weight:600;font-size:.95rem}
.cpill.sel{background:var(--ok-strong);border-color:var(--ok-strong);color:#fff}
.mi.needchoice{outline:2px solid var(--warn-border);outline-offset:2px;border-radius:var(--radius)}
.mi .ln{margin-top:.5rem;font-size:.92rem;padding:.55rem}
.mi .lnlab{font-size:.75rem;color:var(--ink-500);margin-top:.5rem}
.wrap{width:100%}
.nores{color:var(--ink-500);text-align:center;padding:2rem 0}
.foot{position:sticky;bottom:0;background:var(--surface);padding:.6rem 0 .2rem;display:flex;gap:.6rem;align-items:center;
border-top:1px solid var(--border-soft)}
.total{font-weight:800;font-size:1.05rem;white-space:nowrap}
.total small{color:var(--ink-500);font-weight:500}
.foot button.go{flex:1;padding:.95rem;border:none;border-radius:12px;background:var(--ok-strong);color:#fff;
font-weight:800;font-size:1.02rem;box-shadow:var(--shadow-1)}
.foot button.go:disabled{opacity:.45}
.close-x{position:absolute;top:.55rem;right:.6rem;background:none;border:none;color:var(--ink-500);font-size:1.7rem;line-height:1;z-index:4;min-width:2.75rem;min-height:2.75rem}
.msg{color:var(--danger);font-size:.9rem;margin:.4rem 0}`;

export function serviceBoardPage(bootJson: string): string {
  return `<!doctype html><html lang="fr"><head>${opsHead(BASE, "Salle")}<title>Salle Revive</title>
<style>${OPS_TOKENS}${OPS_BASE}${APP_STYLE}</style></head><body>
<div id="offline">Hors ligne — reconnexion…</div>
<header><span id="dot" class="dot"></span><span class="logo">${OPS_LOGO_SVG}</span><h1>Salle</h1><span class="spacer"></span><button id="hist" aria-label="Tables récentes">🕐</button><button id="snd" class="sndbtn" aria-label="Activer/couper le son">🔊</button><button id="bell" hidden>🔔 Alertes</button><span class="count" id="count"></span></header>
<main id="board"><p class="empty" id="empty">Chargement…</p></main>
<noscript>Activez JavaScript pour la prise de commande en salle.</noscript>
<script>window.__BOOT__=${bootJson}</script>
<script src="${BASE}/app.js?b=${ASSET_VERSION}"></script>
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
  background_color: OPS_BG_COLOR,
  theme_color: OPS_THEME_COLOR,
  icons: [
    { src: `${BASE}/icon-192.png`, sizes: "192x192", type: "image/png", purpose: "any" },
    { src: `${BASE}/icon-512.png`, sizes: "512x512", type: "image/png", purpose: "any maskable" },
  ],
});

// ── Service worker (shell/assets only) ───────────────────────────────────────
export const SERVICE_SW = `const CACHE='service-${ASSET_VERSION}';
const SHELL=['${BASE}/app.js','${BASE}/manifest.webmanifest','${BASE}/icon-192.png','${BASE}/icon-512.png'];
self.addEventListener('install',e=>{e.waitUntil(caches.open(CACHE).then(c=>c.addAll(SHELL)).then(()=>self.skipWaiting()));});
// Prune only THIS app's old caches — salle and cuisine share the localhost origin
// during dev review, so an unscoped sweep would delete the other app's cache.
self.addEventListener('activate',e=>{e.waitUntil(caches.keys().then(ks=>Promise.all(ks.filter(k=>k.startsWith('service-')&&k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim()));});
self.addEventListener('fetch',e=>{
  const url=new URL(e.request.url);
  if(e.request.method==='GET' && SHELL.includes(url.pathname)){
    e.respondWith(fetch(e.request).then(r=>{const c=r.clone();caches.open(CACHE).then(cc=>cc.put(e.request,c));return r;}).catch(()=>caches.match(e.request)));
  }
});
// Web Push: show the "commande prête" alert on the lock screen.
self.addEventListener('push',e=>{
  let d={}; try{ d=e.data?e.data.json():{}; }catch(_){}
  const title=d.title||'Revive';
  e.waitUntil(self.registration.showNotification(title,{
    body:d.body||'', tag:d.tag, renotify:true, requireInteraction:true,
    icon:'${BASE}/icon-192.png', badge:'${BASE}/icon-192.png',
    data:{url:d.url||'${BASE}/'}
  }));
});
self.addEventListener('notificationclick',e=>{
  e.notification.close();
  const url=(e.notification.data&&e.notification.data.url)||'${BASE}/';
  e.waitUntil(self.clients.matchAll({type:'window',includeUncontrolled:true}).then(cl=>{
    for(const c of cl){ if(c.url.indexOf('${BASE}')>=0 && 'focus' in c) return c.focus(); }
    if(self.clients.openWindow) return self.clients.openWindow(url);
  }));
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
  var bell=document.getElementById('bell');
  var VAPID=boot.vapidKey||'';

  function el(tag,cls,txt){ var e=document.createElement(tag); if(cls)e.className=cls; if(txt!=null)e.textContent=txt; return e; }
  function uuid(){ try{ return crypto.randomUUID(); }catch(e){ return 'r-'+Date.now()+'-'+Math.round(Math.random()*1e9); } }
  function findItem(id){ for(var i=0;i<MENU.length;i++){ for(var j=0;j<MENU[i].items.length;j++){ if(MENU[i].items[j].id===id) return MENU[i].items[j]; } } return null; }
  function sessionForSpot(spotId){ var found=null; sessions.forEach(function(s){ if(s.spot_id===spotId) found=s; }); return found; }
  function ticketsOf(sid){ var out=[]; tickets.forEach(function(t){ if(t.session_id===sid) out.push(t); }); return out.sort(function(a,b){return new Date(a.created_at)-new Date(b.created_at);}); }
  function capLabel(sp){ if(sp.capacity==null) return ''; return sp.capacity_max? sp.capacity+'–'+sp.capacity_max+' pers.' : sp.capacity+' pers.'; }

  // ---- sound & voice (unlocked on first gesture; iOS requirement) ----
  // Servers aren't glued to the iPad, so the board speaks new commandes (Web
  // Speech API, OS voices, no network). Header 🔊/🔇 toggle (persisted) mutes both.
  var sndBtn=document.getElementById('snd');
  var muted=false; try{ muted=localStorage.getItem('service.sound')==='off'; }catch(e){}
  function paintSnd(){ if(sndBtn){ sndBtn.textContent=muted?'🔇':'🔊'; sndBtn.classList.toggle('off',muted); } }
  paintSnd();
  // Voices load asynchronously — grab them now and whenever the browser fires
  // voiceschanged, so the first real announcement isn't spoken into the void.
  var voices=[];
  function loadVoices(){ if(!window.speechSynthesis) return; try{ voices=speechSynthesis.getVoices()||[]; }catch(e){} }
  if(window.speechSynthesis){ loadVoices(); try{ speechSynthesis.onvoiceschanged=loadVoices; }catch(e){} }
  function frVoice(){ for(var i=0;i<voices.length;i++){ if(((voices[i].lang||'').toLowerCase()).indexOf('fr')===0) return voices[i]; } return null; }
  var actx=null;
  function unlock(){ if(!actx){ try{ actx=new (window.AudioContext||window.webkitAudioContext)(); }catch(e){} } if(actx&&actx.state==='suspended'){ actx.resume(); }
    // Warm speech on the gesture: resume any paused queue + ensure voices are loaded.
    if(window.speechSynthesis){ try{ speechSynthesis.resume(); loadVoices(); }catch(e){} } }
  document.addEventListener('touchstart',unlock);
  document.addEventListener('click',unlock);
  // Toggling the sound ON speaks a confirmation — a direct user gesture is the most
  // reliable way to prove TTS works (and it primes it for the SSE-driven alerts).
  if(sndBtn) sndBtn.onclick=function(){ muted=!muted; try{ localStorage.setItem('service.sound',muted?'off':'on'); }catch(e){} paintSnd();
    if(muted){ try{ speechSynthesis.cancel(); }catch(e){} } else { unlock(); speak('Son activé'); } };
  function beep(){ if(muted||!actx) return; try{ var o=actx.createOscillator(),g=actx.createGain();
    o.type='sine';o.frequency.value=760;g.gain.value=.001;o.connect(g);g.connect(actx.destination);
    var t=actx.currentTime;g.gain.exponentialRampToValueAtTime(.25,t+.02);g.gain.exponentialRampToValueAtTime(.001,t+.5);o.start(t);o.stop(t+.5);}catch(e){} }
  function speak(text){ if(muted||!text||!window.speechSynthesis) return; try{
    speechSynthesis.resume();                        // Chrome pauses the queue at times
    var u=new SpeechSynthesisUtterance(text); u.lang='fr-FR'; var v=frVoice(); if(v) u.voice=v;
    speechSynthesis.speak(u); }catch(e){} }
  // Voice text mirrors the cuisine board: spot name first, then every line with
  // qty, multi-option selections and per-line notes — nothing shown is unsaid.
  function linePicked(l){ return Array.isArray(l.selections)&&l.selections.length>1
    ? l.selections.map(function(s){return s.label+' : '+s.value;}).join(' · ')
    : (l.choice||''); }
  function itemsSpeech(t){ return (t.items||[]).map(function(l){ var p=linePicked(l);
    return l.qty+' '+l.name+(p?', '+p:'')+(l.note?', '+l.note:''); }).join('. '); }
  // Say the spot the servers know (Canapé/Terrasse/Pergola), not the ticket code.
  function spotSpeech(t){ var s=t.session_id&&sessions.get(t.session_id);
    if(s){ for(var i=0;i<SPOTS.length;i++){ if(SPOTS[i].id===s.spot_id) return SPOTS[i].label; } }
    return t.subheading||t.heading||''; }
  function newSpeech(t){ var w=spotSpeech(t); var it=itemsSpeech(t);
    return 'Nouvelle commande'+(t.takeaway?' à emporter':'')+(w?', '+w:'')+(it?'. '+it:''); }

  function post(path,body){ return fetch(BASE+path,{method:'POST',headers:{'Content-Type':'application/json','X-Requested-With':'fetch'},body:JSON.stringify(body||{})}); }

  function ticketCard(t){
    var d=el('div','tk'+(t.urgent?' urgent':'')); d.dataset.id=t.id;
    (t.items||[]).forEach(function(l,i){ var ln=el('div','line');
      ln.appendChild(el('span','q',l.qty+'×'));
      ln.appendChild(document.createTextNode(' '+l.name+(l.choice?' ('+l.choice+')':'')));
      if(i===0){ var st=el('span','st '+t.status.toLowerCase(), t.status==='READY'?'Prête':t.status==='PREPARING'?'En prépa':'Envoyée'); ln.appendChild(st); }
      d.appendChild(ln);
      if(l.note) d.appendChild(el('div','tnote','• '+l.note));
    });
    if(t.note) d.appendChild(el('div','tnote','📝 '+t.note));
    if(t.takeaway) d.appendChild(el('div','away','📦 À emporter'));
    if(t.urgent) d.appendChild(el('div','urg','⚡ Urgent'));
    if(t.serve_by) d.appendChild(el('div','taken','🙋 Pris par '+t.serve_by));
    if(t.status==='READY'){
      var acts=el('div','tacts');
      if(!t.serve_by){ var tk=el('button','act take','Je prends'); tk.onclick=function(){ tk.disabled=true; post('/tickets/'+t.id+'/take',{}).then(function(r){if(!r.ok)tk.disabled=false;}).catch(function(){tk.disabled=false;}); }; acts.appendChild(tk); }
      var sv=el('button','act serve','Servie'); sv.onclick=function(){ sv.disabled=true; post('/tickets/'+t.id+'/served',{}).then(function(r){if(!r.ok)sv.disabled=false;}).catch(function(){sv.disabled=false;}); }; acts.appendChild(sv);
      d.appendChild(acts);
    } else {
      var acts2=el('div','tacts');
      // Escalate an impatient client's order — bubbles to the top of the kitchen
      // screen and is announced there. Toggles on/off.
      var ug=el('button','act urg'+(t.urgent?' on':''), t.urgent?'⚡ Urgent ✓':'⚡ Urgent');
      ug.setAttribute('aria-pressed', t.urgent?'true':'false');
      ug.onclick=function(){ ug.disabled=true; post('/tickets/'+t.id+'/urgent',{urgent:!t.urgent}).then(function(r){if(!r.ok)ug.disabled=false;}).catch(function(){ug.disabled=false;}); };
      acts2.appendChild(ug);
      var cx=el('button','act cancel','✕'); cx.title='Annuler cette commande'; cx.setAttribute('aria-label','Annuler cette commande');
      cx.onclick=function(){ askConfirm('Annuler cette commande ?','Oui, annuler la commande','Non, garder la commande',function(){ cx.disabled=true; post('/tickets/'+t.id+'/cancel',{reason:'annulée en salle'}).then(function(r){if(!r.ok)cx.disabled=false;}).catch(function(){cx.disabled=false;}); }); };
      acts2.appendChild(cx); d.appendChild(acts2);
    }
    return d;
  }

  function spotTile(sp){
    var s=sessionForSpot(sp.id);
    var tks=s? ticketsOf(s.id) : [];
    var anyReady=tks.some(function(t){return t.status==='READY';});
    if(!s){
      // Free spot = a real <button>: proper press/focus semantics + VoiceOver.
      var f=el('button','spot free'); f.type='button'; f.dataset.spot=sp.id;
      f.setAttribute('aria-label','Prendre une commande — '+sp.label);
      var fh=el('div','sh'); fh.appendChild(el('span','nm',sp.label)); var fcap=capLabel(sp); if(fcap)fh.appendChild(el('span','cap',fcap)); f.appendChild(fh);
      f.appendChild(el('div','freehint','Toucher pour prendre la commande'));
      f.onclick=function(){ openOrder(sp,null,f); };
      return f;
    }
    var c=el('div','spot occupied'+(anyReady?' ready':'')); c.dataset.spot=sp.id; c.dataset.session=s.id;
    var h=el('div','sh'); h.appendChild(el('span','nm',sp.label)); var cap=capLabel(sp); if(cap)h.appendChild(el('span','cap',cap)); c.appendChild(h);
    if(s.first_name) c.appendChild(el('div','who','👤 '+s.first_name));
    tks.forEach(function(t){ c.appendChild(ticketCard(t)); });
    // Indicative running subtotal (served tickets included) — answers "combien
    // je dois ?" during service. The POS remains the ledger. Hidden at 0.
    if(s.total_xof>0){ var st=el('div','subtot');
      st.appendChild(el('span','sl','Sous-total — indicatif'));
      st.appendChild(el('span','sv',s.total_xof+' F')); c.appendChild(st); }
    var sa=el('div','sacts');
    var add=el('button','sec add','＋ Ajouter une commande'); add.onclick=function(){ openOrder(sp,s,add); }; sa.appendChild(add);
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

  // ---- order composer ----
  function overlay(){ return el('div','ov'); }

  // The native confirm dialog renders OK/Annuler — ambiguous when the question IS
  // « Annuler ? ». Here each button carries its verb; escape routes (backdrop
  // tap, initial focus) all mean « garder », the safe default.
  function askConfirm(question,yesLabel,noLabel,onYes){
    var ov=el('div','ov center'); var box=el('div','cfm');
    box.setAttribute('role','alertdialog'); box.setAttribute('aria-modal','true'); box.setAttribute('aria-label',question);
    box.appendChild(el('p',null,question));
    var acts=el('div','cfmacts');
    var yes=el('button','danger',yesLabel);
    var no=el('button',null,noLabel);
    function close(){ if(ov.parentNode) document.body.removeChild(ov); }
    yes.onclick=function(){ close(); onYes(); };
    no.onclick=close;
    ov.onclick=function(e){ if(e.target===ov) close(); };
    acts.appendChild(yes); acts.appendChild(no); box.appendChild(acts); ov.appendChild(box);
    document.body.appendChild(ov); try{ no.focus(); }catch(e){}
  }

  function normalize(s){ return String(s||'').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g,''); }

  function openOrder(sp,session,trigger){
    unlock();
    var ov=overlay(); var sh=el('div','sheet');
    sh.setAttribute('role','dialog'); sh.setAttribute('aria-modal','true');
    sh.setAttribute('aria-label','Nouvelle commande — '+sp.label);
    // Lock the board behind the sheet (no scroll bleed) and return focus on close.
    var prevOverflow=document.body.style.overflow; document.body.style.overflow='hidden';
    function returnFocus(){ var t=trigger;
      if(!t||!t.isConnected){ var host=board.querySelector('[data-spot="'+sp.id+'"]');
        t=host&&host.tagName==='BUTTON'?host:(host?host.querySelector('button'):null); }
      if(t&&t.focus){ try{ t.focus(); }catch(e){} } }
    function closeSheet(){ if(ov.parentNode) document.body.removeChild(ov); document.body.style.overflow=prevOverflow; returnFocus(); }
    function requestClose(){ if(cartCount()>0){ askConfirm('Abandonner cette commande ?','Oui, abandonner','Non, continuer la saisie',closeSheet); return; } closeSheet(); }
    ov.onclick=function(e){ if(e.target===ov) requestClose(); };
    var x=el('button','close-x','×'); x.setAttribute('aria-label','Fermer la commande'); x.onclick=requestClose; sh.appendChild(x);
    sh.appendChild(el('h2','Commande — '+sp.label));
    var fn=null;
    if(!session){ fn=el('input'); fn.placeholder='Prénom (optionnel)'; fn.maxLength=40; fn.style.marginBottom='.6rem'; sh.appendChild(fn); }

    var draft={};       // id -> {qty, choice, note}
    var state={cat:'__ALL__', q:'', cartOnly:false, takeaway:false};
    var totalEl, cartChip, listEl;

    // Packaging mode for THIS order (default sur place). A mixed table = two sends
    // on the same spot; one ticket = one packaging mode keeps the kitchen unambiguous.
    var modeseg=el('div','modeseg');
    var mHere=el('button','mode sel'); mHere.type='button'; mHere.textContent='🍽️ Sur place';
    var mAway=el('button','mode away'); mAway.type='button'; mAway.textContent='📦 À emporter';
    mHere.setAttribute('aria-pressed','true'); mAway.setAttribute('aria-pressed','false');
    mHere.onclick=function(){ state.takeaway=false; mHere.classList.add('sel'); mAway.classList.remove('sel'); mHere.setAttribute('aria-pressed','true'); mAway.setAttribute('aria-pressed','false'); };
    mAway.onclick=function(){ state.takeaway=true; mAway.classList.add('sel'); mHere.classList.remove('sel'); mAway.setAttribute('aria-pressed','true'); mHere.setAttribute('aria-pressed','false'); };
    modeseg.appendChild(mHere); modeseg.appendChild(mAway); sh.appendChild(modeseg);

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
    // ⭐ Favoris — the studio "incontournables" (server-flagged), a shortcut to the
    // most-ordered items. Rendered only when at least one favourite exists.
    var anyFav=MENU.some(function(c){ return c.items.some(function(it){ return it.fav; }); });
    var chipFav=anyFav?el('button','chip fav','⭐ Favoris'):null;
    if(chipFav){ chipFav.onclick=function(){ setCat('__FAV__'); }; chips.appendChild(chipFav); }
    var catChips={};
    MENU.forEach(function(cat){ var ch=el('button','chip',cat.category); ch.onclick=(function(name){return function(){ setCat(name); };})(cat.category); catChips[cat.category]=ch; chips.appendChild(ch); });
    cartChip=el('button','chip cart','🛒 Panier'); cartChip.onclick=function(){ state.cartOnly=!state.cartOnly; if(state.cartOnly){state.q='';search.value='';} renderList(); };
    chips.appendChild(cartChip);
    toolbar.appendChild(chips);
    sh.appendChild(toolbar);

    listEl=el('div','list'); sh.appendChild(listEl);

    function itemRow(it){
      var d=draft[it.id]||{qty:0,choice:'',note:''};
      var needsChoice=it.choices && it.choices.length;
      var row=el('div','mi'+(d.qty>0?' on':'')); row.dataset.id=it.id;
      var nm=el('div','nm'); nm.appendChild(el('span',null,it.name));
      if(d.qty>0){ nm.appendChild(el('span','qbadge','×'+d.qty)); }
      nm.appendChild(el('span','pr',it.price+' F')); row.appendChild(nm);
      var stp=el('div','stepper');
      var minus=el('button',null,'−'); var qv=el('span','qv',String(d.qty)); var plus=el('button','plus','+');
      var extra=el('div','wrap'); extra.style.display=d.qty>0?'block':'none';
      var creq=null;
      function markChoice(){ if(!creq)return; var dd=draft[it.id]||{qty:0}; var miss=dd.qty>0 && !dd.choice; creq.classList.toggle('missing',miss); row.classList.toggle('needchoice',miss); }
      function sync(){ var dd=draft[it.id]||{qty:0}; qv.textContent=dd.qty;
        extra.style.display=dd.qty>0?'block':'none'; row.classList.toggle('on',dd.qty>0);
        var old=nm.querySelector('.qbadge'); if(old) nm.removeChild(old);
        if(dd.qty>0){ var b=el('span','qbadge','×'+dd.qty); nm.insertBefore(b,nm.querySelector('.pr')); }
        markChoice(); recompute();
      }
      minus.onclick=function(){ var dd=draft[it.id]||{qty:0,choice:'',note:''}; dd.qty=Math.max(0,dd.qty-1); draft[it.id]=dd; sync(); if(state.cartOnly&&dd.qty===0) renderList(); };
      plus.onclick=function(){ var dd=draft[it.id]||{qty:0,choice:'',note:''}; dd.qty=Math.min(10,dd.qty+1); draft[it.id]=dd; sync(); };
      stp.appendChild(minus); stp.appendChild(qv); stp.appendChild(plus); row.appendChild(stp);
      if(needsChoice){
        creq=el('div','creq'); creq.appendChild(el('div','clab',(it.optionLabel||'Choix')+' · obligatoire'));
        var pills=el('div','cpills');
        it.choices.forEach(function(ch){
          var p=el('button','cpill'+(d.choice===ch?' sel':''),ch);
          p.onclick=function(){ var dd=draft[it.id]||{qty:0,choice:'',note:''}; dd.choice=ch; draft[it.id]=dd;
            Array.from(pills.children).forEach(function(c){c.classList.remove('sel');}); p.classList.add('sel'); markChoice(); };
          pills.appendChild(p);
        });
        creq.appendChild(pills); extra.appendChild(creq);
      }
      extra.appendChild(el('div','lnlab','Note (optionnel)'));
      var ntn=el('input','ln'); ntn.placeholder='ex: sans sucre, bien chaud…'; ntn.maxLength=140; ntn.value=d.note||'';
      ntn.oninput=function(){ var dd=draft[it.id]||{qty:0}; dd.note=ntn.value; draft[it.id]=dd; }; extra.appendChild(ntn);
      row.appendChild(extra);
      markChoice();
      return row;
    }

    function renderList(){
      // sync chip highlight
      chipAll.classList.toggle('sel',state.cat==='__ALL__'&&!state.q&&!state.cartOnly);
      if(chipFav) chipFav.classList.toggle('sel',state.cat==='__FAV__'&&!state.q&&!state.cartOnly);
      Object.keys(catChips).forEach(function(k){ catChips[k].classList.toggle('sel',state.cat===k&&!state.q&&!state.cartOnly); });
      cartChip.classList.toggle('sel',state.cartOnly);
      listEl.textContent='';
      var q=normalize(state.q);
      var any=false;
      MENU.forEach(function(cat){
        var items=cat.items.filter(function(it){
          if(state.cartOnly) return (draft[it.id]&&draft[it.id].qty>0);
          if(q) return normalize(it.name).indexOf(q)>=0;
          if(state.cat==='__FAV__') return !!it.fav;
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
      // Client-side guard: every added item with a required option must have its
      // choice picked. Reveal the offender (cart view + scroll) with a clear message.
      var miss=null;
      Object.keys(draft).forEach(function(id){ var d=draft[id]; if(d.qty>0 && !miss){ var it=findItem(id); if(it&&it.choices&&it.choices.length&&!d.choice) miss=it; } });
      if(miss){
        msg.textContent='Choisissez « '+(miss.optionLabel||'option')+' » pour '+miss.name+'.'; msg.style.display='block';
        state.cartOnly=true; state.q=''; search.value=''; renderList();
        var r=listEl.querySelector('[data-id="'+miss.id+'"]'); if(r&&r.scrollIntoView) r.scrollIntoView({block:'center'});
        return;
      }
      var items=[]; Object.keys(draft).forEach(function(id){ var d=draft[id]; if(d.qty>0){ var e={item_id:id,qty:d.qty}; if(d.choice)e.choice=d.choice; if(d.note)e.note=d.note; items.push(e); } });
      if(!items.length){ msg.textContent='Ajoutez au moins un article.'; msg.style.display='block'; return; }
      go.disabled=true; msg.style.display='none';
      var body={items:items,note:gnote.value,client_request_id:uuid(),takeaway:state.takeaway}; if(fn&&fn.value) body.first_name=fn.value;
      post('/spots/'+sp.id+'/orders',body).then(function(r){return r.json().catch(function(){return{};});}).then(function(j){
        if(j&&j.ok){ closeSheet(); } else { go.disabled=false; msg.textContent=(j&&j.message)||'Commande refusée. Vérifiez les choix requis.'; msg.style.display='block'; }
      }).catch(function(){ go.disabled=false; msg.textContent='Erreur réseau.'; msg.style.display='block'; });
    };
    foot.appendChild(go); sh.appendChild(foot);
    ov.appendChild(sh); document.body.appendChild(ov);
    renderList(); recompute();
    // Land focus inside the dialog: prénom on a new session, else the search field.
    try{ (fn||search).focus(); }catch(e){}
  }

  // The SSE stream blips routinely (phone backgrounding, screen lock, network
  // switch) and EventSource auto-reconnects within ~3s. Only cry "hors ligne"
  // after the link has really been down a few seconds — and clear it instantly on
  // reconnect — so a routine reconnect never flashes a scary banner while online.
  var downTimer=null;
  function setOnline(on){
    if(on){ if(downTimer){clearTimeout(downTimer);downTimer=null;} dot.classList.add('on'); offline.classList.remove('show'); }
    else if(!downTimer){ downTimer=setTimeout(function(){ downTimer=null; dot.classList.remove('on'); offline.classList.add('show'); },5000); }
  }

  // Re-fetch the authoritative board state on load, so a stale cached page (an old
  // inline boot without spots) self-heals to the current spots/sessions/menu.
  function refreshState(){
    fetch(BASE+'/state',{headers:{'X-Requested-With':'fetch'}}).then(function(r){return r.ok?r.json():null;}).then(function(d){
      if(!d)return;
      SPOTS=(d.spots||[]).slice().sort(function(a,b){return (a.sort_order||0)-(b.sort_order||0);});
      if(d.menu&&d.menu.length) MENU=d.menu;
      if(d.vapidKey){ VAPID=d.vapidKey; }
      sessions=new Map(); (d.sessions||[]).forEach(function(s){sessions.set(s.id,s);});
      tickets=new Map(); (d.tickets||[]).forEach(function(t){ if(t.source==='TABLE') tickets.set(t.id,t); });
      render(); initPush();
    }).catch(function(){});
  }

  // ---- Web Push (lock-screen "commande prête") ----
  function urlB64(b64){ var pad='='.repeat((4-b64.length%4)%4); var s=(b64+pad).replace(/-/g,'+').replace(/_/g,'/');
    var raw=atob(s); var a=new Uint8Array(raw.length); for(var i=0;i<raw.length;i++)a[i]=raw.charCodeAt(i); return a; }
  function pushSupported(){ return VAPID && ('serviceWorker' in navigator) && ('PushManager' in window) && ('Notification' in window); }
  function postSub(sub){ post('/push/subscribe',sub.toJSON()).catch(function(){}); }
  function initPush(){
    if(!pushSupported()){ bell.hidden=true; return; }
    navigator.serviceWorker.ready.then(function(reg){
      return reg.pushManager.getSubscription().then(function(sub){
        if(sub && Notification.permission==='granted'){ bell.hidden=true; postSub(sub); }
        else { bell.hidden=false; }
      });
    }).catch(function(){});
  }
  bell.onclick=function(){
    if(!pushSupported())return; unlock();
    Notification.requestPermission().then(function(p){
      if(p!=='granted'){ alert('Notifications refusées. Activez-les dans les réglages du téléphone pour être alerté des commandes prêtes.'); return; }
      navigator.serviceWorker.ready.then(function(reg){
        reg.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:urlB64(VAPID)}).then(function(sub){
          postSub(sub); bell.hidden=true;
        }).catch(function(){ alert('Impossible d\'activer les alertes sur cet appareil.'); });
      });
    });
  };

  // ---- Recent history (read-only): today's closed tables + indicative subtotal ----
  // The "addition" a client asks for after their table was auto-freed on the last
  // serve. No actions — closing/serving is done live, the board is forward-only.
  var histBtn=document.getElementById('hist');
  function hhmm(iso){ var d=new Date(iso); return (d.getHours()<10?'0':'')+d.getHours()+':'+(d.getMinutes()<10?'0':'')+d.getMinutes(); }
  function rPicked(l){ return Array.isArray(l.selections)&&l.selections.length>1
    ? l.selections.map(function(s){return s.label+' : '+s.value;}).join(' · ')
    : (l.choice||''); }
  function rLine(l){ var p=rPicked(l); return l.qty+'× '+l.name+(p?' ('+p+')':'')+(l.note?' — '+l.note:''); }
  function recentSession(s){
    var card=el('div','hsess');
    var h=el('div','hsh'); h.appendChild(el('span','hnm',s.short_code));
    if(s.first_name) h.appendChild(el('span','hwho','👤 '+s.first_name));
    h.appendChild(el('span','htime',hhmm(s.closed_at))); card.appendChild(h);
    (s.tickets||[]).forEach(function(t){ var cx=t.status==='CANCELLED';
      (t.items||[]).forEach(function(l){ card.appendChild(el('div','hline'+(cx?' cx':''),rLine(l)+(cx?' — annulé':''))); });
      if(t.note) card.appendChild(el('div','hline','📝 '+t.note));
    });
    var tot=el('div','htot'); tot.appendChild(el('span',null,'Sous-total — indicatif'));
    tot.appendChild(el('span','htotv',s.total_xof+' F')); card.appendChild(tot);
    return card;
  }
  function openRecent(){
    unlock();
    var ov=el('div','ov'); var sh=el('div','sheet');
    sh.setAttribute('role','dialog'); sh.setAttribute('aria-modal','true'); sh.setAttribute('aria-label','Tables récentes');
    var prevOverflow=document.body.style.overflow; document.body.style.overflow='hidden';
    function close(){ if(ov.parentNode) document.body.removeChild(ov); document.body.style.overflow=prevOverflow; if(histBtn&&histBtn.focus){try{histBtn.focus();}catch(e){}} }
    ov.onclick=function(e){ if(e.target===ov) close(); };
    var x=el('button','close-x','×'); x.setAttribute('aria-label','Fermer'); x.onclick=close; sh.appendChild(x);
    sh.appendChild(el('h2','Tables récentes'));
    var list=el('div','list'); list.appendChild(el('p','hempty','Chargement…')); sh.appendChild(list);
    ov.appendChild(sh); document.body.appendChild(ov);
    fetch(BASE+'/recent',{headers:{'X-Requested-With':'fetch'}}).then(function(r){return r.ok?r.json():null;}).then(function(d){
      list.textContent='';
      var rows=(d&&d.sessions)||[];
      if(!rows.length){ list.appendChild(el('p','hempty','Aucune table fermée aujourd’hui.')); return; }
      rows.forEach(function(s){ list.appendChild(recentSession(s)); });
    }).catch(function(){ list.textContent=''; list.appendChild(el('p','hempty','Erreur de chargement.')); });
  }
  if(histBtn) histBtn.onclick=openRecent;

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
  es.addEventListener('ticket_new',function(e){ var t=JSON.parse(e.data); bump(e); if(t.source!=='TABLE')return; var isNew=!tickets.has(t.id); tickets.set(t.id,t); render(); if(isNew){ beep(); speak(newSpeech(t)); } });
  es.addEventListener('ticket_update',function(e){ var t=JSON.parse(e.data); bump(e); if(t.source!=='TABLE')return; var was=tickets.get(t.id); tickets.set(t.id,t); render(); if(t.status==='READY' && (!was||was.status!=='READY')){ beep(); var stEl=board.querySelector('[data-id="'+t.id+'"] .st.ready'); if(stEl)stEl.classList.add('just-ready'); } });
  es.addEventListener('ticket_removed',function(e){ var d=JSON.parse(e.data); bump(e); tickets.delete(d.id); render(); });

  // Keep the reception screen awake while the board is open. Wake Lock drops when
  // the page hides, so re-acquire on visibility return; a no-op where unsupported.
  var wakeLock=null;
  function keepAwake(){ if(!('wakeLock' in navigator)||document.visibilityState!=='visible') return;
    navigator.wakeLock.request('screen').then(function(w){ wakeLock=w; }).catch(function(){}); }
  document.addEventListener('visibilitychange',function(){ if(document.visibilityState==='visible') keepAwake(); });
  keepAwake();

  if('serviceWorker' in navigator){ navigator.serviceWorker.register(BASE+'/sw.js').catch(function(){}); }
})();`;
