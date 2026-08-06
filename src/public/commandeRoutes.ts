import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { config } from "../config.js";
import { getCafeMenu, computeExtras, pickerMenu } from "../lib/cafeMenu.js";
import { topOrderedItemIds } from "../domain/kitchenTicketRepo.js";
import { barOpenNow } from "../domain/openingHours.js";
import { isOmEnabled } from "../lib/orangeMoney.js";
import { allowPublicOrder } from "../lib/rateLimit.js";
import {
  upsertClient,
  setClientNameIfMissing,
  createDraftCafeOrder,
  setCafeOrderAwaitingPayment,
  findActiveCafeOrderByRequestId,
  expireActiveCafeOrders,
  type CafeServiceMode,
} from "../domain/repo.js";
import { createClientPaymentSession, type MobilePaymentMethod } from "../domain/paymentSession.js";
import {
  COMMANDER_APP_JS,
  COMMANDER_MENU_VERSION,
  commanderPage,
  commandeErreurPage,
  commandeMerciPage,
  hardenCommande,
} from "./commandePage.js";

/**
 * Public customer ordering routes (/commander). Same pipeline as the WhatsApp bar
 * order — computeExtras prices server-side, createClientPaymentSession makes the
 * Wave/OM link, the verified webhook drives fulfillCafeOrder — so the payment-first
 * invariant holds identically. The ONLY new entry point is this public POST; it is
 * rate-limited (IP + phone), gated on the published bar schedule, and never trusts a
 * price or a return URL from the body.
 */

const BASE = "/commander";
const MODES: CafeServiceMode[] = ["SUR_PLACE", "A_EMPORTER", "RETRAIT", "LIVRAISON"];

/** Senegalese mobile → wa_id digits (221 + 9 digits, prefix 70/75/76/77/78), or
 *  null. Stricter than normalizeDeliveryPhone (which accepts any 10–15 digits). */
function normalizeSnPhone(raw: string): string | null {
  let d = String(raw ?? "").replace(/\D/g, "");
  if (d.startsWith("00")) d = d.slice(2);
  if (d.length === 9 && d.startsWith("7")) d = `221${d}`;
  return /^221(7[05678])\d{7}$/.test(d) ? d : null;
}

function reject(reply: FastifyReply, code: number, message: string): FastifyReply {
  return reply.code(code).type("application/json").send({ ok: false, message });
}

export function registerCommande(app: FastifyInstance): void {
  app.get(BASE, async (_req, reply) => {
    hardenCommande(reply);
    return reply.type("text/html").send(commanderPage());
  });
  app.get(`${BASE}/`, async (_req, reply) => {
    hardenCommande(reply);
    return reply.type("text/html").send(commanderPage());
  });

  app.get(`${BASE}/app.js`, async (_req, reply) => {
    hardenCommande(reply);
    return reply.type("text/javascript").send(COMMANDER_APP_JS);
  });

  // Boot data (menu + payment options + live opening hours). Fetched by app.js
  // because the strict CSP forbids an inline boot script.
  app.get(`${BASE}/menu.json`, async (_req, reply) => {
    hardenCommande(reply);
    const [hours, top] = await Promise.all([barOpenNow(), topOrderedItemIds()]);
    return reply.type("application/json").send({
      menu: pickerMenu(),
      // Best-seller item ids (server-computed) for the "🔥 Populaires" section.
      top,
      om: isOmEnabled(),
      deliveryFeeXof: config.DELIVERY_FEE_XOF > 0 ? config.DELIVERY_FEE_XOF : 0,
      hours,
      version: COMMANDER_MENU_VERSION,
    });
  });

  app.get(`${BASE}/merci`, async (_req, reply) => {
    hardenCommande(reply);
    return reply.type("text/html").send(commandeMerciPage());
  });
  app.get(`${BASE}/erreur`, async (_req, reply) => {
    hardenCommande(reply);
    return reply.type("text/html").send(commandeErreurPage());
  });

  app.post(`${BASE}/api/order`, async (req: FastifyRequest, reply) => {
    reply.header("Cache-Control", "no-store");
    const b = (req.body as any) ?? {};

    const mode = String(b.mode ?? "") as CafeServiceMode;
    if (!MODES.includes(mode)) return reject(reply, 400, "Mode de commande invalide.");

    // Opening hours (fail-closed) — re-decided server-side, never trust the client.
    const hours = await barOpenNow();
    if (!hours.open) {
      return reject(
        reply,
        409,
        hours.reason === "no_schedule"
          ? "Commande en ligne momentanément indisponible."
          : `Le bar est fermé${hours.reopensLabel ? ` — réouvre ${hours.reopensLabel}.` : "."}`,
      );
    }
    if (mode === "LIVRAISON" && !hours.deliveryOpen) {
      return reject(reply, 409, "Les livraisons sont terminées pour aujourd'hui.");
    }

    const phone = normalizeSnPhone(String(b.phone ?? ""));
    if (!phone) return reject(reply, 400, "Numéro mobile sénégalais invalide (ex : 77 123 45 67).");

    // Rate limit per IP AND per phone (either alone can't flood).
    const ip = req.ip || "unknown";
    if (!allowPublicOrder(`ip:${ip}`) || !allowPublicOrder(`ph:${phone}`)) {
      return reject(reply, 429, "Trop de tentatives. Réessaie dans quelques minutes.");
    }

    const firstName = String(b.first_name ?? "").trim().slice(0, 40);
    if (firstName.length < 1) return reject(reply, 400, "Indique ton prénom.");

    let address: string | null = null;
    if (mode === "LIVRAISON") {
      address = String(b.address ?? "").trim();
      if (address.length < 5 || address.length > 200) return reject(reply, 400, "Adresse de livraison requise.");
    }

    const method = String(b.method ?? "wave");
    if (!["wave", "orange_money", "maxit"].includes(method)) return reject(reply, 400, "Moyen de paiement invalide.");
    if ((method === "orange_money" || method === "maxit") && !isOmEnabled()) {
      return reject(reply, 400, "Orange Money indisponible pour le moment — choisis Wave.");
    }

    // Server-side pricing/validation (the POST never carries a price).
    const result = computeExtras(getCafeMenu().items, b.items, { requireChoices: true });
    if (!result.ok) return reject(reply, 400, result.message || "Articles invalides.");
    if (result.totalXof <= 0) return reject(reply, 400, "Ton panier est vide.");

    const client = await upsertClient(phone);
    await setClientNameIfMissing(client.id, firstName).catch(() => {});

    // Idempotency: a double-tap / retry / second tab with the same request id
    // returns the SAME live order + link instead of creating a second.
    const reqId = String(b.client_request_id ?? "").slice(0, 80) || null;
    if (reqId) {
      const existing = await findActiveCafeOrderByRequestId(reqId);
      if (existing?.payment_link) return reply.send({ ok: true, payment_link: existing.payment_link });
    }
    await expireActiveCafeOrders(client.id);

    const note = String(b.note ?? "").trim().slice(0, 280) || null;
    const draft = await createDraftCafeOrder({
      clientId: client.id,
      linkedBookingId: null,
      serviceName: null,
      slotStart: null,
      extrasJson: result.lines,
      amountXof: result.totalXof,
      orderNote: note,
      serviceMode: mode,
      deliveryAddress: address,
      customerName: firstName,
      clientRequestId: reqId,
    });

    // Return URLs are built SERVER-SIDE from config (never from the body).
    const publicBase = config.COMMANDER_PUBLIC_BASE_URL.replace(/\/$/, "");
    try {
      const session = await createClientPaymentSession({
        method: method as MobilePaymentMethod,
        amountXof: result.totalXof,
        clientReference: draft.id,
        name: firstName,
        successUrl: `${publicBase}${BASE}/merci`,
        errorUrl: `${publicBase}${BASE}/erreur`,
      });
      await setCafeOrderAwaitingPayment(draft.id, session.sessionId, session.paymentLink, session.expiresAt, method);
      return reply.send({ ok: true, payment_link: session.paymentLink });
    } catch (err) {
      req.log.error({ err, cafeOrderId: draft.id }, "commander: payment session creation failed");
      return reject(reply, 502, "Paiement momentanément indisponible. Réessaie dans un instant.");
    }
  });
}
