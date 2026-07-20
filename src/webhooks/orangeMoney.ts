import type { FastifyInstance, FastifyRequest } from "fastify";
import { config } from "../config.js";
import * as repo from "../domain/repo.js";
import { processPayment } from "../domain/fulfillment.js";
import {
  lookupSuccessfulTransaction,
  transactionMatchesPending,
  type OmTransaction,
} from "../lib/orangeMoney.js";
import { notifyReception } from "../lib/notify.js";
import { recordBookingFunnelEvent } from "../domain/bookingFunnel.js";

/**
 * Orange Money / Max It payment notification (X-Callback-Url on QR create).
 *
 * Payment-first: the callback is only a TRIGGER. We always re-check the
 * transaction via the authenticated GET /api/eWallet/v1/transactions API
 * before fulfilling (webhook forgery must not free-book).
 *
 * Payload contract (Sonatel docs):
 *   type MERCHANT_PAYMENT, status SUCCESS, metadata.order, transactionId, …
 * Ack/auth headers: still empirically observed — we return bare 200.
 */

/** Rate-limit reception spam for "lookup failed / not found" (1/h per key). */
const recentOmNotifies = new Map<string, number>();
const OM_NOTIFY_COOLDOWN_MS = 60 * 60 * 1000;

function shouldNotifyOmOnce(key: string): boolean {
  const now = Date.now();
  // Opportunistic prune
  if (recentOmNotifies.size > 200) {
    for (const [k, t] of recentOmNotifies) {
      if (now - t > OM_NOTIFY_COOLDOWN_MS) recentOmNotifies.delete(k);
    }
  }
  const prev = recentOmNotifies.get(key);
  if (prev && now - prev < OM_NOTIFY_COOLDOWN_MS) return false;
  recentOmNotifies.set(key, now);
  return true;
}

export function registerOrangeMoneyWebhook(app: FastifyInstance): void {
  app.post("/webhooks/orange-money", async (req: FastifyRequest, reply) => {
    const rawBody = (req as any).rawBody as Buffer | undefined;
    const body: any = req.body;

    // Stage A observation: always log full headers + body (no secrets in body).
    req.log.info(
      {
        headers: redactHeaders(req.headers as Record<string, unknown>),
        bodyPreview: rawBody?.toString("utf8").slice(0, 4000),
      },
      "OM webhook received",
    );

    // Always 200 quickly so Sonatel doesn't thrash if we process slowly.
    reply.code(200).send({ ok: true });

    const type = String(body?.type ?? "");
    const status = String(body?.status ?? "").toUpperCase();
    const transactionId = body?.transactionId != null ? String(body.transactionId) : "";
    const orderId =
      body?.metadata?.order != null
        ? String(body.metadata.order)
        : body?.metadata?.Order != null
          ? String(body.metadata.Order)
          : "";

    if (type && type !== "MERCHANT_PAYMENT") {
      req.log.info({ type }, "OM webhook: ignoring non-merchant type");
      return;
    }
    if (status && status !== "SUCCESS") {
      req.log.info({ status, transactionId }, "OM webhook: non-SUCCESS — ignoring");
      return;
    }
    if (!transactionId || !orderId) {
      req.log.warn({ body }, "OM webhook: missing transactionId or metadata.order");
      return;
    }

    // Local existence FIRST — before any Sonatel lookup. A forged POST with a
    // random orderId must not burn OAuth or spam reception with "introuvable".
    const pending = await findPendingAny(orderId);
    if (!pending) {
      req.log.warn({ orderId, transactionId }, "OM webhook: unknown order id — no lookup");
      return;
    }

    const idemKey = `om:${transactionId}`;
    if (await repo.wasProcessed(idemKey)) {
      req.log.info({ transactionId }, "OM webhook: duplicate delivery, skipping");
      return;
    }

    setImmediate(() => {
      handleOmPayment({
        transactionId,
        orderId,
        amountXof: pending.amount_xof,
        customerId: body?.customer?.id,
        log: req.log,
      })
        .then(() => repo.markProcessed(idemKey, "orange_money"))
        .catch((err) =>
          req.log.error(
            { err, transactionId, orderId },
            "OM payment processing failed — id NOT marked processed so provider can retry",
          ),
        );
    });
  });
}

async function findPendingAny(
  orderId: string,
): Promise<{ amount_xof: number } | null> {
  const booking = await repo.findBookingById(orderId).catch(() => null);
  if (booking) return booking;
  const plan = await repo.findPlanOrderById(orderId).catch(() => null);
  if (plan) return plan;
  const cafe = await repo.findCafeOrderById(orderId).catch(() => null);
  return cafe;
}

async function recordClassVerificationFailure(
  orderId: string,
  transactionId: string,
  reason: string,
  log: any,
): Promise<void> {
  const booking = await repo.findBookingById(orderId).catch(() => null);
  if (!booking) return; // plan and café callbacks are outside this class funnel
  await recordBookingFunnelEvent({
    clientId: booking.client_id,
    bookingId: booking.id,
    stage: "technical_failure",
    paymentMethod: booking.payment_method,
    failureCode: "payment_verification_failed",
    idempotencyKey: `booking:${booking.id}:om-verification:${transactionId}:${reason}`,
    metadata: { operation: "payment_verification", reason },
  }).catch((err) =>
    log.error({ err, bookingId: booking.id }, "OM verification funnel event failed"),
  );
}

async function handleOmPayment(args: {
  transactionId: string;
  orderId: string;
  amountXof: number;
  customerId?: string;
  log: any;
}): Promise<void> {
  // Verify-by-lookup (source of truth).
  let tx: OmTransaction | null;
  try {
    tx = await lookupSuccessfulTransaction(args.transactionId);
  } catch (err) {
    args.log.error({ err, transactionId: args.transactionId }, "OM lookup failed");
    await recordClassVerificationFailure(
      args.orderId,
      args.transactionId,
      "lookup_failed",
      args.log,
    );
    if (shouldNotifyOmOnce(`lookup_fail:${args.orderId}`)) {
      notifyReception(
        "⚠️ Paiement OM — vérif transaction échouée",
        `Callback reçu pour order=${args.orderId} transactionId=${args.transactionId} mais ` +
          `la recherche API a échoué. Ne pas marquer payé à la main sans vérifier dans le portail OM.\n` +
          `Erreur: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    throw err;
  }
  if (!tx) {
    args.log.warn({ transactionId: args.transactionId }, "OM lookup: no SUCCESS transaction");
    await recordClassVerificationFailure(
      args.orderId,
      args.transactionId,
      "not_successful",
      args.log,
    );
    if (shouldNotifyOmOnce(`lookup_miss:${args.orderId}`)) {
      notifyReception(
        "⚠️ Paiement OM — transaction introuvable/non SUCCESS",
        `Callback order=${args.orderId} transactionId=${args.transactionId} — lookup n'a pas confirmé SUCCESS. ` +
          `Pas de réservation créée.`,
      );
    }
    return;
  }

  const match = transactionMatchesPending(tx, {
    amountXof: args.amountXof,
    merchantCode: config.OM_MERCHANT_CODE,
    orderId: args.orderId,
  });
  if (!match.ok) {
    args.log.warn(
      { reason: match.reason, transactionId: args.transactionId, orderId: args.orderId },
      "OM verify-by-lookup mismatch — not fulfilling",
    );
    await recordClassVerificationFailure(
      args.orderId,
      args.transactionId,
      match.reason,
      args.log,
    );
    if (shouldNotifyOmOnce(`mismatch:${args.orderId}:${match.reason}`)) {
      notifyReception(
        "⚠️ Paiement OM — mismatch vérif",
        `Callback order=${args.orderId} transactionId=${args.transactionId} rejeté: ${match.reason}. ` +
          `Montant attendu ${args.amountXof} FCFA. Pas de réservation créée.`,
      );
    }
    return;
  }

  const payerPhone = args.customerId
    ? String(args.customerId).replace(/\D/g, "")
    : tx.customerId
      ? String(tx.customerId).replace(/\D/g, "")
      : null;

  await processPayment(args.orderId, { payerPhone }, args.log);
}

function redactHeaders(h: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(h)) {
    const lk = k.toLowerCase();
    if (lk.includes("authorization") || lk.includes("cookie") || lk.includes("secret")) {
      out[k] = "[redacted]";
    } else {
      out[k] = v;
    }
  }
  return out;
}
