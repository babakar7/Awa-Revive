import { config } from "../config.js";
import * as wix from "../lib/wix.js";
import * as keys from "./keyRepo.js";
import { invitationEarnings, type ContinuityFamily, type KeyPlanMapping } from "./keyRules.js";

export type ContinuitySourceKind = "KEY" | "LEGACY_REFORMER";

export interface ContinuitySource {
  kind: ContinuitySourceKind;
  orderId: string;
  planId: string;
  planName: string;
  expiresAt: Date;
  remaining: number | null;
  previousKeyId: string | null;
}

export interface KeyPurchaseContinuityDecision {
  startsAt: Date;
  /** Purchased before the same-family source expired (drives the review gate). */
  earlyRenewal: boolean;
  invitationCount: number;
  sourceKind: ContinuitySourceKind | null;
  sourceOrderId: string | null;
  sourcePlanId: string | null;
  sourceExpiresAt: Date | null;
  sourceRemaining: number | null;
  previousKeyId: string | null;
}

export function keyPurchaseContinuityDecision(args: {
  mapping: KeyPlanMapping;
  purchasedAt: Date;
  source: ContinuitySource | null;
}): KeyPurchaseContinuityDecision {
  // The source is already family-scoped by resolveContinuitySource, so an
  // early renewal can only chain onto a same-family subscription.
  const early =
    args.source !== null &&
    args.purchasedAt.getTime() < args.source.expiresAt.getTime();
  return {
    startsAt: args.source && early ? args.source.expiresAt : args.purchasedAt,
    earlyRenewal: early,
    invitationCount: invitationEarnings(
      args.mapping,
      args.source !== null,
      early,
    ),
    sourceKind: args.source?.kind ?? null,
    sourceOrderId: args.source?.orderId ?? null,
    sourcePlanId: args.source?.planId ?? null,
    sourceExpiresAt: args.source?.expiresAt ?? null,
    sourceRemaining: args.source?.remaining ?? null,
    previousKeyId: args.source?.previousKeyId ?? null,
  };
}

function buyerMatches(
  order: any,
  contactId?: string | null,
  memberId?: string | null,
): boolean {
  return (
    (!!contactId && String(order?.buyer?.contactId ?? "") === contactId) ||
    (!!memberId &&
      String(order?.buyer?.memberId ?? order?.memberId ?? "") === memberId)
  );
}

function covers(order: any, at: Date): boolean {
  const start = Date.parse(String(order?.startDate ?? order?.createdDate ?? ""));
  const end = Date.parse(String(order?.endDate ?? ""));
  return Number.isFinite(start) && Number.isFinite(end) && start <= at.getTime() && end > at.getTime();
}

export function selectLegacyContinuityOrder(args: {
  orders: any[];
  legacyPlanIds: Set<string>;
  contactId?: string | null;
  memberId?: string | null;
  at: Date;
  excludePaidOrderId?: string | null;
}): any | null {
  return (
    args.orders
      .filter(
        (order) =>
          args.legacyPlanIds.has(String(order?.planId ?? "")) &&
          String(order?.id ?? "") !== args.excludePaidOrderId &&
          buyerMatches(order, args.contactId, args.memberId) &&
          covers(order, args.at),
      )
      .sort(
        (a, b) =>
          Date.parse(String(b?.endDate ?? "")) - Date.parse(String(a?.endDate ?? "")),
      )[0] ?? null
  );
}

/**
 * Resolve the continuity source at the verified purchase time, WITHIN the
 * target key's family. A same-family Key always wins over a legacy
 * subscription. Among multiple legacy Reformer orders, the latest expiry wins;
 * unrelated Aquafitness/Mat orders are never considered. Because resolution is
 * family-scoped, an active Aquabike key never masks a Clé (and vice versa), and
 * a legacy Reformer plan is only a source for the REFORMER family.
 */
export async function resolveContinuitySource(args: {
  family: ContinuityFamily;
  clientId?: string | null;
  contactId?: string | null;
  memberId?: string | null;
  at: Date;
  excludePaidOrderId?: string | null;
}): Promise<ContinuitySource | null> {
  const key = await keys.keyCoveringAt({
    clientId: args.clientId,
    wixMemberId: args.memberId,
    at: args.at,
    family: args.family,
    excludePaidOrderId: args.excludePaidOrderId,
  });
  if (key) {
    const wixOrder = args.contactId
      ? (await wix.listAllPlanOrders()).find(
          (order) => String(order?.id ?? "") === key.paid_order_id,
        )
      : null;
    const planName = String(wixOrder?.planName ?? key.key_type);
    const remaining = args.contactId
      ? await wix.planRemainingSessions(
          args.contactId,
          key.plan_id,
          planName,
          key.paid_order_id,
        )
      : null;
    return {
      kind: "KEY",
      orderId: key.paid_order_id,
      planId: key.plan_id,
      planName,
      expiresAt: new Date(key.effective_ends_at),
      remaining,
      previousKeyId: key.id,
    };
  }

  // Legacy Reformer subscriptions belong to the REFORMER family only.
  if (args.family !== "REFORMER") return null;
  if (config.LEGACY_REFORMER_PLAN_IDS.length === 0) return null;
  const legacyIds = new Set(config.LEGACY_REFORMER_PLAN_IDS);
  const selected = selectLegacyContinuityOrder({
    orders: await wix.listAllPlanOrders(),
    legacyPlanIds: legacyIds,
    contactId: args.contactId,
    memberId: args.memberId,
    at: args.at,
    excludePaidOrderId: args.excludePaidOrderId,
  });
  if (!selected) return null;
  const planId = String(selected.planId);
  const planName = String(selected.planName ?? planId);
  const orderId = String(selected.id);
  const remaining =
    args.contactId && String(selected.status ?? "") === "ACTIVE"
      ? await wix.planRemainingSessions(args.contactId, planId, planName, orderId)
      : null;
  return {
    kind: "LEGACY_REFORMER",
    orderId,
    planId,
    planName,
    expiresAt: new Date(String(selected.endDate)),
    remaining,
    previousKeyId: null,
  };
}
