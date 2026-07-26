import type { FastifyInstance, FastifyRequest } from "fastify";
import { config } from "../config.js";
import * as repo from "../domain/repo.js";
import { registerAndEnsureKey } from "../domain/keyProvisioning.js";
import { keyMappingForPlan } from "../domain/keyRules.js";
import { verifyAndNormalizeWixWebhook } from "../lib/wixWebhook.js";

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
      await registerAndEnsureKey({
        paidOrderId: event.entityId,
        planId,
        wixContactId: String(order?.buyer?.contactId ?? "") || null,
        wixMemberId: memberId,
        startsAt: start,
        endsAt: end,
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
