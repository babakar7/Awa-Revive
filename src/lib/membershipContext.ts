import * as wix from "./wix.js";
import type { Client } from "../domain/repo.js";

/**
 * Automatic membership lookup, injected into Awa's context on every message —
 * clients must never pay Wave for a class their abonnement covers, even if
 * they don't think to mention it. Cached per client to keep latency flat.
 * Lives in its own module so both the agent (read) and the tools / Wave
 * webhook (invalidate after a deduction, re-credit or activation) can use it
 * without a circular import.
 */
export interface MembershipContext {
  plan: string;
  /** Class names this plan can pay for; null when Wix exposes no plan↔service links. */
  covers: string[] | null;
  /** Session credits left on the plan; null when the balance can't be read. */
  remaining: number | null;
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
    const contactId = await wix.findContactIdByPhone(
      `+${client.wa_phone.replace(/^\+/, "")}`,
      client.name ?? undefined,
    );
    const memberships = contactId ? await wix.listActiveMemberships(contactId) : [];
    const plans = await Promise.all(
      memberships.map(async (m) => ({
        plan: m.planName,
        covers: await wix.planCoveredClassNames(m.planId),
        remaining: contactId
          ? await wix.planRemainingSessions(contactId, m.planId, m.planName)
          : null,
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
