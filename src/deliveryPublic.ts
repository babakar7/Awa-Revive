import type { FastifyInstance, FastifyReply } from "fastify";
import { formatExtrasMultiline } from "./lib/cafeMenu.js";
import { attemptRouteNotify } from "./domain/deliveryNotify.js";
import {
  findDeliveryOrderByToken,
  deliveryMayDepart,
  markOutForDelivery,
  orderItems,
  type DeliveryOrder,
} from "./domain/deliveryRepo.js";

/**
 * Public, no-auth page the kitchen opens from its WhatsApp ticket. ONE one-tap
 * action: "🛵 Partie en livraison" (IN_KITCHEN → OUT_FOR_DELIVERY), which
 * notifies the client that the order is on its way.
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

const STYLE = `body{font-family:system-ui,-apple-system,sans-serif;margin:0;background:#f6f3ee;color:#1f2328;
display:flex;align-items:center;justify-content:center;min-height:100vh}
main{max-width:26rem;width:92%;background:#fff;border:1px solid #e4ddd3;border-radius:14px;padding:1.4rem;margin:1rem}
h1{font-size:1.2rem;margin:0 0 .2rem}
.muted{color:#6e7781;font-size:.9rem}
.items{white-space:pre-wrap;background:#faf8f4;border:1px solid #eee;border-radius:10px;padding:.7rem;margin:.8rem 0;font-size:.95rem}
.total{font-weight:600;margin:.3rem 0 1rem}
button{width:100%;padding:1rem;font-size:1.15rem;font-weight:700;color:#fff;background:#1a7f37;border:none;border-radius:12px;cursor:pointer}
button:active{background:#166f30}
button.route{background:#1f6feb}
button.route:active{background:#1a5fca}
.done{font-size:1.05rem;color:#1a7f37;font-weight:600}`;

function shell(title: string, inner: string): string {
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow">
<title>${esc(title)}</title><style>${STYLE}</style></head><body><main>${inner}</main></body></html>`;
}

const notFound = () =>
  shell("Lien invalide", `<h1>Lien invalide ou expiré</h1><p class="muted">Ce lien ne correspond à aucune commande active.</p>`);

/** Read-only order card. IN_KITCHEN → "partie en livraison" button; other
 *  states show a terminal message (no address). */
function orderCard(order: DeliveryOrder, token: string): string {
  const items = formatExtrasMultiline(orderItems(order));
  if (order.status === "IN_KITCHEN") {
    const mayDepart = deliveryMayDepart(order);
    const payment =
      order.payment_status === "PAID"
        ? `✅ Payé via ${esc(order.payment_method ?? "mobile money")} — ne rien encaisser.`
        : order.payment_status === "CASH_DUE"
          ? `💵 ${esc(order.amount_xof)} FCFA en espèces à encaisser auprès du client.`
          : order.payment_status === "REFUND_NEEDED"
            ? `⚠️ Incident de paiement — contacter la réception.`
            : order.payment_status === "AWAITING_PAYMENT"
              ? `⏳ Lien de paiement envoyé — confirmation en attente.`
              : `⏳ Le client n'a pas encore choisi son moyen de paiement.`;
    return shell(
      "Commande à préparer",
      `<h1>🛵 Commande livraison</h1>
<p class="muted">${esc(order.client_name)} — ${esc(order.address)}</p>
<div class="items">${esc(items)}</div>
<p class="total">Total : ${esc(order.amount_xof)} FCFA</p>
<p class="${mayDepart ? "done" : "muted"}">${payment}</p>
${mayDepart
  ? `<p class="muted">Touchez ci-dessous quand le livreur part — le client sera prévenu automatiquement.</p>
<form method="post" action="/livraison/${esc(token)}"><button class="route" type="submit">🛵 Partie en livraison</button></form>`
  : `<p class="muted">Départ bloqué. Rechargez cette page après le choix espèces ou la confirmation du paiement.</p>`}`,
    );
  }
  // Terminal / en-route: no address repeated.
  const msg =
    order.status === "CANCELLED"
      ? "Cette commande a été annulée."
      : order.status === "OUT_FOR_DELIVERY"
        ? "🛵 Commande partie en livraison — le client est prévenu."
        : "✅ Commande livrée.";
  return shell("Commande", `<h1>🛵 Commande livraison</h1><p class="done">${esc(msg)}</p>`);
}

export function registerDeliveryPublic(app: FastifyInstance): void {
  const load = async (token: string): Promise<DeliveryOrder | null> => {
    const order = await findDeliveryOrderByToken(token);
    if (!order) return null;
    if (Date.now() - new Date(order.created_at).getTime() > LINK_MAX_AGE_MS) return null;
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
      // Fire-and-forget: the sweep reconciles if this attempt fails/crashes.
      void attemptRouteNotify(order.id, req.log);
      req.log.info({ order: order.id }, "Delivery order marked out-for-delivery via kitchen magic link");
    }
    // Redirect to the read-only view (idempotent; no form re-submit on refresh).
    return reply.redirect(`/livraison/${token}`, 303);
  });
}
