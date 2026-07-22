import type { FastifyInstance, FastifyReply } from "fastify";
import { config } from "./config.js";
import { parseOptionChoices } from "./lib/cafeMenu.js";
import { renderMenuOgImage } from "./lib/menuOgImage.js";
import {
  categoryNames,
  listPublicMenuItems,
  type PublicMenuItem,
} from "./domain/cafeMenuRepo.js";

/**
 * Public café-menu page (menu.revive.sn). No auth, no client JS, GET-only —
 * rendered straight from cafe_menu_items on every request so /admin/menu edits
 * show up within the 60s HTTP cache (no redeploy, no per-process snapshot
 * staleness). Recipe columns never reach this module: listPublicMenuItems()
 * selects the client-facing columns only. Unlike the other public pages
 * (delivery magic links, payment returns), this one is MEANT to be indexed —
 * it's a marketing surface, so no noindex anywhere.
 *
 * The category anchor nav works with CSS smooth scrolling alone; keep the page
 * script-free or the strict CSP below must change.
 */

export const MENU_HOST = "menu.revive.sn";
const CANONICAL_URL = "https://menu.revive.sn/";
const AWA_WA_ME = "https://wa.me/221789536676";

function esc(s: unknown): string {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function price(value: number): string {
  return `${Math.round(value).toLocaleString("fr-FR").replace(/ /g, " ")} F`;
}

function normalized(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLocaleLowerCase("fr-FR");
}

/** Anchor slug for a category section (lowercase, accents stripped, dashes). */
function anchorSlug(category: string): string {
  return (
    normalized(category)
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "autres"
  );
}

function headers(reply: FastifyReply): void {
  reply.header("Cache-Control", "public, max-age=60, stale-while-revalidate=300");
  reply.header("X-Content-Type-Options", "nosniff");
  reply.header("X-Frame-Options", "DENY");
  reply.header("Referrer-Policy", "strict-origin-when-cross-origin");
  // img-src data: = la seule relaxation, pour le favicon SVG inline.
  reply.header(
    "Content-Security-Policy",
    "default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'",
  );
}

export interface MenuGroup {
  category: string;
  items: PublicMenuItem[];
}

/** Group enabled items by category in the curated menu_categories order;
 *  categories with no items disappear, items whose category was removed from
 *  menu_categories go last (first-appearance order — items arrive sorted by
 *  sort_order, name). */
export function groupPublicMenu(
  items: PublicMenuItem[],
  orderedCategories: string[],
): MenuGroup[] {
  const groups: MenuGroup[] = [];
  for (const category of orderedCategories) {
    const inCategory = items.filter((i) => i.category === category);
    if (inCategory.length) groups.push({ category, items: inCategory });
  }
  const known = new Set(orderedCategories);
  const leftovers = new Map<string, PublicMenuItem[]>();
  for (const item of items) {
    if (known.has(item.category)) continue;
    const list = leftovers.get(item.category);
    if (list) list.push(item);
    else leftovers.set(item.category, [item]);
  }
  for (const [category, leftoverItems] of leftovers) groups.push({ category, items: leftoverItems });
  return groups;
}

// Charte Revive (cf. src/lib/scheduleImage.ts) : prune #7c547d, mauve #a98baa,
// rose poudré #f2e7e2, prune foncé #211921, crème #fbf6f0. Polices système
// (serif pour les titres, sans pour le corps) : pas d'embed de TTF — les
// clients scannent un QR sur data mobile.
// Contrastes vérifiés sur crème #fbf6f0 : #7d5f80 ≈ 5.1:1, #6b5c6c ≈ 5.8:1,
// #7c547d sur #f2e7e2 ≈ 5.0:1 — tous ≥ 4.5:1 (WCAG AA petite taille).
const STYLE = `*{box-sizing:border-box}
@media (prefers-reduced-motion:no-preference){html{scroll-behavior:smooth}}
body{margin:0;background:#fbf6f0;color:#211921;font-family:system-ui,-apple-system,"Segoe UI",sans-serif;line-height:1.5}
header.brand{text-align:center;padding:2.2rem 1.1rem .9rem}
.wordmark{display:inline-flex;align-items:center;gap:.5rem;font-weight:700;font-size:1.2rem;letter-spacing:.05em;color:#211921}
h1{font-family:Georgia,"Times New Roman",serif;font-weight:500;font-size:2.2rem;margin:.7rem 0 .3rem;letter-spacing:.03em}
.tagline{color:#7d5f80;font-size:.72rem;letter-spacing:.28em;text-transform:uppercase;margin:0}
.catsbar{position:sticky;top:0;z-index:2;background:rgba(251,246,240,.95);backdrop-filter:blur(4px);border-bottom:1px solid #f2e7e2}
.catsbar::after{content:"";position:absolute;top:0;right:0;bottom:1px;width:2.4rem;background:linear-gradient(to left,rgba(251,246,240,.95),rgba(251,246,240,0));pointer-events:none}
nav.cats{display:flex;gap:.5rem;overflow-x:auto;-webkit-overflow-scrolling:touch;padding:.55rem 1.1rem;scrollbar-width:none}
nav.cats::-webkit-scrollbar{display:none}
nav.cats a{flex:0 0 auto;background:#f2e7e2;color:#7c547d;text-decoration:none;font-size:.8rem;line-height:1;font-weight:600;letter-spacing:.04em;padding:.75rem 1.05rem;border-radius:999px}
main{max-width:42rem;margin:0 auto;padding:0 1.1rem 7rem}
section{scroll-margin-top:4.6rem;padding-top:1.7rem}
h2{font-family:Georgia,"Times New Roman",serif;font-weight:500;text-transform:uppercase;letter-spacing:.16em;font-size:1.05rem;color:#7c547d;border-bottom:1px solid #f2e7e2;padding-bottom:.45rem;margin:0 0 .3rem}
section:target h2{color:#211921;border-bottom:2px solid #7c547d;padding-bottom:calc(.45rem - 1px)}
.item{padding:.7rem 0}
.line{display:flex;align-items:baseline;gap:.6rem}
.name{font-weight:600}
.dots{flex:1;min-width:1.25rem;border-bottom:1px dotted #d9c9da;transform:translateY(-4px)}
.price{color:#7c547d;font-weight:600;white-space:nowrap}
.fav{display:inline-block;background:#f2e7e2;color:#7c547d;font-size:.68rem;font-weight:700;letter-spacing:.06em;text-transform:uppercase;border-radius:999px;padding:.12rem .55rem;margin-left:.45rem;vertical-align:middle;white-space:nowrap}
.desc{margin:.15rem 0 0;color:#6b5c6c;font-size:.9rem}
.opts{margin:.15rem 0 0;color:#7d5f80;font-size:.85rem;font-style:italic}
.empty{text-align:center;color:#6b5c6c;margin-top:3rem}
footer{text-align:center;margin-top:3rem}
a.wa{display:inline-block;padding:.9rem 1.7rem;background:#7c547d;color:#fbf6f0;text-decoration:none;border-radius:999px;font-weight:600;font-size:1.02rem}
a.wa-float{position:fixed;left:50%;transform:translateX(-50%);bottom:calc(.9rem + env(safe-area-inset-bottom));z-index:3;padding:.8rem 1.4rem;background:#7c547d;color:#fbf6f0;text-decoration:none;border-radius:999px;font-weight:600;font-size:.95rem;white-space:nowrap;box-shadow:0 2px 10px rgba(33,25,33,.18)}
.foot-note{color:#7d5f80;font-size:.7rem;letter-spacing:.22em;text-transform:uppercase;margin-top:1.5rem}`;

// Chevron Revive (évocation du logo de la charte) en SVG inline — le markup
// n'est pas soumis à img-src, donc compatible avec default-src 'none'.
const LOGO_SVG = `<svg width="26" height="20" viewBox="0 0 36 28" aria-hidden="true"><path d="M18 0 36 28h-9L18 14 9 28H0Z" fill="#7c547d"/></svg>`;

const META_DESCRIPTION =
  "Le menu du café du studio Revive à Dakar — boissons et douceurs préparées sur place. Commandez sur WhatsApp.";

function itemHtml(item: PublicMenuItem): string {
  const fav = item.favourite ? `<span class="fav">★ Incontournable</span>` : "";
  const desc = item.description?.trim()
    ? `<p class="desc">${esc(item.description.trim())}</p>`
    : "";
  const choices = parseOptionChoices(item.option_choices);
  const opts = choices.length
    ? `<p class="opts">${esc(item.option_label?.trim() || "Au choix")} : ${choices.map(esc).join(" · ")}</p>`
    : "";
  return `<article class="item"><div class="line"><span class="name">${esc(item.name)}${fav}</span><span class="dots"></span><span class="price">${esc(price(item.price_xof))}</span></div>${desc}${opts}</article>`;
}

export function renderPublicMenuPage(groups: MenuGroup[]): string {
  const nav = groups.length
    ? `<div class="catsbar"><nav class="cats" aria-label="Catégories">${groups
        .map((g) => `<a href="#cat-${anchorSlug(g.category)}">${esc(g.category)}</a>`)
        .join("")}</nav></div>`
    : "";
  const content = groups.length
    ? groups
        .map(
          (g) =>
            `<section id="cat-${anchorSlug(g.category)}"><h2>${esc(g.category)}</h2>${g.items
              .map(itemHtml)
              .join("")}</section>`,
        )
        .join("")
    : `<p class="empty">Le menu arrive bientôt — revenez nous voir très vite !</p>`;
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Le Menu — Revive</title>
<meta name="description" content="${esc(META_DESCRIPTION)}">
<link rel="canonical" href="${CANONICAL_URL}">
<meta property="og:title" content="Le Menu — Revive">
<meta property="og:description" content="${esc(META_DESCRIPTION)}">
<meta property="og:type" content="website">
<meta property="og:url" content="${CANONICAL_URL}">
<meta property="og:site_name" content="Revive">
<meta property="og:locale" content="fr_FR">
<meta property="og:image" content="${esc(config.BASE_URL.replace(/\/$/, ""))}/menu/og.png">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image">
<meta name="theme-color" content="#fbf6f0">
<meta name="color-scheme" content="only light">
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 36 28'%3E%3Cpath d='M18 0 36 28h-9L18 14 9 28H0Z' fill='%237c547d'/%3E%3C/svg%3E">
<style>${STYLE}</style></head><body>
<header class="brand"><span class="wordmark">${LOGO_SVG}revive</span>
<h1>Le Menu</h1>
<p class="tagline">Pilates | Wellness | Community</p></header>
${nav}<main>${content}
<footer><a class="wa" href="${AWA_WA_ME}">Commander sur WhatsApp 📲</a>
<p class="foot-note">Revive — Dakar</p></footer></main>
<a class="wa-float" href="${AWA_WA_ME}">Commander sur WhatsApp 📲</a></body></html>`;
}

/** Query + render + headers; shared by GET /menu and the host-aware "/". */
export async function serveMenuPage(reply: FastifyReply): Promise<FastifyReply> {
  const [items, categories] = await Promise.all([listPublicMenuItems(), categoryNames()]);
  headers(reply);
  return reply.type("text/html").send(renderPublicMenuPage(groupPublicMenu(items, categories)));
}

// Static content (brand only, no menu data) → render once per process, lazily
// so boot/tests without fonts never pay for it.
let ogImageCache: Buffer | null = null;

export function registerMenuPublic(app: FastifyInstance): void {
  // Stable path, served on EVERY host: works before/without the menu.revive.sn
  // DNS cutover and from links on awa.revive.sn. SEO canonicalization is done
  // in the markup (canonical + og:url), not by redirect.
  app.get("/menu", async (_req, reply) => serveMenuPage(reply));

  // og:image for WhatsApp/Instagram link previews (referenced by the <head>).
  app.get("/menu/og.png", async (_req, reply) => {
    if (!ogImageCache) ogImageCache = renderMenuOgImage();
    reply.header("Cache-Control", "public, max-age=86400");
    return reply.type("image/png").send(ogImageCache);
  });
}
