import type { FastifyInstance, FastifyRequest } from "fastify";
import * as repo from "../domain/repo.js";
import {
  enqueueOmVerification,
  findPendingOmOrder,
  verifyQueuedOmTransaction,
} from "../domain/orangeMoneyVerification.js";

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

    // ACK only after durable receipt for valid payment callbacks. If Postgres
    // is unavailable, let Fastify return an error so Sonatel retries instead
    // of acknowledging a callback that only lived in this process's memory.
    const ack = () => reply.code(200).send({ ok: true });

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
      return ack();
    }
    if (status && status !== "SUCCESS") {
      req.log.info({ status, transactionId }, "OM webhook: non-SUCCESS — ignoring");
      return ack();
    }
    if (!transactionId || !orderId) {
      req.log.warn({ body }, "OM webhook: missing transactionId or metadata.order");
      return ack();
    }

    // Local existence FIRST — before any Sonatel lookup. A forged POST with a
    // random orderId must not burn OAuth or spam reception with "introuvable".
    const pending = await findPendingOmOrder(orderId);
    if (!pending) {
      req.log.warn({ orderId, transactionId }, "OM webhook: unknown order id — no lookup");
      return ack();
    }

    const idemKey = `om:${transactionId}`;
    if (await repo.wasProcessed(idemKey)) {
      req.log.info({ transactionId }, "OM webhook: duplicate delivery, skipping");
      return ack();
    }

    const queued = await enqueueOmVerification({
      transactionId,
      orderId,
      amountXof: pending.amount_xof,
      customerId: body?.customer?.id,
    });
    if (!queued) {
      req.log.error(
        { transactionId, orderId },
        "OM transaction id was already attached to another order — ignoring",
      );
      return ack();
    }

    ack();
    setImmediate(() => {
      void verifyQueuedOmTransaction(transactionId, req.log).catch((err) =>
        req.log.error(
          { err, transactionId, orderId },
          "OM durable verification could not start — periodic sweep will retry",
        ),
      );
    });
  });
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
