import { config } from "../config.js";
import { sendText, sendTemplate } from "../lib/whatsapp.js";
import { toTemplateParam } from "../lib/notify.js";
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
 * 24h-window: free-text first; on Meta 131047, if WA_WAITLIST_TEMPLATE is set,
 * fall back to that template (same pattern as notify.ts reception WhatsApp).
 * NEVER both (template only after free-text was refused). NOTIFY_FAILED only
 * when both fail (or free-text fails and no template is configured).
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

/** Pure: should we attempt the Utility template after a free-text failure? */
export function shouldFallbackWaitlistTemplate(
  err: unknown,
  templateName: string,
): boolean {
  return !!templateName && String(err).includes("131047");
}

/**
 * Template body params: class name + date/time label (sanitized). Pure.
 * `templateLang` is the Meta language code (e.g. en, en_US, fr) so {{2}}
 * matches the template language (English template → English weekday/month).
 */
export function waitlistTemplateParams(
  serviceName: string,
  slotStart: Date,
  templateLang: string = "fr",
): [string, string] {
  const locale = /^en/i.test(templateLang) ? "en-GB" : "fr-FR";
  return [
    toTemplateParam(serviceName, 60),
    toTemplateParam(formatSlot(slotStart, locale), 60),
  ];
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
    const msg = waitlistNudgeMessage(
      entry.language,
      entry.service_name,
      new Date(entry.slot_start),
    );
    try {
      await sendText(entry.wa_phone, msg);
      await repo.addTurn(entry.client_id, "assistant", msg);
      sent++;
      log.info({ waitlistId: entry.id, event: entry.event_id }, "Waitlist nudge sent");
    } catch (err) {
      // Free-text refused (typically 24h window / 131047) → optional template.
      if (shouldFallbackWaitlistTemplate(err, config.WA_WAITLIST_TEMPLATE)) {
        try {
          const [p1, p2] = waitlistTemplateParams(
            entry.service_name,
            new Date(entry.slot_start),
            config.WA_WAITLIST_TEMPLATE_LANG,
          );
          await sendTemplate(
            entry.wa_phone,
            config.WA_WAITLIST_TEMPLATE,
            config.WA_WAITLIST_TEMPLATE_LANG,
            [p1, p2],
          );
          // Same free-text body logged so Awa has context when the client replies.
          await repo.addTurn(entry.client_id, "assistant", msg);
          sent++;
          log.info(
            { waitlistId: entry.id, event: entry.event_id },
            "Waitlist nudge sent via template (131047 fallback)",
          );
          continue;
        } catch (tmplErr) {
          await repo.markWaitlistNotifyFailed(entry.id).catch(() => {});
          log.error(
            { err: tmplErr, waitlistId: entry.id },
            "Waitlist template fallback failed",
          );
          continue;
        }
      }
      await repo.markWaitlistNotifyFailed(entry.id).catch(() => {});
      log.error({ err, waitlistId: entry.id }, "Waitlist nudge failed");
    }
  }
  return sent;
}
