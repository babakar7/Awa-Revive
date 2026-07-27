import { config } from "../config.js";
import * as wix from "../lib/wix.js";
import { notifyReception } from "../lib/notify.js";
import * as keys from "./keyRepo.js";
import {
  invitationEarnings,
  keyMappingForPlan,
  type KeyPlanMapping,
} from "./keyRules.js";

function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 24 * 60 * 60 * 1000);
}

export async function registerPaidKey(args: {
  paidOrderId: string;
  planId: string;
  clientId?: string | null;
  wixContactId?: string | null;
  wixMemberId: string;
  startsAt: Date;
  endsAt?: Date | null;
  invitationCount?: number | null;
  purchasedAt?: Date | null;
  continuitySourceKind?: "KEY" | "LEGACY_REFORMER" | null;
  continuitySourceOrderId?: string | null;
  continuitySourcePlanId?: string | null;
  continuityExpiresAt?: Date | null;
  previousKeyId?: string | null;
}): Promise<keys.KeyRegistry | null> {
  if (!config.KEYS_AUTOMATION_ENABLED) return null;
  const mapping = keyMappingForPlan(args.planId);
  if (!mapping) return null;
  const alreadyRegistered = await keys.getKeyByPaidOrder(args.paidOrderId);
  if (alreadyRegistered) return alreadyRegistered;
  const purchasedAt = args.purchasedAt ?? new Date();
  const previous =
    args.previousKeyId === undefined && args.continuitySourceKind !== "LEGACY_REFORMER"
      ? await keys.latestPreviousKey({
          clientId: args.clientId,
          wixMemberId: args.wixMemberId,
          before: args.startsAt,
        })
      : args.previousKeyId
        ? await keys.getKeyById(args.previousKeyId)
        : null;
  const earned =
    args.invitationCount ??
    invitationEarnings(
      mapping.type,
      !!args.continuitySourceOrderId || previous !== null,
      args.continuityExpiresAt
        ? purchasedAt.getTime() < args.continuityExpiresAt.getTime()
        : previous !== null && purchasedAt.getTime() < previous.effective_ends_at.getTime(),
    );
  const row = await keys.upsertKey({
    paidOrderId: args.paidOrderId,
    clientId: args.clientId,
    wixContactId: args.wixContactId,
    wixMemberId: args.wixMemberId,
    mapping,
    startsAt: args.startsAt,
    endsAt: args.endsAt ?? addDays(args.startsAt, mapping.durationDays),
    status: args.startsAt.getTime() > Date.now() ? "SCHEDULED" : "ACTIVE",
    previousKeyId: args.previousKeyId ?? previous?.id ?? null,
    purchasedAt,
    continuitySourceKind: args.continuitySourceKind ?? (previous ? "KEY" : null),
    continuitySourceOrderId: args.continuitySourceOrderId ?? previous?.paid_order_id ?? null,
    continuitySourcePlanId: args.continuitySourcePlanId ?? previous?.plan_id ?? null,
    continuityExpiresAt: args.continuityExpiresAt ?? previous?.effective_ends_at ?? null,
    invitationsGranted: earned,
  });
  await keys.createInvitationRights(row.id, earned);
  return row;
}

async function createOrAttachBonus(row: keys.KeyRegistry): Promise<string> {
  const existing = await wix.findPlanOrderForMember({
    planId: row.bonus_plan_id,
    memberId: row.wix_member_id!,
    startDate: row.starts_at,
  });
  if (existing) return existing;
  const future = row.starts_at.getTime() > Date.now() + 30_000;
  return wix.createOfflinePlanOrder(
    row.bonus_plan_id,
    row.wix_member_id!,
    future ? row.starts_at.toISOString() : undefined,
  );
}

export async function ensureBonusForKey(paidOrderId: string): Promise<boolean> {
  if (!config.KEYS_AUTOMATION_ENABLED) return false;
  const existing = await keys.getKeyByPaidOrder(paidOrderId);
  if (!existing || existing.bonus_order_id) return !!existing?.bonus_order_id;
  if (!existing.wix_member_id) {
    await keys.markBonusFailure(existing.id, "missing Wix member id", null);
    return false;
  }
  const row = await keys.claimBonusProvisioning(existing.id);
  if (!row) return false;
  try {
    const bonusOrderId = await createOrAttachBonus(row);
    await keys.attachBonusOrder(row.id, bonusOrderId);
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const delays = [1, 5, 15];
    const nextDelayMinutes = delays[row.bonus_attempts];
    const nextRetryAt =
      nextDelayMinutes === undefined
        ? null
        : new Date(Date.now() + nextDelayMinutes * 60 * 1000);
    await keys.markBonusFailure(row.id, message, nextRetryAt);
    if (!nextRetryAt) {
      notifyReception(
        "⚠️ Cours en plus à activer",
        `La Clé Wix ${row.paid_order_id} est active, mais son bonus n'a pas pu être créé après les retries.\n` +
          `Plan bonus : ${row.bonus_plan_id}\nMembre Wix : ${row.wix_member_id}\nErreur : ${message.slice(0, 500)}\n` +
          `La Clé payante reste valide. À faire : attribuer manuellement le plan bonus avec la même date de début.`,
      );
    }
    return false;
  }
}

export async function registerAndEnsureKey(args: {
  paidOrderId: string;
  planId: string;
  clientId?: string | null;
  wixContactId?: string | null;
  wixMemberId: string;
  startsAt: Date;
  endsAt?: Date | null;
  invitationCount?: number | null;
  purchasedAt?: Date | null;
  continuitySourceKind?: "KEY" | "LEGACY_REFORMER" | null;
  continuitySourceOrderId?: string | null;
  continuitySourcePlanId?: string | null;
  continuityExpiresAt?: Date | null;
  previousKeyId?: string | null;
}): Promise<boolean> {
  const row = await registerPaidKey(args);
  if (!row) return false;
  return ensureBonusForKey(row.paid_order_id);
}

export async function sweepDueKeyBonuses(): Promise<number> {
  if (!config.KEYS_AUTOMATION_ENABLED) return 0;
  const due = await keys.dueBonusRepairs();
  let repaired = 0;
  for (const row of due) {
    if (await ensureBonusForKey(row.paid_order_id)) repaired += 1;
  }
  return repaired;
}

export async function repairClientKeyBonuses(clientId: string): Promise<number> {
  if (!config.KEYS_AUTOMATION_ENABLED) return 0;
  const rows = await keys.keysMissingBonusForClient(clientId);
  let repaired = 0;
  for (const row of rows) {
    if (await ensureBonusForKey(row.paid_order_id)) repaired += 1;
  }
  return repaired;
}

export function configuredMappingForPlan(planId: string): KeyPlanMapping | null {
  return keyMappingForPlan(planId);
}
