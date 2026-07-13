import { config } from "../config.js";
import { sendText } from "../lib/whatsapp.js";
import * as repo from "./repo.js";

/**
 * One-shot follow-up when a payment link expires unused: the client showed
 * clear intent (a link was created for a precise slot) then went silent — a
 * single gentle nudge recovers those bookings. Runs from the 60s sweeper,
 * right after the TTL sweep; repo.expiredLinksToNudge keeps it narrow (recent
 * TTL expiry only, client hasn't moved on) and claimExpiryNudge makes it
 * one-shot. Always inside WhatsApp's 24h window: the client necessarily wrote
 * to us minutes before the link was created.
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

export function expiryNudgeMessage(
  lang: string | null,
  serviceName: string,
  slotStart: Date,
): string {
  switch (lang) {
    case "en":
      return (
        `⏳ Your payment link for ${serviceName} (${formatSlot(slotStart, "en-GB")}) has expired — ` +
        `we haven't received a payment confirmation. If you just paid, your confirmation should arrive ` +
        `automatically within 1–2 minutes; otherwise, reply here and I'll send you a fresh link 🙂`
      );
    case "wo":
      return (
        `⏳ Sa lien de paiement ngir ${serviceName} (${formatSlot(slotStart, "fr-FR")}) jeex na — ` +
        `jotagunu confirmation fey bi. Su fekkee fey nga leegi, confirmation bi dina ñëw ci 1–2 simili; ` +
        `lu ko moy, bindal ma fii ma yónnee la beneen lien bu bees 🙂`
      );
    default:
      return (
        `⏳ Ton lien de paiement pour ${serviceName} (${formatSlot(slotStart, "fr-FR")}) a expiré — ` +
        `nous n'avons pas reçu de confirmation de paiement. Si tu viens de payer, ta confirmation devrait ` +
        `arriver automatiquement d'ici 1 à 2 min ; sinon, réponds-moi et je t'en renvoie un tout frais 🙂`
      );
  }
}

/** Send the pending nudges. Returns how many were sent. */
export async function nudgeExpiredLinks(log: {
  info: (o: unknown, m?: string) => void;
  error: (o: unknown, m?: string) => void;
}): Promise<number> {
  const candidates = await repo.expiredLinksToNudge();
  let sent = 0;
  for (const b of candidates) {
    // Claim BEFORE sending: a lost nudge is a minor miss, a double nudge is spam.
    if (!(await repo.claimExpiryNudge(b.id))) continue;
    try {
      const msg = expiryNudgeMessage(b.language, b.service_name, new Date(b.slot_start));
      await sendText(b.wa_phone, msg);
      await repo.addTurn(b.client_id, "assistant", msg);
      sent++;
      log.info({ bookingId: b.id }, "Expired-link nudge sent");
    } catch (err) {
      log.error({ err, bookingId: b.id }, "Expired-link nudge failed");
    }
  }
  return sent;
}
