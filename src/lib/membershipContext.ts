import * as wix from "./wix.js";
import { config } from "../config.js";
import type { Client } from "../domain/repo.js";
import { repairClientKeyBonuses } from "../domain/keyProvisioning.js";

/**
 * Automatic membership lookup, injected into Awa's context on every message —
 * clients must never pay Wave for a class their abonnement covers, even if
 * they don't think to mention it. Cached per client to keep latency flat.
 * Lives in its own module so both the agent (read) and the tools / Wave
 * webhook (invalidate after a deduction, re-credit or activation) can use it
 * without a circular import.
 */
export interface MembershipContext {
  planId: string;
  plan: string;
  /** Class names this plan can pay for; null when Wix exposes no plan↔service links. */
  covers: string[] | null;
  /** Session credits left on the plan; null when the balance can't be read. */
  remaining: number | null;
  /** ISO end date of the plan; null when Wix exposes none (valid-until-cancelled). */
  expiresAt: string | null;
  /**
   * True ONLY for recurring subscriptions (monthly and up). One-time packs —
   * the discovery pack, carnets — are buy-once and must NEVER be offered for
   * renewal. Conservative: a plan absent from the live catalog (archived/
   * hidden) counts as non-renewable, so we never wrongly push a renewal.
   */
  renewable: boolean;
  /** Active legacy Reformer subscription: operational Founding Member rights. */
  foundingMember: boolean;
}

/**
 * Result of the per-message membership lookup.
 *  - `linked`: the WhatsApp number matches EXACTLY ONE Wix contact (live).
 *    false = unknown number OR ambiguous duplicates (findContactIdByPhone
 *    deliberately returns null for both). Drives the first-contact "do you
 *    already have an account?" ask.
 *  - `plans`: active abonnements on that contact ([] when linked-but-no-plan
 *    or unlinked).
 */
export interface MembershipLookup {
  linked: boolean;
  plans: MembershipContext[];
}

const membershipCache = new Map<string, { fetchedAt: number; result: MembershipLookup }>();
const MEMBERSHIP_CACHE_TTL_MS = 10 * 60 * 1000;

/**
 * Drop a client's cached memberships so the next message re-fetches them.
 * Called whenever the balance just changed: plan activated after purchase,
 * session deducted by book_with_membership, session re-credited by a
 * cancellation — the injected context must reflect it immediately instead of
 * lagging up to 10 min.
 */
export function invalidateMembershipCache(clientId: string): void {
  membershipCache.delete(clientId);
}

/**
 * Returns null when the lookup FAILS (context then says "unknown" — we must
 * never tell a client they have no account just because Wix errored). On
 * success, reports whether the number is linked to a unique contact and the
 * active plans on it.
 */
export async function activeMemberships(client: Client): Promise<MembershipLookup | null> {
  const hit = membershipCache.get(client.id);
  if (hit && Date.now() - hit.fetchedAt < MEMBERSHIP_CACHE_TTL_MS) return hit.result;
  try {
    // Repair-on-touch safety net for a delayed/missed counter webhook. This is
    // scoped to this client's registry rows and is idempotent.
    await repairClientKeyBonuses(client.id).catch((error) =>
      console.error("Client Key bonus repair failed:", error),
    );
    const contactId = await wix.findContactIdByPhone(
      `+${client.wa_phone.replace(/^\+/, "")}`,
      client.name ?? undefined,
    );
    const memberships = contactId ? await wix.listActiveMemberships(contactId) : [];
    // Renewability comes from the live catalog (business rule in wix.ts:
    // duration ≥ 1 month, not a gift card). A plan not found there (archived/
    // hidden, or a free program filtered out) is treated as NON-renewable — we
    // never wrongly offer to renew a trial (Pack Découverte) or a gift card.
    const catalog = memberships.length ? await wix.listPlans().catch(() => []) : [];
    const renewablePlanIds = new Set(
      catalog.filter((p) => p.renewable).map((p) => p.id),
    );
    const plans = await Promise.all(
      memberships.map(async (m) => ({
        planId: m.planId,
        plan: m.planName,
        covers: await wix.planCoveredClassNames(m.planId),
        remaining: contactId
          ? await wix.planRemainingSessions(contactId, m.planId, m.planName, m.orderId)
          : null,
        expiresAt: m.expiresAt,
        renewable: renewablePlanIds.has(m.planId),
        foundingMember:
          config.KEYS_AUTOMATION_ENABLED &&
          config.LEGACY_REFORMER_PLAN_IDS.includes(m.planId),
      })),
    );
    const result: MembershipLookup = { linked: contactId !== null, plans };
    membershipCache.set(client.id, { fetchedAt: Date.now(), result });
    return result;
  } catch (err) {
    console.error("Membership lookup failed (context will say unknown):", err);
    return null;
  }
}
