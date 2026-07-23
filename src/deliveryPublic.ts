import type { FastifyInstance, FastifyReply } from "fastify";
import { formatExtrasMultiline } from "./lib/cafeMenu.js";
import { attemptRouteNotify } from "./domain/deliveryNotify.js";
import { completeTicketForDelivery } from "./domain/kitchenTicketRepo.js";
import {
  findDeliveryOrderByToken,
  deliveryMayDepart,
  markOutForDelivery,
  orderItems,
  type DeliveryOrder,
} from "./domain/deliveryRepo.js";
import { deliveryCallContact } from "./domain/deliveryRules.js";

/**
 * Public, no-auth page the kitchen opens from its WhatsApp ticket. Its explicit
 * departure confirmation performs IN_KITCHEN → OUT_FOR_DELIVERY and notifies
 * the client that the order is on its way.
 *
 * SECURITY / OPS invariants:
 *  - GET is READ-ONLY. WhatsApp and other clients PREFETCH links for previews;
 *    a mutating GET would mark orders departed on preview. Only the POST mutates.
 *  - The URL carries ONLY the token (no order id — nothing enumerable). The
 *    order is found by the token's stored HASH; the cleartext is never queried
 *    or logged. Any unknown/expired token → a uniform 404.
 *  - The page shows a home address + order — hardened headers (no-store,
 *    noindex, no-referrer, DENY framing, tight CSP), and terminal states don't
 *    repeat the address. Links older than 48h are refused.
 *  - POST → 303 → GET so a browser back/refresh never re-submits.
 */

const LINK_MAX_AGE_MS = 48 * 60 * 60 * 1000;

function esc(s: unknown): string {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function harden(reply: FastifyReply): void {
  reply.header("Cache-Control", "no-store");
  reply.header("X-Robots-Tag", "noindex, nofollow");
  reply.header("Referrer-Policy", "no-referrer");
  reply.header("X-Frame-Options", "DENY");
  reply.header(
    "Content-Security-Policy",
    "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'",
  );
}

const STYLE = `:root{color-scheme:only light}*{box-sizing:border-box}body{font-family:system-ui,-apple-system,sans-serif;margin:0;background:#f5efe9;color:#302a31;display:flex;align-items:center;justify-content:center;min-height:100vh;line-height:1.55}
main{max-width:30rem;width:calc(100% - 1.5rem);background:#fefbf7;border:1px solid #dfd4dc;border-radius:18px;padding:1.2rem;margin:1rem;box-shadow:0 12px 35px rgba(53,38,57,.1)}
h1{font-size:1.35rem;margin:0}.intro{margin:.2rem 0 1rem}.muted{color:#665c68;font-size:.9rem}
.section{margin:.75rem 0;padding:.85rem;border:1px solid #e7dfe4;border-radius:12px;background:#fff}.section-label{display:block;margin-bottom:.28rem;color:#765a78;font-size:.75rem;font-weight:800;letter-spacing:.06em;text-transform:uppercase}.section h2{margin:.05rem 0 .25rem;font-size:1.02rem}.section p{margin:.2rem 0}.items{white-space:pre-wrap;margin:.35rem 0 0;font-size:.95rem}.total{font-size:1.08rem;font-weight:750}
a{color:#68436c;font-weight:700;text-underline-offset:3px}.call{display:inline-flex;min-height:44px;align-items:center;font-size:1.05rem}
button,.refresh,summary.action{min-height:48px;width:100%;display:flex;align-items:center;justify-content:center;padding:.8rem 1rem;font-size:1rem;font-weight:750;border-radius:12px;cursor:pointer;text-decoration:none}
button{color:#fff;background:#2f7650;border:1px solid #2f7650}button:active{background:#245f40}button:focus-visible,a:focus-visible,summary:focus-visible{outline:3px solid #c8a9ca;outline-offset:2px}
.refresh{margin-top:.75rem;color:#68436c;background:#f3eaf4;border:1px solid #cdb9cf}.block{border-color:#e8c083;background:#fff6e7;color:#7a4c0a}.block b{display:block}.confirm{margin-top:1rem}.confirm>summary{list-style:none;color:#fff;background:#765379}.confirm>summary::-webkit-details-marker{display:none}.confirm[open]>summary{border-radius:12px 12px 0 0}.confirm-body{padding:.9rem;border:1px solid #cdb9cf;border-top:0;border-radius:0 0 12px 12px;background:#f8f0f8}.confirm-body p{margin:0 0 .75rem}.done{font-size:1.05rem;color:#286b47;font-weight:700}@media(max-width:390px){main{padding:1rem}.section{padding:.75rem}}`;

function shell(title: string, inner: string): string {
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow">
<title>${esc(title)}</title><style>${STYLE}</style></head><body><main>${inner}</main></body></html>`;
}

const notFound = () =>
  shell("Lien invalide", `<h1>Lien invalide ou expiré</h1><p class="muted">Ce lien ne correspond à aucune commande active.</p>`);

/** Read-only order card. IN_KITCHEN gets a two-step confirmation; other states
 * show a terminal message with no personal data. */
function orderCard(order: DeliveryOrder, token: string): string {
  const items = formatExtrasMultiline(orderItems(order));
  if (order.status === "IN_KITCHEN") {
    const contact = deliveryCallContact(order);
    const mayDepart = deliveryMayDepart(order);
    const payment =
      order.payment_status === "PAID"
        ? `Payé via ${esc(order.payment_method ?? "mobile money")} — ne rien encaisser.`
        : order.payment_status === "CASH_DUE"
          ? `${esc(order.amount_xof)} FCFA en espèces à encaisser auprès de ${esc(contact.name)}.`
          : order.payment_status === "REFUND_NEEDED"
            ? `Remboursement requis : ne pas faire partir la commande et contacter la réception.`
            : order.payment_status === "AWAITING_PAYMENT"
              ? `Paiement mobile en attente de confirmation : le départ est bloqué.`
              : `Moyen de paiement non choisi : le départ est bloqué.`;
    return shell(
      "Commande à préparer",
      `<h1>Commande livraison</h1>
<p class="intro muted">Informations à vérifier avant de confier la commande au livreur.</p>
<section class="section">
  <span class="section-label">1 · Contact et destination</span>
  <h2>${contact.isRecipient ? "Contact de remise" : "Client à appeler"}</h2>
  <p><b>${esc(contact.name)}</b><br><a class="call" href="tel:+${esc(contact.phone)}">+${esc(contact.phone)}</a></p>
  <p>${esc(order.address)}</p>
</section>
<section class="section${mayDepart ? "" : " block"}">
  <span class="section-label">2 · Paiement</span>
  <p class="${mayDepart ? "done" : ""}"><b>${mayDepart ? "Départ autorisé" : "Départ bloqué"}</b><br>${payment}</p>
</section>
<section class="section">
  <span class="section-label">3 · Commande</span>
  <div class="items">${esc(items)}</div>
  ${order.note ? `<p><b>Note :</b> ${esc(order.note)}</p>` : ""}
  <p class="total">Total : ${esc(order.amount_xof)} FCFA</p>
</section>
${mayDepart
  ? `<details class="confirm">
  <summary class="action" role="button">Préparer le départ</summary>
  <div class="confirm-body">
    <p><b>Le départ est-il effectif ?</b><br>En confirmant, la cliente${contact.isRecipient ? " et le contact de remise seront prévenus" : " sera prévenue"} immédiatement.</p>
    <form method="post" action="/livraison/${esc(token)}"><button type="submit">Confirmer le départ</button></form>
  </div>
</details>`
  : `<p class="muted">Actualisez après le choix espèces ou la confirmation du paiement mobile.</p>`}
<a class="refresh" href="/livraison/${esc(token)}">Rafraîchir l’état</a>`,
    );
  }
  // Terminal / en-route: no address repeated.
  const msg =
    order.status === "CANCELLED"
      ? "Cette commande a été annulée."
      : order.status === "OUT_FOR_DELIVERY"
        ? `🛵 Commande partie en livraison — la cliente${order.recipient_phone ? " et le contact de remise sont prévenus" : " est prévenue"}.`
        : "✅ Commande livrée.";
  return shell("Commande", `<h1>🛵 Commande livraison</h1><p class="done">${esc(msg)}</p>`);
}

export function registerDeliveryPublic(app: FastifyInstance): void {
  const load = async (token: string): Promise<DeliveryOrder | null> => {
    const order = await findDeliveryOrderByToken(token);
    if (!order) return null;
    // Future orders have a token hash from creation but no kitchen access until
    // activation. A week-ahead order's eventual link also expires relative to
    // activation, not relative to when reception first entered it.
    if (!order.activated_at) return null;
    if (Date.now() - new Date(order.activated_at).getTime() > LINK_MAX_AGE_MS) return null;
    return order;
  };

  // READ-ONLY — never mutates (WhatsApp prefetches this for link previews).
  app.get("/livraison/:token", async (req, reply) => {
    harden(reply);
    const { token } = req.params as { token: string };
    const order = await load(token);
    reply.type("text/html");
    return reply.code(order ? 200 : 404).send(order ? orderCard(order, token) : notFound());
  });

  // The mutation: mark the order gone for delivery + ping the client, then
  // 303 → GET. Double-POST is idempotent (markOutForDelivery returns null once
  // the order is no longer IN_KITCHEN).
  app.post("/livraison/:token", async (req, reply) => {
    harden(reply);
    const { token } = req.params as { token: string };
    const order = await load(token);
    if (!order) {
      reply.type("text/html");
      return reply.code(404).send(notFound());
    }
    const updated = await markOutForDelivery(order.id, "kitchen-link");
    if (updated) {
      // Remove the ticket from the iPad board live (sweep reconcile is the backstop).
      void completeTicketForDelivery(order.id).catch(() => {});
      // Fire-and-forget: the sweep reconciles if this attempt fails/crashes.
      void attemptRouteNotify(order.id, req.log);
      req.log.info({ order: order.id }, "Delivery order marked out-for-delivery via kitchen magic link");
    }
    // Redirect to the read-only view (idempotent; no form re-submit on refresh).
    return reply.redirect(`/livraison/${token}`, 303);
  });
}
