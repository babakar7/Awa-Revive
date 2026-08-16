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
const ASSET_VERSION = "v26";

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
.tk .timing{display:inline-block;font-size:.78rem;font-weight:800;color:var(--plum-700);background:var(--plum-50);
border:1px solid var(--plum-200);border-radius:999px;padding:.2rem .55rem;margin-top:.35rem}
.tk.scheduled{border-color:var(--plum-300);background:var(--plum-50)}
.tk.urgent{border-color:var(--danger);box-shadow:0 0 0 2px var(--danger-bg)}
.tk .urg{display:inline-block;font-size:.75rem;font-weight:800;color:#fff;background:var(--danger);
border-radius:999px;padding:.15rem .5rem;margin-top:.3rem;letter-spacing:.02em}
button.act.urg{flex:1;background:var(--warn-bg);color:var(--warn);border:1px solid var(--warn-border)}
button.act.urg.on{background:var(--danger);color:#fff;border-color:var(--danger)}
.tk .taken{font-size:.8rem;color:var(--info);margin-top:.25rem}
/* Cuisine-confirmation line: sent → received (auto, on the tablet's ACK) → warn. */
.tk .cuis{font-size:.8rem;font-weight:700;margin-top:.3rem}
.tk .cuis.send{color:var(--ink-500)}
.tk .cuis.ok{color:var(--ok-strong)}
.tk .cuis.warn{color:var(--danger)}
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
/* Dimmed until THIS phone is subscribed — coverage visible at a glance. */
#bell.off{background:var(--cream-100);color:var(--ink-500);border-color:var(--border)}
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
.cfm button.primary{background:var(--plum-600);border-color:var(--plum-600);color:#fff}
.cfm button:disabled{opacity:.5}
/* Alerts panel (🔔) — install/enable/test walkthrough. */
.cfm h3{font-family:var(--serif);font-size:1.2rem;font-weight:600;margin:.1rem 0 .7rem}
.cfm .amsg{font-size:1rem;font-weight:500;color:var(--ink-800);margin:0 0 .8rem}
.cfm .asteps{margin:0 0 .8rem 1.1rem;padding:0;font-size:.95rem;color:var(--ink-700);line-height:1.55}
.cfm .anote{font-size:.82rem;font-weight:400;color:var(--ink-500);margin:.7rem 0 0}
/* Stable height + internal scroll: switching categories changes only the inner
   list, never the sheet box, so the sheet never jumps as list size varies. */
.sheet{position:relative;display:flex;flex-direction:column;background:var(--surface);width:100%;max-width:34rem;
height:96vh;height:96dvh;overflow:hidden;overscroll-behavior:contain;
border-radius:var(--radius-xl) var(--radius-xl) 0 0;box-shadow:var(--shadow-2);
padding:.75rem .8rem;padding-bottom:calc(.55rem + env(safe-area-inset-bottom));animation:sheet-up .3s var(--ease)}
.list{flex:1 1 auto;min-height:0;overflow-y:auto;-webkit-overflow-scrolling:touch;overscroll-behavior:contain}
@keyframes sheet-up{0%{transform:translateY(24px);opacity:.5}100%{transform:none;opacity:1}}
.sheet::before{content:"";display:block;width:2.6rem;height:.3rem;border-radius:99px;background:var(--border-strong);margin:0 auto .7rem}
.sheet h2{font-family:var(--serif);font-size:1.25rem;font-weight:600;letter-spacing:-.02em;margin:0 2.7rem .55rem 0}
.modeseg{display:flex;gap:.45rem;margin:0 0 .55rem}
.modeseg .mode{flex:1;min-height:2.75rem;padding:.7rem;border-radius:var(--radius);border:1px solid var(--border);
background:var(--surface-raised);color:var(--ink-700);font-weight:700;font-size:.95rem}
.modeseg .mode.sel{background:var(--plum-600);border-color:var(--plum-600);color:#fff}
.modeseg .mode.away.sel{background:var(--info);border-color:var(--info);color:#fff}
.later-picker{margin:0 0 .55rem;padding:.5rem;border:1px solid var(--border-soft);border-radius:var(--radius);background:var(--surface-raised)}
.later-toggle{width:100%;min-height:2.65rem;border:1px solid var(--border-strong);border-radius:var(--radius);background:#fff;color:var(--ink-700);font-weight:750;font-size:.95rem}
.later-toggle.sel{border-color:var(--plum-600);background:var(--plum-50);color:var(--plum-700)}
.later-options{display:grid;grid-template-columns:1fr 1fr;gap:.4rem;margin-top:.45rem}.later-options[hidden]{display:none}
.later-delay{min-height:2.65rem;border:1px solid var(--border-strong);border-radius:var(--radius);background:#fff;color:var(--ink-700);font-weight:750}
.later-delay.sel{border-color:var(--plum-600);background:var(--plum-600);color:#fff}
/* Test-order toggle: quiet when off, loud (danger) when on so it's never sent by accident. */
.testrow{display:flex;align-items:center;gap:.6rem;margin:0 0 .6rem;padding:.6rem .7rem;border-radius:var(--radius);
border:1px dashed var(--border-strong);background:var(--surface-raised);color:var(--ink-500);font-size:.9rem;font-weight:600}
.testrow.on{border-style:solid;border-color:var(--danger);background:var(--danger-bg);color:var(--danger)}
.testrow .testcb{width:1.3rem;height:1.3rem;flex:0 0 auto;accent-color:var(--danger)}
.sheet input,.sheet textarea{width:100%;padding:.8rem;border-radius:var(--radius);border:1px solid var(--border);
background:#fff;color:var(--ink-900);font-size:1rem;font-family:inherit}
.sheet textarea{min-height:3rem}.optional{border:1px solid var(--border-soft);border-radius:var(--radius);background:var(--surface-raised);margin-bottom:.55rem}
.optional summary{padding:.65rem .75rem;cursor:pointer;font-weight:700;color:var(--ink-600);font-size:.88rem}
.optional-fields{padding:0 .65rem .1rem}.optional input,.optional textarea{margin:0 0 .55rem}
/* sticky search + category chips */
.toolbar{position:sticky;top:0;z-index:3;background:var(--surface);padding:.05rem 0 .45rem}
.searchbar{display:flex;align-items:stretch;gap:.4rem}.searchbar .search{flex:1;min-width:0;margin-bottom:.45rem}
.searchbar>.cart{min-height:2.75rem;margin:0 0 .45rem auto}
.searchctl{display:none;min-width:3rem;height:2.75rem;border:1px solid var(--border);border-radius:var(--radius);background:#fff;
color:var(--plum-700);font-weight:750;padding:0 .65rem}
.search-summary{display:none;align-items:center;gap:.4rem;min-height:2rem;margin:-.15rem 3rem .35rem 0;color:var(--ink-600);font-size:.82rem;font-weight:700}
.search-summary .dotsep{color:var(--ink-300)}
.browsebar{display:block}.browsebar .chips{width:100%}
.chips{display:flex;gap:.4rem;overflow-x:auto;-webkit-overflow-scrolling:touch;padding-bottom:.2rem;scrollbar-width:none}
.chips::-webkit-scrollbar{display:none}
.chip{flex:0 0 auto;padding:.55rem .95rem;border-radius:999px;background:var(--rose);border:1px solid transparent;
color:var(--plum-600);font-size:.88rem;font-weight:600;white-space:nowrap}
.chip.sel{background:var(--plum-600);border-color:var(--plum-600);color:#fff}
.chip.cart{margin-left:auto;background:var(--ok-bg);border-color:var(--ok-border);color:var(--ok-strong);font-weight:800}
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
.clab{display:block;width:100%;padding:0;border:0;background:none;text-align:left;font-family:inherit;font-size:.75rem;font-weight:700;
color:var(--ink-500);margin-bottom:.4rem;text-transform:uppercase;letter-spacing:.05em}
.creq.missing .clab{color:var(--warn)}
.creq.collapsed{padding:.42rem .58rem;border-color:var(--ok-border);background:var(--ok-bg)}
.creq.collapsed .clab{margin:0;color:var(--ok);text-transform:none;letter-spacing:0;font-size:.82rem}
.creq.collapsed .cpills{display:none}
.cpills{display:flex;gap:.45rem;flex-wrap:wrap}
.cpill{padding:.55rem .9rem;border-radius:999px;border:1px solid var(--border-strong);background:#fff;color:var(--ink-700);font-weight:600;font-size:.95rem}
.cpill.sel{background:var(--ok-strong);border-color:var(--ok-strong);color:#fff}
.mi.needchoice{outline:2px solid var(--warn-border);outline-offset:2px;border-radius:var(--radius)}
.mi .ln{margin-top:.5rem;font-size:.92rem;padding:.55rem}
.mi .lnlab{font-size:.75rem;color:var(--ink-500);margin-top:.5rem}
.wrap{width:100%}
.nores{color:var(--ink-500);text-align:center;padding:2rem 0}
.foot{position:sticky;bottom:0;background:var(--surface);padding:.5rem 0 0;display:flex;gap:.55rem;align-items:center;
border-top:1px solid var(--border-soft)}
.total{font-weight:800;font-size:.95rem;white-space:nowrap;line-height:1.15}
.total small{display:block;color:var(--ink-500);font-weight:500;font-size:.7rem}
.foot button.go{flex:1;padding:.95rem;border:none;border-radius:12px;background:var(--ok-strong);color:#fff;
font-weight:800;font-size:1.02rem;box-shadow:var(--shadow-1)}
.foot button.go:disabled{opacity:.45}
.close-x{position:absolute;top:.55rem;right:.6rem;background:none;border:none;color:var(--ink-500);font-size:1.7rem;line-height:1;z-index:4;min-width:2.75rem;min-height:2.75rem}
.msg{color:var(--danger);font-size:.88rem;margin:.25rem 0}.msg[hidden]{display:none}
.toast{position:fixed;z-index:40;left:50%;bottom:calc(1rem + env(safe-area-inset-bottom));transform:translateX(-50%);
max-width:calc(100% - 2rem);padding:.75rem 1rem;border-radius:999px;background:var(--ok-strong);color:#fff;font-weight:750;
box-shadow:var(--shadow-2);animation:pop .2s var(--ease);white-space:nowrap}
/* Focused search spends the keyboard-reduced viewport on dense menu rows. */
.sheet.searching .sheet-title,.sheet.searching .modeseg,.sheet.searching .later-picker,.sheet.searching .optional,.sheet.searching .browsebar{display:none}
.sheet.searching::before{display:none}.sheet.searching .search-summary,.sheet.searching .searchctl{display:flex}
.sheet.searching .searchbar>.cart{display:none}.sheet.searching{padding-top:.55rem}.sheet.searching .toolbar{padding-bottom:.15rem}
.sheet.searching .mi{padding:.35rem .2rem;gap:.35rem;flex-wrap:wrap}.sheet.searching .mi .nm{font-size:.94rem;min-width:7rem}
.sheet.searching .mi .nm .pr{font-size:.76rem}.sheet.searching .stepper{gap:.3rem}.sheet.searching .stepper button{width:2.55rem;height:2.55rem}
.sheet.searching .cat{font-size:.76rem;margin:.4rem 0 .1rem;padding-bottom:.2rem}
.sheet.searching .creq.collapsed~.lnlab,.sheet.searching .creq.collapsed~.ln{display:none}.sheet.searching .foot{padding-top:.3rem}
@media(min-width:42rem){.sheet{max-width:42rem}}@media(max-height:620px){.sheet{height:100vh;height:100dvh;border-radius:0}.sheet::before{display:none}}
`;

export function serviceBoardPage(): string {
  // No inline boot: script-src 'self' blocks it. The client fetches /state before
  // opening SSE, so the board is DB-authoritative from the first paint.
  return `<!doctype html><html lang="fr"><head>${opsHead(BASE, "Salle")}<title>Salle Revive</title>
<style>${OPS_TOKENS}${OPS_BASE}${APP_STYLE}</style></head><body>
<div id="offline">Hors ligne — reconnexion…</div>
<header><span id="dot" class="dot"></span><span class="logo">${OPS_LOGO_SVG}</span><h1>Salle</h1><span class="spacer"></span><button id="hist" aria-label="Tables récentes">🕐</button><button id="snd" class="sndbtn" aria-label="Activer/couper le son">🔊</button><button id="bell" class="off" aria-label="Alertes commandes prêtes">🔔 Alertes</button><span class="count" id="count"></span></header>
<main id="board"><p class="empty" id="empty">Chargement…</p></main>
<noscript>Activez JavaScript pour la prise de commande en salle.</noscript>
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
    vibrate:[200,100,200,100,300],   // Android vibrates; iOS vibrates per system settings
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
export const SERVICE_APP_JS = OPS_PICKER_HELPERS + String.raw`(function(){
  var BASE=${JSON.stringify(BASE)};
  var cursor=0;                    // event cursor; seeded from /state before SSE opens
  var connected=false;             // SSE opened once, after the first /state
  var SPOTS=[];
  var MENU=[];
  var TOP=[];
  var loaded=false, loadTries=0;   // load-state guard (see refreshState/retryLoad)
  var sessions=new Map();
  var tickets=new Map();
  // Per-device cuisine-confirmation tracking for orders THIS phone just sent:
  // sentAt[id] while awaiting the tablet's ACK, overdue[id] once 10s lapsed with none.
  var sentAt={}, overdue={};
  var board=document.getElementById('board');
  var countEl=document.getElementById('count');
  var dot=document.getElementById('dot');
  var offline=document.getElementById('offline');
  var bell=document.getElementById('bell');
  var VAPID='';

  // Paint + load the board FIRST, before any optional audio/push/composer setup —
  // so a throw in any of that can never leave the board stuck on "Chargement…"
  // (the "works again if I close and reopen the app" bug). Helpers below are
  // function declarations, hoisted, so they're callable here.
  render();
  refreshState();

  function el(tag,cls,txt){ var e=document.createElement(tag); if(cls)e.className=cls; if(txt!=null)e.textContent=txt; return e; }
  function uuid(){ try{ return crypto.randomUUID(); }catch(e){ return 'r-'+Date.now()+'-'+Math.round(Math.random()*1e9); } }
  function findItem(id){ for(var i=0;i<MENU.length;i++){ for(var j=0;j<MENU[i].items.length;j++){ if(MENU[i].items[j].id===id) return MENU[i].items[j]; } } return null; }
  function sessionForSpot(spotId){ var found=null; sessions.forEach(function(s){ if(s.spot_id===spotId) found=s; }); return found; }
  function ticketsOf(sid){ var out=[]; tickets.forEach(function(t){ if(t.session_id===sid) out.push(t); }); return out.sort(function(a,b){var sa=a.scheduled_for&&!a.activated_at?1:0,sb=b.scheduled_for&&!b.activated_at?1:0;return (sa-sb)||(new Date((sa?a.scheduled_for:a.activated_at)||a.created_at)-new Date((sb?b.scheduled_for:b.activated_at)||b.created_at));}); }
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
  // iOS requires ONE speak() inside a real user gesture per page load before any
  // programmatic announcement is allowed — resume() alone does NOT count. Without
  // this, a freshly reloaded board stays mute until someone toggles 🔇→🔊. The
  // first tap anywhere speaks an empty utterance: inaudible, but it activates
  // the engine for the SSE-driven alerts.
  var primed=false;
  function primeSpeech(){ if(primed||muted||!window.speechSynthesis) return;
    try{ speechSynthesis.speak(new SpeechSynthesisUtterance('')); primed=true; }catch(e){} }
  function unlock(){ if(!actx){ try{ actx=new (window.AudioContext||window.webkitAudioContext)(); }catch(e){} } if(actx&&actx.state==='suspended'){ actx.resume(); }
    // Warm speech on the gesture: prime once, resume any paused queue, load voices.
    if(window.speechSynthesis){ try{ primeSpeech(); speechSynthesis.resume(); loadVoices(); }catch(e){} } }
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
  // WebKit quirk on long-running pages: after hours of idle the TTS engine
  // silently pauses and later utterances queue without playing. A resume()
  // heartbeat (harmless when idle) + a kick on return-to-foreground prevent it.
  if(window.speechSynthesis){ setInterval(function(){ try{ speechSynthesis.resume(); }catch(e){} },4000); }
  document.addEventListener('visibilitychange',function(){ if(document.visibilityState==='visible'&&window.speechSynthesis){ try{ speechSynthesis.resume(); loadVoices(); }catch(e){} } });
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
    return (t.scheduled_for?'Commande prévue pour '+hhmm(t.scheduled_for):'Nouvelle commande')+(t.takeaway?' à emporter':'')+(w?', '+w:'')+(it?'. '+it:''); }
  // A dish going READY is the moment a server must act on — hit it harder than a
  // new order: triple bip + vibration (no-op on iOS but free) + a spoken cue.
  function vibrate(pattern){ try{ if(navigator.vibrate) navigator.vibrate(pattern); }catch(e){} }
  function readyAlert(t){ if(muted) return; beep(); setTimeout(beep,260); setTimeout(beep,520);
    vibrate([200,100,200,100,300]); speak('Commande prête'+((function(){var w=spotSpeech(t);return w?', '+w:'';})())); }

  function post(path,body){ return fetch(BASE+path,{method:'POST',headers:{'Content-Type':'application/json','X-Requested-With':'fetch'},body:JSON.stringify(body||{})}); }

  function ticketCard(t){
    var waiting=!!(t.scheduled_for&&!t.activated_at);
    var d=el('div','tk'+(waiting?' scheduled':'')+(t.urgent?' urgent':'')); d.dataset.id=t.id;
    (t.items||[]).forEach(function(l,i){ var ln=el('div','line');
      ln.appendChild(el('span','q',l.qty+'×'));
      ln.appendChild(document.createTextNode(' '+l.name+(l.choice?' ('+l.choice+')':'')));
      if(i===0){ var st=el('span','st '+t.status.toLowerCase(), waiting?'Prévue':t.status==='READY'?'Prête':t.status==='PREPARING'?'En prépa':'Envoyée'); ln.appendChild(st); }
      d.appendChild(ln);
      if(l.note) d.appendChild(el('div','tnote','• '+l.note));
    });
    if(t.note) d.appendChild(el('div','tnote','📝 '+t.note));
    if(t.takeaway) d.appendChild(el('div','away','📦 À emporter'));
    if(t.scheduled_for) d.appendChild(el('div','timing','⏰ '+(waiting?'Prévue pour ':'Pour ')+hhmm(t.scheduled_for)));
    if(t.urgent) d.appendChild(el('div','urg','⚡ Urgent'));
    // Cuisine confirmation for orders THIS phone sent: "Envoi…" → auto "Reçue ✓" on
    // the tablet's ACK → "non confirmée" only if the authoritative state still has
    // no ack after 10s. Never shown once READY (the order clearly reached the kitchen).
    if(t.status!=='READY'&&!waiting){
      if(t.ipad_ack_at){ d.appendChild(el('div','cuis ok','✓ Reçue par Cuisine')); }
      else if(overdue[t.id]){ d.appendChild(el('div','cuis warn','⚠︎ Cuisine non confirmée — vérifiez la tablette')); }
      else if(sentAt[t.id]!=null){ d.appendChild(el('div','cuis send','Envoi à Cuisine…')); }
    }
    if(waiting){
      var futureActs=el('div','tacts');
      var now=el('button','act take','Préparer maintenant'); now.onclick=function(){ now.disabled=true; post('/tickets/'+t.id+'/prepare-now',{}).then(function(r){if(!r.ok)now.disabled=false;}).catch(function(){now.disabled=false;}); }; futureActs.appendChild(now);
      var futureCx=el('button','act cancel','✕'); futureCx.setAttribute('aria-label','Annuler cette commande prévue');
      futureCx.onclick=function(){ askConfirm('Annuler cette commande prévue ?','Oui, annuler la commande','Non, garder la commande',function(){ futureCx.disabled=true; post('/tickets/'+t.id+'/cancel',{reason:'commande prévue annulée en salle'}).then(function(r){if(!r.ok)futureCx.disabled=false;}).catch(function(){futureCx.disabled=false;}); }); };
      futureActs.appendChild(futureCx); d.appendChild(futureActs);
    } else if(t.status==='READY'){
      var acts=el('div','tacts');
      // ONE tap: the server takes the ready order to the client. It both claims and
      // completes the ticket (the /served endpoint completes any READY ticket), so
      // the old two-step "Je prends" → "Servie" is gone — simpler for everyone.
      var sv=el('button','act serve','🙋 Je prends'); sv.onclick=function(){ sv.disabled=true; post('/tickets/'+t.id+'/served',{}).then(function(r){if(!r.ok)sv.disabled=false;}).catch(function(){sv.disabled=false;}); }; acts.appendChild(sv);
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
      // Before the first /state resolves, keep the honest "Chargement…"; only once
      // loaded (or given up after retries) do we offer the one-tap reload — so a
      // slow first load never looks like a dead "aucun espace" end.
      var e=el('p','empty', loaded?'Aucun espace chargé.':'Chargement…');
      if(loaded){
        e.appendChild(document.createElement('br'));
        var b=el('button','sec','↻ Recharger'); b.style.marginTop='1rem'; b.style.maxWidth='12rem';
        b.onclick=function(){ location.reload(); };
        e.appendChild(b);
      }
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

  function showServiceNotice(message){
    var old=document.querySelector('.toast'); if(old&&old.parentNode) old.parentNode.removeChild(old);
    var notice=el('div','toast',message); notice.setAttribute('role','status'); notice.setAttribute('aria-live','polite');
    document.body.appendChild(notice); setTimeout(function(){if(notice.parentNode)notice.parentNode.removeChild(notice);},2800);
  }

  function openOrder(sp,session,trigger){
    unlock();
    var ov=overlay(); var sh=el('div','sheet');
    sh.setAttribute('role','dialog'); sh.setAttribute('aria-modal','true');
    sh.setAttribute('aria-label','Nouvelle commande — '+sp.label);
    var prevOverflow=document.body.style.overflow; document.body.style.overflow='hidden';
    var draft={};
    var state={cat:'__ALL__',q:'',cartOnly:false,takeaway:false,test:false,readyIn:0,searching:false,sending:false};
    var totalEl,cartChip,searchCart,listEl,go,msg,search,summaryMode,summaryWhen;
    function returnFocus(){ var t=trigger;
      if(!t||!t.isConnected){ var host=board.querySelector('[data-spot="'+sp.id+'"]');
        t=host&&host.tagName==='BUTTON'?host:(host?host.querySelector('button'):null); }
      if(t&&t.focus){ try{ t.focus(); }catch(e){} } }
    function closeSheet(){
      if(window.visualViewport){window.visualViewport.removeEventListener('resize',fitViewport);window.visualViewport.removeEventListener('scroll',fitViewport);}
      window.removeEventListener('resize',fitViewport);
      if(ov.parentNode)document.body.removeChild(ov); document.body.style.overflow=prevOverflow; returnFocus();
    }
    function requestClose(){ if(cartCount()>0){ askConfirm('Abandonner cette commande ?','Oui, abandonner','Non, continuer la saisie',closeSheet); return; } closeSheet(); }
    function fitViewport(){ var vv=window.visualViewport;
      if(vv){ov.style.height=Math.round(vv.height)+'px';ov.style.top=Math.round(vv.offsetTop)+'px';ov.style.bottom='auto';sh.style.height='100%';}
      else{ov.style.height='';ov.style.top='';ov.style.bottom='';sh.style.height='';} }
    ov.onclick=function(e){ if(e.target===ov) requestClose(); };
    var x=el('button','close-x','×'); x.type='button'; x.setAttribute('aria-label','Fermer la commande'); x.onclick=requestClose; sh.appendChild(x);
    sh.appendChild(el('h2','sheet-title','Commande — '+sp.label));

    var modeseg=el('div','modeseg');
    var mHere=el('button','mode sel'); mHere.type='button'; mHere.textContent='🍽️ Sur place';
    var mAway=el('button','mode away'); mAway.type='button'; mAway.textContent='📦 À emporter';
    mHere.setAttribute('aria-pressed','true'); mAway.setAttribute('aria-pressed','false');
    function paintMode(){mHere.classList.toggle('sel',!state.takeaway);mAway.classList.toggle('sel',state.takeaway);
      mHere.setAttribute('aria-pressed',state.takeaway?'false':'true');mAway.setAttribute('aria-pressed',state.takeaway?'true':'false');
      summaryMode.textContent=state.takeaway?'À emporter':'Sur place';}
    mHere.onclick=function(){state.takeaway=false;paintMode();}; mAway.onclick=function(){state.takeaway=true;paintMode();};
    modeseg.appendChild(mHere); modeseg.appendChild(mAway); sh.appendChild(modeseg);

    // Immediate remains the quiet default. "Pour plus tard" exposes exactly the
    // two operational presets requested by the team — no free-form time entry.
    var laterPicker=el('div','later-picker');
    var laterToggle=el('button','later-toggle','⏰ Pour plus tard'); laterToggle.type='button'; laterToggle.setAttribute('aria-pressed','false');
    var laterOptions=el('div','later-options'); laterOptions.hidden=true;
    var delayButtons=[];
    function clockAfter(mins){ var d=new Date(Date.now()+mins*60000); return (d.getHours()<10?'0':'')+d.getHours()+':'+(d.getMinutes()<10?'0':'')+d.getMinutes(); }
    function paintTiming(){ var on=state.readyIn===30||state.readyIn===50;
      laterToggle.classList.toggle('sel',on); laterToggle.setAttribute('aria-pressed',on?'true':'false');
      laterToggle.textContent=on?'⏰ Pour plus tard · '+state.readyIn+' min':'⏰ Pour plus tard'; laterOptions.hidden=!on;
      delayButtons.forEach(function(b){var sel=+b.dataset.delay===state.readyIn;b.classList.toggle('sel',sel);b.setAttribute('aria-pressed',sel?'true':'false');b.textContent=b.dataset.delay+' min · '+clockAfter(+b.dataset.delay);});
      if(summaryWhen)summaryWhen.textContent=on?'Dans '+state.readyIn+' min':'Maintenant'; if(go)recompute(); }
    laterToggle.onclick=function(){ state.readyIn=state.readyIn?0:50; paintTiming(); };
    [30,50].forEach(function(mins){ var b=el('button','later-delay');b.type='button';b.dataset.delay=String(mins);b.setAttribute('aria-pressed','false');
      b.onclick=function(){state.readyIn=mins;paintTiming();};delayButtons.push(b);laterOptions.appendChild(b); });
    laterPicker.appendChild(laterToggle);laterPicker.appendChild(laterOptions);sh.appendChild(laterPicker);

    // Prénom, note générale and the service-only test flag are intentionally
    // collapsed so the menu receives most of the phone viewport.
    var optional=document.createElement('details'); optional.className='optional';
    var optionalSummary=document.createElement('summary'); optionalSummary.textContent='Détails optionnels'; optional.appendChild(optionalSummary);
    var optionalFields=el('div','optional-fields'); var fn=null;
    if(!session){fn=el('input');fn.placeholder='Prénom';fn.maxLength=40;fn.setAttribute('autocomplete','given-name');optionalFields.appendChild(fn);}
    var gnote=el('textarea');gnote.placeholder='Note générale pour la table';gnote.maxLength=280;optionalFields.appendChild(gnote);
    var testRow=el('label','testrow'); testRow.setAttribute('role','switch'); testRow.setAttribute('aria-checked','false');
    var testCb=document.createElement('input'); testCb.type='checkbox'; testCb.className='testcb';
    testCb.onchange=function(){ state.test=testCb.checked; testRow.classList.toggle('on',testCb.checked); testRow.setAttribute('aria-checked',testCb.checked?'true':'false'); };
    testRow.appendChild(testCb); testRow.appendChild(el('span',null,'🧪 Commande test — exclue des statistiques'));
    optionalFields.appendChild(testRow); optional.appendChild(optionalFields); sh.appendChild(optional);

    var searchSummary=el('div','search-summary'); searchSummary.appendChild(el('span',null,sp.label));
    searchSummary.appendChild(el('span','dotsep','·')); summaryMode=el('span',null,'Sur place'); searchSummary.appendChild(summaryMode);
    searchSummary.appendChild(el('span','dotsep','·')); summaryWhen=el('span',null,'Maintenant'); searchSummary.appendChild(summaryWhen);
    searchCart=el('button','chip cart','Panier (0)'); searchCart.type='button'; searchSummary.appendChild(searchCart); sh.appendChild(searchSummary);

    function cartCount(){ var n=0; Object.keys(draft).forEach(function(id){ if(draft[id].qty>0) n+=draft[id].qty; }); return n; }
    function recompute(){
      if(!totalEl)return;
      var tot=0; Object.keys(draft).forEach(function(id){ var it=findItem(id); if(it&&draft[id].qty>0) tot+=it.price*draft[id].qty; });
      var n=cartCount();totalEl.textContent='';totalEl.appendChild(document.createTextNode(n+' article'+(n>1?'s':'')+' · '+tot+' F'));totalEl.appendChild(el('small',null,'Total indicatif'));
      cartChip.textContent='Panier ('+n+')';searchCart.textContent='Panier ('+n+')';cartChip.classList.toggle('sel',state.cartOnly);searchCart.classList.toggle('sel',state.cartOnly);
      go.textContent=n?(state.readyIn?'Programmer · '+state.readyIn+' min':'Envoyer en cuisine'):'Ajouter des articles';
    }

    // Search mode keeps the keyboard-open viewport focused on dense results.
    var toolbar=el('div','toolbar');
    var searchbar=el('div','searchbar'); search=el('input','search');search.placeholder='🔍 Rechercher un article…';search.setAttribute('inputmode','search');search.setAttribute('enterkeyhint','search');search.setAttribute('autocomplete','off');search.setAttribute('aria-label','Rechercher un article');
    var clearSearch=el('button','searchctl','×');clearSearch.type='button';clearSearch.setAttribute('aria-label','Effacer la recherche');
    var doneSearch=el('button','searchctl','Terminé');doneSearch.type='button';
    function enterSearch(){if(state.cartOnly)state.cartOnly=false;state.searching=true;sh.classList.add('searching');renderList();fitViewport();}
    function finishSearch(){state.searching=false;sh.classList.remove('searching');try{search.blur();}catch(e){}renderList();fitViewport();}
    search.onfocus=enterSearch;search.oninput=function(){state.q=search.value;state.cartOnly=false;renderList();};
    clearSearch.onpointerdown=function(e){e.preventDefault();};clearSearch.onclick=function(){state.q='';search.value='';renderList();try{search.focus();}catch(e){}};
    doneSearch.onclick=finishSearch;searchbar.appendChild(search);searchbar.appendChild(clearSearch);searchbar.appendChild(doneSearch);toolbar.appendChild(searchbar);
    var chips=el('div','chips');
    function setCat(c){ state.cat=c; state.cartOnly=false; renderList(); }
    var chipAll=el('button','chip','Tout'); chipAll.onclick=function(){ setCat('__ALL__'); }; chips.appendChild(chipAll);
    var anyFav=MENU.some(function(c){ return c.items.some(function(it){ return it.fav; }); });
    var chipFav=anyFav?el('button','chip fav','⭐ Favoris'):null;
    if(chipFav){ chipFav.onclick=function(){ setCat('__FAV__'); }; chips.appendChild(chipFav); }
    var catChips={};
    MENU.forEach(function(cat){ var ch=el('button','chip',cat.category); ch.onclick=(function(name){return function(){ setCat(name); };})(cat.category); catChips[cat.category]=ch; chips.appendChild(ch); });
    cartChip=el('button','chip cart','Panier (0)');cartChip.type='button';searchbar.appendChild(cartChip);
    function showCart(){state.cartOnly=true;state.q='';search.value='';finishSearch();renderList();}
    cartChip.onclick=function(){if(state.cartOnly){state.cartOnly=false;renderList();}else showCart();};searchCart.onclick=showCart;
    var browsebar=el('div','browsebar');browsebar.appendChild(chips);toolbar.appendChild(browsebar);sh.appendChild(toolbar);

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
      var extra=el('div','wrap');extra.style.display=(d.qty>0&&(!state.searching||needsChoice||state.cartOnly))?'block':'none';
      var creq=null;
      function markChoice(){ if(!creq)return; var dd=draft[it.id]||{qty:0}; var miss=dd.qty>0 && !dd.choice; creq.classList.toggle('missing',miss); row.classList.toggle('needchoice',miss); }
      function sync(){ var dd=draft[it.id]||{qty:0}; qv.textContent=dd.qty;
        extra.style.display=(dd.qty>0&&(!state.searching||needsChoice||state.cartOnly))?'block':'none'; row.classList.toggle('on',dd.qty>0);
        var old=nm.querySelector('.qbadge'); if(old) nm.removeChild(old);
        if(dd.qty>0){ var b=el('span','qbadge','×'+dd.qty); nm.insertBefore(b,nm.querySelector('.pr')); }
        markChoice(); recompute();
      }
      minus.onpointerdown=function(e){if(state.searching)e.preventDefault();};plus.onpointerdown=function(e){if(state.searching&&!needsChoice)e.preventDefault();};
      minus.onclick=function(){ var dd=draft[it.id]||{qty:0,choice:'',note:''}; dd.qty=Math.max(0,dd.qty-1); draft[it.id]=dd; sync(); if(state.cartOnly&&dd.qty===0) renderList(); };
      plus.onclick=function(){var dd=draft[it.id]||{qty:0,choice:'',note:''};var wasEmpty=dd.qty===0;dd.qty=Math.min(10,dd.qty+1);draft[it.id]=dd;sync();
        if(state.searching){state.q='';search.value='';finishSearch();setTimeout(function(){var fresh=listEl.querySelector('[data-id="'+it.id+'"]');if(fresh&&fresh.scrollIntoView)fresh.scrollIntoView({block:'center'});},50);}};
      stp.appendChild(minus); stp.appendChild(qv); stp.appendChild(plus); row.appendChild(stp);
      if(needsChoice){
        creq=el('div','creq');var optionName=it.optionLabel||'Choix';var choiceLabel=el('button','clab');choiceLabel.type='button';creq.appendChild(choiceLabel);
        var pills=el('div','cpills');
        function paintChoice(){var dd=draft[it.id]||d;var picked=dd.choice||'';creq.classList.toggle('collapsed',!!picked);
          choiceLabel.textContent=picked?optionName+' · '+picked+' ✓ — modifier':optionName+' · obligatoire';choiceLabel.setAttribute('aria-expanded',picked?'false':'true');}
        choiceLabel.onclick=function(){var dd=draft[it.id]||d;if(!dd.choice)return;var folded=creq.classList.toggle('collapsed');choiceLabel.setAttribute('aria-expanded',folded?'false':'true');if(!folded&&creq.scrollIntoView)creq.scrollIntoView({block:'center'});};
        it.choices.forEach(function(ch){
          var p=el('button','cpill'+(d.choice===ch?' sel':''),ch);
          p.onclick=function(){ var dd=draft[it.id]||{qty:0,choice:'',note:''}; dd.choice=ch; draft[it.id]=dd;
            Array.from(pills.children).forEach(function(c){c.classList.remove('sel');});p.classList.add('sel');paintChoice();markChoice();if(state.searching){try{search.focus();}catch(e){}} };
          pills.appendChild(p);
        });
        creq.appendChild(pills);extra.appendChild(creq);paintChoice();
      }
      extra.appendChild(el('div','lnlab','Note (optionnel)'));
      var ntn=el('input','ln'); ntn.placeholder='ex: sans sucre, bien chaud…'; ntn.maxLength=140; ntn.value=d.note||'';
      ntn.oninput=function(){ var dd=draft[it.id]||{qty:0}; dd.note=ntn.value; draft[it.id]=dd; }; extra.appendChild(ntn);
      row.appendChild(extra);markChoice();
      return row;
    }

    function section(label,items){ if(!items.length) return; listEl.appendChild(el('div','cat',label));
      items.forEach(function(it){ listEl.appendChild(itemRow(it)); }); }
    function renderList(){
      // sync chip highlight
      chipAll.classList.toggle('sel',state.cat==='__ALL__'&&!state.q&&!state.cartOnly);
      if(chipFav) chipFav.classList.toggle('sel',state.cat==='__FAV__'&&!state.q&&!state.cartOnly);
      Object.keys(catChips).forEach(function(k){ catChips[k].classList.toggle('sel',state.cat===k&&!state.q&&!state.cartOnly); });
      cartChip.classList.toggle('sel',state.cartOnly);
      listEl.textContent='';
      if(!MENU.length){listEl.appendChild(el('div','nores','Menu indisponible.'));return;}
      var q=normalize(state.q);
      var any=false;
      // The default "Tout" view leads with 🔥 Populaires (best-sellers, server-
      // computed) so matchas/toasts/brunch are reachable with zero scrolling. Those
      // items are then skipped in their own category so each appears exactly once
      // (no duplicate row → no qty-badge desync).
      var isDefault=!q && !state.cartOnly && state.cat==='__ALL__';
      var popIds={};
      if(isDefault){
        var pop=window.__pick.top(MENU,TOP,8);
        pop.forEach(function(it){ popIds[it.id]=1; });
        if(pop.length){ section('🔥 Populaires',pop); any=true; }
      }
      MENU.forEach(function(cat){
        var items=cat.items.filter(function(it){
          if(state.cartOnly) return (draft[it.id]&&draft[it.id].qty>0);
          if(q) return normalize(it.name).indexOf(q)>=0;
          if(state.cat==='__FAV__') return !!it.fav;
          if(state.cat!=='__ALL__') return cat.category===state.cat;
          return !popIds[it.id];   // default view: don't repeat a Populaire below
        });
        if(!items.length) return;
        // ⭐ favourites first, "Supplément…" add-ons last, else server order.
        section(cat.category, window.__pick.sortItems(items));
        any=true;
      });
      if(!any){ listEl.appendChild(el('div','nores', state.cartOnly?'Panier vide — ajoutez des articles.':'Aucun article trouvé.')); }
      recompute();
    }

    msg=el('div','msg');msg.hidden=true;msg.setAttribute('role','alert');sh.appendChild(msg);function setError(text){msg.textContent=text;msg.hidden=false;}
    var foot=el('div','foot'); totalEl=el('div','total'); foot.appendChild(totalEl);
    go=el('button','go','Ajouter des articles');
    go.onclick=function(){
      var miss=null;
      Object.keys(draft).forEach(function(id){ var d=draft[id]; if(d.qty>0 && !miss){ var it=findItem(id); if(it&&it.choices&&it.choices.length&&!d.choice) miss=it; } });
      if(miss){
        setError('Choisissez « '+(miss.optionLabel||'option')+' » pour '+miss.name+'.');state.cartOnly=true;state.q='';search.value='';finishSearch();renderList();
        var r=listEl.querySelector('[data-id="'+miss.id+'"]'); if(r&&r.scrollIntoView) r.scrollIntoView({block:'center'});
        return;
      }
      var items=[]; Object.keys(draft).forEach(function(id){ var d=draft[id]; if(d.qty>0){ var e={item_id:id,qty:d.qty}; if(d.choice)e.choice=d.choice; if(d.note)e.note=d.note; items.push(e); } });
      if(!items.length){setError('Ajoutez au moins un article au panier.');return;}
      state.sending=true;go.disabled=true;go.textContent='Envoi…';msg.hidden=true;
      var body={items:items,note:gnote.value,client_request_id:uuid(),takeaway:state.takeaway,test:state.test}; if(state.readyIn)body.ready_in_minutes=state.readyIn;if(fn&&fn.value) body.first_name=fn.value;
      post('/spots/'+sp.id+'/orders',body).then(function(r){return r.json().catch(function(){return{};});}).then(function(j){
        if(j&&j.ok){if(j.id&&!j.scheduled_for)trackSend(j.id);closeSheet();showServiceNotice(j.scheduled_for?'Commande programmée — '+sp.label+' · '+hhmm(j.scheduled_for):'Commande envoyée — '+sp.label);}
        else{state.sending=false;go.disabled=false;recompute();setError((j&&j.message)||'Commande refusée. Corrigez les choix puis réessayez.');}
      }).catch(function(){state.sending=false;go.disabled=false;recompute();setError('Envoi impossible. Vérifiez la connexion puis réessayez.');});
    };
    foot.appendChild(go); sh.appendChild(foot);
    ov.appendChild(sh); document.body.appendChild(ov);
    if(window.visualViewport){window.visualViewport.addEventListener('resize',fitViewport);window.visualViewport.addEventListener('scroll',fitViewport);}
    window.addEventListener('resize',fitViewport);fitViewport();paintMode();paintTiming();renderList();recompute();try{search.focus();}catch(e){}
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

  // Re-fetch the authoritative board state (the inline boot is CSP-blocked, so
  // /state is the REAL first paint) AND resync every 60s / on wake / after an SSE
  // recovery. This must never leave the board stuck on "Chargement…": a transient
  // failure retries a few times, then falls back to an actionable reload button
  // (loaded=true). The SSE stream is opened ONCE, here, only after the first
  // /state — seeded at the right cursor so it never replays from 0. A snapshot
  // whose cursor trails what live events already advanced us past is ignored (a
  // slow /state racing live events must not revert newer state). The done callback
  // lets the 10s cuisine-confirmation check re-read the authoritative ack first.
  function refreshState(done){
    loadTries++;
    fetch(BASE+'/state',{headers:{'X-Requested-With':'fetch'}}).then(function(r){
      if(r.status===401){ location.reload(); return null; }
      return r.ok?r.json():null;
    }).then(function(d){
      if(!d){ retryLoad(); if(done)done(); return; }
      if(connected && (d.cursor||0)<cursor){ if(done)done(); return; }  // stale snapshot — ignore
      cursor=d.cursor||0;
      SPOTS=(d.spots||[]).slice().sort(function(a,b){return (a.sort_order||0)-(b.sort_order||0);});
      if(d.menu&&d.menu.length) MENU=d.menu;
      if(d.top) TOP=d.top;
      if(d.vapidKey){ VAPID=d.vapidKey; }
      sessions=new Map(); (d.sessions||[]).forEach(function(s){sessions.set(s.id,s);});
      tickets=new Map(); (d.tickets||[]).forEach(function(t){ if(t.source==='TABLE') tickets.set(t.id,t); });
      // Drop confirmation tracking for orders no longer on the board.
      Object.keys(sentAt).forEach(function(id){ if(!tickets.has(id)) delete sentAt[id]; });
      Object.keys(overdue).forEach(function(id){ if(!tickets.has(id)) delete overdue[id]; });
      loaded=true; render(); initPush();
      if(!connected){ connected=true; connect(); }   // open the live stream, seeded at cursor
      if(done)done();
    }).catch(function(){ retryLoad(); if(done)done(); });
  }
  // Retry a failed FIRST load a few times (~2s apart), then stop hanging: mark
  // loaded so render() swaps "Chargement…" for a one-tap "↻ Recharger". After the
  // first success (loaded), a failed periodic resync just no-ops until the next tick.
  function retryLoad(){ if(loaded) return; if(loadTries<5){ setTimeout(refreshState,2000); } else { loaded=true; render(); } }

  // Track a just-sent order until the cuisine tablet ACKs it. "Envoi à Cuisine…"
  // shows immediately; the tablet's ticket_ack flips it to "Reçue ✓". After 10s
  // with no ack, re-read the AUTHORITATIVE /state before warning (the ack may have
  // landed between our SSE and the POST response) — only a state that still lacks
  // the ack shows "Cuisine non confirmée". We never resend: the order is saved.
  function trackSend(id){
    sentAt[id]=Date.now(); delete overdue[id]; render();
    setTimeout(function(){
      var t=tickets.get(id);
      if(!t || t.ipad_ack_at) return;               // already confirmed (or gone)
      refreshState(function(){ var t2=tickets.get(id); if(t2 && !t2.ipad_ack_at){ overdue[id]=true; render(); } });
    },10000);
  }

  // ---- Web Push (lock-screen "commande prête") ----
  // The bell is ALWAYS visible and dims (.off) until THIS phone is subscribed, so
  // a phone that won't ring is obvious. Tapping opens a panel that walks staff
  // from « installe la PWA » → « active les alertes » → « teste la sonnerie ».
  function urlB64(b64){ var pad='='.repeat((4-b64.length%4)%4); var s=(b64+pad).replace(/-/g,'+').replace(/_/g,'/');
    var raw=atob(s); var a=new Uint8Array(raw.length); for(var i=0;i<raw.length;i++)a[i]=raw.charCodeAt(i); return a; }
  // iOS only allows web-push once the PWA runs from the home screen (not Safari).
  // Android Chrome pushes fine from a plain tab — installing is a nicety there,
  // never a gate. Branch the walkthrough on the actual platform.
  var IOS=/iPhone|iPad|iPod/.test(navigator.userAgent||'');
  function isStandalone(){ try{ return window.matchMedia('(display-mode: standalone)').matches || navigator.standalone===true; }catch(e){ return false; } }
  function pushSupported(){ return !!VAPID && ('serviceWorker' in navigator) && ('PushManager' in window) && ('Notification' in window); }
  function postSub(sub){ post('/push/subscribe',sub.toJSON()).catch(function(){}); }
  var subscribed=false;
  function paintBell(){ if(bell) bell.classList.toggle('off',!subscribed); }
  paintBell();
  function initPush(){
    if(!('serviceWorker' in navigator)){ subscribed=false; paintBell(); return; }
    navigator.serviceWorker.ready.then(function(reg){
      return reg.pushManager.getSubscription().then(function(sub){
        subscribed=!!(sub && (!('Notification' in window) || Notification.permission==='granted'));
        if(sub && subscribed) postSub(sub);   // self-heal the server row on every load
        paintBell();
      });
    }).catch(function(){ subscribed=false; paintBell(); });
  }
  // Ask permission + subscribe; onDone(true) on success. Must run from a gesture.
  function subscribeNow(onDone){
    unlock();
    if(!pushSupported()){ onDone(false); return; }
    Notification.requestPermission().then(function(p){
      if(p!=='granted'){ subscribed=false; paintBell(); onDone(false); return; }
      navigator.serviceWorker.ready.then(function(reg){
        reg.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:urlB64(VAPID)}).then(function(sub){
          postSub(sub); subscribed=true; paintBell(); onDone(true);
        }).catch(function(){ onDone(false); });
      });
    }).catch(function(){ onDone(false); });
  }
  function openAlerts(){
    unlock();
    var ov=el('div','ov center'); var box=el('div','cfm');
    box.setAttribute('role','dialog'); box.setAttribute('aria-modal','true'); box.setAttribute('aria-label','Alertes commandes prêtes');
    function close(){ if(ov.parentNode) document.body.removeChild(ov); }
    ov.onclick=function(e){ if(e.target===ov) close(); };
    function paint(){
      box.textContent='';
      box.appendChild(el('h3',null,'🔔 Alertes commandes prêtes'));
      var msg=el('p','amsg'); box.appendChild(msg);
      var acts=el('div','cfmacts');
      if(IOS && !isStandalone()){
        // iOS hard-gates push behind a home-screen install — no button to offer yet.
        msg.textContent='Pour être alerté quand une commande est prête, même écran verrouillé, installe l’app sur l’écran d’accueil :';
        var steps=el('ol','asteps');
        steps.appendChild(el('li',null,'Ouvre cette page dans Safari'));
        steps.appendChild(el('li',null,'Bouton Partager, puis « Sur l’écran d’accueil »'));
        steps.appendChild(el('li',null,'Rouvre l’app depuis son icône, puis reviens ici'));
        box.appendChild(steps);
        box.appendChild(el('p','anote','iPhone : iOS 16.4 ou plus récent requis.'));
      } else if(!pushSupported()){
        msg.textContent=IOS?'Ce téléphone ne supporte pas les alertes. Mets à jour iOS (16.4 minimum) puis réessaie.'
          :'Ce navigateur ne supporte pas les alertes. Ouvre cette page avec Chrome, puis réessaie.';
      } else if(('Notification' in window) && Notification.permission==='denied'){
        if(IOS){
          // iOS only lists a web app in Réglages → Notifications after it has shown
          // the permission prompt at least once; a stuck « denied » with no entry
          // there can only be reset by reinstalling the icon (which also wipes the
          // pairing cookie — hence the re-pair step).
          msg.textContent='Notifications bloquées pour cette app. Cherche « Salle » dans Réglages → Notifications ; si elle n’y figure pas, réinitialise-la :';
          var rsteps=el('ol','asteps');
          rsteps.appendChild(el('li',null,'Supprime l’icône Salle de l’écran d’accueil'));
          rsteps.appendChild(el('li',null,'Rouvre la page dans Safari → Partager → « Sur l’écran d’accueil »'));
          rsteps.appendChild(el('li',null,'Rouvre l’app et réappaire le téléphone (code à créer sur /admin/appareils)'));
          rsteps.appendChild(el('li',null,'Reviens ici → « Activer les alertes » → autorise'));
          box.appendChild(rsteps);
        } else {
          // Android needs no reinstall: re-allow in place, then come back.
          msg.textContent='Notifications bloquées. Réautorise-les puis reviens ici :';
          var asteps=el('ol','asteps');
          asteps.appendChild(el('li',null,'Dans Chrome : icône 🔒 à gauche de l’adresse → Autorisations → Notifications → Autoriser'));
          asteps.appendChild(el('li',null,'Ou : appui long sur l’icône de l’app Salle → Infos → Notifications → Autoriser'));
          asteps.appendChild(el('li',null,'Reviens ici → « Activer les alertes »'));
          box.appendChild(asteps);
        }
      } else if(subscribed){
        msg.textContent='✓ Alertes activées sur ce téléphone.';
        var test=el('button','primary','🔔 Tester la sonnerie');
        test.onclick=function(){ test.disabled=true; test.textContent='Envoi…';
          post('/push/test',{}).then(function(r){return r.json().catch(function(){return{};});}).then(function(j){
            test.disabled=false; test.textContent='🔔 Tester la sonnerie';
            if(j&&j.sent>0){ msg.textContent='Envoyé ✓ — verrouille l’écran : tu dois entendre la sonnerie et vibrer dans quelques secondes.'; }
            else { subscribed=false; paintBell(); paint(); }
          }).catch(function(){ test.disabled=false; test.textContent='🔔 Tester la sonnerie'; msg.textContent='Erreur réseau — réessaie.'; });
        };
        acts.appendChild(test);
        box.appendChild(el('p','anote',IOS?'Pas de son ? Vérifie le bouton silencieux (côté du téléphone) et le volume.'
          :'Pas de son ? Vérifie le volume des notifications et le mode Ne pas déranger.'));
      } else {
        msg.textContent='Active les alertes pour être prévenu dès qu’une commande est prête, même écran verrouillé.';
        var go=el('button','primary','Activer les alertes');
        go.onclick=function(){ go.disabled=true; go.textContent='…';
          subscribeNow(function(){ go.disabled=false; go.textContent='Activer les alertes'; paint(); }); };
        acts.appendChild(go);
        if(!IOS && !isStandalone()) box.appendChild(el('p','anote','Astuce : installe aussi l’app (menu Chrome ⋮ → « Ajouter à l’écran d’accueil ») pour des alertes plus fiables.'));
      }
      var closeb=el('button',null,'Fermer'); closeb.onclick=close; acts.appendChild(closeb);
      box.appendChild(acts);
    }
    paint();
    ov.appendChild(box); document.body.appendChild(ov); try{ box.querySelector('button').focus(); }catch(e){}
  }
  if(bell) bell.onclick=openAlerts;

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

  // Live updates, with a silent-death watchdog: a half-open socket (network blip,
  // tab suspension) can kill the stream WITHOUT firing onerror — EventSource never
  // auto-reconnects and the board freezes while looking healthy. The server emits
  // a 'ping' event every 25s; if no ping and no real event lands for 60s, rebuild
  // the stream (?since=cursor replays everything missed). On tab wake, check
  // immediately (iOS suspends timers while hidden). Guarded: if EventSource
  // construction ever throws, the board is already painted + loading
  // (render/refreshState ran first), so no live updates is a soft degradation,
  // never a blank "Chargement…".
  function bump(e){ if(e.lastEventId)cursor=+e.lastEventId; }
  function flashSpot(spotId){ var c=board.querySelector('[data-spot="'+spotId+'"]'); if(c)c.classList.add('flash'); }
  var es=null, lastBeat=Date.now(), firstOpen=true;
  function beat(){ lastBeat=Date.now(); }
  function connect(){
    if(es){ try{es.close();}catch(e){} }
    es=new EventSource(BASE+'/events?since='+cursor);
    es.onopen=function(){ beat(); setOnline(true);
      // A reconnect may have missed events beyond the SSE replay window — reconcile
      // against /state. Skip the very first open (we just loaded /state).
      if(firstOpen){ firstOpen=false; } else { refreshState(); } };
    es.onerror=function(){setOnline(false);};
    es.addEventListener('ping',beat);
    es.addEventListener('session_new',function(e){ beat(); var s=JSON.parse(e.data); sessions.set(s.id,s); bump(e); render(); flashSpot(s.spot_id); });
    es.addEventListener('session_update',function(e){ beat(); var s=JSON.parse(e.data); sessions.set(s.id,s); bump(e); render(); });
    es.addEventListener('session_closed',function(e){ beat(); var d=JSON.parse(e.data); sessions.delete(d.id); bump(e); render(); });
    es.addEventListener('ticket_new',function(e){ beat(); var t=JSON.parse(e.data); bump(e); if(t.source!=='TABLE')return; var isNew=!tickets.has(t.id); tickets.set(t.id,t); render(); if(isNew){ beep(); speak(newSpeech(t)); } });
    es.addEventListener('ticket_update',function(e){ beat(); var t=JSON.parse(e.data); bump(e); if(t.source!=='TABLE')return; var was=tickets.get(t.id); tickets.set(t.id,t); render(); if(t.status==='READY' && (!was||was.status!=='READY')){ readyAlert(t); var stEl=board.querySelector('[data-id="'+t.id+'"] .st.ready'); if(stEl)stEl.classList.add('just-ready'); } });
    es.addEventListener('ticket_removed',function(e){ beat(); var d=JSON.parse(e.data); bump(e); tickets.delete(d.id); delete sentAt[d.id]; delete overdue[d.id]; render(); });
    // The cuisine tablet rendered this ticket: flip our "Envoi…" to "Reçue ✓".
    es.addEventListener('ticket_ack',function(e){ beat(); var a=JSON.parse(e.data); bump(e); var t=tickets.get(a.id); delete overdue[a.id]; if(t){ t.ipad_ack_at=a.ipad_ack_at; render(); } });
  }
  function reconnectIfStale(maxMs){ if(Date.now()-lastBeat>maxMs){ beat(); setOnline(false); try{ connect(); }catch(e){} } }
  setInterval(function(){ reconnectIfStale(60000); },15000);
  setInterval(function(){ if(loaded) refreshState(); },60000);   // authoritative resync
  document.addEventListener('visibilitychange',function(){ if(document.visibilityState==='visible'){ reconnectIfStale(30000); if(loaded) refreshState(); } });

  // Keep the reception screen awake while the board is open. Wake Lock drops when
  // the page hides, so re-acquire on visibility return; a no-op where unsupported.
  var wakeLock=null;
  function keepAwake(){ if(!('wakeLock' in navigator)||document.visibilityState!=='visible') return;
    navigator.wakeLock.request('screen').then(function(w){ wakeLock=w; }).catch(function(){}); }
  document.addEventListener('visibilitychange',function(){ if(document.visibilityState==='visible') keepAwake(); });
  keepAwake();

  if('serviceWorker' in navigator){ navigator.serviceWorker.register(BASE+'/sw.js').catch(function(){}); }
})();`;
