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
import { OPS_PICKER_HELPERS } from "./opsPicker.js";

/**
 * The owner supervision PWA (owner.revive.sn) — an overview of all live activity
 * for the manager: today's KPIs, device status, and every in-progress ticket
 * (cuisine + salle + livraison), urgents first. Same house style as the cuisine
 * kiosque (inline strings, DOM via textContent, shared Revive theme). Full
 * control: the owner can take a salle order (＋ Commande) AND drive any ticket
 * through the same transitions as the cuisine iPad (commencer/prête/terminée)
 * and the salle phones (servie/urgent/annuler) — all via /ops/owner endpoints,
 * server-decided as everywhere. Subscribes to the cuisine channel (which
 * already carries every ticket) and polls /stats.
 */

const BASE = "/ops/owner";
const ASSET_VERSION = "v6";

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
.card.src-bar{border-left-color:#b7791f}
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
/* Ticket actions — same verbs as the cuisine iPad (Commencer/Prête/Terminée) and
   the salle phones (Servie/urgent/annuler); the supervisor can do it all. */
.actions{display:flex;gap:.5rem;margin-top:.25rem}
button.act{flex:1;padding:.8rem;font-size:1rem;font-weight:800;border:none;border-radius:var(--radius);color:#fff;box-shadow:var(--shadow-1)}
button.act.prep{background:var(--plum-600)}
button.act.ready{background:var(--ok-strong)}
button.act.serve{background:var(--info)}
button.act.undo{background:var(--warn)}
button.act.urg{background:none;border:1px solid var(--border-strong);color:var(--ink-700);flex:0 0 auto;padding:.8rem .7rem;box-shadow:none}
button.act.urg.on{border-color:var(--danger);color:var(--danger);background:var(--danger-bg)}
button.act.cancelx{background:none;border:1px solid var(--danger-border);color:var(--danger);flex:0 0 auto;min-width:2.75rem;padding:.8rem .85rem;box-shadow:none}
/* Fleet anomaly: a still-NEW ticket the cuisine tablet never acknowledged. */
.card.unconfirmed{border-left-color:var(--danger)}
.cuis.warn{font-size:.8rem;font-weight:700;color:var(--danger)}
/* "Prête" pending its local undo grace (same 3s pattern as the cuisine board). */
.card.pending{border-color:var(--warn);border-left-color:var(--warn);box-shadow:0 0 0 3px var(--warn-bg)}
/* Confirm dialog (verb-labeled buttons — native OK/Annuler is ambiguous when the
   question IS « Annuler ? »). Same pattern as the salle PWA. */
.ov.center{align-items:center;padding:1rem}
.cfm{background:var(--surface);border-radius:var(--radius-xl);box-shadow:var(--shadow-2);padding:1.2rem;max-width:22rem;width:100%}
.cfm p{font-size:1.05rem;font-weight:600;margin:.1rem 0 1rem;color:var(--ink-900)}
.cfm .cfmacts{display:flex;flex-direction:column;gap:.55rem}
.cfm button{padding:.85rem;border-radius:var(--radius);border:1px solid var(--border-strong);background:#fff;color:var(--ink-700);font-weight:700;font-size:.95rem}
.cfm button.danger{background:var(--danger);border-color:var(--danger);color:#fff}
#clock{font-variant-numeric:tabular-nums;font-weight:600;font-size:.95rem;color:var(--ink-500)}
.empty{grid-column:1/-1;text-align:center;color:var(--ink-500);margin-top:16vh;font-family:var(--serif);font-size:1.3rem;font-style:italic}
/* "＋ Commande" — the owner can also take an order. */
#take{background:var(--plum-600);color:#fff;border:1px solid var(--plum-600);border-radius:999px;
min-height:2.5rem;padding:.35rem .9rem;font-size:.9rem;font-weight:700}
/* Order composer (a lean variant of the salle sheet; server still decides prices). */
.ov{position:fixed;inset:0;z-index:20;background:rgba(33,25,33,.45);display:flex;align-items:flex-end;justify-content:center;animation:pop .2s var(--ease)}
.sheet{position:relative;display:flex;flex-direction:column;background:var(--surface);width:100%;max-width:34rem;
height:90vh;height:90dvh;overflow:hidden;overscroll-behavior:contain;
border-radius:var(--radius-xl) var(--radius-xl) 0 0;box-shadow:var(--shadow-2);
padding:1rem;padding-bottom:calc(1rem + env(safe-area-inset-bottom))}
.sheet::before{content:"";display:block;width:2.6rem;height:.3rem;border-radius:99px;background:var(--border-strong);margin:0 auto .7rem}
.sheet h2{font-family:var(--serif);font-size:1.3rem;font-weight:600;letter-spacing:-.02em;margin:.1rem 0 .8rem}
.sheet select,.sheet input,.sheet textarea{width:100%;padding:.8rem;border-radius:var(--radius);border:1px solid var(--border);
background:#fff;color:var(--ink-900);font-size:1rem;font-family:inherit;margin-bottom:.6rem}
.sheet textarea{min-height:3rem}
.modeseg{display:flex;gap:.45rem;margin:0 0 .7rem}
.modeseg .mode{flex:1;min-height:2.75rem;padding:.7rem;border-radius:var(--radius);border:1px solid var(--border);
background:var(--surface-raised);color:var(--ink-700);font-weight:700;font-size:.95rem}
.modeseg .mode.sel{background:var(--plum-600);border-color:var(--plum-600);color:#fff}
.modeseg .mode.away.sel{background:var(--info);border-color:var(--info);color:#fff}
.toolbar{position:sticky;top:0;z-index:3;background:var(--surface);padding:.2rem 0 .5rem}
.search{margin-bottom:.5rem}
.chips{display:flex;gap:.4rem;overflow-x:auto;-webkit-overflow-scrolling:touch;padding-bottom:.2rem;scrollbar-width:none}
.chips::-webkit-scrollbar{display:none}
.chip{flex:0 0 auto;padding:.55rem .95rem;border-radius:999px;background:var(--rose);border:1px solid transparent;
color:var(--plum-600);font-size:.88rem;font-weight:600;white-space:nowrap}
.chip.sel{background:var(--plum-600);border-color:var(--plum-600);color:#fff}
.chip.fav{background:var(--warn-bg);border-color:transparent;color:var(--warn)}
.chip.fav.sel{background:var(--warn);border-color:var(--warn);color:#fff}
.list{flex:1 1 auto;min-height:0;overflow-y:auto;-webkit-overflow-scrolling:touch;overscroll-behavior:contain}
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
.foot{position:sticky;bottom:0;background:var(--surface);padding:.6rem 0 .2rem;display:flex;gap:.6rem;align-items:center;border-top:1px solid var(--border-soft)}
.total{font-weight:800;font-size:1.05rem;white-space:nowrap}
.total small{color:var(--ink-500);font-weight:500}
.foot button.go{flex:1;padding:.95rem;border:none;border-radius:12px;background:var(--ok-strong);color:#fff;font-weight:800;font-size:1.02rem;box-shadow:var(--shadow-1)}
.foot button.go:disabled{opacity:.45}
.close-x{position:absolute;top:.55rem;right:.6rem;background:none;border:none;color:var(--ink-500);font-size:1.7rem;line-height:1;z-index:4;min-width:2.75rem;min-height:2.75rem}
.msg{color:var(--danger);font-size:.9rem;margin:.4rem 0}`;

export function ownerBoardPage(): string {
  // No inline boot: script-src 'self' blocks it. The client fetches /state before
  // opening SSE, so the board is DB-authoritative from the first paint.
  return `<!doctype html><html lang="fr"><head>${opsHead(BASE, "Supervision")}<title>Supervision Revive</title>
<style>${OPS_TOKENS}${OPS_BASE}${APP_STYLE}</style></head><body>
<div id="offline">Hors ligne — reconnexion…</div>
<header><span id="dot" class="dot"></span><span class="logo">${OPS_LOGO_SVG}</span><h1>Supervision</h1><span id="clock"></span><span class="spacer"></span>
<button id="take" type="button">＋ Commande</button><span class="count" id="count"></span></header>
<section id="kpi" class="kpi-bar"></section>
<section id="devs" class="dev-bar"></section>
<main id="board"><p class="empty" id="empty">Chargement…</p></main>
<noscript>Activez JavaScript pour la supervision.</noscript>
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

// ── Client app (SSE cuisine channel + /stats poll; can also take an order) ───
export const OWNER_APP_JS = OPS_PICKER_HELPERS + String.raw`(function(){
  var BASE=${JSON.stringify(BASE)};
  var cursor=0;             // event cursor; seeded from /state before SSE opens
  var booted=false;         // flips true after the first successful /state load
  var connected=false;      // SSE opened once, after the first /state
  var SPOTS=[];
  var MENU=[];
  var TOP=[];
  var model=new Map();
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

  // ---- "Prête" with a local undo grace (same 3s pattern as the cuisine iPad) ----
  // The POST fires only after the countdown; undoing in time reaches no server
  // (no status change, no false reception push). A reload or a removal drops it.
  var READY_DELAY_MS=3000;
  var pendingReady={};   // id -> { until:epochMs, timer:id }
  function remainSecs(id){ var p=pendingReady[id]; if(!p) return 0; return Math.max(0,Math.ceil((p.until-Date.now())/1000)); }
  function startPendingReady(id){
    if(pendingReady[id]) return;
    pendingReady[id]={ until:Date.now()+READY_DELAY_MS, timer:setTimeout(function(){ commitReady(id); },READY_DELAY_MS) };
    render();
  }
  function cancelPendingReady(id){
    var p=pendingReady[id]; if(!p) return;
    clearTimeout(p.timer); delete pendingReady[id]; render();
  }
  function commitReady(id){
    var p=pendingReady[id]; if(!p) return;
    clearTimeout(p.timer); delete pendingReady[id];
    postJSON('/tickets/'+id+'/ready',{})
      .then(function(r){ if(!r.ok) render(); }).catch(function(){ render(); });
  }
  function clearPendingReady(id){ var p=pendingReady[id]; if(p){ clearTimeout(p.timer); delete pendingReady[id]; } }

  // Verb-labeled confirm (native OK/Annuler is ambiguous when the question IS
  // « Annuler ? »). Escape routes (backdrop tap, initial focus) mean « garder ».
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

  function act(btn,path,body){ btn.disabled=true;
    postJSON(path,body||{}).then(function(r){ if(!r.ok) btn.disabled=false; }).catch(function(){ btn.disabled=false; }); }

  // A still-NEW ticket the cuisine tablet never acknowledged past a short grace =
  // the reception→cuisine anomaly, mirrored on the supervisor's board.
  function unconfirmed(t){ return t.status==='NEW' && !t.ipad_ack_at && elapsedMins(t.created_at)>=0.17; }

  function card(t){
    var isPending=!!pendingReady[t.id];
    var c=el('div','card src-'+(t.source==='TABLE'?'table':t.source==='BAR'?'bar':'delivery')+(t.status==='READY'?' ready':'')+(isPending?' pending':'')+(t.is_test?' test':'')+(t.urgent?' urgent':'')+(unconfirmed(t)?' unconfirmed':''));
    c.dataset.id=t.id;
    var top=el('div','top');
    if(t.urgent) top.appendChild(el('span','badge urgent','⚡ URGENT'));
    var b;
    if(t.source==='DELIVERY') b=el('span','badge','🛵 Livraison');
    else if(t.source==='BAR') b=el('span','badge','☕ Bar');
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
    if(unconfirmed(t)) c.appendChild(el('div','cuis warn','⚠︎ Cuisine non confirmée — vérifiez la tablette'));
    var stTxt=t.status==='READY'?'Prête':t.status==='PREPARING'?'En préparation':'Nouveau';
    c.appendChild(el('span','pill '+t.status.toLowerCase(), stTxt));
    // Full control: cuisine verbs (Commencer/Prête/Terminée) + salle verbs
    // (Servie/urgent/annuler). DELIVERY departures stay on /admin/livraisons.
    var acts=el('div','actions');
    if(t.status==='READY'){
      if(t.source==='TABLE'){ var sv=el('button','act serve','🙋 Servie'); sv.onclick=function(){act(sv,'/tickets/'+t.id+'/served');}; acts.appendChild(sv); }
      else if(t.source==='BAR'){ var dn=el('button','act ready','Terminée'); dn.onclick=function(){act(dn,'/tickets/'+t.id+'/complete');}; acts.appendChild(dn); }
    } else if(isPending){
      // Mis-tap window: the "Prête" POST hasn't fired yet — one tap undoes it.
      var un=el('button','act undo'); un.dataset.pending=t.id;
      un.textContent='↩ Annuler ('+remainSecs(t.id)+')';
      un.onclick=function(){ cancelPendingReady(t.id); };
      acts.appendChild(un);
    } else {
      if(t.status==='NEW'){ var p=el('button','act prep','Commencer'); p.onclick=function(){act(p,'/tickets/'+t.id+'/preparing');}; acts.appendChild(p); }
      var r=el('button','act ready','Prête'); r.onclick=function(){ startPendingReady(t.id); }; acts.appendChild(r);
      if(t.source==='TABLE'){
        var ug=el('button','act urg'+(t.urgent?' on':''), t.urgent?'⚡ ✓':'⚡');
        ug.title=t.urgent?'Retirer l’urgence':'Marquer urgent'; ug.setAttribute('aria-pressed',t.urgent?'true':'false');
        ug.onclick=function(){act(ug,'/tickets/'+t.id+'/urgent',{urgent:!t.urgent});};
        acts.appendChild(ug);
        var cx=el('button','act cancelx','✕'); cx.title='Annuler cette commande'; cx.setAttribute('aria-label','Annuler cette commande');
        cx.onclick=function(){ askConfirm('Annuler cette commande ?','Oui, annuler la commande','Non, garder la commande',function(){ act(cx,'/tickets/'+t.id+'/cancel',{reason:'annulée (supervision)'}); }); };
        acts.appendChild(cx);
      }
    }
    if(acts.childNodes.length) c.appendChild(acts);
    return c;
  }

  function render(){
    var list=Array.from(model.values()).sort(function(x,y){
      var u=(y.urgent?1:0)-(x.urgent?1:0);
      return u || (new Date(x.created_at)-new Date(y.created_at));
    });
    board.textContent='';
    if(!list.length){ board.appendChild(el('p','empty', booted?'Aucune commande en cours':'Chargement…')); }
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
  renderStats({}); renderDevices([]);   // filled by the first /state

  function tickClock(){ if(!clockEl)return; var d=new Date();
    clockEl.textContent=(d.getHours()<10?'0':'')+d.getHours()+':'+(d.getMinutes()<10?'0':'')+d.getMinutes(); }
  setInterval(function(){ tickClock(); document.querySelectorAll('[data-age]').forEach(function(a){
    a.textContent=fmtElapsed(a.dataset.age); a.className=ageClass(a.dataset.age); });
    // Count the "Prête" undo window down in place (the timeout does the commit).
    document.querySelectorAll('[data-pending]').forEach(function(u){
      u.textContent='↩ Annuler ('+remainSecs(u.dataset.pending)+')'; }); },1000);
  tickClock();

  // Anti false "offline": the SSE stream blips + auto-reconnects (~3s); only warn
  // after a real few-second outage, clear it instantly on reconnect.
  var downTimer=null;
  function setOnline(on){
    if(on){ if(downTimer){clearTimeout(downTimer);downTimer=null;} dot.classList.add('on'); offline.classList.remove('show'); }
    else if(!downTimer){ downTimer=setTimeout(function(){ downTimer=null; dot.classList.remove('on'); offline.classList.add('show'); },5000); }
  }

  // Authoritative /state: loaded BEFORE the SSE stream opens (the inline boot is
  // CSP-blocked), then re-fetched every 60s / on wake / after an SSE recovery. A
  // snapshot whose cursor trails what live events already advanced us past is
  // ignored; otherwise the model is replaced and the stream is opened once, at the
  // right cursor (never replaying from 0).
  function refreshState(){
    fetch(BASE+'/state',{headers:{'X-Requested-With':'fetch'}}).then(function(r){
      if(r.status===401){ location.reload(); return null; }
      return r.ok?r.json():null;
    }).then(function(d){
      if(!d)return;
      if(connected && (d.cursor||0)<cursor) return;   // stale snapshot racing live events — ignore
      cursor=d.cursor||0;
      model=new Map(); (d.tickets||[]).forEach(function(t){model.set(t.id,t);});
      // Self-heal the composer inputs on a stale cached page.
      if(d.spots) SPOTS=(d.spots||[]).slice().sort(function(a,b){return (a.sort_order||0)-(b.sort_order||0);});
      if(d.menu&&d.menu.length) MENU=d.menu;
      if(d.top) TOP=d.top;
      if(d.stats)renderStats(d.stats); if(d.devices)renderDevices(d.devices);
      booted=true; render();
      if(!connected){ connected=true; connect(); }
    }).catch(function(){});
  }
  function pollStats(){
    fetch(BASE+'/stats',{headers:{'X-Requested-With':'fetch'}}).then(function(r){return r.ok?r.json():null;}).then(function(d){
      if(!d)return; if(d.stats)renderStats(d.stats); if(d.devices)renderDevices(d.devices);
    }).catch(function(){});
  }
  setInterval(pollStats,60000);
  setInterval(refreshState,60000);   // authoritative reconciliation every minute
  // Surface the "Cuisine non confirmée" anomaly promptly (its trigger is elapsed
  // time, not an event): re-render every 10s while any NEW ticket is unacked.
  setInterval(function(){ var pend=false; model.forEach(function(t){ if(t.status==='NEW' && !t.ipad_ack_at) pend=true; }); if(pend) render(); },10000);

  render(); refreshState();

  // Live stream with a silent-death watchdog: a half-open socket fires no onerror,
  // so EventSource never reconnects and the board freezes while looking healthy.
  // The server pings every 25s; 60s without a ping/event → rebuild the stream
  // (?since=cursor replays what was missed). On tab wake, check immediately.
  function bump(e){ if(e.lastEventId)cursor=+e.lastEventId; }
  var es=null, lastBeat=Date.now(), firstOpen=true;
  function beat(){ lastBeat=Date.now(); }
  function connect(){
    if(es){ try{es.close();}catch(e){} }
    es=new EventSource(BASE+'/events?since='+cursor);
    es.onopen=function(){ beat(); setOnline(true);
      // A reconnect may have missed events beyond the SSE replay window — reconcile.
      if(firstOpen){ firstOpen=false; } else { refreshState(); } };
    es.onerror=function(){setOnline(false);};
    es.addEventListener('ping',beat);
    es.addEventListener('ticket_new',function(e){ beat(); var t=JSON.parse(e.data); model.set(t.id,t); bump(e); render(); });
    es.addEventListener('ticket_update',function(e){ beat(); var t=JSON.parse(e.data); if(t.status==='READY') clearPendingReady(t.id); model.set(t.id,t); bump(e); render(); });
    es.addEventListener('ticket_removed',function(e){ beat(); var d=JSON.parse(e.data); clearPendingReady(d.id); model.delete(d.id); bump(e); render(); });
    // Cuisine acked a ticket → clear the anomaly on this board.
    es.addEventListener('ticket_ack',function(e){ beat(); var a=JSON.parse(e.data); bump(e); var t=model.get(a.id); if(t){ t.ipad_ack_at=a.ipad_ack_at; render(); } });
  }
  function reconnectIfStale(maxMs){ if(Date.now()-lastBeat>maxMs){ beat(); setOnline(false); connect(); } }
  setInterval(function(){ reconnectIfStale(60000); },15000);
  document.addEventListener('visibilitychange',function(){ if(document.visibilityState==='visible'){ reconnectIfStale(30000); refreshState(); } });

  // ---- Take an order (the owner can also compose a salle order) ----
  // Lean variant of the salle composer: pick an espace, add items (required
  // choices + per-line notes preserved), send. The SERVER decides prices/choices
  // and opens/reuses the spot's session — same endpoint contract as the salle.
  function uuid(){ try{ return crypto.randomUUID(); }catch(e){ return 'r-'+Date.now()+'-'+Math.round(Math.random()*1e9); } }
  function findItem(id){ for(var i=0;i<MENU.length;i++){ for(var j=0;j<MENU[i].items.length;j++){ if(MENU[i].items[j].id===id) return MENU[i].items[j]; } } return null; }
  function normalize(s){ return String(s||'').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g,''); }
  function postJSON(path,body){ return fetch(BASE+path,{method:'POST',headers:{'Content-Type':'application/json','X-Requested-With':'fetch'},body:JSON.stringify(body||{})}); }
  var takeBtn=document.getElementById('take');
  function openComposer(){
    var ov=el('div','ov'); var sh=el('div','sheet');
    sh.setAttribute('role','dialog'); sh.setAttribute('aria-modal','true'); sh.setAttribute('aria-label','Prendre une commande');
    var prevOverflow=document.body.style.overflow; document.body.style.overflow='hidden';
    function close(){ if(ov.parentNode) document.body.removeChild(ov); document.body.style.overflow=prevOverflow; if(takeBtn&&takeBtn.focus){try{takeBtn.focus();}catch(e){}} }
    ov.onclick=function(e){ if(e.target===ov) close(); };
    var x=el('button','close-x','×'); x.setAttribute('aria-label','Fermer'); x.onclick=close; sh.appendChild(x);
    sh.appendChild(el('h2',null,'Prendre une commande'));

    // Spot picker (owner has no tiles) — server opens/reuses the session.
    var spotSel=document.createElement('select'); spotSel.setAttribute('aria-label','Espace');
    var opt0=el('option',null,'— Choisir un espace —'); opt0.value=''; spotSel.appendChild(opt0);
    SPOTS.forEach(function(sp){ var o=el('option',null,sp.label); o.value=sp.id; spotSel.appendChild(o); });
    sh.appendChild(spotSel);
    var fn=el('input'); fn.placeholder='Prénom (optionnel)'; fn.maxLength=40; sh.appendChild(fn);

    var draft={}; var state={takeaway:false, cat:'__ALL__', q:''};
    var modeseg=el('div','modeseg');
    var mHere=el('button','mode sel'); mHere.type='button'; mHere.textContent='🍽️ Sur place';
    var mAway=el('button','mode away'); mAway.type='button'; mAway.textContent='📦 À emporter';
    mHere.setAttribute('aria-pressed','true'); mAway.setAttribute('aria-pressed','false');
    mHere.onclick=function(){ state.takeaway=false; mHere.classList.add('sel'); mAway.classList.remove('sel'); mHere.setAttribute('aria-pressed','true'); mAway.setAttribute('aria-pressed','false'); };
    mAway.onclick=function(){ state.takeaway=true; mAway.classList.add('sel'); mHere.classList.remove('sel'); mAway.setAttribute('aria-pressed','true'); mHere.setAttribute('aria-pressed','false'); };
    modeseg.appendChild(mHere); modeseg.appendChild(mAway); sh.appendChild(modeseg);

    // ── sticky toolbar: real-time search + category chips (same as the salle) ──
    var toolbar=el('div','toolbar');
    var search=el('input','search'); search.placeholder='🔍 Rechercher un article…'; search.setAttribute('inputmode','search'); search.setAttribute('enterkeyhint','search'); search.setAttribute('autocomplete','off'); search.setAttribute('aria-label','Rechercher un article');
    search.oninput=function(){ state.q=search.value; renderList(); };   // live, no Enter
    toolbar.appendChild(search);
    var chips=el('div','chips');
    function setCat(c){ state.cat=c; renderList(); }
    var chipAll=el('button','chip','Tout'); chipAll.onclick=function(){ setCat('__ALL__'); }; chips.appendChild(chipAll);
    var anyFav=MENU.some(function(c){ return c.items.some(function(it){ return it.fav; }); });
    var chipFav=anyFav?el('button','chip fav','⭐ Favoris'):null;
    if(chipFav){ chipFav.onclick=function(){ setCat('__FAV__'); }; chips.appendChild(chipFav); }
    var catChips={};
    MENU.forEach(function(cat){ var ch=el('button','chip',cat.category); ch.onclick=(function(name){return function(){ setCat(name); };})(cat.category); catChips[cat.category]=ch; chips.appendChild(ch); });
    toolbar.appendChild(chips); sh.appendChild(toolbar);

    var listEl=el('div','list'); sh.appendChild(listEl);
    var totalEl;
    function recompute(){ var tot=0; Object.keys(draft).forEach(function(id){ var it=findItem(id); if(it&&draft[id].qty>0) tot+=it.price*draft[id].qty; });
      totalEl.textContent=''; totalEl.appendChild(document.createTextNode(tot+' F ')); totalEl.appendChild(el('small',null,'(indicatif)')); }

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
      function sync(){ var dd=draft[it.id]||{qty:0}; qv.textContent=dd.qty; extra.style.display=dd.qty>0?'block':'none'; row.classList.toggle('on',dd.qty>0);
        var old=nm.querySelector('.qbadge'); if(old) nm.removeChild(old);
        if(dd.qty>0){ var b=el('span','qbadge','×'+dd.qty); nm.insertBefore(b,nm.querySelector('.pr')); }
        markChoice(); recompute(); }
      minus.onclick=function(){ var dd=draft[it.id]||{qty:0,choice:'',note:''}; dd.qty=Math.max(0,dd.qty-1); draft[it.id]=dd; sync(); };
      plus.onclick=function(){ var dd=draft[it.id]||{qty:0,choice:'',note:''}; dd.qty=Math.min(10,dd.qty+1); draft[it.id]=dd; sync(); };
      stp.appendChild(minus); stp.appendChild(qv); stp.appendChild(plus); row.appendChild(stp);
      if(needsChoice){
        creq=el('div','creq'); creq.appendChild(el('div','clab',(it.optionLabel||'Choix')+' · obligatoire'));
        var pills=el('div','cpills');
        it.choices.forEach(function(ch){ var p=el('button','cpill'+(d.choice===ch?' sel':''),ch);
          p.onclick=function(){ var dd=draft[it.id]||{qty:0,choice:'',note:''}; dd.choice=ch; draft[it.id]=dd;
            Array.from(pills.children).forEach(function(c){c.classList.remove('sel');}); p.classList.add('sel'); markChoice(); };
          pills.appendChild(p); });
        creq.appendChild(pills); extra.appendChild(creq);
      }
      extra.appendChild(el('div','lnlab','Note (optionnel)'));
      var ntn=el('input','ln'); ntn.placeholder='ex: sans sucre, bien chaud…'; ntn.maxLength=140; ntn.value=d.note||'';
      ntn.oninput=function(){ var dd=draft[it.id]||{qty:0}; dd.note=ntn.value; draft[it.id]=dd; }; extra.appendChild(ntn);
      row.appendChild(extra); markChoice();
      return row;
    }
    function section(label,items){ if(!items.length) return; listEl.appendChild(el('div','cat',label));
      items.forEach(function(it){ listEl.appendChild(itemRow(it)); }); }
    function renderList(){
      chipAll.classList.toggle('sel',state.cat==='__ALL__'&&!state.q);
      if(chipFav) chipFav.classList.toggle('sel',state.cat==='__FAV__'&&!state.q);
      Object.keys(catChips).forEach(function(k){ catChips[k].classList.toggle('sel',state.cat===k&&!state.q); });
      listEl.textContent='';
      if(!MENU.length){ listEl.appendChild(el('div','nores','Menu indisponible.')); return; }
      var q=normalize(state.q); var any=false;
      var isDefault=!q && state.cat==='__ALL__'; var popIds={};
      if(isDefault){
        var pop=window.__pick.top(MENU,TOP,8); pop.forEach(function(it){ popIds[it.id]=1; });
        if(pop.length){ section('🔥 Populaires',pop); any=true; }
      }
      MENU.forEach(function(cat){
        var items=cat.items.filter(function(it){
          if(q) return normalize(it.name).indexOf(q)>=0;
          if(state.cat==='__FAV__') return !!it.fav;
          if(state.cat!=='__ALL__') return cat.category===state.cat;
          return !popIds[it.id];
        });
        if(!items.length) return;
        section(cat.category, window.__pick.sortItems(items)); any=true;
      });
      if(!any){ listEl.appendChild(el('div','nores','Aucun article trouvé.')); }
    }

    var gnote=el('textarea'); gnote.placeholder='Note générale (optionnel)'; gnote.maxLength=280; sh.appendChild(gnote);
    var msg=el('div','msg'); msg.style.display='none'; sh.appendChild(msg);
    var foot=el('div','foot'); totalEl=el('div','total'); foot.appendChild(totalEl);
    var go=el('button','go','Envoyer en cuisine');
    go.onclick=function(){
      if(!spotSel.value){ msg.textContent='Choisissez un espace.'; msg.style.display='block'; return; }
      var miss=null; Object.keys(draft).forEach(function(id){ var d=draft[id]; if(d.qty>0 && !miss){ var it=findItem(id); if(it&&it.choices&&it.choices.length&&!d.choice) miss=it; } });
      if(miss){ msg.textContent='Choisissez « '+(miss.optionLabel||'option')+' » pour '+miss.name+'.'; msg.style.display='block';
        var r=listEl.querySelector('[data-id="'+miss.id+'"]'); if(r&&r.scrollIntoView) r.scrollIntoView({block:'center'}); return; }
      var items=[]; Object.keys(draft).forEach(function(id){ var d=draft[id]; if(d.qty>0){ var e={item_id:id,qty:d.qty}; if(d.choice)e.choice=d.choice; if(d.note)e.note=d.note; items.push(e); } });
      if(!items.length){ msg.textContent='Ajoutez au moins un article.'; msg.style.display='block'; return; }
      go.disabled=true; msg.style.display='none';
      var body={items:items,note:gnote.value,client_request_id:uuid(),takeaway:state.takeaway}; if(fn.value) body.first_name=fn.value;
      postJSON('/spots/'+spotSel.value+'/orders',body).then(function(r){return r.json().catch(function(){return{};});}).then(function(j){
        if(j&&j.ok){ close(); } else { go.disabled=false; msg.textContent=(j&&j.message)||'Commande refusée. Vérifiez les choix requis.'; msg.style.display='block'; }
      }).catch(function(){ go.disabled=false; msg.textContent='Erreur réseau.'; msg.style.display='block'; });
    };
    foot.appendChild(go); sh.appendChild(foot);
    ov.appendChild(sh); document.body.appendChild(ov);
    renderList(); recompute();
    try{ spotSel.focus(); }catch(e){}
  }
  if(takeBtn) takeBtn.onclick=openComposer;

  // Keep the supervision screen awake while open; re-acquire on visibility return.
  var wakeLock=null;
  function keepAwake(){ if(!('wakeLock' in navigator)||document.visibilityState!=='visible') return;
    navigator.wakeLock.request('screen').then(function(w){ wakeLock=w; }).catch(function(){}); }
  document.addEventListener('visibilitychange',function(){ if(document.visibilityState==='visible') keepAwake(); });
  keepAwake();

  if('serviceWorker' in navigator){ navigator.serviceWorker.register(BASE+'/sw.js').catch(function(){}); }
})();`;
