/**
 * Pure logic for the « 1re séance L'Invitée » staff alert: one WhatsApp ping
 * ~1 h before a Reformer class containing at least one client attending the
 * FIRST of the 3 sessions of their Clé L'Invitée, so accueil offers the
 * welcome matcha without the client having to ask. No DB, no network — the
 * sweep (firstSessionAlert.ts) is the only I/O layer.
 */
import { config } from "../config.js";
import type { SlotWithName } from "./notificationRules.js";

export const FIRST_SESSION_LEAD_MINUTES = 60;

/**
 * Due = inside the lead window [start − 60 min, start). Same shape as
 * dueClassReminders: a restart inside the window still sends (late but useful),
 * a class already started never does.
 */
export function isFirstSessionAlertDue(startIso: string, now: Date): boolean {
  const start = new Date(startIso).getTime();
  if (Number.isNaN(start)) return false;
  const nowMs = now.getTime();
  return nowMs >= start - FIRST_SESSION_LEAD_MINUTES * 60_000 && nowMs < start;
}

/**
 * One send per (occurrence, recipient). The attendee list is stable inside the
 * last hour (Wix availability closes before that), so the class-level key never
 * hides a late joiner in practice.
 */
export function firstSessionDedupKey(eventId: string, recipientDigits: string): string {
  return `INVITEE_FIRST:${eventId}:${recipientDigits}`;
}

export interface FirstSessionAttendee {
  clientName: string | null;
  waPhone: string;
  isTest: boolean;
}

export interface AlertRecipient {
  name: string;
  phone: string;
}

function fmtTime(iso: string): string {
  return new Date(iso).toLocaleTimeString("fr-FR", {
    timeZone: config.TIMEZONE,
    hour: "2-digit",
    minute: "2-digit",
  });
}

function attendeeLine(a: FirstSessionAttendee): string {
  const name = (a.clientName ?? "").trim() || "Cliente sans nom enregistré";
  const testTag = a.isTest ? " [TEST]" : "";
  return `• ${name}${testTag} (${a.waPhone})`;
}

/**
 * Deliberately terse (Babakar 21/08): the subject carries class + time + the
 * matcha cue, the body only lists who — no coach, no date line, no footer.
 */
export function buildFirstSessionMessage(
  slot: Pick<SlotWithName, "serviceName" | "startDate" | "coach">,
  attendees: FirstSessionAttendee[],
): { subject: string; body: string } {
  const time = fmtTime(slot.startDate);
  const service = slot.serviceName || "Cours";
  const subject = `🍵 Matcha offert — ${service} ${time}`;
  const body = `1re séance L'Invitée :\n${attendees.map(attendeeLine).join("\n")}`;
  return { subject, body };
}

/**
 * Owner + every accueil on shift at class time, deduplicated by phone digits.
 * `onShiftAccueil` arrives already filtered (role accueil, non-muted, valid
 * phone, shift covering the class start). When the planning yields nobody, the
 * reception number takes accueil's leg so the alert is never owner-only by
 * accident (deliveryNotify fallback posture).
 */
export function assembleFirstSessionRecipients(args: {
  onShiftAccueil: AlertRecipient[];
  ownerPhone: string;
  receptionPhone: string;
  phoneDigits: (phone: string) => string;
}): AlertRecipient[] {
  const { phoneDigits } = args;
  const out: AlertRecipient[] = [];
  const seen = new Set<string>();
  const push = (r: AlertRecipient): boolean => {
    const digits = phoneDigits(r.phone);
    if (digits.length < 8 || seen.has(digits)) return false;
    seen.add(digits);
    out.push(r);
    return true;
  };
  push({ name: "owner", phone: args.ownerPhone });
  // The owner doubling as the on-shift accueil still counts as accueil covered.
  let accueilCovered = false;
  for (const r of args.onShiftAccueil) {
    if (push(r) || phoneDigits(r.phone).length >= 8) accueilCovered = true;
  }
  if (!accueilCovered) push({ name: "réception", phone: args.receptionPhone });
  return out;
}
