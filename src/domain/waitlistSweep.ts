import { config } from "../config.js";
import { sendText } from "../lib/whatsapp.js";
import * as wix from "../lib/wix.js";
import * as repo from "./repo.js";

/**
 * Waitlist sweep (runs with the 5-min cancellation sweep): for every WAITING
 * entry whose class hasn't started, re-check availability in ONE batched Wix
 * call; a freed spot sends ONE WhatsApp nudge (claim WAITING→NOTIFIED before
 * sending, exactly like the expiry nudge — a lost nudge is a minor miss, a
 * double nudge is spam). No booking is created here: the client replies and
 * the normal payment-first flow (fresh check_availability included) applies.
 *
 * 24h-window caveat (accepted product trade-off, 11/07): the nudge is plain
 * text — if the client's last inbound message is older than 24h Meta rejects
 * it (131047) and the entry is marked NOTIFY_FAILED. First come, first served:
 * every waiter on the slot is notified.
 */

function formatSlot(date: Date, locale: string): string {
  return date.toLocaleString(locale, {
    timeZone: config.TIMEZONE,
    weekday: "long",
    day: "numeric",
    month: "long",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function waitlistNudgeMessage(
  lang: string | null,
  serviceName: string,
  slotStart: Date,
): string {
  switch (lang) {
    case "en":
      return (
        `🎉 Good news — a spot just freed up for ${serviceName} (${formatSlot(slotStart, "en-GB")})! ` +
        `Reply here quickly if you want it — first come, first served 🙏🏾`
      );
    case "wo":
      return (
        `🎉 Xibaar bu baax — am na palaas bu ubbiku ci ${serviceName} (${formatSlot(slotStart, "fr-FR")})! ` +
        `Bindal ma fii bu gaaw soo ko bëggee — ki jëkk a ñëw mooy jël 🙏🏾`
      );
    default:
      return (
        `🎉 Bonne nouvelle — une place vient de se libérer pour ${serviceName} (${formatSlot(slotStart, "fr-FR")}) ! ` +
        `Réponds-moi vite ici si tu la veux — premier arrivé, premier servi 🙏🏾`
      );
  }
}

/** Check freed spots and send the pending nudges. Returns how many were sent. */
export async function sweepWaitlist(log: {
  info: (o: unknown, m?: string) => void;
  error: (o: unknown, m?: string) => void;
}): Promise<number> {
  const expired = await repo.expirePastWaitlistEntries();
  if (expired > 0) log.info({ expired }, "Waitlist entries expired (class started)");

  const entries = await repo.pendingWaitlistEntries();
  if (entries.length === 0) return 0;

  // One batched availability call covering every waited-on slot.
  const serviceIds = [...new Set(entries.map((e) => e.service_id))];
  const starts = entries.map((e) => new Date(e.slot_start).getTime());
  const from = new Date(Math.min(...starts) - 60 * 60 * 1000).toISOString();
  const to = new Date(Math.max(...starts) + 60 * 60 * 1000).toISOString();
  const slots = await wix.queryAvailabilityMulti(serviceIds, from, to);
  const openByEvent = new Map(
    slots.filter((s) => s.openSpots > 0).map((s) => [s.eventId, s.openSpots]),
  );

  let sent = 0;
  for (const entry of entries) {
    if (!openByEvent.has(entry.event_id)) continue;
    // Claim BEFORE sending — one-shot per entry even across concurrent sweeps.
    if (!(await repo.claimWaitlistNotify(entry.id))) continue;
    try {
      const msg = waitlistNudgeMessage(entry.language, entry.service_name, new Date(entry.slot_start));
      await sendText(entry.wa_phone, msg);
      await repo.addTurn(entry.client_id, "assistant", msg);
      sent++;
      log.info({ waitlistId: entry.id, event: entry.event_id }, "Waitlist nudge sent");
    } catch (err) {
      // Typical cause: 24h window closed (Meta 131047). Never retried.
      await repo.markWaitlistNotifyFailed(entry.id).catch(() => {});
      log.error({ err, waitlistId: entry.id }, "Waitlist nudge failed");
    }
  }
  return sent;
}
