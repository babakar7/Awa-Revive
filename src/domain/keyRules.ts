import { config } from "../config.js";

export type KeyType = "INVITEE" | "HABITUEE" | "RESIDENTE";

export interface KeyPlanMapping {
  type: KeyType;
  planId: string;
  bonusPlanId: string;
  durationDays: number;
}

export function configuredKeyMappings(): KeyPlanMapping[] {
  const mappings: KeyPlanMapping[] = [
    {
      type: "INVITEE",
      planId: config.INVITEE_PLAN_ID,
      bonusPlanId: config.INVITEE_BONUS_PLAN_ID,
      durationDays: 21,
    },
    {
      type: "HABITUEE",
      planId: config.HABITUEE_PLAN_ID,
      bonusPlanId: config.HABITUEE_BONUS_PLAN_ID,
      durationDays: 30,
    },
    {
      type: "RESIDENTE",
      planId: config.RESIDENTE_PLAN_ID,
      bonusPlanId: config.RESIDENTE_BONUS_PLAN_ID,
      durationDays: 60,
    },
  ];
  return mappings.filter((mapping) => mapping.planId && mapping.bonusPlanId);
}

export function keyMappingForPlan(planId: string): KeyPlanMapping | null {
  return configuredKeyMappings().find((mapping) => mapping.planId === planId) ?? null;
}

export function invitationEarnings(
  newKeyType: KeyType,
  hasPreviousKeyOrLegacyReformer: boolean,
  boughtBeforePreviousExpiry: boolean,
): number {
  const normalBenefit = newKeyType === "RESIDENTE" ? 1 : 0;
  const continuity =
    hasPreviousKeyOrLegacyReformer && boughtBeforePreviousExpiry ? 1 : 0;
  return normalBenefit + continuity;
}

export function isDakarWeekday(date: Date): boolean {
  const day = date.getUTCDay();
  return day >= 1 && day <= 5;
}

export function isBonusSlotAllowed(start: Date): boolean {
  return isDakarWeekday(start);
}

export function isInvitationSlotAllowed(start: Date): boolean {
  return (
    isDakarWeekday(start) &&
    start.getUTCHours() === config.INVITATION_SLOT_HOUR &&
    start.getUTCMinutes() === config.INVITATION_SLOT_MINUTE
  );
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
