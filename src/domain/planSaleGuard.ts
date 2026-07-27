/**
 * Wix's `public:false` flag only hides a Pricing Plan from the website. It
 * does not mean "internal": Awa intentionally sells some non-public plans.
 * An explicit id allowlist is therefore the only safe catalogue boundary.
 */
export function isPlanSellableByAwa(
  planId: string,
  allowedPlanIds: readonly string[],
  enforceWhenUnconfigured = process.env.NODE_ENV === "production",
): boolean {
  if (allowedPlanIds.length === 0) return !enforceWhenUnconfigured;
  return allowedPlanIds.includes(planId);
}
