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
    ],
  },
  {
    title: "Studio",
    links: [{ href: "/admin/bookings", label: "Réservations" }],
  },
  {
    title: "Bar",
    links: [
      { href: "/admin/orders", label: "Commandes payées" },
      { href: "/admin/livraisons", label: "Livraisons", badgeKey: "livraisons" },
    ],
  },
  {
    title: null,
    links: [{ href: "/admin/crm", label: "CRM", badgeKey: "crmLinks" }],
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
:root{color-scheme:light}
*{box-sizing:border-box}
body{font-family:system-ui,-apple-system,sans-serif;margin:0;background:#f6f3ee;color:#1f2328}
.shell{display:flex;min-height:100vh;align-items:stretch}
.sidebar{width:220px;flex-shrink:0;background:#1f2328;color:#fff;padding:.85rem .65rem 1.5rem;display:flex;flex-direction:column;gap:.15rem}
.sidebar .brand{font-size:.95rem;font-weight:700;padding:.35rem .55rem .5rem;letter-spacing:.01em}
.sidebar .logout{margin-top:auto;padding-top:.8rem}
.sidebar .logout button{width:100%;background:transparent;border:1px solid #39414a;color:#c9d1d9;border-radius:7px;padding:.4rem .55rem;font-size:.8rem;cursor:pointer}
.sidebar .logout button:hover{background:#39414a;color:#fff}
.sidebar a{color:#c9d1d9;text-decoration:none;padding:.4rem .55rem;border-radius:7px;font-size:.88rem;display:flex;align-items:center;justify-content:space-between;gap:.4rem}
.sidebar a.active,.sidebar a:hover{background:#39414a;color:#fff}
.nav-section{font-size:.68rem;text-transform:uppercase;letter-spacing:.06em;color:#8b949e;padding:.75rem .55rem .25rem;font-weight:600}
.nav-section.muted-sec{margin-top:.5rem;opacity:.85}
.nav-badge{background:#cf222e;color:#fff;border-radius:10px;font-size:.68rem;font-weight:700;padding:.05rem .4rem;min-width:1.2rem;text-align:center}
.main-wrap{flex:1;min-width:0;display:flex;flex-direction:column}
.topbar{background:#fff;border-bottom:1px solid #e4ddd3;padding:.55rem 1rem;display:flex;align-items:center;gap:.75rem;flex-wrap:wrap;position:sticky;top:0;z-index:5}
.topbar form{flex:1;min-width:180px;max-width:420px;margin:0}
.topbar input[type=search]{width:100%;padding:.45rem .75rem;border:1px solid #e4ddd3;border-radius:8px;font-size:.9rem;margin:0}
.topbar .page-title{font-size:.95rem;font-weight:600;margin:0;white-space:nowrap}
main{max-width:960px;width:100%;margin:0 auto;padding:1rem}
h2{font-size:1.05rem;margin:1.4rem 0 .6rem;scroll-margin-top:4rem}
h2:first-child{margin-top:.2rem}
.card{background:#fff;border:1px solid #e4ddd3;border-radius:10px;padding:.9rem;margin-bottom:.8rem}
table{width:100%;border-collapse:collapse;font-size:.88rem}
th,td{text-align:left;padding:.45rem .5rem;border-top:1px solid #eee;vertical-align:top}
th{border-top:none;color:#6e7781;font-weight:600;font-size:.8rem}
.badge{color:#fff;border-radius:20px;padding:.1rem .55rem;font-size:.72rem;font-weight:600;white-space:nowrap}
.muted{color:#6e7781;font-size:.82rem}
.stat-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:.6rem}
.stat{background:#fff;border:1px solid #e4ddd3;border-radius:10px;padding:.7rem}
.stat b{display:block;font-size:1.3rem}
.bubble{max-width:78%;padding:.55rem .8rem;border-radius:12px;margin:.25rem 0;white-space:pre-wrap;word-break:break-word;font-size:.92rem}
.user{background:#fff;border:1px solid #e4ddd3;margin-right:auto}
.assistant{background:#d7f5dc;margin-left:auto}
.turnrow{display:flex;flex-direction:column}
details.tool{margin:.15rem 0 .15rem 0;font-size:.78rem;color:#6e7781}
details.tool pre{white-space:pre-wrap;word-break:break-all;background:#f0ede7;padding:.5rem;border-radius:8px;margin:.3rem 0 0}
form.inline{display:inline}
button.act{background:#1a7f37;color:#fff;border:none;border-radius:8px;padding:.45rem .8rem;font-size:.85rem;cursor:pointer}
button.act:hover{background:#166f30}
input[type=search]{width:100%;padding:.55rem .8rem;border:1px solid #e4ddd3;border-radius:10px;font-size:.95rem;margin-bottom:.8rem}
a.rowlink{color:inherit;text-decoration:none;display:block}
a.rowlink:hover{background:#faf8f4}
.ok{color:#1a7f37;font-weight:600}
.warn{background:#fff8f0;border-color:#f0d8b6}
.jump-nav{display:flex;flex-wrap:wrap;gap:.4rem;margin:0 0 1rem}
.jump-nav a{font-size:.85rem;color:#0969da;text-decoration:none;background:#fff;border:1px solid #e4ddd3;border-radius:20px;padding:.25rem .7rem}
.jump-nav a:hover{background:#f0ede7}
.subhead{font-size:.82rem;color:#6e7781;margin:-.3rem 0 .8rem}
@media(max-width:800px){
  .shell{flex-direction:column}
  .sidebar{width:100%;flex-direction:row;flex-wrap:wrap;align-items:center;gap:.2rem;padding:.5rem}
  .sidebar .brand{width:100%;padding:.2rem .4rem .4rem}
  .nav-section{width:100%;padding:.4rem .4rem 0}
  .sidebar a{padding:.35rem .5rem;font-size:.82rem}
}
@media(max-width:640px){ td.hide-sm,th.hide-sm{display:none} }
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
<style>${CSS}</style></head>
<body>
<div class="shell">
<aside class="sidebar">
  <div class="brand">🤖 Awa</div>
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
