import { config } from "../config.js";
import { pool } from "../db/index.js";
import { sendText } from "../lib/whatsapp.js";
import * as wix from "../lib/wix.js";
import * as repo from "./repo.js";
import { transition } from "./stateMachine.js";
import { notifyReception } from "../lib/notify.js";
import { invalidateMembershipCache } from "../lib/membershipContext.js";
import { extrasFromJson, formatExtrasMultiline, type ExtraLine } from "../lib/cafeMenu.js";
import { sendCafeMenuOffer } from "../lib/cafeOffer.js";
import { emailAskMessage } from "../lib/linkAsk.js";
import { classTip } from "../lib/classTips.js";
import {
  receptionLinkInstruction,
  receptionWhatsAppLink,
} from "../lib/receptionContact.js";

/**
 * Payment fulfillment — shared by Wave and Orange Money / Max It webhooks.
 * Payment-first invariant: Wix bookings are created HERE after a verified payment,
 * never from the agent. Extracted from webhooks/wave.ts (pure move, then OM added).
 */

export type PaymentLog = {
  info: (o: unknown, m?: string) => void;
  warn: (o: unknown, m?: string) => void;
  error: (o: unknown, m?: string) => void;
};

/**
 * Look up pending booking / plan / cafe by id and mark paid + fulfill.
 * `payerPhone` is optional (Wave mobile, OM customer MSISDN).
 */
export async function processPayment(
  clientReference: string,
  opts: { payerPhone?: string | null } = {},
  log: PaymentLog,
): Promise<void> {
  const booking = await repo.findBookingById(clientReference).catch(() => null);
  if (!booking) {
    const planOrder = await repo.findPlanOrderById(clientReference).catch(() => null);
    if (planOrder) {
      await processPlanPayment(planOrder, log);
      return;
    }
    const cafeOrder = await repo.findCafeOrderById(clientReference).catch(() => null);
    if (cafeOrder) {
      await processCafePayment(cafeOrder, log);
      return;
    }
    log.warn({ clientReference }, "Payment: unknown client_reference — ignoring");
    return;
  }

  const paid = await transition(pool, booking.id, "PAID", {
    payer_phone: opts.payerPhone ?? null,
  });
  if (!paid) {
    log.info(
      { bookingId: booking.id, status: booking.status },
      "Not newly payable — attempting fulfillment resume",
    );
  }

  await fulfillPaidBooking(booking.id, log);
}

/**
 * Turn a PAID booking into a confirmed Wix booking (or flag a refund).
 * Exclusive + idempotent via claimBookingForFulfillment, so it is safe to call
 * from the webhook happy path, a webhook retry (stuck-PAID resume), and the
 * reconciliation sweep — only one caller ever fulfills a given booking.
 */
export async function fulfillPaidBooking(bookingId: string, log: any): Promise<void> {
  const booking = await repo.claimBookingForFulfillment(bookingId);
  if (!booking) {
    log.info({ bookingId }, "Booking already fulfilled or being fulfilled elsewhere — skipping");
    return;
  }

  const clientRes = await pool.query(`select * from clients where id = $1`, [booking.client_id]);
  const client = clientRes.rows[0];
  const lang: string = client?.language ?? "fr";

  // 5. Re-check slot in Wix, then create the booking — or flag for refund.
  // CRITICAL: only the path up to BOOKED may call markRefund. Anything after
  // (WhatsApp confirm, bar offer, unlinked ask) is post-BOOKED: a failure there
  // must NEVER refund — the seat is already reserved and paid.
  let wixBookingId: string;
  let participants: number;
  let serviceLabel: string;
  let extras: ExtraLine[];
  try {
    participants = Math.max(1, booking.participants ?? 1);
    const slotStartIso = new Date(booking.slot_start).toISOString();

    // Payment landed after class start (Wave links outlive their local TTL,
    // and late payments are honored) — Wix can no longer create the booking,
    // so refund with an honest message instead of a generic "technical" one.
    if (new Date(booking.slot_start).getTime() <= Date.now()) {
      await markRefund(booking.id, client, lang, log, undefined, "class_started");
      return;
    }

    const fresh = await wix.findSlot(booking.service_id, booking.event_id, slotStartIso);
    if (!fresh || fresh.openSpots < participants) {
      await markRefund(booking.id, client, lang, log, {
        requested: participants,
        remaining: fresh?.openSpots ?? 0,
      });
      return;
    }

    wixBookingId = await wix.createBooking({
      slot: fresh.raw ?? booking.slot_json,
      name: client?.name ?? "Client Revive",
      phone: `+${client.wa_phone.replace(/^\+/, "")}`,
      participants,
    });

    await transition(pool, booking.id, "BOOKED", { wix_booking_id: wixBookingId });
    log.info({ bookingId: booking.id, wixBookingId, participants }, "Booking confirmed in Wix");
    serviceLabel =
      participants > 1 ? `${booking.service_name} — ${participants} places` : booking.service_name;
    extras = extrasFromJson(booking.extras_json);
  } catch (err) {
    log.error({ err, bookingId: booking.id }, "Wix booking failed after payment");
    // Not a capacity problem — don't tell the client the spot was taken.
    await markRefund(booking.id, client, lang, log, undefined, "technical");
    return;
  }

  // --- Post-BOOKED: never refund from here ---
  try {
    const confirmation = confirmationMessage(
      lang,
      serviceLabel,
      new Date(booking.slot_start),
      extras,
      booking.order_note,
    );
    await sendText(client.wa_phone, confirmation);
    await repo.addTurn(booking.client_id, "assistant", confirmation);
  } catch (err) {
    log.error({ err, bookingId: booking.id }, "Client confirmation failed after BOOKED");
    notifyReception(
      "⚠️ Résa confirmée mais client non notifié",
      `La place est réservée dans Wix (BOOKED) mais le WhatsApp de confirmation a échoué.\n` +
        `  Client : ${client?.name ?? "?"} (+${String(client?.wa_phone ?? "").replace(/^\+/, "")})\n` +
        `  Cours : ${serviceLabel}\n` +
        `  Wix booking : ${wixBookingId}\n` +
        `  Booking id : ${booking.id}\n\n` +
        `À faire : écrire au client manuellement (la place EST prise, ne pas rembourser).`,
    );
  }

  // Book-first, menu-after: now that the class is confirmed, offer the bar
  // menu as its own (separate) order. Non-blocking.
  if (extras.length === 0) {
    await sendCafeMenuOffer({
      waPhone: client.wa_phone,
      clientId: booking.client_id,
      lang,
      log,
    });
  }

  if (extras.length > 0) {
    try {
      notifyReception(
        `☕ Commande bar payée — ${booking.extras_amount_xof} FCFA`,
        `Un client a payé une commande bar avec sa réservation :\n` +
          `  Client : ${client?.name ?? "?"} (+${String(client.wa_phone).replace(/^\+/, "")})\n` +
          extras.map((l) => `  • ${l.qty}× ${l.name} — ${l.lineTotalXof} FCFA`).join("\n") +
          `\n  À servir : ${booking.order_note ?? "prête après le cours"}\n` +
          `  Cours : ${serviceLabel} — ${new Date(booking.slot_start).toLocaleString("fr-FR", { timeZone: config.TIMEZONE })}\n` +
          `  Total bar : ${booking.extras_amount_xof} FCFA (payé, inclus dans le paiement)`,
        { whatsappFirst: true },
      );
    } catch (err) {
      log.error({ err, bookingId: booking.id }, "Bar order notification failed");
    }
  }

  await maybeHandleUnlinkedClient(client, booking, lang, log);
}

/**
 * Reconciliation sweep — recover PAID bookings that were never turned into a
 * Wix booking (a crash between the payment and the booking). Returns the count
 * attempted. Called periodically from the boot sweeper; the fulfillment claim
 * makes it safe to run alongside a late webhook retry.
 */
export async function reconcileStuckBookings(log: any): Promise<number> {
  const stuck = await repo.stuckPaidBookings();
  for (const b of stuck) {
    log.warn({ bookingId: b.id }, "Reconciling stuck PAID booking (paid but never booked)");
    await fulfillPaidBooking(b.id, log).catch((err) =>
      log.error({ err, bookingId: b.id }, "Reconciliation of stuck PAID booking failed"),
    );
  }
  return stuck.length;
}

/** PAID plan orders never activated / never reception-notified. */
export async function reconcileStuckPlanOrders(log: PaymentLog): Promise<number> {
  const stuck = await repo.stuckPaidPlanOrders();
  for (const o of stuck) {
    log.warn({ planOrderId: o.id }, "Reconciling stuck PAID plan order");
    await fulfillPlanOrder(o.id, log).catch((err) =>
      log.error({ err, planOrderId: o.id }, "Reconciliation of stuck plan order failed"),
    );
  }
  return stuck.length;
}

/** PAID cafe orders never notified (fulfilled_at null). */
export async function reconcileStuckCafeOrders(log: PaymentLog): Promise<number> {
  const stuck = await repo.stuckPaidCafeOrders();
  for (const o of stuck) {
    log.warn({ cafeOrderId: o.id }, "Reconciling stuck PAID cafe order");
    await fulfillCafeOrder(o.id, log).catch((err) =>
      log.error({ err, cafeOrderId: o.id }, "Reconciliation of stuck cafe order failed"),
    );
  }
  return stuck.length;
}

/** REFUND_NEEDED with no refund_notified_at — re-run reception + client notify. */
export async function reconcileUnnotifiedRefunds(log: PaymentLog): Promise<number> {
  const stuck = await repo.stuckUnnotifiedRefunds();
  for (const b of stuck) {
    log.warn({ bookingId: b.id }, "Re-notifying REFUND_NEEDED without refund_notified_at");
    const clientRes = await pool.query(`select * from clients where id = $1`, [b.client_id]);
    const client = clientRes.rows[0];
    if (!client) continue;
    try {
      await notifyRefundParties(b, client, client.language ?? "fr", log);
      await repo.markRefundNotified(b.id);
    } catch (err) {
      log.error({ err, bookingId: b.id }, "Refund re-notify failed");
    }
  }
  return stuck.length;
}

/**
 * Plan purchase paid via Wave/OM. The Wix offline order (activation) happens
 * HERE after the verified webhook — same payment-first invariant as classes.
 *
 * Re-entrant: if already PAID but not activated/notified (crash mid-flight),
 * a webhook retry or the stuck-plan sweep resumes via claimPlanOrderForFulfillment.
 */
export async function processPlanPayment(order: any, log: PaymentLog): Promise<void> {
  const paid = await repo.markPlanOrderPaid(order.id);
  if (!paid) {
    const current = await repo.findPlanOrderById(order.id);
    if (!current || current.status !== "PAID") {
      log.info(
        { planOrderId: order.id, status: current?.status ?? order.status },
        "Plan order not payable — skipping",
      );
      return;
    }
    log.info({ planOrderId: order.id }, "Plan already PAID — resuming fulfillment");
  }
  await fulfillPlanOrder(order.id, log);
}

/**
 * Exclusive plan fulfillment (lease). Safe from webhook, retry, and sweep.
 */
export async function fulfillPlanOrder(planOrderId: string, log: PaymentLog): Promise<void> {
  const order = await repo.claimPlanOrderForFulfillment(planOrderId);
  if (!order) {
    log.info({ planOrderId }, "Plan already fulfilled or being fulfilled — skipping");
    return;
  }

  const clientRes = await pool.query(`select * from clients where id = $1`, [order.client_id]);
  const client = clientRes.rows[0];
  const lang: string = client?.language ?? "fr";
  const phoneDisplay = `+${String(client?.wa_phone ?? "").replace(/^\+/, "")}`;

  const startsAt: Date | null = order.starts_at ? new Date(order.starts_at) : null;
  const startsInFuture = startsAt !== null && startsAt.getTime() > Date.now();

  let activated = !!order.wix_order_id;
  if (!activated && order.member_id) {
    try {
      const wixOrderId = await wix.createOfflinePlanOrder(
        order.plan_id,
        order.member_id,
        startsInFuture ? startsAt!.toISOString() : undefined,
      );
      await repo.markPlanOrderActivated(order.id, wixOrderId);
      activated = true;
      invalidateMembershipCache(order.client_id);
      log.info({ planOrderId: order.id, wixOrderId }, "Plan activated in Wix");
    } catch (err) {
      log.error({ err, planOrderId: order.id }, "Plan activation failed — falling back to manual");
    }
  }

  // Manual path (or auto failed): notify reception once.
  if (!activated && !order.reception_notified_at) {
    notifyReception(
      `🎫 ABONNEMENT payé — activation manuelle : ${order.plan_name}`,
      `Un client a acheté un abonnement via Awa (paiement reçu) mais l'activation ` +
        `automatique n'a pas pu se faire${order.member_id ? "" : " (pas de compte membre Wix relié à ce numéro)"}.\n` +
        `  Client : ${client?.name ?? "?"} (${phoneDisplay})\n` +
        `  Formule : ${order.plan_name}\n` +
        `  Montant payé : ${order.amount_xof} FCFA (session : ${order.wave_session_id ?? "?"})\n` +
        (startsInFuture
          ? `  ⚠️ Démarrage voulu : ${startsAt!.toISOString().slice(0, 10)} (renouvellement à la fin de l'abonnement actuel) — régler la date de début en conséquence.\n`
          : "") +
        `\nÀ faire dans le dashboard Wix : Abonnements → attribuer "${order.plan_name}" au client ` +
        `(créer/relier sa fiche si besoin — numéro WhatsApp ci-dessus), en marquant l'ordre comme payé. ` +
        `Astuce : au moment d'attribuer le plan, l'envoi d'un email au client est optionnel — décoche-le si tu ne veux pas le notifier.`,
    );
    await repo.markPlanOrderReceptionNotified(order.id);
  } else if (activated) {
    await repo.clearPlanOrderFulfilling(order.id).catch(() => {});
  } else {
    // Already reception-notified on a prior attempt — release lease.
    await repo.clearPlanOrderFulfilling(order.id).catch(() => {});
  }

  const msg = planConfirmationMessage(
    lang,
    order.plan_name,
    activated,
    startsInFuture ? startsAt! : null,
    client?.name,
  );
  try {
    await sendText(client.wa_phone, msg);
    await repo.addTurn(order.client_id, "assistant", msg);
  } catch (err) {
    log.error({ err, planOrderId: order.id }, "Failed to send plan confirmation");
  }
}

/**
 * Bar-only order paid via Wave/OM. Re-entrant via claim + fulfilled_at.
 */
export async function processCafePayment(order: any, log: PaymentLog): Promise<void> {
  const paid = await repo.markCafeOrderPaid(order.id);
  if (!paid) {
    const current = await repo.findCafeOrderById(order.id);
    if (!current || current.status !== "PAID" || current.fulfilled_at) {
      log.info(
        { cafeOrderId: order.id, status: current?.status ?? order.status },
        "Bar order not payable — skipping",
      );
      return;
    }
    log.info({ cafeOrderId: order.id }, "Bar already PAID — resuming fulfillment");
  }
  await fulfillCafeOrder(order.id, log);
}

export async function fulfillCafeOrder(cafeOrderId: string, log: PaymentLog): Promise<void> {
  const order = await repo.claimCafeOrderForFulfillment(cafeOrderId);
  if (!order) {
    log.info({ cafeOrderId }, "Bar order already fulfilled or being fulfilled — skipping");
    return;
  }

  const clientRes = await pool.query(`select * from clients where id = $1`, [order.client_id]);
  const client = clientRes.rows[0];
  const lang: string = client?.language ?? "fr";
  const extras = extrasFromJson(order.extras_json);
  const slotLabel = order.slot_start
    ? new Date(order.slot_start).toLocaleString("fr-FR", { timeZone: config.TIMEZONE })
    : "?";

  const standalone = !order.linked_booking_id;
  try {
    notifyReception(
      standalone
        ? `☕ Commande bar payée (sans réservation) — ${order.amount_xof} FCFA`
        : `☕ Commande bar payée (résa existante) — ${order.amount_xof} FCFA`,
      (standalone
        ? `Un client a payé une commande bar seule (aucun cours associé — retrait au comptoir) :\n`
        : `Un client a payé une commande bar qui accompagne une réservation existante :\n`) +
        `  Client : ${client?.name ?? "?"} (+${String(client?.wa_phone ?? "").replace(/^\+/, "")})\n` +
        extras.map((l) => `  • ${l.qty}× ${l.name} — ${l.lineTotalXof} FCFA`).join("\n") +
        `\n  À servir : ${order.order_note ?? (standalone ? "dès que possible" : "prête après le cours")}\n` +
        (standalone ? "" : `  Cours associé : ${order.service_name ?? "?"} — ${slotLabel}\n`) +
        `  Total bar : ${order.amount_xof} FCFA (payé)`,
      { whatsappFirst: true },
    );
  } catch (err) {
    log.error({ err, cafeOrderId: order.id }, "Bar order notification failed");
  }

  const msg = cafeConfirmationMessage(lang, extras, order.order_note, order.service_name);
  try {
    await sendText(client.wa_phone, msg);
    await repo.addTurn(order.client_id, "assistant", msg);
  } catch (err) {
    log.error({ err, cafeOrderId: order.id }, "Failed to send bar confirmation");
  }

  // Mark fulfilled even if WhatsApp failed — reception was told (or we logged).
  // Retrying forever would re-spam the kitchen.
  await repo.markCafeOrderFulfilled(order.id);
}

export function cafeConfirmationMessage(
  lang: string,
  extras: ExtraLine[],
  orderNote?: string | null,
  serviceName?: string | null,
): string {
  // No attached class = standalone counter order → default timing differs.
  const defaultNote = {
    en: serviceName ? `ready after your class (${serviceName})` : "ready as soon as possible — pick it up at the counter",
    wo: serviceName ? `dina pare ginnaaw sa cours (${serviceName})` : "dina pare léegi léegi — jëlal ko ci comptoir bi",
    fr: serviceName ? `prête après ton cours (${serviceName})` : "prête dès que possible — à récupérer au comptoir",
  };
  switch (lang) {
    case "en":
      return (
        `✅ Payment received — your bar order is confirmed!\n\n` +
        `☕ Your order:\n${formatExtrasMultiline(extras)}\n→ ${orderNote ?? defaultNote.en}\n\n` +
        `See you soon! 💪🏾`
      );
    case "wo":
      return (
        `✅ Fey bi jot na — sa commande bar dëgg na!\n\n` +
        `☕ Sa commande:\n${formatExtrasMultiline(extras)}\n→ ${orderNote ?? defaultNote.wo}\n\n` +
        `Ba beneen yoon! 💪🏾`
      );
    default:
      return (
        `✅ Paiement reçu — ta commande bar est confirmée !\n\n` +
        `☕ Ta commande :\n${formatExtrasMultiline(extras)}\n→ ${orderNote ?? defaultNote.fr}\n\n` +
        `À très vite ! 💪🏾`
      );
  }
}

export function planConfirmationMessage(
  lang: string,
  planName: string,
  activated: boolean,
  startsAt: Date | null,
  clientName?: string | null,
): string {
  // Chained renewal: the plan is paid but activates on a future date.
  if (startsAt) {
    const d = startsAt.toISOString().slice(0, 10);
    switch (lang) {
      case "en":
        return (
          `✅ Payment received — your "${planName}" plan is renewed!\n\n` +
          `It starts on ${d}, right when your current plan ends — no interruption. ` +
          `I'll deduct from it automatically once it kicks in 💪🏾`
        );
      case "wo":
        return (
          `✅ Fey bi jot na — sa abonnement "${planName}" renouvelé na!\n\n` +
          `Day tàmbali ${d}, bu sa abonnement bi mujj jeex — amul interruption. ` +
          `Dinaa ci wàññiku bu tàmbalee 💪🏾`
        );
      default:
        return (
          `✅ Paiement reçu — ton abonnement "${planName}" est renouvelé !\n\n` +
          `Il démarre le ${d}, pile à la fin de ton abonnement actuel — aucune interruption. ` +
          `Je décompterai dessus automatiquement une fois qu'il prend le relais 💪🏾`
        );
    }
  }
  if (activated) {
    switch (lang) {
      case "en":
        return (
          `✅ Payment received — your "${planName}" plan is now ACTIVE!\n\n` +
          `You can book your classes right here with me, your sessions will be deducted automatically 💪🏾`
        );
      case "wo":
        return (
          `✅ Fey bi jot na — sa abonnement "${planName}" dox na léegi!\n\n` +
          `Man nga book say cours fii ak man, séance yi dinañu wàññiku ci sa abonnement 💪🏾`
        );
      default:
        return (
          `✅ Paiement reçu — ton abonnement "${planName}" est ACTIF !\n\n` +
          `Tu peux réserver tes cours directement ici avec moi, tes séances seront décomptées automatiquement 💪🏾`
        );
    }
  }
  const receptionContact = receptionWhatsAppLink(
    config.RECEPTION_PHONE,
    clientName,
    `l'activation de mon abonnement « ${planName} » après paiement`,
  );
  const contactInstruction = receptionLinkInstruction(lang, receptionContact.url);
  switch (lang) {
    case "en":
      return (
        `✅ Payment received for the "${planName}" plan!\n\n` +
        `The team is finalizing its activation on your account — you'll be able to book with it very soon. ` +
        `If you need to contact them:\n\n${contactInstruction}`
      );
    case "wo":
      return (
        `✅ Fey bi jot na ngir abonnement "${planName}"!\n\n` +
        `Ekib bi mungi sotal sa compte — dinga man a book ak moom léegi léegi. ` +
        `Soo bëggee jokkoo ak ñoom:\n\n${contactInstruction}`
      );
    default:
      return (
        `✅ Paiement reçu pour l'abonnement "${planName}" !\n\n` +
        `L'équipe finalise son activation sur ton compte — tu pourras réserver avec très vite. ` +
        `Si tu as besoin de la joindre :\n\n${contactInstruction}`
      );
  }
}

/**
 * Unlinked-client handling (one-shot per client). If this client's WhatsApp
 * number matches no unique Wix contact, their booking just created a
 * duplicate contact. We then:
 *   1. Ask the client — in this same WhatsApp chat, replying to Awa — for the
 *      email of their existing account (if any). Never phrased as "send it to
 *      the prefilled reception link".
 *   2. Email reception so the duplicate is known even if the client ignores
 *      the question.
 */
async function maybeHandleUnlinkedClient(
  client: any,
  booking: any,
  lang: string,
  log: any,
): Promise<void> {
  try {
    if (client.email_prompted_at || client.claimed_email) return; // one-shot
    const contactId = await wix.findContactIdByPhone(
      `+${String(client.wa_phone).replace(/^\+/, "")}`,
      client.name ?? undefined,
    );
    if (contactId) return; // linked to a unique account — nothing to do

    await repo.markEmailPrompted(client.id);

    const ask = emailAskMessage(lang);
    await sendText(client.wa_phone, ask);
    await repo.addTurn(client.id, "assistant", ask);

    notifyReception(
      "Nouveau client WhatsApp à relier (doublon de contact)",
      `Le client "${client.name ?? "?"}" (+${String(client.wa_phone).replace(/^\+/, "")}) vient de payer ` +
        `une réservation via Awa :\n` +
        `  ${booking.service_name} — ${new Date(booking.slot_start).toLocaleString("fr-FR", { timeZone: config.TIMEZONE })}\n\n` +
        `Son numéro WhatsApp ne correspond à aucune fiche unique dans Wix, donc un ` +
        `doublon de contact a été créé. Awa vient de lui demander (dans la conversation) ` +
        `l'email de son éventuel compte existant — si le client répond, vous recevrez un ` +
        `second email avec l'adresse.\n\n` +
        `À faire si ce client avait déjà un compte : Dashboard Wix → Contacts → fusionner ` +
        `les fiches et vérifier que le numéro WhatsApp ci-dessus figure sur la fiche. Ses ` +
        `futures réservations et abonnements seront alors reliés automatiquement.`,
    );
    log.info({ clientId: client.id }, "Unlinked client: asked for email in chat + reception notified");
  } catch (err) {
    log.error({ err, clientId: client?.id }, "Unlinked-client handling failed (non-blocking)");
  }
}

async function markRefund(
  bookingId: string,
  client: any,
  lang: string,
  log: any,
  spots?: { requested: number; remaining: number },
  reason: RefundReason = "slot_taken",
): Promise<void> {
  await transition(pool, bookingId, "REFUND_NEEDED");
  log.warn({ bookingId, ...spots }, "REFUND_NEEDED recorded — manual processing in Wave portal");
  const bookingRow = await repo.findBookingById(bookingId);
  try {
    await notifyRefundParties(bookingRow, client, lang, log, spots, reason);
    await repo.markRefundNotified(bookingId);
  } catch (err) {
    // Leave refund_notified_at null so the sweep re-notifies.
    log.error({ err, bookingId }, "Refund notifications failed — will retry via sweep");
  }
}

/** Reception email/WA + client WhatsApp for a REFUND_NEEDED row. */
async function notifyRefundParties(
  bookingRow: any,
  client: any,
  lang: string,
  log: PaymentLog,
  spots?: { requested: number; remaining: number },
  reason: RefundReason = "slot_taken",
): Promise<void> {
  const bookingId = bookingRow?.id ?? "?";
  notifyReception(
    `💸 REMBOURSEMENT à faire — ${bookingRow?.amount_xof ?? "?"} FCFA`,
    `Un paiement doit être remboursé dans le portail Wave/OM :\n` +
      `  Client : ${client?.name ?? "?"} (+${String(client?.wa_phone ?? "").replace(/^\+/, "")})\n` +
      `  Cours : ${bookingRow?.service_name ?? "?"} — ${bookingRow ? new Date(bookingRow.slot_start).toLocaleString("fr-FR", { timeZone: config.TIMEZONE }) : "?"}\n` +
      `  Montant : ${bookingRow?.amount_xof ?? "?"} FCFA\n` +
      (bookingRow && bookingRow.extras_amount_xof > 0
        ? `  Dont commande bar : ${bookingRow.extras_amount_xof} FCFA (incluse dans le montant ci-dessus — la commande ne doit PAS être préparée).\n`
        : "") +
      `  Session : ${bookingRow?.wave_session_id ?? "?"}\n` +
      `  Booking id : ${bookingId}\n\n` +
      `Après remboursement dans le portail, clôturer avec :\n` +
      `  railway run npm run refund:done -- ${bookingId}\n\n` +
      `Le client a été (ou sera) prévenu sur WhatsApp (remboursement sous 24h).`,
  );
  const msg = refundMessage(lang, spots, reason, client?.name);
  try {
    await sendText(client.wa_phone, msg);
    await repo.addTurn(client.id, "assistant", msg);
  } catch (err) {
    log.error({ err, bookingId }, "Failed to notify client about refund");
    throw err; // keep refund_notified_at null for sweep
  }
}

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

export function confirmationMessage(
  lang: string,
  serviceName: string,
  slotStart: Date,
  extras?: ExtraLine[],
  orderNote?: string | null,
): string {
  const hasCafe = !!extras && extras.length > 0;
  // Keyword tip from classTips (null when unknown — never invent).
  // Lazy import avoided: classTips is pure and safe at module load.
  const tip = classTip(serviceName, lang);
  const tipBlock = tip ? `${tip}\n\n` : "";
  switch (lang) {
    case "en":
      return (
        `✅ Payment received — your spot is confirmed!\n\n` +
        `${serviceName}\n📅 ${formatSlot(slotStart, "en-GB")}\n📍 ${config.STUDIO_ADDRESS}\n\n` +
        (hasCafe
          ? `☕ Your bar order (already paid):\n${formatExtrasMultiline(extras!)}\n→ ${orderNote ?? "ready after your class"}\n\n`
          : "") +
        tipBlock +
        `ℹ️ Free cancellation up to 16 hours before class — after that, the session is due.\n\n` +
        `Show this message at reception. See you soon! 💪🏾`
      );
    case "wo":
      return (
        `✅ Fey bi jot na — sa palass dëgg na!\n\n` +
        `${serviceName}\n📅 ${formatSlot(slotStart, "fr-FR")}\n📍 ${config.STUDIO_ADDRESS}\n\n` +
        (hasCafe
          ? `☕ Sa commande bar (fey nga ko ba noppi):\n${formatExtrasMultiline(extras!)}\n→ ${orderNote ?? "dina pare ginnaaw sa cours"}\n\n`
          : "") +
        tipBlock +
        `ℹ️ Man nga annuler ba 16 waxtu laata cours bi ; su weesoo loolu, séance bi dina jar.\n\n` +
        `Wone bataaxal bii ci réception. Ba beneen yoon! 💪🏾`
      );
    default:
      return (
        `✅ Paiement reçu — ta place est confirmée !\n\n` +
        `${serviceName}\n📅 ${formatSlot(slotStart, "fr-FR")}\n📍 ${config.STUDIO_ADDRESS}\n\n` +
        (hasCafe
          ? `☕ Ta commande bar (déjà payée) :\n${formatExtrasMultiline(extras!)}\n→ ${orderNote ?? "prête après ton cours"}\n\n`
          : "") +
        tipBlock +
        `ℹ️ Annulation gratuite jusqu'à 16h avant le cours ; passé ce délai, la séance est due.\n\n` +
        `Montre ce message à la réception. À très vite ! 💪🏾`
      );
  }
}

export type RefundReason = "slot_taken" | "technical" | "class_started";

export function refundMessage(
  lang: string,
  spots?: { requested: number; remaining: number },
  reason: RefundReason = "slot_taken",
  clientName?: string | null,
): string {
  // Group shortage: be precise about why, so the client can adjust.
  const shortage = spots && spots.requested > 1 && spots.remaining > 0;
  const technicalContact =
    reason === "technical"
      ? receptionWhatsAppLink(
          config.RECEPTION_PHONE,
          clientName,
          "mon remboursement après un incident technique sur ma réservation",
        )
      : null;
  const technicalContactInstruction = technicalContact
    ? receptionLinkInstruction(lang, technicalContact.url)
    : "";
  switch (lang) {
    case "en":
      if (shortage)
        return (
          `We're so sorry 😔 — only ${spots!.remaining} spot(s) were left for your request of ${spots!.requested}. ` +
          `You will be refunded within 24h. Reply here if you want the remaining spot(s) or another slot! 🙏🏾`
        );
      if (reason === "class_started")
        return (
          `We're so sorry 😔 — your payment arrived after the class had already started, so we couldn't confirm your spot. ` +
          `You will be refunded within 24h. Reply here if you'd like to book an upcoming class! 🙏🏾`
        );
      if (reason === "technical")
        return (
          `We're so sorry 😔 — a technical issue prevented us from finalizing your booking. ` +
          `You will be refunded within 24h. Reply here if you'd like to try again. 🙏🏾\n\n` +
          technicalContactInstruction
        );
      return (
        `We're so sorry 😔 — that spot was just taken while your payment went through. ` +
        `You will be refunded within 24h. Reply here if you'd like me to find you another slot! 🙏🏾`
      );
    case "wo":
      if (shortage)
        return (
          `Baal ma — ${spots!.remaining} palass rekk a des, te ${spots!.requested} nga laaj. ` +
          `Dinañu la delloo sa xaalis balaa 24 waxtu. Bindal ma fii su la neexee! 🙏🏾`
        );
      if (reason === "class_started")
        return (
          `Baal ma — sa fey bi ñëw na ginnaaw bi cours bi tàmbalee, kon mënuma woon confirmer sa palass. ` +
          `Dinañu la delloo sa xaalis balaa 24 waxtu. Bindal ma fii su la neexee ma wut la beneen palass! 🙏🏾`
        );
      if (reason === "technical")
        return (
          `Baal ma — am na jafe-jafe technique bu tere réservation bi sotti. ` +
          `Dinañu la delloo sa xaalis balaa 24 waxtu. Bindal ma fii su la neexee nga jéemaat. 🙏🏾\n\n` +
          technicalContactInstruction
        );
      return (
        `Baal ma — palass bi jeex na ci diggante bi nga fey. Dinañu la delloo sa xaalis balaa 24 waxtu. ` +
        `Bindal ma fii su la neexee ma wut la beneen palass! 🙏🏾`
      );
    default:
      if (shortage)
        return (
          `Désolé 😔 — il ne restait que ${spots!.remaining} place(s) pour ta demande de ${spots!.requested}. ` +
          `Tu seras remboursé(e) sous 24h. Écris-moi si tu veux prendre les places restantes ou un autre créneau ! 🙏🏾`
        );
      if (reason === "class_started")
        return (
          `Désolé 😔 — ton paiement est arrivé après le début du cours, je n'ai donc pas pu confirmer ta place. ` +
          `Tu seras remboursé(e) sous 24h. Écris-moi ici si tu veux réserver un prochain créneau ! 🙏🏾`
        );
      if (reason === "technical")
        return (
          `Désolé 😔 — un souci technique a empêché de finaliser ta réservation. ` +
          `Tu seras remboursé(e) sous 24h. Écris-moi ici si tu veux réessayer. 🙏🏾\n\n` +
          technicalContactInstruction
        );
      return (
        `Désolé 😔 — cette place vient d'être prise pendant ton paiement. ` +
        `Tu seras remboursé(e) sous 24h. Écris-moi ici si tu veux que je te trouve un autre créneau ! 🙏🏾`
      );
  }
}
