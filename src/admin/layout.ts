import { ADMIN_CLIENT_JS } from "./adminClient.js";
import { ADMIN_CSS } from "./adminStyles.js";
import { badgeLabel, escapeHtml } from "./helpers.js";
import { loadNavBadges, type NavBadges } from "./navBadges.js";

export type ContentWidth = "standard" | "wide" | "full";

export type LayoutOpts = {
  refreshSeconds?: number;
  /** Preloaded badges (home already has them); otherwise fetched. */
  badges?: NavBadges;
  subtitle?: string;
  actions?: string;
  contentWidth?: ContentWidth;
  breadcrumbs?: Array<{ href?: string; label: string }>;
};

type IconName =
  | "home"
  | "chat"
  | "handoff"
  | "review"
  | "crm"
  | "booking"
  | "team"
  | "wallet"
  | "funnel"
  | "invoice"
  | "quote"
  | "gift"
  | "orders"
  | "delivery"
  | "menu"
  | "bell"
  | "profile"
  | "tests"
  | "search"
  | "logout"
  | "panel"
  | "hamburger"
  | "empty";

type NavLink = {
  href: string;
  label: string;
  icon: IconName;
  badgeKey?: keyof NavBadges;
};

type NavSection = {
  title: string;
  muted?: boolean;
  links: NavLink[];
};

const NAV: NavSection[] = [
  {
    title: "Aperçu",
    links: [
      { href: "/admin", label: "À faire", icon: "home", badgeKey: "total" },
      { href: "/admin/rapport", label: "Rapport", icon: "wallet" },
      { href: "/admin/conversion", label: "Conversion", icon: "funnel" },
    ],
  },
  {
    title: "Clients",
    links: [
      { href: "/admin/conversations", label: "Conversations", icon: "chat" },
      { href: "/admin/suivi", label: "Suivi clients", icon: "handoff", badgeKey: "followUps" },
      { href: "/admin/crm", label: "CRM", icon: "crm", badgeKey: "crmLinks" },
    ],
  },
  {
    title: "Studio",
    links: [
      { href: "/admin/bookings", label: "Réservations", icon: "booking" },
      { href: "/admin/staff", label: "Équipe", icon: "team" },
      { href: "/admin/paiements-coachs", label: "Paiements coachs", icon: "wallet" },
    ],
  },
  {
    title: "Documents",
    links: [
      { href: "/admin/factures", label: "Factures", icon: "invoice" },
      { href: "/admin/devis", label: "Devis", icon: "quote" },
      { href: "/admin/cartes-cadeaux", label: "Cartes cadeaux", icon: "gift" },
    ],
  },
  {
    title: "Bar",
    links: [
      { href: "/admin/orders", label: "Commandes payées", icon: "orders" },
      { href: "/admin/livraisons", label: "Livraisons", icon: "delivery", badgeKey: "livraisons" },
      { href: "/admin/menu", label: "Menu", icon: "menu" },
    ],
  },
  {
    title: "Configuration",
    muted: true,
    links: [
      { href: "/admin/notifications", label: "Notifications", icon: "bell" },
      { href: "/admin/story", label: "Story Instagram", icon: "gift" },
      { href: "/admin/profile", label: "Profil WhatsApp", icon: "profile" },
      { href: "/admin/tests", label: "Tests", icon: "tests" },
    ],
  },
];

const ICON_PATHS: Record<IconName, string> = {
  home: '<path d="M3 10.5 10 4l7 6.5"/><path d="M5 9.5V17h10V9.5"/><path d="M8 17v-5h4v5"/>',
  chat: '<path d="M4 4.5h12v9H9l-4 3v-3H4z"/><path d="M7 8h6M7 10.5h4"/>',
  handoff: '<circle cx="7" cy="7" r="2.5"/><path d="M2.8 16c.6-3 2.1-4.5 4.2-4.5 1.5 0 2.7.7 3.5 2"/><path d="M12 7h5m-2-2 2 2-2 2"/>',
  review: '<path d="M4 3.5h12v13H4z"/><path d="M7 7h6M7 10h6M7 13h3"/>',
  crm: '<circle cx="7" cy="7" r="2.5"/><circle cx="14.5" cy="8" r="2"/><path d="M2.5 16c.7-3 2.2-4.5 4.5-4.5S11 13 11.5 16M12 13c1.8-.8 4 .2 5 2.5"/>',
  booking: '<rect x="3" y="5" width="14" height="12" rx="2"/><path d="M6 3v4m8-4v4M3 9h14M7 12h2m2 0h2"/>',
  team: '<circle cx="10" cy="6.5" r="3"/><path d="M4.5 17c.7-3.5 2.5-5.2 5.5-5.2s4.8 1.7 5.5 5.2"/><path d="M15 5.2c1.6.2 2.5 1.2 2.5 2.5s-.8 2.2-2.2 2.5"/>',
  wallet: '<path d="M3 5h12.5A1.5 1.5 0 0 1 17 6.5V15H4.5A1.5 1.5 0 0 1 3 13.5z"/><path d="M3 6.5 14 3v3M13 9.5h4v3h-4a1.5 1.5 0 0 1 0-3Z"/>',
  funnel: '<path d="M3 4h14l-5.5 6v5l-3 1.5V10z"/><path d="M6 7h8"/>',
  invoice: '<path d="M5 3h8l3 3v11H5z"/><path d="M13 3v4h3M8 10h5M8 13h5"/>',
  quote: '<path d="M5 3h8l3 3v11H5z"/><path d="M13 3v4h3M8 10h5M8 13h3"/><path d="m3 15 2-2"/>',
  gift: '<rect x="3" y="8" width="14" height="9" rx="1"/><path d="M2.5 6h15v3h-15zM10 6v11"/><path d="M10 6C8 6 6 5.3 6 4s1-2 2.2-1C9.2 3.8 10 6 10 6Zm0 0s.8-2.2 1.8-3C13 2 14 2.7 14 4s-2 2-4 2Z"/>',
  orders: '<path d="M4 5h12l-1 12H5zM7 5a3 3 0 0 1 6 0"/><path d="M7.5 9h5"/>',
  delivery: '<path d="M2.5 5h9v9h-9zM11.5 8h3l3 3v3h-6z"/><circle cx="6" cy="15.5" r="1.5"/><circle cx="15" cy="15.5" r="1.5"/>',
  menu: '<path d="M4 4h12M4 8h12M4 12h8M4 16h6"/>',
  bell: '<path d="M5 14h10l-1.5-2V8a3.5 3.5 0 0 0-7 0v4z"/><path d="M8.5 16.5h3"/>',
  profile: '<circle cx="10" cy="7" r="3"/><path d="M4.5 17c.8-3.5 2.6-5.2 5.5-5.2s4.7 1.7 5.5 5.2"/>',
  tests: '<path d="M7 3h6M8 3v4l-4 8a1.5 1.5 0 0 0 1.3 2h9.4a1.5 1.5 0 0 0 1.3-2l-4-8V3"/><path d="M6.5 12h7"/>',
  search: '<circle cx="8.5" cy="8.5" r="5"/><path d="m12.5 12.5 4 4"/>',
  logout: '<path d="M8 4H4v12h4M12 7l3 3-3 3M7 10h8"/>',
  panel: '<rect x="3" y="4" width="14" height="12" rx="2"/><path d="M8 4v12m3-9 3 3-3 3"/>',
  hamburger: '<path d="M3 5.5h14M3 10h14M3 14.5h14"/>',
  empty: '<path d="M4 6h12v10H4zM7 6V4h6v2"/><path d="M7 11h6"/>',
};

export function uiIcon(name: IconName, label?: string): string {
  const aria = label ? `role="img" aria-label="${escapeHtml(label)}"` : 'aria-hidden="true"';
  return `<span class="ui-icon" ${aria}><svg viewBox="0 0 20 20" focusable="false">${ICON_PATHS[name]}</svg></span>`;
}

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
            ? `<span class="nav-badge" aria-label="${n} en attente">${escapeHtml(badgeLabel(n))}</span>`
            : "";
        const current = isActive(l.href, active);
        return `<a href="${l.href}" class="nav-link${current ? " active" : ""}"${current ? ' aria-current="page"' : ""} title="${escapeHtml(l.label)}"><span class="nav-icon">${uiIcon(l.icon)}</span><span class="nav-label">${escapeHtml(l.label)}</span>${b}</a>`;
      })
      .join("");
    return `<div class="nav-section${section.muted ? " muted-sec" : ""}">${escapeHtml(section.title)}</div>${links}`;
  }).join("");
}

function breadcrumbHtml(items?: LayoutOpts["breadcrumbs"]): string {
  if (!items?.length) return "";
  const parts = items.map((item, i) => {
    const label = escapeHtml(item.label);
    const node = item.href ? `<a href="${escapeHtml(item.href)}">${label}</a>` : `<span>${label}</span>`;
    return `${i ? '<span aria-hidden="true">/</span>' : ""}${node}`;
  });
  return `<nav class="breadcrumbs" aria-label="Fil d’Ariane">${parts.join("")}</nav>`;
}

/** Shared admin chrome: task-oriented navigation, search and progressive mobile shell. */
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
  const contentWidth = opts.contentWidth ?? "wide";
  return `<!doctype html>
<html lang="fr"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
${refresh}
<title>${escapeHtml(title)} — Revive admin</title>
<link rel="icon" href="data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 100%22><rect width=%22100%22 height=%22100%22 rx=%2222%22 fill=%22%237c547d%22/><text x=%2250%22 y=%2268%22 text-anchor=%22middle%22 fill=%22white%22 font-family=%22Georgia%22 font-size=%2262%22>r</text></svg>">
<style>${ADMIN_CSS}</style></head>
<body>
<div class="shell">
<aside class="sidebar" id="admin-sidebar" aria-label="Navigation principale">
  <a class="brand" href="/admin" aria-label="Revive — Awa admin">
    <span class="brand-mark" aria-hidden="true">r</span>
    <span class="brand-copy"><b>revive</b><small>Awa admin</small></span>
  </a>
  <nav>${navHtml(active, badges)}</nav>
  <div class="sidebar-footer">
    <form method="post" action="/admin/logout">
      <button type="submit">${uiIcon("logout")}<span>Se déconnecter</span></button>
    </form>
  </div>
</aside>
<button class="nav-scrim" id="nav-scrim" type="button" tabindex="-1" aria-label="Fermer le menu"></button>
<div class="main-wrap">
  <header class="topbar">
    <button class="nav-toggle" id="nav-toggle" type="button" aria-controls="admin-sidebar" aria-expanded="false" aria-label="Ouvrir le menu">${uiIcon("hamburger")}</button>
    <button class="nav-collapse" id="nav-collapse" type="button" aria-controls="admin-sidebar" aria-expanded="true" aria-label="Replier la navigation">${uiIcon("panel")}</button>
    <div class="topbar-title"><h1 class="page-title">${escapeHtml(title)}</h1>${opts.subtitle ? `<span class="page-subtitle">${escapeHtml(opts.subtitle)}</span>` : ""}</div>
    <form class="topbar-search" method="get" action="/admin/conversations" role="search">
      ${uiIcon("search")}
      <input id="global-client-search" type="search" name="q" placeholder="Rechercher un client…" aria-label="Rechercher un client par nom ou numéro" autocomplete="off">
      <span class="search-key" aria-hidden="true">⌘ K</span>
    </form>
    ${opts.actions ? `<div class="topbar-actions">${opts.actions}</div>` : ""}
  </header>
  <main class="content-${contentWidth}">${breadcrumbHtml(opts.breadcrumbs)}${body}</main>
</div>
</div>
<dialog class="confirm-dialog" id="confirm-dialog" aria-labelledby="confirm-title">
  <div class="confirm-dialog-inner">
    <h2 id="confirm-title">Confirmer l’action</h2>
    <p id="confirm-text"></p>
    <div class="confirm-dialog-actions">
      <button class="act act--ghost" type="button" onclick="this.closest('dialog').close()">Annuler</button>
      <button class="act act--danger" id="confirm-ok" type="button">Confirmer</button>
    </div>
  </div>
</dialog>
<script>${ADMIN_CLIENT_JS}</script>
</body></html>`;
}
