import type { FastifyInstance, FastifyRequest } from "fastify";
import { config } from "../config.js";
import * as repo from "../domain/repo.js";
import { registerAndEnsureKey } from "../domain/keyProvisioning.js";
import { keyMappingForPlan } from "../domain/keyRules.js";
import {
  keyPurchaseContinuityDecision,
  resolveContinuitySource,
} from "../domain/keyContinuity.js";
import { verifyAndNormalizeWixWebhook } from "../lib/wixWebhook.js";
import { notifyReception } from "../lib/notify.js";
import * as wix from "../lib/wix.js";

function orderFromEvent(event: ReturnType<typeof verifyAndNormalizeWixWebhook>): any {
  return event.actionEvent?.body?.order ?? null;
}

export function registerWixWebhook(app: FastifyInstance): void {
  app.post("/webhooks/wix", async (req: FastifyRequest, reply) => {
    if (!config.WIX_WEBHOOK_PUBLIC_KEY) {
      req.log.warn("Wix webhook received but WIX_WEBHOOK_PUBLIC_KEY is unset");
      return reply.code(503).send("Wix webhook not configured");
    }
    const raw = (req as any).rawBody as Buffer | undefined;
    const token =
      raw?.toString("utf8") ??
      (typeof req.body === "string" ? req.body : "");
    let event;
    try {
      event = verifyAndNormalizeWixWebhook(token, config.WIX_WEBHOOK_PUBLIC_KEY);
    } catch (error) {
      req.log.warn({ err: error }, "Wix webhook signature rejected");
      return reply.code(401).send("Invalid signature");
    }
    try {
      if (!config.KEYS_AUTOMATION_ENABLED) return reply.code(200).send("OK");
      if (
        event.entityFqdn !== "wix.pricing_plans.v2.order" ||
        event.slug !== "purchased"
      ) return reply.code(200).send("OK");
      if (!event.id || !event.entityId) return reply.code(200).send("OK");
      const dedupId = `wix:${event.id}`;
      if (await repo.wasProcessed(dedupId)) return reply.code(200).send("OK");
      const order = orderFromEvent(event);
      const planId = String(order?.planId ?? "");
      const mapping = keyMappingForPlan(planId);
      if (!mapping) {
        await repo.markProcessed(dedupId, "wix");
        return reply.code(200).send("OK");
      }
      const memberId = String(order?.buyer?.memberId ?? "");
      if (!memberId) throw new Error(`Wix Key order ${event.entityId} has no memberId`);
      const start = new Date(String(order?.startDate ?? order?.createdDate ?? ""));
      if (Number.isNaN(start.getTime())) {
        throw new Error(`Wix Key order ${event.entityId} has no valid startDate`);
      }
      const endRaw = String(order?.endDate ?? "");
      const end = endRaw && !Number.isNaN(Date.parse(endRaw)) ? new Date(endRaw) : null;
      const purchasedAt = new Date(String(order?.createdDate ?? ""));
      if (Number.isNaN(purchasedAt.getTime())) {
        throw new Error(`Wix Key order ${event.entityId} has no valid purchase date`);
      }
      const contactId = String(order?.buyer?.contactId ?? "") || null;
      let clientId: string | null = null;
      if (contactId) {
        const contact = await wix.getContactById(contactId);
        const phones = (contact?.info?.phones?.items ?? [])
          .map((phone: any) => String(phone?.e164Phone ?? phone?.phone ?? ""))
          .filter(Boolean);
        clientId = (await repo.findClientByPhone(phones))?.id ?? null;
      }
      const continuity = await resolveContinuitySource({
        clientId,
        contactId,
        memberId,
        at: purchasedAt,
        excludePaidOrderId: event.entityId,
      });
      const decision = keyPurchaseContinuityDecision({
        newKeyType: mapping.type,
        purchasedAt,
        source: continuity,
      });
      if (
        continuity &&
        start.getTime() < continuity.expiresAt.getTime() - 60_000
      ) {
        notifyReception(
          "⚠️ Clé comptoir démarrée avant la fin de l'abonnement",
          `La Clé Wix ${event.entityId} démarre le ${start.toISOString().slice(0, 10)}, ` +
            `mais ${continuity.kind === "KEY" ? "la Clé précédente" : "l'abonnement Fondatrice"} ` +
            `${continuity.orderId} se termine le ${continuity.expiresAt.toISOString().slice(0, 10)}. ` +
            `La commande Wix est conservée : vérifier les dates avec la cliente.`,
        );
      }
      if (
        continuity?.kind === "LEGACY_REFORMER" &&
        (continuity.remaining === 0 || continuity.remaining === null)
      ) {
        notifyReception(
          "⚠️ Démarrage d'une Clé comptoir à vérifier",
          `La source legacy ${continuity.orderId} a un solde ` +
            `${continuity.remaining === 0 ? "à 0" : "illisible"}. Vérifier si la Clé ${event.entityId} doit démarrer plus tôt.`,
        );
      }
      await registerAndEnsureKey({
        paidOrderId: event.entityId,
        planId,
        clientId,
        wixContactId: contactId,
        wixMemberId: memberId,
        startsAt: start,
        endsAt: end,
        purchasedAt,
        invitationCount: decision.invitationCount,
        continuitySourceKind: decision.sourceKind,
        continuitySourceOrderId: decision.sourceOrderId,
        continuitySourcePlanId: decision.sourcePlanId,
        continuityExpiresAt: decision.sourceExpiresAt,
        previousKeyId: decision.previousKeyId,
      });
      await repo.markProcessed(dedupId, "wix");
      return reply.code(200).send("OK");
    } catch (error) {
      // Non-2xx is deliberate: Wix can redeliver. Once the Key row exists,
      // bonus failures are persisted and repaired separately, so only failures
      // before durable registration reach this path.
      req.log.error({ err: error, eventId: event.id }, "Wix Key webhook processing failed");
      return reply.code(500).send("Retry");
    }
  });
}
