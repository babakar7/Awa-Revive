import { config } from "../config.js";
import { sendText } from "../lib/whatsapp.js";
import { notifyReception } from "../lib/notify.js";
import * as repo from "./repo.js";
import { recordBookingFunnelEvent } from "./bookingFunnel.js";

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

export function planExpiryNudgeMessage(lang: string | null, planName: string): string {
  switch (lang) {
    case "en":
      return (
        `⏳ Your payment link for "${planName}" has expired — we haven't received a payment confirmation. ` +
        `If you already paid, just reply here and the team will check it for you right away; otherwise, ` +
        `tell me and I'll send you a fresh link 🙂`
      );
    case "wo":
      return (
        `⏳ Sa lien de paiement ngir « ${planName} » jeex na — jotagunu confirmation fey bi. Su fekkee fey nga ba noppi, ` +
        `tontul ma fii te équipe bi dina ko seet ci saa si ; lu ko moy, waxal ma ma yónnee la beneen lien bu bees 🙂`
      );
    default:
      return (
        `⏳ Ton lien de paiement pour « ${planName} » a expiré — nous n'avons pas reçu de confirmation de paiement. ` +
        `Si tu as déjà payé, réponds-moi simplement ici et l'équipe vérifie tout de suite ; sinon, dis-le-moi et ` +
        `je t'en renvoie un tout frais 🙂`
      );
  }
}

/**
 * Plan-order twin of nudgeExpiredLinks. Same one-shot client follow-up, PLUS a
 * reception alert for Orange Money / Max It orders: a lost Sonatel callback is
 * invisible to Awa (the list API can't be joined to pending rows), so an OM/Max
 * It link that expires with no callback is the one case where a real payment can
 * silently vanish (Maryeme 01/08). Flag reception to check the portal.
 */
export async function nudgeExpiredPlanOrders(log: {
  info: (o: unknown, m?: string) => void;
  error: (o: unknown, m?: string) => void;
}): Promise<number> {
  const candidates = await repo.expiredPlanOrdersToNudge();
  let sent = 0;
  for (const o of candidates) {
    if (!(await repo.claimPlanOrderExpiryNudge(o.id))) continue;
    try {
      const msg = planExpiryNudgeMessage(o.language, o.plan_name);
      await sendText(o.wa_phone, msg);
      await repo.addTurn(o.client_id, "assistant", msg);
      if (o.payment_method === "orange_money" || o.payment_method === "maxit") {
        const label = o.payment_method === "maxit" ? "Max It" : "Orange Money";
        const phone = `+${String(o.wa_phone).replace(/^\+/, "")}`;
        const expiredAt = o.link_expires_at ? new Date(o.link_expires_at) : null;
        notifyReception(
          `⚠️ Lien ${label} expiré sans confirmation — ${o.plan_name}`,
          `Un lien de paiement ${label} a expiré sans qu'aucun callback de paiement n'arrive. ` +
            `Si la cliente dit avoir payé, c'est probablement un callback Sonatel perdu (invisible côté Awa).\n` +
            `  Cliente : ${phone}\n` +
            `  Formule : ${o.plan_name}\n` +
            `  Montant : ${o.amount_xof} FCFA\n` +
            (expiredAt ? `  Lien expiré à : ${formatSlot(expiredAt, "fr-FR")}\n` : "") +
            `\nÀ faire si un paiement est réclamé : vérifier le portail OM autour de cette heure ; ` +
            `si la transaction existe, rejouer le callback (voir OM-LINKS-HOW-TO.md) pour finaliser ` +
            `automatiquement l'abonnement et la séance.`,
        );
      }
      sent++;
      log.info({ planOrderId: o.id }, "Expired plan-order nudge sent");
    } catch (err) {
      log.error({ err, planOrderId: o.id }, "Expired plan-order nudge failed");
    }
  }
  return sent;
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
      await recordBookingFunnelEvent({
        clientId: b.client_id,
        bookingId: b.id,
        stage: "recovery_sent",
        paymentMethod: b.payment_method,
        idempotencyKey: `booking:${b.id}:recovery-sent`,
        metadata: { recovery: "expired_link_one_shot" },
      });
      sent++;
      log.info({ bookingId: b.id }, "Expired-link nudge sent");
    } catch (err) {
      log.error({ err, bookingId: b.id }, "Expired-link nudge failed");
    }
  }
  return sent;
}
