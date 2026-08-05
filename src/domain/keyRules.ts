import { config } from "../config.js";

export type KeyType =
  | "INVITEE"
  | "HABITUEE"
  | "RESIDENTE"
  | "AQUABIKE"
  | "SUR_MESURE";

/**
 * Continuity family. A client may hold one active/scheduled subscription PER
 * family at a time (never two of the same family). Reformer-based keys
 * (the three Clés + the sur-mesure plan) share one pool of Reformer sessions
 * and chain among themselves; the Aquabike abonnement is its own family and
 * coexists freely with a Reformer key. Continuity is always resolved WITHIN a
 * family — an Aquabike source can never mask a Clé, nor the reverse.
 */
export type ContinuityFamily = "REFORMER" | "AQUABIKE";

/** 12h30 lun–ven (créneau calme) vs. n'importe quelle heure lun–ven. */
export type SlotRule = "CALM_SLOT_1230" | "ANY_WEEKDAY_HOUR";

/**
 * NEVER_REFORMER: the friend must never have done Reformer at Revive (a visit
 * for another class does NOT disqualify) — the Clé invitation rule.
 * NEVER_AQUABIKE: the friend must never have done Aquabike at Revive — the
 * Aquabike invitation rule ("une amie qui n'a jamais fait d'Aquabike").
 */
export type FriendHistoryRule = "NEVER_REFORMER" | "NEVER_AQUABIKE";

export interface InvitationRule {
  /** Wix plan whose offline order grants the friend's free session. */
  planId: string;
  /** Services the invitation may be booked on. */
  serviceIds: string[];
  slotRule: SlotRule;
  friendRule: FriendHistoryRule;
}

export interface BonusRule {
  /** Wix plan granting the "cours en plus" / bonus session credit. */
  planId: string;
  serviceIds: string[];
  slotRule: SlotRule;
}

export interface KeyPlanMapping {
  type: KeyType;
  planId: string;
  family: ContinuityFamily;
  durationDays: number;
  /** Base invitations earned per cycle, before any continuity bonus. */
  baseInvitations: number;
  /** Whether an early renewal grants +1 invitation (Clés only). */
  continuityInvitation: boolean;
  /** Whether this type can trigger the one-time Google-review gate (Clés only). */
  reviewGateEligible: boolean;
  invitation: InvitationRule;
  /** null when the plan has no "cours en plus" (sur-mesure covers Mat/Step itself). */
  bonus: BonusRule | null;
}

/**
 * The catalogue of key types. Reformer-family Clés keep their historical rules
 * (base invitation only for La Résidente, +1 continuity, review-gate eligible).
 * AQUABIKE and SUR_MESURE each grant exactly one invitation per cycle with no
 * continuity bonus and are never review-gated. A type is dropped from the list
 * until fully configured, so an unset env var leaves it dark (its plan is sold
 * as an ordinary non-key plan) — a safe no-op, never a half-wired state.
 */
export function configuredKeyMappings(): KeyPlanMapping[] {
  const clePlanBonus = (bonusPlanId: string): BonusRule | null =>
    bonusPlanId ? { planId: bonusPlanId, serviceIds: config.KEY_BONUS_SERVICE_IDS, slotRule: "ANY_WEEKDAY_HOUR" } : null;
  const reformerInvitation = (): InvitationRule => ({
    planId: config.INVITATION_PLAN_ID,
    serviceIds: config.KEY_REFORMER_SERVICE_IDS,
    slotRule: "CALM_SLOT_1230",
    friendRule: "NEVER_REFORMER",
  });

  const mappings: Array<{ mapping: KeyPlanMapping; requires: unknown[] }> = [
    {
      requires: [config.INVITEE_PLAN_ID, config.INVITEE_BONUS_PLAN_ID],
      mapping: {
        type: "INVITEE",
        planId: config.INVITEE_PLAN_ID,
        family: "REFORMER",
        durationDays: 21,
        baseInvitations: 0,
        continuityInvitation: true,
        reviewGateEligible: true,
        invitation: reformerInvitation(),
        bonus: clePlanBonus(config.INVITEE_BONUS_PLAN_ID),
      },
    },
    {
      requires: [config.HABITUEE_PLAN_ID, config.HABITUEE_BONUS_PLAN_ID],
      mapping: {
        type: "HABITUEE",
        planId: config.HABITUEE_PLAN_ID,
        family: "REFORMER",
        durationDays: 30,
        baseInvitations: 0,
        continuityInvitation: true,
        reviewGateEligible: true,
        invitation: reformerInvitation(),
        bonus: clePlanBonus(config.HABITUEE_BONUS_PLAN_ID),
      },
    },
    {
      requires: [config.RESIDENTE_PLAN_ID, config.RESIDENTE_BONUS_PLAN_ID],
      mapping: {
        type: "RESIDENTE",
        planId: config.RESIDENTE_PLAN_ID,
        family: "REFORMER",
        durationDays: 60,
        baseInvitations: 1,
        continuityInvitation: true,
        reviewGateEligible: true,
        invitation: reformerInvitation(),
        bonus: clePlanBonus(config.RESIDENTE_BONUS_PLAN_ID),
      },
    },
    // Sur mesure: Reformer family, no bonus (the plan's own pool already covers
    // its non-Reformer classes), 1 invitation/cycle. One mapping per configured
    // plan id — several clientes can each have their own tailor-made plan.
    // Every SUR_MESURE mapping shares the exact same rule fields (only planId
    // differs), which keeps keyMappingForType() correct even though the type
    // is no longer unique in this list.
    ...config.SUR_MESURE_PLAN_IDS.map((planId) => ({
      requires: [planId] as unknown[],
      mapping: {
        type: "SUR_MESURE" as const,
        planId,
        family: "REFORMER" as const,
        durationDays: 30,
        baseInvitations: 1,
        continuityInvitation: false,
        reviewGateEligible: false,
        invitation: reformerInvitation(),
        bonus: null,
      },
    })),
    {
      // Aquabike: its own family. Bonus = 1 Reformer session on the calm 12h30
      // slot; invitation = 1 Aquabike class (any weekday hour) for a friend who
      // never came to Revive. Needs all four Aquabike vars set.
      requires: [
        config.AQUABIKE_ABO_PLAN_ID,
        config.AQUABIKE_BONUS_PLAN_ID,
        config.AQUABIKE_INVITATION_PLAN_ID,
        config.AQUABIKE_SERVICE_IDS.length,
      ],
      mapping: {
        type: "AQUABIKE",
        planId: config.AQUABIKE_ABO_PLAN_ID,
        family: "AQUABIKE",
        durationDays: 30,
        baseInvitations: 1,
        continuityInvitation: false,
        reviewGateEligible: false,
        invitation: {
          planId: config.AQUABIKE_INVITATION_PLAN_ID,
          serviceIds: config.AQUABIKE_SERVICE_IDS,
          slotRule: "ANY_WEEKDAY_HOUR",
          friendRule: "NEVER_AQUABIKE",
        },
        bonus: {
          planId: config.AQUABIKE_BONUS_PLAN_ID,
          serviceIds: config.KEY_REFORMER_SERVICE_IDS,
          slotRule: "CALM_SLOT_1230",
        },
      },
    },
  ];
  return mappings
    .filter((entry) => entry.requires.every(Boolean))
    .map((entry) => entry.mapping);
}

export function keyMappingForPlan(planId: string): KeyPlanMapping | null {
  return configuredKeyMappings().find((mapping) => mapping.planId === planId) ?? null;
}

export function keyMappingForType(type: KeyType): KeyPlanMapping | null {
  return configuredKeyMappings().find((mapping) => mapping.type === type) ?? null;
}

export function familyOfPlan(planId: string): ContinuityFamily | null {
  return keyMappingForPlan(planId)?.family ?? null;
}

export function invitationEarnings(
  mapping: KeyPlanMapping,
  hasPreviousKeyOrLegacyReformer: boolean,
  boughtBeforePreviousExpiry: boolean,
): number {
  const continuity =
    mapping.continuityInvitation &&
    hasPreviousKeyOrLegacyReformer &&
    boughtBeforePreviousExpiry
      ? 1
      : 0;
  return mapping.baseInvitations + continuity;
}

/**
 * Whether THIS verified Key purchase triggers the one-time Google-review gate:
 * its invitations are created PENDING_REVIEW until the client leaves a review.
 * The gate changes the born-status of the invitation rows, never their count
 * (that stays governed by invitationEarnings). Only Clé types are eligible, and
 * only on an early renewal — never AQUABIKE/SUR_MESURE, even when they earn an
 * invitation on a first (or early) purchase.
 */
export function reviewGateApplies(args: {
  featureEnabled: boolean; // KEYS_AUTOMATION_ENABLED && GOOGLE_REVIEW_URL set
  typeEligible: boolean; // mapping.reviewGateEligible (Clés only)
  earlyRenewal: boolean; // purchasedAt < continuity source expiry
  clientKnown: boolean; // gate is per-client; anonymous purchases never gate
  clientAlreadyGated: boolean; // a google_review_gates row already exists
  invitationCount: number; // from invitationEarnings, unchanged by this feature
}): boolean {
  return (
    args.featureEnabled &&
    args.typeEligible &&
    args.earlyRenewal &&
    args.clientKnown &&
    !args.clientAlreadyGated &&
    args.invitationCount > 0
  );
}

export function isDakarWeekday(date: Date): boolean {
  const day = date.getUTCDay();
  return day >= 1 && day <= 5;
}

/** True when `start` satisfies the given slot rule. */
export function slotRuleAllows(rule: SlotRule, start: Date): boolean {
  if (!isDakarWeekday(start)) return false;
  if (rule === "ANY_WEEKDAY_HOUR") return true;
  return (
    start.getUTCHours() === config.INVITATION_SLOT_HOUR &&
    start.getUTCMinutes() === config.INVITATION_SLOT_MINUTE
  );
}

/** Legacy Clé helpers kept for existing callers/tests (Reformer 12h30 / weekday). */
export function isBonusSlotAllowed(start: Date): boolean {
  return isDakarWeekday(start);
}

export function isInvitationSlotAllowed(start: Date): boolean {
  return slotRuleAllows("CALM_SLOT_1230", start);
}

/** Whether an invitation on `serviceId` at `start` fits this key's invitation rule. */
export function invitationScopeAllows(
  mapping: KeyPlanMapping,
  serviceId: string,
  start: Date,
): boolean {
  return (
    mapping.invitation.serviceIds.includes(serviceId) &&
    slotRuleAllows(mapping.invitation.slotRule, start)
  );
}

/** Whether a bonus on `serviceId` at `start` fits this key's bonus rule. */
export function bonusScopeAllows(
  mapping: KeyPlanMapping,
  serviceId: string,
  start: Date,
): boolean {
  if (!mapping.bonus) return false;
  return (
    mapping.bonus.serviceIds.includes(serviceId) &&
    slotRuleAllows(mapping.bonus.slotRule, start)
  );
}

/** Any configured mapping whose invitation rule admits (serviceId, start). */
export function anyInvitationScopeAllows(serviceId: string, start: Date): boolean {
  return configuredKeyMappings().some((mapping) =>
    invitationScopeAllows(mapping, serviceId, start),
  );
}

/** Any configured mapping whose bonus rule admits (serviceId, start). */
export function anyBonusScopeAllows(serviceId: string, start: Date): boolean {
  return configuredKeyMappings().some((mapping) =>
    bonusScopeAllows(mapping, serviceId, start),
  );
}

/**
 * The friend-eligibility rule for an invitation on `serviceId`. Invitation
 * service sets are disjoint across families (Reformer vs Aquabike), so the
 * service alone determines the rule. null = no configured invitation covers it.
 */
export function invitationFriendRuleForService(
  serviceId: string,
): FriendHistoryRule | null {
  const mapping = configuredKeyMappings().find((entry) =>
    entry.invitation.serviceIds.includes(serviceId),
  );
  return mapping?.invitation.friendRule ?? null;
}

/** Calendar date in Dakar. Kept explicit even though Dakar currently equals UTC. */
export function dakarDateKey(date: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: config.TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? "";
  return `${value("year")}-${value("month")}-${value("day")}`;
}
