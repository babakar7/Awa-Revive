import { config } from "../config.js";
import { sendText } from "../lib/whatsapp.js";
import { notifyReception } from "../lib/notify.js";
import * as repo from "./repo.js";
import { recordBookingFunnelEvent } from "./bookingFunnel.js";
import { isOmOutageActive } from "./omOutage.js";

/**
 * One-shot follow-up when a payment link expires unused: the client showed
 * clear intent (a link was created for a precise slot) then went silent — a
 * single gentle nudge recovers those bookings. Runs from the 60s sweeper,
 * right after the TTL sweep; repo.expiredLinksToNudge keeps it narrow (recent
 * TTL expiry only, client hasn't moved on) and claimExpiryNudge makes it
 * one-shot. Always inside WhatsApp's 24h window: the client necessarily wrote
 * to us minutes before the link was created.
 *
 * OM/Max It twist (panne callbacks 31/07): an expired OM/Max It link may hide a
 * REAL payment whose Sonatel callback was lost. For those, reception is alerted
 * (owner copy via the ⚠ intervention marker) and, when the owner-activated
 * outage mode is on, the client copy never implies the payment wasn't made.
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
  omOutage = false,
): string {
  if (omOutage) {
    switch (lang) {
      case "en":
        return (
          `⏳ Your payment link for ${serviceName} (${formatSlot(slotStart, "en-GB")}) has expired. ` +
          `Heads-up: Orange Money / Max It confirmations are temporarily verified by our team, so they can take ` +
          `a bit longer. If you paid, reply here — the team is checking and your confirmation will arrive ` +
          `automatically. If you didn't pay yet, tell me and I'll send you a fresh link 🙂`
        );
      case "wo":
        return (
          `⏳ Sa lien de paiement ngir ${serviceName} (${formatSlot(slotStart, "fr-FR")}) jeex na. ` +
          `Confirmations Orange Money / Max It yi, équipe bi mooy leen seet léegi — mën na yàgg tuuti. ` +
          `Su fekkee fey nga, bindal ma fii ; su fekkee feyoo, waxal ma ma yónnee la beneen lien 🙂`
        );
      default:
        return (
          `⏳ Ton lien de paiement pour ${serviceName} (${formatSlot(slotStart, "fr-FR")}) a expiré. ` +
          `Petite précision : les confirmations Orange Money / Max It sont temporairement vérifiées par notre ` +
          `équipe, donc un peu plus lentes. Si tu as payé, réponds-moi ici — l'équipe vérifie et ta confirmation ` +
          `arrivera automatiquement. Si tu n'as pas encore payé, dis-le-moi et je t'en renvoie un tout frais 🙂`
        );
    }
  }
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

export function planExpiryNudgeMessage(
  lang: string | null,
  planName: string,
  omOutage = false,
): string {
  if (omOutage) {
    switch (lang) {
      case "en":
        return (
          `⏳ Your payment link for "${planName}" has expired. Heads-up: Orange Money / Max It confirmations ` +
          `are temporarily verified by our team, so they can take a bit longer. If you paid, reply here — the ` +
          `team is checking and your confirmation will arrive automatically. If you didn't pay yet, tell me ` +
          `and I'll send you a fresh link 🙂`
        );
      case "wo":
        return (
          `⏳ Sa lien de paiement ngir « ${planName} » jeex na. Confirmations Orange Money / Max It yi, ` +
          `équipe bi mooy leen seet léegi — mën na yàgg tuuti. Su fekkee fey nga, bindal ma fii ; ` +
          `su fekkee feyoo, waxal ma ma yónnee la beneen lien 🙂`
        );
      default:
        return (
          `⏳ Ton lien de paiement pour « ${planName} » a expiré. Petite précision : les confirmations ` +
          `Orange Money / Max It sont temporairement vérifiées par notre équipe, donc un peu plus lentes. ` +
          `Si tu as payé, réponds-moi ici — l'équipe vérifie et ta confirmation arrivera automatiquement. ` +
          `Si tu n'as pas encore payé, dis-le-moi et je t'en renvoie un tout frais 🙂`
        );
    }
  }
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

const OM_METHOD_LABEL: Record<string, string> = {
  orange_money: "Orange Money",
  maxit: "Max It",
};

/** Outage-only alert for an OM/Max It link that expired with no callback. */
function alertOmExpiry(args: {
  methodLabel: string;
  what: string;
  phone: string;
  amountXof: number;
  expiredAt: Date | null;
  omOutage: boolean;
}): void {
  notifyReception(
    `⚠️ Lien ${args.methodLabel} expiré sans confirmation — ${args.what}`,
    (args.omOutage ? `🚧 MODE PANNE OM ACTIF — réconciliation manuelle attendue.\n` : "") +
      `Un lien de paiement ${args.methodLabel} a expiré sans qu'aucun callback de paiement n'arrive. ` +
      `Si la cliente dit avoir payé, c'est probablement un callback Sonatel perdu (invisible côté Awa).\n` +
      `  Cliente : ${args.phone}\n` +
      `  Commande : ${args.what}\n` +
      `  Montant : ${args.amountXof} FCFA\n` +
      (args.expiredAt ? `  Lien expiré à : ${formatSlot(args.expiredAt, "fr-FR")}\n` : "") +
      `\nÀ faire si un paiement est réclamé : portail OM → copier l'ID de transaction (MP…) → ` +
      `${config.BASE_URL}/admin/paiements-om → choisir la commande et valider. La vérification Sonatel ` +
      `et la confirmation client sont automatiques ensuite.`,
  );
}

/**
 * Plan-order twin of nudgeExpiredLinks. Same one-shot client follow-up. While
 * outage mode is explicitly active, also flag reception because a lost Sonatel
 * callback is then a known operational risk.
 */
export async function nudgeExpiredPlanOrders(log: {
  info: (o: unknown, m?: string) => void;
  error: (o: unknown, m?: string) => void;
}): Promise<number> {
  const candidates = await repo.expiredPlanOrdersToNudge();
  if (candidates.length === 0) return 0;
  const omOutage = await isOmOutageActive().catch(() => false);
  let sent = 0;
  for (const o of candidates) {
    if (!(await repo.claimPlanOrderExpiryNudge(o.id))) continue;
    try {
      const isOm = o.payment_method === "orange_money" || o.payment_method === "maxit";
      const msg = planExpiryNudgeMessage(o.language, o.plan_name, omOutage && isOm);
      await sendText(o.wa_phone, msg);
      await repo.addTurn(o.client_id, "assistant", msg);
      if (isOm && omOutage) {
        alertOmExpiry({
          methodLabel: OM_METHOD_LABEL[o.payment_method] ?? o.payment_method,
          what: o.plan_name,
          phone: `+${String(o.wa_phone).replace(/^\+/, "")}`,
          amountXof: o.amount_xof,
          expiredAt: o.link_expires_at ? new Date(o.link_expires_at) : null,
          omOutage,
        });
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
  if (candidates.length === 0) return 0;
  const omOutage = await isOmOutageActive().catch(() => false);
  let sent = 0;
  for (const b of candidates) {
    // Claim BEFORE sending: a lost nudge is a minor miss, a double nudge is spam.
    if (!(await repo.claimExpiryNudge(b.id))) continue;
    try {
      const isOm = b.payment_method === "orange_money" || b.payment_method === "maxit";
      const msg = expiryNudgeMessage(
        b.language,
        b.service_name,
        new Date(b.slot_start),
        omOutage && isOm,
      );
      await sendText(b.wa_phone, msg);
      await repo.addTurn(b.client_id, "assistant", msg);
      // During an explicit outage, retain the lost-callback safety net used for
      // plan orders. In normal operation, successful callbacks reconcile
      // automatically and an expired unpaid link needs no owner intervention.
      if (isOm && omOutage) {
        alertOmExpiry({
          methodLabel: OM_METHOD_LABEL[b.payment_method] ?? b.payment_method,
          what: `${b.service_name} (${formatSlot(new Date(b.slot_start), "fr-FR")})`,
          phone: `+${String(b.wa_phone).replace(/^\+/, "")}`,
          amountXof: b.amount_xof,
          expiredAt: b.link_expires_at ? new Date(b.link_expires_at) : null,
          omOutage,
        });
      }
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
