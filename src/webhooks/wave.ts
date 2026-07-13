import type { FastifyInstance, FastifyRequest } from "fastify";
import { config } from "../config.js";
import { verifyWaveSignature } from "../lib/wave.js";
import * as repo from "../domain/repo.js";
import {
  processPayment,
  reconcileStuckBookings,
  confirmationMessage,
  refundMessage,
  cafeConfirmationMessage,
} from "../domain/fulfillment.js";

// Re-export for existing imports (tests, index sweeper)
export {
  reconcileStuckBookings,
  confirmationMessage,
  refundMessage,
  cafeConfirmationMessage,
};
export type { RefundReason } from "../domain/fulfillment.js";

/**
 * Wave webhook handler — the critical path (SPEC §7).
 * Payment-first invariant: the Wix booking is created in domain/fulfillment
 * after signature + idempotency + state checks.
 */
export function registerWaveWebhook(app: FastifyInstance): void {
  app.post("/webhooks/wave", async (req: FastifyRequest, reply) => {
    const rawBody = (req as any).rawBody as Buffer | undefined;
    const signature = (req.headers["wave-signature"] ?? req.headers["Wave-Signature"]) as
      | string
      | undefined;

    if (
      !rawBody ||
      !verifyWaveSignature(rawBody, signature, config.WAVE_WEBHOOK_SECRET, {
        toleranceSeconds: 300,
      })
    ) {
      req.log.warn({ signature }, "Wave webhook: invalid signature — rejected");
      return reply.code(401).send("Invalid signature");
    }

    const event: any = req.body;
    const eventId: string | undefined = event?.id ?? event?.data?.id;
    const eventType: string | undefined = event?.type;
    const clientReference: string | undefined = event?.data?.client_reference;

    reply.code(200).send("OK");

    if (eventType !== "checkout.session.completed") {
      req.log.info({ eventType }, "Wave webhook: ignoring event type");
      return;
    }
    if (!eventId || !clientReference) {
      req.log.warn({ event }, "Wave webhook: missing id/client_reference");
      return;
    }

    if (await repo.wasProcessed(`wave:${eventId}`)) {
      req.log.info({ eventId }, "Wave webhook: duplicate delivery, skipping");
      return;
    }

    const payerPhone: string | null = event?.data?.mobile ?? event?.data?.payer_phone ?? null;

    setImmediate(() => {
      processPayment(clientReference, { payerPhone }, req.log)
        .then(() => repo.markProcessed(`wave:${eventId}`, "wave"))
        .catch((err) =>
          req.log.error(
            { err, clientReference },
            "Wave payment processing failed — id NOT marked processed so Wave can retry",
          ),
        );
    });
  });
}
