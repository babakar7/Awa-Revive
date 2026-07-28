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
 * The cuisine kiosque PWA (cuisine.revive.sn) — HTML shell, web manifest, and
 * service worker + client JS, all served as strings (no bundler, no @fastify/
 * static, matching the house style). The page shell renders nothing itself: the
 * client JS builds every ticket card from window.__BOOT__ and then live-updates
 * over SSE, constructing DOM with textContent (order data is never interpolated
 * into HTML — no XSS surface). The service worker caches ONLY the shell/assets;
 * it never caches a business mutation, an SSE stream, or the ticket API.
 *
 * Look & feel comes from the shared Revive light theme (opsTheme.ts).
 */

const BASE = "/ops/cuisine";
// Same cache-bust discipline as the salle PWA: the version is the SW cache name
// AND the app.js query string, so a fresh deploy can't be served stale.
const ASSET_VERSION = "v12";

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

// ── Pairing screen (unpaired device) ─────────────────────────────────────────

export function cuisinePairingPage(error?: string): string {
  return `<!doctype html><html lang="fr"><head>${opsHead(BASE, "Cuisine")}<title>Appairer — Cuisine Revive</title>
<style>${OPS_TOKENS}${OPS_BASE}${OPS_PAIR_STYLE}</style></head><body><main>
<span class="logo">${OPS_LOGO_SVG}</span>
<h1>Cuisine Revive</h1>
<p>Entrez le code d'appairage affiché dans l'administration (Réglages → Appareils).</p>
<form method="post" action="${BASE}/pair" autocomplete="off">
<input name="code" inputmode="latin" autocapitalize="characters" maxlength="12" placeholder="CODE" required autofocus>
<button type="submit">Appairer cet écran</button>
${error ? `<p class="err">${esc(error)}</p>` : ""}
</form></main></body></html>`;
}

// ── Kiosque (paired device) ──────────────────────────────────────────────────
const APP_STYLE = `main{padding:1rem;display:grid;gap:1rem;grid-template-columns:repeat(auto-fill,minmax(19rem,1fr));align-content:start}
.card{background:var(--surface-raised);border:1px solid var(--border-soft);border-left:6px solid var(--plum-600);
border-radius:var(--radius-lg);padding:1rem 1.1rem;display:flex;flex-direction:column;gap:.55rem;box-shadow:var(--shadow-1)}
.card.src-delivery{border-left-color:var(--info)}
.card.src-bar{border-left-color:#b7791f}
.card.test{border-left-color:var(--danger)}
.card.ready{background:var(--ok-bg);border-color:var(--ok-border);box-shadow:0 0 0 1px var(--ok-border)}
.card.urgent{border-color:var(--danger);border-left-color:var(--danger);box-shadow:0 0 0 3px var(--danger-bg)}
.card.flash{animation:arrive 1.2s var(--ease)}
.top{display:flex;align-items:center;gap:.5rem}
.badge{font-size:.68rem;font-weight:700;letter-spacing:.06em;text-transform:uppercase;
padding:.22rem .6rem;border-radius:999px;background:var(--info-bg);color:var(--info);white-space:nowrap}
.badge.table{background:var(--rose);color:var(--plum-700)}
.badge.test{background:var(--danger-bg);color:var(--danger)}
.badge.away{background:var(--info);color:#fff}
.badge.urgent{background:var(--danger);color:#fff;animation:pulse 1.2s ease-in-out infinite}
.age{margin-left:auto;font-size:1.5rem;font-weight:800;font-variant-numeric:tabular-nums;letter-spacing:.01em;color:var(--ok-strong)}
.age.warn{color:var(--warn)}
.age.late{color:var(--danger);animation:pulse 1.2s ease-in-out infinite}
.age.done{color:var(--ok);animation:none;font-size:1.15rem}
.heading{font-family:var(--serif);font-size:1.25rem;font-weight:600;letter-spacing:-.02em;line-height:1.2}
.sub{font-size:.88rem;color:var(--ink-500)}
ul.items{list-style:none;margin:.1rem 0;padding:0;display:flex;flex-direction:column;gap:.2rem}
ul.items li{font-size:1.08rem}
ul.items .q{font-weight:800;color:var(--plum-600)}
.lnote{color:var(--warn);font-weight:600}
.note{font-size:.92rem;color:var(--warn);background:var(--warn-bg);border:1px solid var(--warn-border);
border-radius:var(--radius-sm);padding:.45rem .6rem}
/* Compact READY card: one-line items instead of the full list (never when a line
   carries a note — the instruction must stay visible). */
.card.compact{gap:.35rem;padding:.7rem .9rem}
.cline{font-size:.9rem;color:var(--ink-500)}
/* Batching banner: identical preparations spread across ≥2 open tickets. */
.batch{grid-column:1/-1;background:var(--plum-50);border:1px solid var(--plum-200);border-radius:var(--radius-lg);
padding:.7rem .9rem;display:flex;flex-wrap:wrap;align-items:center;gap:.5rem}
.batch .blab{font-family:var(--serif);font-size:.95rem;font-weight:600;color:var(--plum-700);margin-right:.3rem}
.batch .bchip{background:#fff;border:1px solid var(--plum-200);border-radius:999px;padding:.25rem .7rem;
font-size:1rem;font-weight:700;color:var(--ink-700)}
.pill{align-self:flex-start;font-size:.72rem;font-weight:700;text-transform:uppercase;letter-spacing:.05em;
padding:.25rem .65rem;border-radius:999px;background:var(--plum-50);color:var(--plum-700)}
.pill.preparing{background:var(--warn-bg);color:var(--warn)}
.pill.ready{background:var(--ok-bg);color:var(--ok)}
.pill.ready.just-ready{animation:pop .2s var(--ease)}
.actions{display:flex;gap:.6rem;margin-top:.25rem}
button.act{flex:1;padding:.9rem;font-size:1.05rem;font-weight:800;border:none;border-radius:var(--radius);color:#fff;box-shadow:var(--shadow-1)}
button.prep{background:var(--plum-600)}
button.ready{background:var(--ok-strong)}
#clock{font-variant-numeric:tabular-nums;font-weight:600;font-size:.95rem;color:var(--ink-500)}
.sndbtn{background:var(--rose);color:var(--plum-700);border:1px solid var(--plum-200);border-radius:999px;
min-height:2.5rem;padding:.3rem .7rem;font-size:1rem;font-weight:700}
.sndbtn.off{background:var(--cream-100);color:var(--ink-500);border-color:var(--border)}
.histbtn{background:var(--rose);color:var(--plum-700);border:1px solid var(--plum-200);border-radius:999px;
min-height:2.5rem;padding:.3rem .7rem;font-size:1rem;font-weight:700}
.empty{grid-column:1/-1;text-align:center;color:var(--ink-500);margin-top:20vh;font-family:var(--serif);font-size:1.3rem;font-style:italic}
/* Recent-history panel (read-only): today's served/cancelled tickets. */
.ov{position:fixed;inset:0;z-index:20;background:rgba(33,25,33,.45);display:flex;align-items:flex-start;justify-content:center;animation:arrive .2s var(--ease)}
.sheet{position:relative;display:flex;flex-direction:column;background:var(--surface);width:100%;max-width:36rem;
max-height:88vh;max-height:88dvh;overflow:hidden;margin-top:3vh;border-radius:var(--radius-xl);box-shadow:var(--shadow-2);padding:1rem 1.1rem}
.sheet h2{font-family:var(--serif);font-size:1.3rem;font-weight:600;letter-spacing:-.02em;margin:.1rem 0 .7rem}
.sheet .list{flex:1 1 auto;min-height:0;overflow-y:auto;-webkit-overflow-scrolling:touch;display:flex;flex-direction:column;gap:.5rem}
.close-x{position:absolute;top:.55rem;right:.7rem;background:none;border:none;color:var(--ink-500);font-size:1.7rem;line-height:1;min-width:2.75rem;min-height:2.75rem}
.hrow{border:1px solid var(--border-soft);border-radius:var(--radius);padding:.55rem .7rem;display:flex;flex-direction:column;gap:.2rem}
.hrow.cancelled{background:var(--danger-bg);border-color:var(--danger-border)}
.hrow .htop{display:flex;align-items:baseline;gap:.5rem;font-size:.85rem;color:var(--ink-500)}
.hrow .hh{font-weight:700;color:var(--ink-700)}
.hrow .hres{margin-left:auto;font-weight:700}
.hrow .hres.ok{color:var(--ok-strong)}
.hrow .hres.ko{color:var(--danger)}
.hrow .hitems{font-size:.92rem;color:var(--ink-700)}
.hempty{text-align:center;color:var(--ink-500);font-style:italic;font-family:var(--serif);padding:2rem 0}`;

export function cuisineKitchenPage(bootJson: string): string {
  return `<!doctype html><html lang="fr"><head>${opsHead(BASE, "Cuisine")}<title>Cuisine Revive</title>
<style>${OPS_TOKENS}${OPS_BASE}${APP_STYLE}</style></head><body>
<header><span id="dot" class="dot"></span><span class="logo">${OPS_LOGO_SVG}</span><h1>Cuisine</h1><span id="clock"></span><span class="spacer"></span>
<button id="hist" class="histbtn" aria-label="Commandes récentes">🕐</button>
<button id="snd" class="sndbtn" aria-label="Activer/couper le son">🔊</button><span class="count" id="count"></span></header>
<main id="board"><p class="empty" id="empty">Chargement…</p></main>
<div id="offline">Hors ligne — reconnexion…</div>
<noscript>Activez JavaScript pour afficher les tickets cuisine.</noscript>
<script>window.__BOOT__=${bootJson}</script>
<script src="${BASE}/app.js?b=${ASSET_VERSION}"></script>
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
  background_color: OPS_BG_COLOR,
  theme_color: OPS_THEME_COLOR,
  icons: [
    { src: `${BASE}/icon-192.png`, sizes: "192x192", type: "image/png", purpose: "any" },
    { src: `${BASE}/icon-512.png`, sizes: "512x512", type: "image/png", purpose: "any maskable" },
  ],
});

// ── Service worker (shell/assets only; never a mutation or the SSE stream) ────
export const CUISINE_SW = `const CACHE='cuisine-${ASSET_VERSION}';
const SHELL=['${BASE}/app.js','${BASE}/manifest.webmanifest','${BASE}/icon-192.png','${BASE}/icon-512.png'];
self.addEventListener('install',e=>{e.waitUntil(caches.open(CACHE).then(c=>c.addAll(SHELL)).then(()=>self.skipWaiting()));});
// Prune only THIS app's old caches — cuisine and salle share the localhost origin
// during dev review, so an unscoped sweep would delete the other app's cache.
self.addEventListener('activate',e=>{e.waitUntil(caches.keys().then(ks=>Promise.all(ks.filter(k=>k.startsWith('cuisine-')&&k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim()));});
self.addEventListener('fetch',e=>{
  const url=new URL(e.request.url);
  // Shell assets ONLY: network-first so a deployed (or dev-reloaded) update shows
  // immediately when online; the cache is just an offline fallback. Everything
  // else — the page navigation, the SSE stream, every POST mutation — is never
  // touched here, so the kitchen never acts on stale data.
  if(e.request.method==='GET' && SHELL.includes(url.pathname)){
    e.respondWith(
      fetch(e.request).then(r=>{const c=r.clone();caches.open(CACHE).then(cc=>cc.put(e.request,c));return r;})
        .catch(()=>caches.match(e.request))
    );
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
  var clockEl=document.getElementById('clock');

  // ---- sound & voice (unlocked on first user gesture; iOS requirement) ----
  // Cooks can't always watch the screen, so the board speaks (Web Speech API,
  // OS voices, no network). A header 🔊/🔇 toggle (persisted) mutes bip + voix.
  var sndBtn=document.getElementById('snd');
  var muted=false; try{ muted=localStorage.getItem('cuisine.sound')==='off'; }catch(e){}
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
  document.addEventListener('touchstart',unlock,{once:false});
  document.addEventListener('click',unlock,{once:false});
  // Toggling the sound ON speaks a confirmation — a direct user gesture is the most
  // reliable way to prove TTS works (and it primes it for the SSE-driven alerts).
  if(sndBtn) sndBtn.onclick=function(){ muted=!muted; try{ localStorage.setItem('cuisine.sound',muted?'off':'on'); }catch(e){} paintSnd();
    if(muted){ try{ speechSynthesis.cancel(); }catch(e){} } else { unlock(); speak('Son activé',false); } };
  function beep(){ if(muted||!actx) return; try{ var o=actx.createOscillator(),g=actx.createGain();
    o.type='sine'; o.frequency.value=880; g.gain.value=.001; o.connect(g); g.connect(actx.destination);
    var t=actx.currentTime; g.gain.exponentialRampToValueAtTime(.25,t+.02); g.gain.exponentialRampToValueAtTime(.001,t+.5);
    o.start(t); o.stop(t+.5);}catch(e){} }
  function speak(text,urgent){ if(muted||!text||!window.speechSynthesis) return; try{
    speechSynthesis.resume();                        // Chrome pauses the queue at times
    if(urgent) speechSynthesis.cancel();             // an urgence jumps the queue
    var u=new SpeechSynthesisUtterance(text); u.lang='fr-FR'; var v=frVoice(); if(v) u.voice=v;
    if(urgent){ u.rate=1.05; u.pitch=1.1; }
    speechSynthesis.speak(u); }catch(e){} }
  // ---- one place to format an order line (choice + note) ----
  // Reused by the normal card, the compact READY card, the batching banner AND
  // the voice — so multi-option selections and per-line notes are never dropped
  // by one path while shown by another.
  function linePicked(l){ return Array.isArray(l.selections)&&l.selections.length>1
    ? l.selections.map(function(s){return s.label+' : '+s.value;}).join(' · ')
    : (l.choice||''); }
  function lineLabel(l){ var p=linePicked(l); return l.name+(p?' ('+p+')':'')+(l.note?' — '+l.note:''); }
  function lineText(l){ return l.qty+'× '+lineLabel(l); }
  function itemsSpeech(t){ return (t.items||[]).map(function(l){ var p=linePicked(l);
    return l.qty+' '+l.name+(p?', '+p:'')+(l.note?', '+l.note:''); }).join('. '); }
  function newSpeech(t){ var w=t.heading||'';
    var lead;
    if(t.source==='DELIVERY') lead='Nouvelle livraison';
    else if(t.source==='BAR') lead='Nouvelle commande bar';
    else lead='Nouvelle commande'+(t.takeaway?' à emporter':'');
    var it=itemsSpeech(t); return lead+(w?', '+w:'')+(it?'. '+it:''); }
  function urgentSpeech(t){ return 'Commande urgente'+(t.heading?', '+t.heading:''); }
  function cancelSpeech(t){ var it=itemsSpeech(t); return 'Commande annulée'+(t.heading?', '+t.heading:'')+(it?'. '+it:''); }

  // Prep timer (MM:SS): counts up while the kitchen prepares, colored by urgency
  // (green < 5 min, amber 5–10, red pulsing ≥ 10), and FREEZES when the ticket is
  // marked READY — the kitchen's job is done; the delivery/total time belongs to
  // reception (/admin/livraisons), not the iPad.
  function fmtSecs(s){ s=Math.max(0,Math.floor(s)); var m=Math.floor(s/60), r=s%60; return (m<10?'0':'')+m+':'+(r<10?'0':'')+r; }
  function fmtElapsed(iso){ return fmtSecs((Date.now()-new Date(iso).getTime())/1000); }
  function betweenSecs(a,b){ return (new Date(b).getTime()-new Date(a).getTime())/1000; }
  function elapsedMins(iso){ return (Date.now()-new Date(iso).getTime())/60000; }
  function ageClass(iso){ var m=elapsedMins(iso); return m>=10?'age late':m>=5?'age warn':'age'; }

  function el(tag,cls,txt){ var e=document.createElement(tag); if(cls)e.className=cls; if(txt!=null)e.textContent=txt; return e; }

  function card(t){
    // Compact a READY card to a single items line to free the board in a rush —
    // but NEVER when a line carries a note (the instruction must stay readable).
    var hasItemNotes=(t.items||[]).some(function(l){return !!l.note;});
    var compact=t.status==='READY' && !hasItemNotes;
    var c=el('div','card src-'+(t.source==='TABLE'?'table':t.source==='BAR'?'bar':'delivery')+(t.status==='READY'?' ready':'')+(compact?' compact':'')+(t.is_test?' test':'')+(t.urgent?' urgent':''));
    c.dataset.id=t.id;
    var top=el('div','top');
    // Urgent escalation stands out first, then the fulfilment-mode badge.
    if(t.urgent) top.appendChild(el('span','badge urgent','⚡ URGENT'));
    // One fulfilment-mode badge per ticket: Sur place / À emporter / Livraison.
    var b;
    if(t.source==='DELIVERY') b=el('span','badge','🛵 Livraison');
    else if(t.source==='BAR') b=el('span','badge away','☕ Commande bar');
    else if(t.takeaway) b=el('span','badge away','📦 À emporter');
    else b=el('span','badge table','🍽️ Sur place');
    top.appendChild(b);
    if(t.is_test) top.appendChild(el('span','badge test','Test'));
    var a;
    if(t.status==='READY' && t.ready_at){
      // Frozen prep duration — no data-age, so the ticking interval skips it.
      a=el('span','age done','✓ '+fmtSecs(betweenSecs(t.created_at,t.ready_at)));
    } else {
      a=el('span',ageClass(t.created_at),fmtElapsed(t.created_at)); a.dataset.age=t.created_at;
    }
    top.appendChild(a);
    c.appendChild(top);
    c.appendChild(el('div','heading',t.heading||'—'));
    if(t.subheading) c.appendChild(el('div','sub',t.subheading));
    if(compact){
      // One line, choices + (no) notes here since compact only runs without notes.
      c.appendChild(el('div','cline',(t.items||[]).map(lineText).join(' · ')));
    } else {
      var ul=el('ul','items');
      (t.items||[]).forEach(function(l){ var li=el('li'); li.appendChild(el('span','q',l.qty+'× '));
        var picked=linePicked(l);
        li.appendChild(document.createTextNode(l.name+(picked?' ('+picked+')':'')));
        if(l.note) li.appendChild(el('span','lnote',' — '+l.note));
        ul.appendChild(li); });
      c.appendChild(ul);
    }
    if(t.note) c.appendChild(el('div','note','📝 '+t.note));
    if(t.status==='READY'){
      c.appendChild(el('span','pill ready','Prête — à récupérer'));
      if(t.source==='BAR'){ var d=el('button','act ready','Terminée'); d.onclick=function(){move(t.id,'complete',d);}; c.appendChild(d); }
    }
    else {
      if(t.status==='PREPARING') c.appendChild(el('span','pill preparing','En préparation'));
      var acts=el('div','actions');
      if(t.status==='NEW'){ var p=el('button','act prep','Commencer'); p.onclick=function(){move(t.id,'preparing',p);}; acts.appendChild(p); }
      var r=el('button','act ready','Prête'); r.onclick=function(){move(t.id,'ready',r);}; acts.appendChild(r);
      c.appendChild(acts);
    }
    return c;
  }

  // Batching: identical preparations (same item + same options + same note)
  // that appear across ≥2 distinct still-to-make tickets (NEW/PREPARING). A
  // banner lets the kitchen make them together. Groups spanning a single ticket
  // carry no batching value, so they're excluded.
  function normNote(s){ return String(s||'').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g,'').replace(/\s+/g,' ').trim(); }
  function lineSig(l){ var sel=Array.isArray(l.selections)&&l.selections.length
      ? l.selections.map(function(s){return s.label+'='+s.value;}).join('|')
      : (l.choice||''); return l.id+'§'+sel+'§'+normNote(l.note); }
  function batchGroups(list){
    var by={}, order=[];
    list.forEach(function(t){ if(t.status!=='NEW'&&t.status!=='PREPARING') return;
      (t.items||[]).forEach(function(l){ var sig=lineSig(l);
        if(!by[sig]){ by[sig]={qty:0,tickets:{},sample:l}; order.push(sig); }
        by[sig].qty+=l.qty; by[sig].tickets[t.id]=true; }); });
    return order.map(function(s){return by[s];})
      .filter(function(g){ var n=0; for(var k in g.tickets) n++; return n>=2; })
      .sort(function(a,b){ return b.qty-a.qty; });
  }

  function render(){
    // Urgents first (accueil-escalated), then oldest-first within each group.
    var list=Array.from(model.values()).sort(function(x,y){
      var u=(y.urgent?1:0)-(x.urgent?1:0);
      return u || (new Date(x.created_at)-new Date(y.created_at));
    });
    board.textContent='';
    var groups=batchGroups(list);
    if(groups.length){
      var bn=el('div','batch'); bn.appendChild(el('span','blab','À préparer ensemble'));
      groups.forEach(function(g){ bn.appendChild(el('span','bchip',g.qty+'× '+lineLabel(g.sample))); });
      board.appendChild(bn);
    }
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

  // ---- Recent history (read-only): today's served/cancelled tickets ----
  // A recall for a ticket that already left the board — re-check an instruction,
  // a missed voice announcement, a dispute. No actions: the board is forward-only.
  var histBtn=document.getElementById('hist');
  function hhmm(iso){ var d=new Date(iso); return (d.getHours()<10?'0':'')+d.getHours()+':'+(d.getMinutes()<10?'0':'')+d.getMinutes(); }
  function histBadge(t){ return t.source==='DELIVERY'?'🛵 Livraison':t.source==='BAR'?'☕ Bar':t.takeaway?'📦 À emporter':'🍽️ Sur place'; }
  function histRow(t){
    var cancelled=t.status==='CANCELLED';
    var r=el('div','hrow'+(cancelled?' cancelled':''));
    var top=el('div','htop');
    top.appendChild(el('span',null,hhmm(t.finished_at||t.created_at)));
    top.appendChild(el('span','hh',t.heading||'—'));
    top.appendChild(el('span',null,histBadge(t)));
    if(t.is_test) top.appendChild(el('span',null,'Test'));
    if(cancelled){ top.appendChild(el('span','hres ko','Annulée'+(t.cancel_reason?' · '+t.cancel_reason:''))); }
    else { var secs=t.ready_at?betweenSecs(t.created_at,t.ready_at):null; top.appendChild(el('span','hres ok',secs!=null?'✓ '+fmtSecs(secs):'✓ Servie')); }
    r.appendChild(top);
    r.appendChild(el('div','hitems',(t.items||[]).map(lineText).join(' · ')));
    if(t.note) r.appendChild(el('div','hitems','📝 '+t.note));
    return r;
  }
  function openHistory(){
    var ov=el('div','ov'); var sh=el('div','sheet');
    function close(){ if(ov.parentNode) document.body.removeChild(ov); }
    ov.onclick=function(e){ if(e.target===ov) close(); };
    var x=el('button','close-x','×'); x.setAttribute('aria-label','Fermer'); x.onclick=close; sh.appendChild(x);
    sh.appendChild(el('h2','Commandes récentes'));
    var list=el('div','list'); list.appendChild(el('p','hempty','Chargement…')); sh.appendChild(list);
    ov.appendChild(sh); document.body.appendChild(ov);
    fetch(BASE+'/recent',{headers:{'X-Requested-With':'fetch'}}).then(function(r){return r.ok?r.json():null;}).then(function(d){
      list.textContent='';
      var rows=(d&&d.tickets)||[];
      if(!rows.length){ list.appendChild(el('p','hempty','Aucune commande terminée aujourd’hui.')); return; }
      rows.forEach(function(t){ list.appendChild(histRow(t)); });
    }).catch(function(){ list.textContent=''; list.appendChild(el('p','hempty','Erreur de chargement.')); });
  }
  if(histBtn) histBtn.onclick=openHistory;

  // The SSE stream blips routinely (network switch, sleep) and EventSource
  // auto-reconnects within ~3s. Only cry "hors ligne" after the link has really
  // been down a few seconds — and clear it instantly on reconnect — so a routine
  // reconnect never flashes a scary banner on a working connection.
  var downTimer=null;
  function setOnline(on){
    if(on){ if(downTimer){clearTimeout(downTimer);downTimer=null;} dot.classList.add('on'); offline.classList.remove('show'); }
    else if(!downTimer){ downTimer=setTimeout(function(){ downTimer=null; dot.classList.remove('on'); offline.classList.add('show'); },5000); }
  }

  function tickClock(){ if(!clockEl)return; var d=new Date();
    clockEl.textContent=(d.getHours()<10?'0':'')+d.getHours()+':'+(d.getMinutes()<10?'0':'')+d.getMinutes(); }

  // Tick the elapsed timers + the header clock every second, without a full re-render.
  setInterval(function(){ tickClock(); document.querySelectorAll('[data-age]').forEach(function(a){
    a.textContent=fmtElapsed(a.dataset.age); a.className=ageClass(a.dataset.age); }); },1000);
  tickClock();

  render(); ackAll();

  var es=new EventSource(BASE+'/events?since='+cursor);
  es.onopen=function(){setOnline(true);};
  es.onerror=function(){setOnline(false);};
  es.addEventListener('ticket_new',function(e){ var t=JSON.parse(e.data); var isNew=!model.has(t.id); model.set(t.id,t); if(e.lastEventId)cursor=+e.lastEventId; render(); if(isNew){beep(); speak(newSpeech(t),false); var c=board.querySelector('[data-id="'+t.id+'"]'); if(c)c.classList.add('flash'); ack(t.id);} });
  es.addEventListener('ticket_update',function(e){ var t=JSON.parse(e.data); var prev=model.get(t.id); var becameReady=t.status==='READY'&&(!prev||prev.status!=='READY'); var becameUrgent=t.urgent&&(!prev||!prev.urgent); model.set(t.id,t); if(e.lastEventId)cursor=+e.lastEventId; render(); var c2=board.querySelector('[data-id="'+t.id+'"]'); if(becameReady){ var pill=c2&&c2.querySelector('.pill.ready'); if(pill)pill.classList.add('just-ready'); } if(becameUrgent){ if(c2)c2.classList.add('flash'); beep(); speak(urgentSpeech(t),true); } });
  es.addEventListener('ticket_removed',function(e){ var d=JSON.parse(e.data); var prev=model.get(d.id); model.delete(d.id); if(e.lastEventId)cursor=+e.lastEventId; render(); if(d.status==='CANCELLED'){ beep(); speak(cancelSpeech(prev||{heading:''}),true); } });

  // Keep the kitchen screen awake while the board is open (kiosk). The Wake Lock
  // is dropped when the page is hidden, so re-acquire it whenever it returns to
  // view. Silently a no-op where unsupported — the device sleep setting is the net.
  var wakeLock=null;
  function keepAwake(){ if(!('wakeLock' in navigator)||document.visibilityState!=='visible') return;
    navigator.wakeLock.request('screen').then(function(w){ wakeLock=w; }).catch(function(){}); }
  document.addEventListener('visibilitychange',function(){ if(document.visibilityState==='visible') keepAwake(); });
  keepAwake();

  if('serviceWorker' in navigator){ navigator.serviceWorker.register(BASE+'/sw.js').catch(function(){}); }
})();`;
