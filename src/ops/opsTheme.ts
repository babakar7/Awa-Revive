/**
 * Shared Revive brand theme for the ops PWAs (cuisine kiosque + salle). The same
 * light "Charte Revive" tokens as the admin (src/admin/adminStyles.ts), plus the
 * base page styles both apps share: sticky translucent header, status dot, rose
 * count pill, offline banner, entrance/feedback keyframes and the
 * prefers-reduced-motion kill-switch. Served as strings like the rest of the ops
 * stack — no bundler, CSP-safe (style-src 'unsafe-inline' allows <style>;
 * default-src 'none' forbids web fonts, so system fonts only: Georgia + the
 * system sans stack).
 */

/** Manifest/theme-color constants — keep in sync with --surface / --bg below. */
export const OPS_THEME_COLOR = "#fbf7f2";
export const OPS_BG_COLOR = "#fbf6f0";

export function esc(s: unknown): string {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/** Inline Revive chevron (same mark as the public menu) — static markup, safe
 *  to interpolate and not subject to img-src. */
export const OPS_LOGO_SVG = `<svg width="26" height="20" viewBox="0 0 36 28" aria-hidden="true"><path d="M18 0 36 28h-9L18 14 9 28H0Z" fill="#7c547d"/></svg>`;

/** Shared <head> meta for both ops PWAs: light theme-color, dark status-bar text
 *  (apple-mobile-web-app-status-bar-style "default" — black-translucent was for
 *  the old dark theme). */
export function opsHead(base: string, appleTitle: string): string {
  return `<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="${OPS_THEME_COLOR}">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="default">
<meta name="apple-mobile-web-app-title" content="${esc(appleTitle)}">
<link rel="manifest" href="${base}/manifest.webmanifest">
<link rel="apple-touch-icon" href="${base}/icon-192.png">
<link rel="icon" href="${base}/icon-192.png">`;
}

// ── Design tokens (the admin ramp, verbatim, plus the transactional green) ────
export const OPS_TOKENS = `:root{color-scheme:light;
--cream-25:#faf6f1;--cream-50:#f5efe9;--cream-100:#eee5dd;--cream-200:#e2d6cc;
--plum-50:#f8f4f8;--plum-100:#f0e8f0;--plum-200:#dfd0df;--plum-300:#c6b1c6;
--plum-400:#a98baa;--plum-500:#916d92;--plum-600:#7c547d;--plum-700:#684469;--plum-800:#503451;--plum-900:#382439;
--ink-900:#211a22;--ink-700:#48404a;--ink-500:#665c68;--ink-400:#817683;--ink-300:#aaa1ab;
--rose:#f2e7e2;
--surface:#fbf7f2;--surface-raised:#fefbf7;--bg:#fbf6f0;
--border:#ded3ca;--border-soft:#e9e0d8;--border-strong:#cfc1b7;
--brand:var(--plum-600);--brand-strong:var(--plum-700);
--ok:#21683b;--ok-bg:#edf8f1;--ok-border:#c8e7d1;--ok-strong:#2f7650;
--danger:#b63843;--danger-bg:#fff0f1;--danger-border:#f1c8cc;
--warn:#8b5c16;--warn-bg:#fff7e8;--warn-border:#ecd9af;
--info:#2f6394;--info-bg:#edf5fb;--info-border:#c8ddec;
--radius-sm:7px;--radius:10px;--radius-lg:14px;--radius-xl:18px;
--shadow-1:0 1px 2px rgba(45,30,49,.04),0 5px 16px -10px rgba(45,30,49,.18);
--shadow-2:0 2px 5px rgba(45,30,49,.06),0 14px 32px -18px rgba(45,30,49,.28);
--focus:0 0 0 2px var(--surface),0 0 0 4px var(--plum-600);
--serif:Georgia,"Times New Roman",serif;
--sans:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
--ease:cubic-bezier(.22,1,.36,1)}`;

// ── Base page styles shared by both apps ──────────────────────────────────────
// Motion notes: `main` gets the single page-in animation — both boards rebuild
// main's CHILDREN on every SSE event but never the element itself, so it runs
// once. `arrive` (used via the .flash hook) and `pop` replay only when the JS
// recreates an element (new ticket/spot, status change, qty change).
export const OPS_BASE = `*{box-sizing:border-box}
html,body{margin:0;min-height:100%}
/* [hidden] must beat any author display: rule. Without this, a board styled
   display:grid ignores el.hidden entirely (the UA rule is a lower origin) and
   both boards render stacked — that is exactly how the service livraison board
   used to bleed onto the salle screen with its sticky bar. */
[hidden]{display:none!important}
body{background:var(--bg);color:var(--ink-900);font-family:var(--sans);font-size:16px;line-height:1.5;
font-variant-numeric:tabular-nums;-webkit-font-smoothing:antialiased;
padding-top:env(safe-area-inset-top);-webkit-tap-highlight-color:transparent}
button{font:inherit;transition:transform .12s var(--ease),background-color .15s,color .15s,border-color .15s,box-shadow .15s}
button:active{transform:scale(.97)}
button:disabled{opacity:.5}
input,textarea{font:inherit}
input:focus-visible,textarea:focus-visible,button:focus-visible{outline:none;box-shadow:var(--focus)}
header{position:sticky;top:0;z-index:5;display:flex;align-items:center;gap:.6rem;
padding:.7rem 1rem;background:rgba(251,247,242,.88);backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px);
border-bottom:1px solid var(--border-soft)}
header h1{font-family:var(--serif);font-size:1.2rem;font-weight:600;letter-spacing:-.02em;margin:0}
.logo{display:inline-flex;line-height:0}
.dot{width:.7rem;height:.7rem;border-radius:50%;background:var(--danger);box-shadow:0 0 0 3px rgba(182,56,67,.16);
transition:background-color .2s,box-shadow .2s}
.dot.on{background:var(--ok);box-shadow:0 0 0 3px rgba(33,104,59,.16)}
.spacer{flex:1}
.count{font-size:.8rem;font-weight:600;color:var(--plum-600);background:var(--rose);border-radius:999px;
padding:.28rem .75rem;white-space:nowrap}
.count:empty{display:none}
main{animation:page-in .35s var(--ease)}
@keyframes page-in{0%{opacity:0;transform:translateY(8px)}100%{opacity:1;transform:none}}
@keyframes pop{0%{transform:scale(.7)}100%{transform:scale(1)}}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.45}}
@keyframes arrive{0%{background:var(--plum-100);box-shadow:0 0 0 3px var(--plum-200);transform:scale(.98)}100%{transform:none}}
#offline{position:fixed;left:0;right:0;top:0;z-index:30;background:var(--danger);color:#fff;text-align:center;
padding:.55rem;font-weight:700;font-size:.92rem;transform:translateY(-100%);transition:transform .25s var(--ease)}
#offline.show{transform:translateY(0)}
noscript{display:block;padding:2rem;text-align:center;color:var(--ink-500)}
@media (prefers-reduced-motion:reduce){*,*:before,*:after{animation-duration:.01ms!important;animation-iteration-count:1!important;transition-duration:.01ms!important}}`;

// ── Pairing screen (shared by both apps; button label stays per-app) ──────────
export const OPS_PAIR_STYLE = `body{min-height:100vh;display:flex;align-items:center;justify-content:center;padding:1.5rem}
main{width:100%;max-width:24rem;text-align:center;background:var(--surface-raised);
border:1px solid var(--border-soft);border-radius:var(--radius-xl);box-shadow:var(--shadow-2);padding:2.2rem 1.6rem}
main .logo{margin-bottom:.5rem}
h1{font-family:var(--serif);font-size:1.55rem;font-weight:600;letter-spacing:-.02em;margin:.2rem 0 .4rem}
p{color:var(--ink-500);font-size:.95rem;margin:.2rem 0 1.4rem}
input{width:100%;font-size:1.8rem;letter-spacing:.35em;text-align:center;text-transform:uppercase;
padding:1rem;border-radius:var(--radius-lg);border:1px solid var(--border-strong);background:#fff;color:var(--ink-900);font-weight:700}
button{width:100%;margin-top:1rem;padding:1rem;font-size:1.1rem;font-weight:700;border:none;border-radius:var(--radius-lg);
background:var(--plum-600);color:#fff;box-shadow:var(--shadow-1)}
.err{color:var(--danger);margin-top:1rem;font-size:.9rem}`;
