import { config } from "../config.js";

/**
 * Subscriber massage rate — a SERVER pricing decision, never the model's
 * (invariant: "le modèle propose, le serveur décide"). Holders of a qualifying
 * abonnement pay a reduced flat price for the massage service; everyone else
 * pays the Wix catalog price.
 *
 * Wix Bookings has no native "members pay a different price" concept — a plan
 * either fully covers a service or it doesn't — so this rate lives here and is
 * applied when the paid Wave/OM link is built. The massage service is
 * deliberately NOT connected to any plan in Wix, so it is always a paid link
 * (never a session deduction): this rule only changes the AMOUNT, never whether
 * a booking is free.
 */
export interface MassageRateConfig {
  serviceIds: string[];
  memberPlanIds: string[];
  memberXof: number;
}

export interface MassageRateResult {
  /** Per-person price to charge. */
  unitXof: number;
  /** True only when the member rate actually lowered the price. */
  memberRateApplied: boolean;
}

/**
 * Pure core (unit-tested). Returns the member rate only when ALL hold:
 *  - the service is one of the configured massage services,
 *  - the client holds at least one qualifying plan,
 *  - a positive member price is configured, AND
 *  - that price is strictly below the catalog price (a misconfigured rate that
 *    is >= catalog must never silently overcharge — fall back to catalog).
 * Any other case returns the catalog price unchanged, so the feature is inert
 * until it is deliberately configured.
 */
export function resolveMassageUnitPricePure(args: {
  serviceId: string;
  catalogPriceXof: number;
  activePlanIds: readonly string[];
  config: MassageRateConfig;
}): MassageRateResult {
  const { serviceId, catalogPriceXof, activePlanIds, config: cfg } = args;
  const catalog = { unitXof: catalogPriceXof, memberRateApplied: false };

  if (!cfg.serviceIds.includes(serviceId)) return catalog;
  if (!Number.isFinite(cfg.memberXof) || cfg.memberXof <= 0) return catalog;
  if (cfg.memberXof >= catalogPriceXof) return catalog;

  const planSet = new Set(cfg.memberPlanIds);
  const qualifies = activePlanIds.some((id) => planSet.has(id));
  if (!qualifies) return catalog;

  return { unitXof: cfg.memberXof, memberRateApplied: true };
}

/** Thin wrapper reading the live config. */
export function resolveMassageUnitPrice(args: {
  serviceId: string;
  catalogPriceXof: number;
  activePlanIds: readonly string[];
}): MassageRateResult {
  return resolveMassageUnitPricePure({
    ...args,
    config: {
      serviceIds: config.MASSAGE_SERVICE_IDS,
      memberPlanIds: config.MASSAGE_MEMBER_PLAN_IDS,
      memberXof: config.MASSAGE_MEMBER_RATE_XOF,
    },
  });
}
