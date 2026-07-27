import { normalizeCampaignMessage } from "./packDiscoveryCampaign.js";

/**
 * Anti-conflation check for create_plan_payment_link: does the plan NAME the
 * model confirmed clearly disagree with the plan the id actually resolves to?
 *
 * The model must copy plan_name_confirm verbatim from the SAME list_plans row as
 * plan_id. When a conversation jumps topics (Pack Découverte → Aquabike) the
 * model can pair a stale id with the intended name and bill the wrong pack. We
 * compare on a normalized form (accent/case/punctuation-insensitive) and accept
 * either an exact match or one string containing the other — catalog names vary
 * in verbosity ("Pack Découverte" vs "Pack Découverte Pilates Reformer"). An
 * empty confirmation is treated as "no signal" (not a conflict) so the caller
 * decides whether to require it.
 *
 * Returns true when the two names are a CLEAR mismatch (→ reject the link).
 */
export function planNamesConflict(actualName: string, confirmedName: string): boolean {
  const actual = normalizeCampaignMessage(actualName);
  const confirmed = normalizeCampaignMessage(confirmedName);
  if (!actual || !confirmed) return false;
  return actual !== confirmed && !actual.includes(confirmed) && !confirmed.includes(actual);
}
