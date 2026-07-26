import * as wix from "../lib/wix.js";
import { notifyReception } from "../lib/notify.js";
import * as keys from "./keyRepo.js";

const SEVEN_DAYS_MS = 7 * 86_400_000;

/**
 * Reception-side operation after the three human checks have been made:
 * active Key, at least one Reformer credit left, extension not previously
 * used. The caller supplies the live Wix balance decision; this function
 * atomically claims the one-time right before mutating Wix.
 */
export async function extendKeySevenDays(args: {
  keyId: string;
  remainingReformerSessions: number;
}): Promise<{ extended: boolean; newEndDate?: Date; reason?: string }> {
  if (args.remainingReformerSessions < 1) {
    return { extended: false, reason: "no_reformer_sessions_left" };
  }
  const claimed = await keys.claimKeyExtension(args.keyId);
  if (!claimed) return { extended: false, reason: "not_active_or_already_extended" };
  if (!claimed.bonus_order_id) {
    await keys.releaseKeyExtension(args.keyId);
    return { extended: false, reason: "bonus_order_missing" };
  }
  const newEndDate = new Date(claimed.effective_ends_at.getTime() + SEVEN_DAYS_MS);
  try {
    await wix.postponePlanOrderEndDate(claimed.paid_order_id, newEndDate);
  } catch (error) {
    await keys.releaseKeyExtension(args.keyId);
    throw error;
  }
  try {
    await wix.postponePlanOrderEndDate(claimed.bonus_order_id, newEndDate);
  } catch (error) {
    // The paid Key is already extended and Wix has no rollback endpoint. Keep
    // the one-time claim and local effective date, then ask reception to align
    // only the bonus. Never retry the paid order with the same end date.
    await keys.completeKeyExtension(args.keyId, newEndDate);
    await keys.shiftScheduledNextKey(claimed.client_id, claimed.wix_member_id, 7);
    notifyReception(
      "⚠️ Prolongation Clé — bonus à aligner",
      `La Clé ${claimed.paid_order_id} a été prolongée jusqu'au ${newEndDate.toISOString()}, ` +
        `mais le plan bonus ${claimed.bonus_order_id} n'a pas suivi. À prolonger manuellement à la même date.`,
    );
    throw error;
  }
  await keys.completeKeyExtension(args.keyId, newEndDate);
  await keys.shiftScheduledNextKey(claimed.client_id, claimed.wix_member_id, 7);
  return { extended: true, newEndDate };
}
