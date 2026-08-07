import crypto from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { config } from "../config.js";
import * as repo from "../domain/repo.js";
import { handleBounce, parseBounceEvent } from "../domain/emailBounce.js";

/**
 * Webhook transactionnel Brevo — événements de NON-livraison uniquement
 * (soft_bounce, hard_bounce, blocked, invalid_email, error). Brevo répond 201
 * à l'envoi puis découvre le rebond quelques secondes plus tard ; sans ce
 * webhook, un code de vérification parti vers une boîte pleine était invisible
 * (cas réel kaeva18@, 05-07/08 : « je n'ai pas reçu » en boucle).
 *
 * Auth : Brevo ne signe pas ses webhooks — le secret vit dans l'URL
 * (?token=BREVO_WEBHOOK_TOKEN, comparaison à temps constant). Token absent de
 * la config → endpoint inerte (404, comme s'il n'existait pas).
 *
 * On répond toujours 204 aux requêtes authentifiées, même si un item est
 * malformé : Brevo désactive un webhook qui échoue trop souvent, et un retry
 * ne réparerait pas un payload invalide. Idempotence via processed_webhooks
 * (Brevo re-livre le même couple message-id/événement en cas de retry).
 */

function tokenMatches(given: string): boolean {
  const expected = config.BREVO_WEBHOOK_TOKEN;
  if (!expected || !given) return false;
  const a = crypto.createHash("sha256").update(given).digest();
  const b = crypto.createHash("sha256").update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

export function registerBrevoWebhook(app: FastifyInstance): void {
  app.post("/webhooks/brevo", async (req: FastifyRequest, reply) => {
    const token = String((req.query as Record<string, unknown>)?.token ?? "");
    if (!tokenMatches(token)) return reply.code(404).send();

    // Brevo pousse un objet par événement ; on tolère aussi un batch (array).
    const items = Array.isArray(req.body) ? req.body : [req.body];
    for (const raw of items) {
      const evt = parseBounceEvent(raw);
      if (!evt) continue;
      if (await repo.alreadyProcessed(evt.dedupKey, "brevo")) continue;
      try {
        await handleBounce(evt);
        req.log.info({ email: evt.email, event: evt.event }, "Brevo bounce recorded");
      } catch (err) {
        req.log.error({ err, email: evt.email }, "Brevo bounce handling failed");
      }
    }
    return reply.code(204).send();
  });
}
