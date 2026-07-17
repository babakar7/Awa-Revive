import { badgeLabel, escapeHtml } from "./helpers.js";
import { loadNavBadges, type NavBadges } from "./navBadges.js";

export type LayoutOpts = {
  refreshSeconds?: number;
  /** Preloaded badges (home already has them); otherwise fetched. */
  badges?: NavBadges;
};

type NavLink = {
  href: string;
  label: string;
  /** Which badge key to show (optional). */
  badgeKey?: keyof NavBadges;
};

type NavSection = {
  title: string | null;
  muted?: boolean;
  links: NavLink[];
};

const NAV: NavSection[] = [
  {
    title: null,
    links: [{ href: "/admin", label: "À faire", badgeKey: "total" }],
  },
  {
    title: "Clients",
    links: [
      { href: "/admin/conversations", label: "Conversations" },
      { href: "/admin/handoffs", label: "Handoffs", badgeKey: "handoffs" },
      { href: "/admin/reviews", label: "À reprendre", badgeKey: "reviews" },
      { href: "/admin/factures", label: "Factures 🧾" },
      { href: "/admin/cartes-cadeaux", label: "Cartes cadeaux 🎁" },
      // CRM = fiches Wix / liaisons / doublons — same "people" job as conversations,
      // never under Bar (that was only a missing section header in the first layout).
      { href: "/admin/crm", label: "CRM", badgeKey: "crmLinks" },
    ],
  },
  {
    title: "Studio",
    links: [
      { href: "/admin/bookings", label: "Réservations" },
      { href: "/admin/staff", label: "Équipe 🗓" },
      { href: "/admin/devis", label: "Devis 📄" },
    ],
  },
  {
    title: "Bar",
    links: [
      { href: "/admin/orders", label: "Commandes payées" },
      { href: "/admin/livraisons", label: "Livraisons", badgeKey: "livraisons" },
      { href: "/admin/menu", label: "Menu bar" },
    ],
  },
  {
    title: "Réglages",
    muted: true,
    links: [
      { href: "/admin/notifications", label: "Notifs staff" },
      { href: "/admin/profile", label: "Profil WhatsApp" },
      { href: "/admin/tests", label: "À tester" },
    ],
  },
];

function isActive(href: string, active: string): boolean {
  if (href === "/admin") return active === "/admin";
  return active === href || active.startsWith(href + "/");
}

function navHtml(active: string, badges: NavBadges): string {
  return NAV.map((section) => {
    const links = section.links
      .map((l) => {
        const n = l.badgeKey ? badges[l.badgeKey] : 0;
        const b =
          typeof n === "number" && n > 0
            ? `<span class="nav-badge">${escapeHtml(badgeLabel(n))}</span>`
            : "";
        const cls = isActive(l.href, active) ? "active" : "";
        return `<a href="${l.href}" class="${cls}">${escapeHtml(l.label)}${b}</a>`;
      })
      .join("");
    const title = section.title
      ? `<div class="nav-section${section.muted ? " muted-sec" : ""}">${escapeHtml(section.title)}</div>`
      : "";
    return `${title}${links}`;
  }).join("");
}

const CSS = `
:root{
  color-scheme:light;
  --bg:#faf7f2;--surface:#fff;--border:#e8e0d8;--border-subtle:#f0eae2;
  --text:#241c24;--text-2:#5c525c;--muted:#8a7f8a;--faint:#b5abb5;
  --brand:#6b4a6f;--brand-strong:#5a3d5e;--brand-soft:#f5edf4;--brand-border:#e3d3e2;
  --ok:#1a7f37;--danger:#cf222e;--danger-strong:#b31d28;--warn:#9a6700;--warn-bg:#fff8f0;--warn-border:#f0d8b6;--info:#0969da;
  --sidebar:#261c26;--sidebar-hover:#3a2c3a;--sidebar-text:#cfc5cf;
  --radius:8px;--radius-sm:6px;--radius-lg:10px;
  --shadow:0 1px 3px rgba(36,28,36,.07);
}
*{box-sizing:border-box}
body{font-family:system-ui,-apple-system,"Segoe UI",sans-serif;margin:0;background:var(--bg);color:var(--text);font-size:15px;line-height:1.45}
h1,h2,h3{letter-spacing:-.01em}

/* ---------- chrome ---------- */
.shell{display:flex;min-height:100vh;align-items:stretch}
.sidebar{width:224px;flex-shrink:0;background:var(--sidebar);color:#fff;padding:1rem .6rem 1.25rem;display:flex;flex-direction:column;gap:2px}
.sidebar .brand{font-size:.95rem;font-weight:650;padding:.25rem .6rem .1rem;letter-spacing:-.01em;color:#fff}
.sidebar .brand small{display:block;font-size:.68rem;font-weight:500;color:var(--faint);letter-spacing:.04em;text-transform:uppercase;margin-top:.15rem}
.sidebar a{color:var(--sidebar-text);text-decoration:none;padding:.42rem .6rem;border-radius:var(--radius-sm);font-size:.87rem;display:flex;align-items:center;justify-content:space-between;gap:.4rem;border-left:2px solid transparent}
.sidebar a:hover{background:var(--sidebar-hover);color:#fff}
.sidebar a.active{background:var(--sidebar-hover);color:#fff;border-left-color:#c9a3cc;font-weight:600}
.nav-section{font-size:.66rem;text-transform:uppercase;letter-spacing:.08em;color:#8d7f8d;padding:.9rem .6rem .3rem;font-weight:600}
.nav-section.muted-sec{margin-top:.4rem;opacity:.8}
.nav-badge{background:var(--danger);color:#fff;border-radius:10px;font-size:.68rem;font-weight:700;padding:.05rem .4rem;min-width:1.2rem;text-align:center}
.sidebar .logout{margin-top:auto;padding-top:1rem}
.sidebar .logout button{width:100%;background:transparent;border:1px solid #4a3a4a;color:var(--sidebar-text);border-radius:var(--radius-sm);padding:.4rem .55rem;font-size:.8rem;cursor:pointer}
.sidebar .logout button:hover{background:var(--sidebar-hover);color:#fff}
.main-wrap{flex:1;min-width:0;display:flex;flex-direction:column}
.topbar{background:var(--surface);border-bottom:1px solid var(--border);box-shadow:var(--shadow);padding:.6rem 1.25rem;display:flex;align-items:center;gap:1rem;flex-wrap:wrap;position:sticky;top:0;z-index:5}
.topbar .page-title{font-size:1rem;font-weight:600;margin:0;white-space:nowrap}
.topbar form{flex:1;min-width:180px;max-width:380px;margin:0 0 0 auto}
.topbar input[type=search]{width:100%;padding:.42rem .85rem;border:1px solid var(--border);border-radius:20px;font-size:.86rem;margin:0;background:var(--bg)}
main{max-width:1040px;width:100%;margin:0 auto;padding:1.25rem 1.25rem 3rem}
main a:not(.act){color:var(--brand)}
main a:not(.act):hover{color:var(--brand-strong)}
h2{font-size:1.02rem;font-weight:600;margin:1.6rem 0 .6rem;scroll-margin-top:4rem}
h2:first-child{margin-top:.2rem}
h3{font-size:.92rem;font-weight:600;margin:1.1rem 0 .4rem}

/* ---------- surfaces ---------- */
.card{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius-lg);padding:1rem;margin-bottom:.85rem}
.card.warn,.warn{background:var(--warn-bg);border-color:var(--warn-border)}
.card.success{border-color:var(--ok)}
.stat-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:.6rem}
.stat{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius-lg);padding:.8rem .9rem}
.stat span{font-size:.74rem;color:var(--muted);text-transform:uppercase;letter-spacing:.04em;font-weight:600}
.stat b{display:block;font-size:1.5rem;font-weight:650;font-variant-numeric:tabular-nums;margin-top:.1rem}

/* ---------- tables ---------- */
table{width:100%;border-collapse:collapse;font-size:.87rem;font-variant-numeric:tabular-nums}
th,td{text-align:left;padding:.5rem .55rem;border-top:1px solid var(--border-subtle);vertical-align:top}
th{border-top:none;color:var(--muted);font-weight:600;font-size:.7rem;text-transform:uppercase;letter-spacing:.05em}
tbody tr:hover{background:#faf6f0}
a.rowlink{color:inherit;text-decoration:none;display:block}
tr.rowlink{cursor:pointer}

/* ---------- badges & text ---------- */
.badge{color:#fff;border-radius:20px;padding:.12rem .55rem;font-size:.71rem;font-weight:600;white-space:nowrap;display:inline-block}
.badge--gray{background:#8a7f8a}
.badge--violet{background:var(--brand)}
.badge--red{background:var(--danger)}
.badge--amber{background:var(--warn)}
.badge--blue{background:var(--info)}
.badge--green{background:var(--ok)}
.muted{color:var(--muted);font-size:.82rem}
.ok{color:var(--ok);font-weight:600}
.subhead{font-size:.82rem;color:var(--muted);margin:-.3rem 0 .8rem}

/* ---------- buttons ---------- */
button.act,a.act{background:var(--brand);color:#fff;border:none;border-radius:var(--radius);padding:.48rem .9rem;font-size:.85rem;font-weight:550;cursor:pointer;text-decoration:none;display:inline-block;line-height:1.3;transition:background-color .15s,color .15s,border-color .15s}
button.act:hover,a.act:hover{background:var(--brand-strong);color:#fff}
.act--sm{padding:.3rem .6rem;font-size:.78rem;border-radius:var(--radius-sm)}
button.act.act--ok,a.act.act--ok{background:var(--ok);color:#fff}
button.act.act--ok:hover,a.act.act--ok:hover{background:#166f30;color:#fff}
button.act.act--danger,a.act.act--danger{background:var(--danger);color:#fff}
button.act.act--danger:hover,a.act.act--danger:hover{background:var(--danger-strong);color:#fff}
button.act.act--ghost,a.act.act--ghost{background:transparent;color:var(--brand);border:1px solid var(--brand-border)}
button.act.act--ghost:hover,a.act.act--ghost:hover{background:var(--brand-soft);color:var(--brand-strong);border-color:var(--brand)}
button.act:disabled{opacity:.55;cursor:default}
button.act:disabled:hover{background:var(--brand)}
button.act.act--ghost:disabled:hover{background:transparent;color:var(--brand)}
button.act:focus-visible,a.act:focus-visible{outline:2px solid var(--brand);outline-offset:2px}

/* ---------- forms ---------- */
main input:not([type=checkbox]):not([type=radio]):not([type=search]),main select,main textarea{
  background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);
  padding:.5rem .65rem;font-size:.88rem;font-family:inherit;color:var(--text);max-width:100%}
main label>input:not([type=checkbox]):not([type=radio]),main label>select,main label>textarea{width:100%;margin-top:.2rem}
main input:focus-visible,main select:focus-visible,main textarea:focus-visible{outline:2px solid var(--brand);outline-offset:0;border-color:var(--brand)}
main input[type=checkbox],main input[type=radio]{accent-color:var(--brand);width:1rem;height:1rem}
main label{font-size:.85rem;font-weight:500;color:var(--text-2)}
input[type=search]{width:100%;padding:.55rem .85rem;border:1px solid var(--border);border-radius:var(--radius-lg);font-size:.92rem;margin-bottom:.8rem;background:var(--surface)}
input[type=search]:focus-visible{outline:2px solid var(--brand);outline-offset:0}
form.inline{display:inline}
.is-selected{border-color:var(--brand)!important;background:var(--brand-soft)}

/* ---------- chat ---------- */
.bubble{max-width:78%;padding:.55rem .8rem;border-radius:12px;margin:.25rem 0;white-space:pre-wrap;word-break:break-word;font-size:.92rem}
.user{background:var(--surface);border:1px solid var(--border);margin-right:auto}
.assistant{background:var(--brand-soft);border:1px solid var(--brand-border);margin-left:auto}
.turnrow{display:flex;flex-direction:column}
details.tool{margin:.15rem 0;font-size:.78rem;color:var(--muted)}
details.tool pre{white-space:pre-wrap;word-break:break-all;background:var(--bg);border:1px solid var(--border-subtle);padding:.5rem;border-radius:var(--radius);margin:.3rem 0 0}
details>summary{cursor:pointer}

/* ---------- nav & utilities ---------- */
.jump-nav{display:flex;flex-wrap:wrap;gap:.4rem;margin:0 0 1rem}
.jump-nav a{font-size:.83rem;color:var(--brand);text-decoration:none;background:var(--surface);border:1px solid var(--border);border-radius:20px;padding:.25rem .75rem}
.jump-nav a:hover{background:var(--brand-soft);border-color:var(--brand-border)}
.row{display:flex;align-items:center;gap:.5rem;flex-wrap:wrap}
.row.between{justify-content:space-between}
.col{display:flex;flex-direction:column;gap:.6rem}
.actionbar{position:sticky;bottom:0;background:var(--bg);padding:.6rem 0;display:flex;align-items:center;gap:1rem;box-shadow:0 -6px 12px -8px rgba(36,28,36,.18)}
.nowrap{white-space:nowrap}
.right{text-align:right}

@media(max-width:800px){
  .shell{flex-direction:column}
  .sidebar{width:100%;flex-direction:row;flex-wrap:wrap;align-items:center;gap:.2rem;padding:.5rem}
  .sidebar .brand{width:100%;padding:.2rem .4rem .3rem}
  .sidebar .brand small{display:inline;margin-left:.4rem}
  .nav-section{width:100%;padding:.45rem .4rem 0}
  .sidebar a{padding:.32rem .5rem;font-size:.8rem;border-left:none}
  .sidebar a.active{box-shadow:inset 0 -2px 0 #c9a3cc}
  .sidebar .logout{margin:0 0 0 auto;padding:0}
  .sidebar .logout button{width:auto;font-size:.72rem;padding:.3rem .5rem}
  main{padding:1rem .8rem 2.5rem}
}
@media(max-width:640px){
  td.hide-sm,th.hide-sm{display:none}
  .card{overflow-x:auto}
}
`;

/**
 * Shared admin chrome: sidebar IA + global client search + badges.
 * Async so badge counts stay fresh without each route reimplementing them.
 */
export async function layout(
  title: string,
  active: string,
  body: string,
  opts: LayoutOpts = {},
): Promise<string> {
  const badges = opts.badges ?? (await loadNavBadges());
  const refresh = opts.refreshSeconds
    ? `<meta http-equiv="refresh" content="${opts.refreshSeconds}">`
    : "";
  return `<!doctype html>
<html lang="fr"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
${refresh}
<title>${escapeHtml(title)} — Awa admin</title>
<link rel="icon" href="data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 100%22><text y=%22.9em%22 font-size=%2290%22>🤖</text></svg>">
<style>${CSS}</style></head>
<body>
<div class="shell">
<aside class="sidebar">
  <div class="brand">🤖 Awa<small>Revive Studio</small></div>
  ${navHtml(active, badges)}
  <form class="logout" method="post" action="/admin/logout">
    <button type="submit">Se déconnecter</button>
  </form>
</aside>
<div class="main-wrap">
  <div class="topbar">
    <h1 class="page-title">${escapeHtml(title)}</h1>
    <form method="get" action="/admin/conversations" role="search">
      <input type="search" name="q" placeholder="Client : nom ou numéro…" aria-label="Rechercher un client">
    </form>
  </div>
  <main>${body}</main>
</div>
</div>
</body></html>`;
}
