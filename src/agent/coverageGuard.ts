/**
 * Membership-coverage guard for create_payment_link (server decides).
 *
 * Prod 29/07: a client with an active plan was both told (wrongly) her plan
 * didn't cover Reformer AND could have been charged à-la-carte for a class her
 * plan pays for. This pure check refuses a paid class link when the client's
 * active plan clearly covers the service with enough sessions — directing the
 * flow through book_with_membership instead.
 *
 * Non-looping by design: it fires ONLY when remaining >= participants. If the
 * plan can't cover everyone (overflow group, exhausted balance) or the balance
 * is unknown, it does NOT block — so a membership booking that fails
 * not_enough_sessions can still fall back to a paid link without deadlocking.
 * It never accepts a model-provided bypass; the decision is the server's.
 */
export interface CoveringPlan {
  planId: string;
  plan: string;
  remaining: number;
}

export function findCoveringPlan(
  serviceId: string,
  servicePricingPlanIds: string[] | undefined,
  plans: { planId: string; plan: string; remaining: number | null }[],
  participants: number,
): CoveringPlan | null {
  if (!servicePricingPlanIds || servicePricingPlanIds.length === 0) return null;
  for (const p of plans) {
    if (
      servicePricingPlanIds.includes(p.planId) &&
      p.remaining != null &&
      p.remaining >= participants
    ) {
      return { planId: p.planId, plan: p.plan, remaining: p.remaining };
    }
  }
  return null;
}
