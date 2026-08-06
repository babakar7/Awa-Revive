import type { FastifyInstance, FastifyRequest } from "fastify";
import { config } from "../config.js";
import * as repo from "../domain/repo.js";
import { registerAndEnsureKey } from "../domain/keyProvisioning.js";
import { dakarDateKey, keyMappingForPlan } from "../domain/keyRules.js";
import {
  keyPurchaseContinuityDecision,
  resolveContinuitySource,
} from "../domain/keyContinuity.js";
import {
  normalizeWixWebhookEvent,
  verifyAndNormalizeWixWebhook,
  verifyWixSharedSecret,
  type WixWebhookEvent,
} from "../lib/wixWebhook.js";
import * as wix from "../lib/wix.js";

function orderFromEvent(event: WixWebhookEvent): any {
  return event.actionEvent?.body?.order ?? null;
}

function cleanAlertName(value: unknown): string {
  return String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 100)
    .trim();
}

export function shouldAlertKeyOverlap(newStart: Date, previousEnd: Date): boolean {
  return dakarDateKey(newStart) < dakarDateKey(previousEnd);
}

export function formatKeyOverlapAlert(args: {
  newOrderId: string;
  newStart: Date;
  previousKind: "KEY" | "LEGACY_REFORMER";
  previousOrderId: string;
  previousEnd: Date;
  clientName?: string | null;
  clientPhone?: string | null;
  clientId?: string | null;
  wixContactId?: string | null;
  baseUrl?: string;
}): string {
  const name = cleanAlertName(args.clientName) || "Cliente Wix";
  const phone = String(args.clientPhone ?? "").replace(/\D/g, "");
  const clientLine = `Cliente : ${name}${phone ? ` (+${phone})` : ""}`;
  const baseUrl = String(args.baseUrl ?? "").replace(/\/+$/, "");
  const lookupLine =
    args.clientId && baseUrl
      ? `Ouvrir la conversation : ${baseUrl}/admin/conversations/${encodeURIComponent(args.clientId)}`
      : args.wixContactId
        ? `Contact Wix : ${args.wixContactId}`
        : null;
  const overlap =
    `La Clé Wix ${args.newOrderId} démarre le ${args.newStart.toISOString().slice(0, 10)}, ` +
    `mais ${args.previousKind === "KEY" ? "la Clé précédente" : "l'abonnement Fondatrice"} ` +
    `${args.previousOrderId} se termine le ${args.previousEnd.toISOString().slice(0, 10)}. ` +
    `La commande Wix est conservée : vérifier les dates avec la cliente.`;
  return [clientLine, overlap, lookupLine].filter(Boolean).join("\n");
}

export function registerWixWebhook(app: FastifyInstance): void {
  app.post("/webhooks/wix", async (req: FastifyRequest, reply) => {
    if (!config.WIX_WEBHOOK_SHARED_SECRET && !config.WIX_WEBHOOK_PUBLIC_KEY) {
      req.log.warn("Wix webhook received but no authentication method is configured");
      return reply.code(503).send("Wix webhook not configured");
    }
    let event: WixWebhookEvent;
    try {
      if (req.body && typeof req.body === "object" && !Buffer.isBuffer(req.body)) {
        const header = req.headers["x-wix-webhook-secret"];
        const providedSecret = typeof header === "string" ? header : "";
        if (!verifyWixSharedSecret(providedSecret, config.WIX_WEBHOOK_SHARED_SECRET)) {
          throw new Error("invalid Wix shared secret");
        }
        event = normalizeWixWebhookEvent(req.body);
      } else {
        if (!config.WIX_WEBHOOK_PUBLIC_KEY) {
          throw new Error("native Wix webhook public key is not configured");
        }
        const raw = (req as any).rawBody as Buffer | undefined;
        const token =
          raw?.toString("utf8") ??
          (typeof req.body === "string" ? req.body : "");
        event = verifyAndNormalizeWixWebhook(token, config.WIX_WEBHOOK_PUBLIC_KEY);
      }
    } catch (error) {
      req.log.warn({ err: error }, "Wix webhook authentication rejected");
      return reply.code(401).send("Invalid authentication");
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
        const client = await repo.findClientByPhone(phones);
        clientId = client?.id ?? null;
      }
      const continuity = await resolveContinuitySource({
        family: mapping.family,
        clientId,
        contactId,
        memberId,
        at: purchasedAt,
        excludePaidOrderId: event.entityId,
      });
      const decision = keyPurchaseContinuityDecision({
        mapping,
        purchasedAt,
        source: continuity,
      });
      // Key start-timing alerts (overlap with an active plan; legacy-balance
      // "should it start earlier?") were dropped 06/08 — never actionable in
      // practice, pure noise for reception and owner (Babakar). The paid Key is
      // registered normally regardless. formatKeyOverlapAlert/shouldAlertKeyOverlap
      // are kept (still unit-tested) in case the check is ever re-enabled.
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
