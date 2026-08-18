import type { FastifyInstance } from "fastify";
import { config } from "./config.js";
import { getPublishedFicheByToken, type JobFiche } from "./domain/ficheRepo.js";
import { renderFicheBodyHtml } from "./domain/ficheRules.js";
import { hardenPublicPage } from "./lib/publicPageHeaders.js";

/**
 * Page publique, sans authentification, ouverte depuis le WhatsApp d'une
 * employée. Elle porte le texte intégral de la fiche que le message ne peut pas
 * transporter (template Meta plafonné à 550 caractères).
 *
 * Invariants SECURITE / OPS :
 *  - GET STRICTEMENT EN LECTURE. WhatsApp PRÉFETCHE les liens pour l'aperçu :
 *    tout effet de bord se déclencherait sur une simple prévisualisation. Il n'y
 *    a donc aucun POST, et pas de suivi « j'ai lu » dans cette version.
 *  - L'URL ne porte QUE le token, rien d'énumérable. Token inconnu ET fiche
 *    dépubliée renvoient LA MÊME coquille 404 : ne jamais révéler qu'une fiche
 *    existe.
 *  - On sert l'INSTANTANÉ publié (published_*), jamais le brouillon : le lien
 *    est permanent et mis en favori, une phrase à moitié écrite ne doit pas
 *    être lisible en direct.
 *  - Aucun nom d'employée ni numéro personnel sur la page — ce qui limite la
 *    portée d'un lien qui fuiterait.
 *  - Aucun script : impression via @media print, pas de window.print() (ce
 *    serait du JS inline, donc un script-src à ouvrir dans la CSP).
 */

function esc(s: unknown): string {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

const STYLE = `:root{color-scheme:only light}*{box-sizing:border-box}
body{font-family:system-ui,-apple-system,sans-serif;margin:0;background:#f5efe9;color:#302a31;line-height:1.6;display:flex;justify-content:center}
main{max-width:38rem;width:calc(100% - 1.5rem);background:#fefbf7;border:1px solid #dfd4dc;border-radius:18px;padding:1.4rem;margin:1.2rem;box-shadow:0 12px 35px rgba(53,38,57,.1)}
.brand{color:#765a78;font-size:.75rem;font-weight:800;letter-spacing:.08em;text-transform:uppercase;margin:0 0 .2rem}
h1{font-size:1.4rem;margin:0 0 .15rem}
.maj{color:#665c68;font-size:.85rem;margin:0 0 1.1rem}
.body{margin:0}
.body p{margin:.55rem 0}
.body ul,.body ol{margin:.55rem 0;padding-left:1.35rem}
.body li{margin:.3rem 0}
footer{margin-top:1.4rem;padding-top:.9rem;border-top:1px solid #e7dfe4;color:#665c68;font-size:.87rem}
footer a{color:#68436c;font-weight:700;text-underline-offset:3px}
.nf{text-align:center;padding:2rem 1rem}.nf h1{margin-bottom:.4rem}
@media(max-width:420px){main{padding:1.05rem;margin:.6rem}}
@media print{body{background:#fff}main{margin:0;border:0;box-shadow:none;max-width:none}footer{border-top:1px solid #ccc}}`;

function shell(title: string, inner: string): string {
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>${esc(title)}</title><style>${STYLE}</style></head><body>${inner}</body></html>`;
}

/** Coquille unique : token inconnu et fiche dépubliée sont indiscernables. */
export function renderFicheNotFound(): string {
  return shell(
    "Fiche introuvable",
    `<main class="nf"><p class="brand">Studio Revive</p>
<h1>Fiche introuvable</h1>
<p class="maj">Ce lien n’est plus valable. Demande le lien à jour à la réception.</p></main>`,
  );
}

export function renderFichePublic(fiche: JobFiche): string {
  const label = fiche.published_role_label ?? fiche.role_label;
  const maj = fiche.published_at
    ? new Intl.DateTimeFormat("fr-FR", {
        day: "2-digit",
        month: "long",
        year: "numeric",
        timeZone: "Africa/Dakar",
      }).format(fiche.published_at)
    : "";
  return shell(
    `Fiche de poste — ${label}`,
    `<main><p class="brand">Studio Revive</p>
<h1>${esc(label)}</h1>
${maj ? `<p class="maj">Mise à jour le ${esc(maj)}</p>` : ""}
<div class="body">${renderFicheBodyHtml(fiche.published_body ?? "")}</div>
<footer>Une question sur ta fiche ? Passe voir la réception ou appelle le ${esc(
      config.RECEPTION_PHONE,
    )}.</footer></main>`,
  );
}

export function registerFichePublic(app: FastifyInstance): void {
  app.get("/fiche/:token", async (req, reply) => {
    hardenPublicPage(reply, { formAction: "none" });
    const { token } = req.params as { token: string };
    const fiche = await getPublishedFicheByToken(token);
    if (!fiche) return reply.code(404).type("text/html").send(renderFicheNotFound());
    return reply.type("text/html").send(renderFichePublic(fiche));
  });
}
