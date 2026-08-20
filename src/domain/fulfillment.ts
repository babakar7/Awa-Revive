import { config } from "../config.js";
import { pool } from "../db/index.js";
import { sendText } from "../lib/whatsapp.js";
import * as wix from "../lib/wix.js";
import * as repo from "./repo.js";
import { transition } from "./stateMachine.js";
import { notifyReception } from "../lib/notify.js";
import { invalidateMembershipCache } from "../lib/membershipContext.js";
import { registerAndEnsureKey } from "./keyProvisioning.js";
import { configuredMappingForPlan } from "./keyProvisioning.js";
import { extrasFromJson, formatExtrasMultiline, type ExtraLine } from "../lib/cafeMenu.js";
import { emailAskMessage } from "../lib/linkAsk.js";
import { sendCommitmentProgress, sendCommitmentComplete } from "../lib/commitmentMessages.js";
import * as commitments from "./commitments.js";
import { classTip } from "../lib/classTips.js";
import { paymentMethodLabel } from "../lib/paymentMethod.js";
import {
  receptionLinkInstruction,
  receptionWhatsAppLink,
} from "../lib/receptionContact.js";
import { recordBookingFunnelEvent } from "./bookingFunnel.js";
import { backfillBookingContacts } from "./bookingContactBackfill.js";
import { ensureBookingContact, type ContactGap } from "./bookingContact.js";
import { guardBooking, isSessionAutoCancelled, OccurrenceCancelledError } from "./autoCancelGuard.js";
import * as deliveries from "./deliveryRepo.js";
import { normalizeDeliveryPhone } from "./deliveryRules.js";
import type { CafeServiceMode } from "./repo.js";
import * as keyRepo from "./keyRepo.js";
import {
  keyPurchaseContinuityDecision,
  resolveContinuitySource,
  type ContinuitySource,
} from "./keyContinuity.js";
import { keyMappingForPlan, reviewGateApplies } from "./keyRules.js";
import { createBarTicket } from "./kitchenTicketRepo.js";
import { applyFrenchRegister } from "../lib/frenchRegister.js";
import { handleTechnicalFailure } from "./technicalFailure.js";

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
    const deliveryAttempt = await deliveries
      .findDeliveryPaymentAttemptById(clientReference)
      .catch(() => null);
    if (deliveryAttempt) {
      await processDeliveryPayment(deliveryAttempt.id, opts.payerPhone ?? null, log);
      return;
    }
    log.warn({ clientReference }, "Payment: unknown client_reference — ignoring");
    return;
  }

  const paid = await transition(pool, booking.id, "PAID", {
    payer_phone: opts.payerPhone ?? null,
    paid_at: new Date(),
  });
  if (!paid) {
    log.info(
      { bookingId: booking.id, status: booking.status },
      "Not newly payable — attempting fulfillment resume",
    );
  }

  const payable = (paid as typeof booking | null) ?? (await repo.findBookingById(booking.id));
  if (payable && ["PAID", "BOOKED", "REFUND_NEEDED", "REFUNDED", "CANCELLED"].includes(payable.status)) {
    // Authoritative: this runs only after a signed Wave webhook or verified OM
    // lookup transitioned (or resumed) the local payment state.
    await recordBookingFunnelEvent({
      clientId: booking.client_id,
      bookingId: booking.id,
      stage: "payment_confirmed",
      paymentMethod: payable.payment_method,
      idempotencyKey: `booking:${booking.id}:payment-confirmed`,
      metadata: { amount_xof: payable.amount_xof, participants: payable.participants },
    });
  }

  await fulfillPaidBooking(booking.id, log);
}

/** Verified provider payment for an admin-created delivery. */
export async function processDeliveryPayment(
  attemptId: string,
  payerPhone: string | null,
  log: PaymentLog,
): Promise<void> {
  const result = await deliveries.markDeliveryPaymentAttemptPaid(attemptId, payerPhone);
  if (!result || result.outcome === "duplicate") return;
  const { order, attempt } = result;
  const client = await repo.upsertClient(order.client_phone);
  if (!client.name) {
    await repo.updateClientName(client.id, order.client_name).catch(() => {});
    client.name = order.client_name;
  }

  if (result.outcome === "refund_needed") {
    const msg = applyFrenchRegister(
      client.language === "en"
        ? `⚠️ We received your ${attempt.amount_xof} FCFA payment, but this delivery was already closed or paid. The Revive team is checking it and will contact you about the refund.`
        : `⚠️ Nous avons reçu ton paiement de ${attempt.amount_xof} FCFA, mais cette livraison était déjà clôturée ou payée. L'équipe Revive vérifie et te recontacte pour le remboursement.`,
      client.language !== "en" && client.fr_register === "vous",
    );
    await sendText(order.client_phone, msg).catch((err) =>
      log.error({ err, order: order.id }, "Delivery refund-warning client send failed"),
    );
    await repo.addTurn(client.id, "assistant", msg).catch(() => {});
    notifyReception(
      "💸 REMBOURSEMENT à vérifier — paiement livraison tardif/double",
      `Client : ${order.client_name} (+${order.client_phone})\n` +
        `Commande : ${order.id}\nMontant : ${attempt.amount_xof} FCFA\n` +
        `Moyen : ${paymentMethodLabel(attempt.method)}\nRéférence : ${attempt.session_id ?? attempt.id}\n` +
        `Motif : ${order.payment_issue ?? "paiement tardif ou double"}`,
      { whatsappFirst: true, preferTemplate: true },
    );
    return;
  }

  const msg = applyFrenchRegister(
    client.language === "en"
      ? `✅ Payment received — ${order.amount_xof} FCFA via ${paymentMethodLabel(attempt.method)}. Your delivery can now leave; you won't need to pay the delivery person.`
      : `✅ Paiement reçu — ${order.amount_xof} FCFA via ${paymentMethodLabel(attempt.method)}. Ta livraison peut maintenant partir ; tu n'auras rien à régler au livreur.`,
    client.language !== "en" && client.fr_register === "vous",
  );
  await sendText(order.client_phone, msg).catch((err) =>
    log.error({ err, order: order.id }, "Delivery payment confirmation send failed"),
  );
  await repo.addTurn(client.id, "assistant", msg).catch(() => {});
  notifyReception(
    `${order.is_test ? "🧪 TEST — " : ""}✅ Livraison payée — départ autorisé`,
    `Client : ${order.client_name} (+${order.client_phone})\n` +
      `Montant reçu : ${order.amount_xof} FCFA via ${paymentMethodLabel(attempt.method)}\n` +
      `Commande : ${order.id}\nNe rien encaisser auprès du client.`,
    { whatsappFirst: true, preferTemplate: true },
  );
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
  let resolvedContact: wix.WixContactMatch | null = null;
  let contactGap: ContactGap | null = null;
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
      // A slot that vanished because the empty-class engine cancelled it gets an
      // honest reason instead of "that spot was taken" (findSlot returns null on
      // a cancelled occurrence — verified: Wix drops it from availability).
      const autoCancelled = await isSessionAutoCancelled(booking.event_id);
      await markRefund(
        booking.id,
        client,
        lang,
        log,
        autoCancelled ? undefined : { requested: participants, remaining: fresh?.openSpots ?? 0 },
        autoCancelled ? "class_auto_cancelled" : "slot_taken",
      );
      return;
    }

    const phone = `+${client.wa_phone.replace(/^\+/, "")}`;
    // Une réservation payée ne doit JAMAIS partir sans fiche contact : si aucun
    // contact ne porte ce numéro, on la crée ici (cas Penda 17/08 —
    // WIX-ORPHAN-BOOKINGS-PLAN.md). Ne lève jamais : au pire on repart sur le
    // comportement d'avant (réservation inline) avec la raison notée.
    const ensured = await ensureBookingContact(
      {
        clientId: booking.client_id,
        phone,
        name: client?.name ?? null,
        email: client?.claimed_email ?? null,
      },
      undefined,
      log,
    );
    const contact = ensured.contact;
    resolvedContact = contact;
    contactGap = ensured.gap;
    const bookingName = contact?.fullName || client?.name || "Client Revive";
    if (contact?.fullName && contact.fullName !== client?.name) {
      await repo.updateClientName(booking.client_id, contact.fullName);
      client.name = contact.fullName;
    }

    try {
      // Serialize with the empty-class cancel engine on this occurrence: a
      // cancel in flight makes the guard throw before we create a Wix booking
      // against a dying slot.
      wixBookingId = await guardBooking(booking.event_id, () =>
        wix.createBooking({
          slot: fresh.raw ?? booking.slot_json,
          name: bookingName,
          phone,
          participants,
          resolvedContact: contact,
        }),
      );
    } catch (guardErr) {
      if (guardErr instanceof OccurrenceCancelledError) {
        await markRefund(booking.id, client, lang, log, undefined, "class_auto_cancelled");
        return;
      }
      throw guardErr;
    }

    await transition(pool, booking.id, "BOOKED", { wix_booking_id: wixBookingId });
    // Trou de fiche (ambiguïté, nom inexploitable, panne Wix) : on le rend
    // visible dans l'admin plutôt que de le laisser passer en silence.
    if (contactGap) {
      await pool
        .query(`update pending_bookings set contact_gap = $2 where id = $1`, [
          booking.id,
          contactGap,
        ])
        .catch((err) => log.error({ err, bookingId: booking.id }, "contact_gap write failed"));
    }
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

  // The local BOOKED transition is the authoritative conversion point. Keep
  // analytics outside the refund-producing try/catch: a metrics outage must
  // never turn an already reserved Wix seat into a refund incident.
  await recordBookingFunnelEvent({
    clientId: booking.client_id,
    bookingId: booking.id,
    stage: "booked",
    paymentMethod: booking.payment_method,
    idempotencyKey: `booking:${booking.id}:booked`,
    metadata: { participants },
  }).catch((err) => log.error({ err, bookingId: booking.id }, "BOOKED funnel event failed"));

  // Auto-réparation : si une résa antérieure du client est partie sans fiche
  // contact (payée avant toute vérification, cas « A »), on la rattache
  // maintenant qu'un contact est résolu. Fire-and-forget, jamais de refund.
  if (resolvedContact?.id) {
    void backfillBookingContacts(
      {
        clientId: booking.client_id,
        phone: `+${client.wa_phone.replace(/^\+/, "")}`,
        contactId: resolvedContact.id,
      },
      log,
    );
  }

  // --- Post-BOOKED: never refund from here ---
  try {
    const confirmation = applyFrenchRegister(confirmationMessage(
      lang,
      serviceLabel,
      new Date(booking.slot_start),
      extras,
      booking.order_note,
    ), lang === "fr" && client?.fr_register === "vous");
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

  // Wix's custom-checkout flow needs a separate eCommerce order after the
  // booking confirmation. This is post-BOOKED on purpose: an Orders API error
  // must never refund or delete a seat that is already paid and reserved.
  await recordWixOrderForBooking(booking.id, log);

  if (extras.length > 0) {
    try {
      await createBarTicket({
        sourceKey: `bar:booking:${booking.id}`,
        heading: client?.name ?? "Client Awa",
        subheading: `${serviceLabel} · ${new Date(booking.slot_start).toLocaleString("fr-FR", {
          timeZone: config.TIMEZONE,
        })}`,
        lines: extras,
        amountXof: booking.extras_amount_xof,
        note: booking.order_note ?? "prête après le cours",
        isTest: client?.is_test === true,
      });
    } catch (err) {
      log.error({ err, bookingId: booking.id }, "Paid booking bar ticket projection failed");
      notifyReception(
        "⚠️ Commande bar payée absente de l’iPad",
        `La commande bar de la réservation ${booking.id} n’a pas pu être affichée en cuisine.\n` +
          `Client : ${client?.name ?? "?"} (+${String(client?.wa_phone ?? "").replace(/^\+/, "")})\n` +
          `Articles : ${extras.map((line) => `${line.qty}× ${line.name}`).join(", ")}`,
      );
    }
  }

  // Multi-session commitment progression. The server advances the plan ONLY
  // here (shared BOOKED transition) — never Awa's wording. While the plan is
  // incomplete, the "session X/N — continue?" message REPLACES the café offer;
  // for an unlinked client the account-linking invitation rides along as a
  // third button so a client who stops early still receives it. At completion,
  // linking-if-due wins over the café upsell (account integrity > upsell).
  const progress = await commitments
    .advanceOnBooking(booking.id)
    .catch((err) => {
      log.error({ err, bookingId: booking.id }, "Commitment progression failed (non-blocking)");
      return null;
    });

  if (progress && !progress.is_complete) {
    const showLink = extras.length === 0 && (await shouldAskUnlinked(client));
    if (showLink) await repo.markEmailPrompted(client.id).catch(() => {});
    await sendCommitmentProgress({
      waPhone: client.wa_phone,
      clientId: booking.client_id,
      commitmentId: progress.commitment_id,
      lang,
      serviceName: progress.service_name,
      booked: progress.booked_count,
      requested: progress.requested_count,
      showLink,
      log,
    });
    return; // café + link deferred until the plan completes
  }

  if (progress && progress.is_complete) {
    await sendCommitmentComplete({
      waPhone: client.wa_phone,
      clientId: booking.client_id,
      lang,
      serviceName: progress.service_name,
      requested: progress.requested_count,
      log,
    });
    await maybeHandleUnlinkedClient(client, booking, lang, log);
    return;
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
    await recordBookingFunnelEvent({
      clientId: b.client_id,
      bookingId: b.id,
      stage: "payment_confirmed",
      paymentMethod: b.payment_method,
      idempotencyKey: `booking:${b.id}:payment-confirmed`,
      metadata: { amount_xof: b.amount_xof, participants: b.participants },
    }).catch((err) =>
      log.error({ err, bookingId: b.id }, "Payment-confirmed funnel event repair failed"),
    );
    await fulfillPaidBooking(b.id, log).catch((err) =>
      log.error({ err, bookingId: b.id }, "Reconciliation of stuck PAID booking failed"),
    );
  }
  return stuck.length;
}

/**
 * Record a BOOKED custom-checkout reservation in Wix eCommerce and attach the
 * already-collected payment. Safe on retries: recover by externalOrderId and
 * inspect existing transactions before adding another payment record.
 * Membership bookings get the native-flow shape instead: a 0-amount MEMBERSHIP
 * order already PAID, with no separate payment record to attach.
 */
export async function recordWixOrderForBooking(
  bookingId: string,
  log: PaymentLog,
): Promise<boolean> {
  const booking = await repo.claimBookingForWixOrderSync(bookingId);
  if (!booking) return false;

  const isMembership = booking.payment_method === "membership";
  try {
    const clientRes = await pool.query(`select * from clients where id = $1`, [booking.client_id]);
    const client = clientRes.rows[0];
    if (!client) throw new Error(`Client ${booking.client_id} not found`);

    const phone = `+${String(client.wa_phone).replace(/^\+/, "")}`;
    const contact = await wix.findContactByPhone(phone, client.name ?? undefined);
    const canonicalName = contact?.fullName || client.name || "Client Revive";
    if (contact?.fullName && contact.fullName !== client.name) {
      await repo.updateClientName(booking.client_id, contact.fullName);
    }

    let wixOrderId = booking.wix_order_id;
    let membershipOrderStatus: string | null = null;
    if (!wixOrderId) {
      wixOrderId = await wix.findOrderIdByExternalId(booking.id);
      if (!wixOrderId) {
        if (isMembership) {
          // The MEMBERSHIP buyer must be the plan-holding member; without the
          // contact the order would not attach to them — retry on next sweep.
          if (!contact?.id) throw new Error(`No Wix contact for membership order (${phone})`);
          const created = await wix.createMembershipBookingOrder({
            wixBookingId: booking.wix_booking_id!,
            externalOrderId: booking.id,
            serviceName: booking.service_name,
            participants: Math.max(1, booking.participants ?? 1),
            phone,
            name: canonicalName,
            contactId: contact.id,
            slotStart: booking.slot_start,
          });
          wixOrderId = created.orderId;
          membershipOrderStatus = created.status;
        } else {
          wixOrderId = await wix.createBookingOrder({
            wixBookingId: booking.wix_booking_id!,
            externalOrderId: booking.id,
            // The calendar booking stays on the real service; the custom order
            // label lets reception immediately identify the 10k campaign visit.
            serviceName:
              booking.campaign_code === "pack_decouverte_ctwa"
                ? "Pack Découverte — Première séance"
                : booking.service_name,
            amountXof: booking.amount_xof,
            participants: Math.max(1, booking.participants ?? 1),
            phone,
            name: canonicalName,
            contactId: contact?.id,
          });
        }
      }
      await repo.saveWixOrderId(booking.id, wixOrderId);
    }

    if (isMembership) {
      // A membership order left INITIALIZED (number 0) never shows in the
      // dashboard. A 0-amount approved offline payment flips it to APPROVED —
      // the same transition the paid path gets from its real payment record.
      if (!membershipOrderStatus) {
        membershipOrderStatus = await wix.getOrderStatus(wixOrderId);
      }
      if (membershipOrderStatus !== "APPROVED") {
        await wix.addApprovedOrderPayment({
          orderId: wixOrderId,
          amountXof: 0,
          paymentMethod: paymentMethodLabel(booking.payment_method),
        });
        const after = await wix.getOrderStatus(wixOrderId);
        if (after !== "APPROVED") {
          log.warn(
            { bookingId: booking.id, wixOrderId, orderStatus: after },
            "Membership Wix order still not APPROVED after 0-amount payment",
          );
        }
      }
    } else if (!(await wix.hasApprovedOrderPayment(wixOrderId, booking.amount_xof))) {
      await wix.addApprovedOrderPayment({
        orderId: wixOrderId,
        amountXof: booking.amount_xof,
        paymentMethod: paymentMethodLabel(booking.payment_method),
      });
    }
    await repo.markWixPaymentRecorded(booking.id);
    log.info(
      { bookingId: booking.id, wixBookingId: booking.wix_booking_id, wixOrderId },
      "Wix order and payment recorded",
    );
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await repo.releaseWixOrderSync(booking.id, message).catch(() => undefined);
    log.error(
      { err, bookingId: booking.id, wixBookingId: booking.wix_booking_id },
      "Wix order/payment recording failed after BOOKED (seat remains confirmed)",
    );
    return false;
  }
}

/** Recover recent BOOKED rows whose separate Wix order/payment sync failed. */
export async function reconcileMissingWixOrders(log: PaymentLog): Promise<number> {
  const missing = await repo.bookingsMissingWixPaymentRecord();
  for (const booking of missing) {
    log.warn({ bookingId: booking.id }, "Reconciling missing Wix order/payment record");
    await recordWixOrderForBooking(booking.id, log);
  }
  return missing.length;
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

export async function activateCompletedInviteeRenewals(log: PaymentLog): Promise<number> {
  const released = await keyRepo.releaseScheduledKeysAfterInviteeCompletion();
  for (const planOrderId of released) {
    await fulfillPlanOrder(planOrderId, log).catch((err) =>
      log.error(
        { err, planOrderId },
        "Early activation of completed L'Invitée renewal failed",
      ),
    );
  }
  return released.length;
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
  const current = paid ?? (await repo.findPlanOrderById(order.id));
  if (current?.is_key && current.paid_at) {
    await finalizeVerifiedKeyContinuity(current, log);
  }
  await fulfillPlanOrder(order.id, log);
  await maybeSendGoogleReviewAsk(order.id, log);
}

/**
 * One-time "leave a Google review" ask, sent right after a gated early-renewal
 * payment. The atomic claim on ask_sent_at makes webhook retries a no-op, and
 * both Wave and OM funnels reach here via processPlanPayment.
 */
async function maybeSendGoogleReviewAsk(planOrderId: string, log: PaymentLog): Promise<void> {
  if (!config.GOOGLE_REVIEW_URL) return;
  const gate = await keyRepo.claimReviewAskSend(planOrderId);
  if (!gate) return;
  const clientRes = await pool.query(`select * from clients where id=$1`, [gate.client_id]);
  const client = clientRes.rows[0];
  if (!client) return;
  const lang: string = client.language ?? "fr";
  const msg = applyFrenchRegister(
    googleReviewAskMessage(lang, config.GOOGLE_REVIEW_URL),
    lang === "fr" && client.fr_register === "vous",
  );
  await sendText(client.wa_phone, msg).catch((err) =>
    log.error({ err, planOrderId }, "Failed to send Google review ask"),
  );
  await repo.addTurn(gate.client_id, "assistant", msg).catch(() => undefined);
}

export function googleReviewAskMessage(lang: string, reviewUrl: string): string {
  switch (lang) {
    case "en":
      return (
        `🌟 Thank you for your trust! Quick note: the invitation you earned activates with a Google review.\n\n` +
        `Leave yours here: ${reviewUrl}\nThen send me a screenshot of your published review — I'll unlock your invitation right away 💛`
      );
    case "wo":
      return (
        `🌟 Jërëjëf ci sa kóllëre! Xibaar bu gaaw: invitation bi nga jot day ubbiku ak benn avis Google.\n\n` +
        `Bindal sa bos fii: ${reviewUrl}\nBu ko defee, yónnee ma benn foto (capture) bu sa avis bi — dinaa ubbi sa invitation ci saa si 💛`
      );
    default:
      return (
        `🌟 Merci pour ta confiance ! Petit rappel : l'invitation que tu as gagnée s'active avec un avis Google.\n\n` +
        `Laisse le tien ici : ${reviewUrl}\nEnvoie-moi ensuite une capture d'écran de ton avis publié — j'active ton invitation aussitôt 💛`
      );
  }
}

async function finalizeVerifiedKeyContinuity(
  order: repo.PlanOrder,
  log: PaymentLog,
): Promise<void> {
  const mapping = keyMappingForPlan(order.plan_id);
  if (!mapping || !order.paid_at) return;
  const paidAt = new Date(order.paid_at);
  const clientRes = await pool.query(`select * from clients where id=$1`, [order.client_id]);
  const client = clientRes.rows[0];
  let source: ContinuitySource | null = null;
  try {
    const contact = client
      ? await wix.findContactByPhone(
          `+${String(client.wa_phone ?? "").replace(/^\+/, "")}`,
          client.name ?? undefined,
        )
      : null;
    source = await resolveContinuitySource({
      family: mapping.family,
      clientId: order.client_id,
      contactId: contact?.id ?? null,
      memberId: order.member_id,
      at: paidAt,
    });
  } catch (error) {
    // Do not block a verified payment on a transient Wix read. The source
    // snapshotted when the link was created remains a safe fallback.
    log.error({ err: error, planOrderId: order.id }, "Key continuity refresh failed");
    if (
      order.continuity_source_kind &&
      order.continuity_source_order_id &&
      order.continuity_source_plan_id &&
      order.continuity_expires_at
    ) {
      source = {
        kind: order.continuity_source_kind,
        orderId: order.continuity_source_order_id,
        planId: order.continuity_source_plan_id,
        planName: order.continuity_source_plan_id,
        expiresAt: new Date(order.continuity_expires_at),
        remaining: order.continuity_remaining,
        previousKeyId: null,
      };
    }
  }
  const decision = keyPurchaseContinuityDecision({
    mapping,
    purchasedAt: paidAt,
    source,
  });
  await repo.finalizePaidKeyContinuity({
    id: order.id,
    startsAt: decision.startsAt,
    invitationCount: decision.invitationCount,
    sourceKind: decision.sourceKind,
    sourceOrderId: decision.sourceOrderId,
    sourcePlanId: decision.sourcePlanId,
    sourceExpiresAt: decision.sourceExpiresAt,
    sourceRemaining: decision.sourceRemaining,
  });
  // Google-review gate: the client's FIRST early Clé renewal locks its
  // invitations until she leaves a review. Created here (runs once per verified
  // Key order, re-entrant on webhook retries via the idempotent insert) because
  // a chained renewal's Key row and invitations are only born later, at
  // activation. earlyRenewal is taken from the family-scoped decision (never a
  // raw source presence), so a Résidente bought while an Aquabike is active is
  // not mis-gated; typeEligible keeps AQUABIKE/SUR_MESURE out entirely.
  if (
    order.client_id &&
    reviewGateApplies({
      featureEnabled: config.KEYS_AUTOMATION_ENABLED && !!config.GOOGLE_REVIEW_URL,
      typeEligible: mapping.reviewGateEligible,
      earlyRenewal: decision.earlyRenewal,
      clientKnown: !!order.client_id,
      clientAlreadyGated: !!(await keyRepo.reviewGateForClient(order.client_id)),
      invitationCount: decision.invitationCount,
    })
  ) {
    await keyRepo.insertReviewGate(order.client_id, order.id);
  }
  if (
    source?.kind === "LEGACY_REFORMER" &&
    (source.remaining === 0 || source.remaining === null) &&
    !order.continuity_alerted_at
  ) {
    notifyReception(
      "⚠️ Démarrage d'une Clé à vérifier",
      `La Clé "${order.plan_name}" a été payée et programmée au ${decision.startsAt.toISOString().slice(0, 10)} ` +
        `après l'abonnement legacy ${source.planName} (${source.orderId}), mais son solde est ` +
        `${source.remaining === 0 ? "à 0" : "illisible"}. Vérifier avec la cliente si la Clé doit démarrer plus tôt.`,
    );
    await repo.markPlanContinuityAlerted(order.id);
  }
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
  const keyMapping = configuredMappingForPlan(order.plan_id);

  // Paid future Keys live durably in Resabot until their actual activation
  // date. A paid Wix offline order is PENDING and its start date cannot be
  // changed; deferring creation lets a later +7-day extension shift the next
  // Key safely without cancel/recreate.
  if (order.status === "PAID" && keyMapping && startsInFuture) {
    const scheduled = await repo.markPlanOrderScheduled(order.id);
    if (!scheduled) {
      await repo.clearPlanOrderFulfilling(order.id).catch(() => {});
      return;
    }
    const currentKey = await keyRepo.activeKeyForClient({
      clientId: order.client_id,
      wixMemberId: order.member_id,
      family: keyMapping.family,
    });
    const msg = applyFrenchRegister(planConfirmationMessage(
      lang,
      order.plan_name,
      true,
      startsAt,
      client?.name,
      currentKey?.key_type === "INVITEE",
    ), lang === "fr" && client?.fr_register === "vous");
    await sendText(client.wa_phone, msg).catch((err) =>
      log.error({ err, planOrderId: order.id }, "Failed to send scheduled Key confirmation"),
    );
    await repo.addTurn(order.client_id, "assistant", msg).catch(() => undefined);
    return;
  }

  let activated = !!order.wix_order_id;
  let activatedOrderId: string | null = order.wix_order_id;
  if (!activated && order.member_id) {
    try {
      // Reconcile before retrying the non-idempotent offline-order write. A
      // previous request may have succeeded in Wix while our response was lost.
      const expectedStart = startsAt ?? new Date(order.paid_at ?? order.created_at);
      const existingOrderId = await wix.findPlanOrderForMember({
        planId: order.plan_id,
        memberId: order.member_id,
        startDate: expectedStart,
      });
      const wixOrderId = existingOrderId ?? await wix.createOfflinePlanOrder(
          order.plan_id,
          order.member_id,
          startsInFuture ? startsAt!.toISOString() : undefined,
        );
      await repo.markPlanOrderActivated(order.id, wixOrderId);
      activated = true;
      activatedOrderId = wixOrderId;
      invalidateMembershipCache(order.client_id);
      log.info({ planOrderId: order.id, wixOrderId }, "Plan activated in Wix");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const failures = await repo.recordPlanFulfillmentFailure(order.id, message);
      log.error({ err, planOrderId: order.id, failures }, "Plan activation failed after reconciliation");
      if (failures >= 2) {
        await repo.markPlanTechnicalFailure(order.id, message);
        await handleTechnicalFailure({
          client,
          kind: "plan",
          orderId: order.id,
          stage: "activation",
          cause: err,
        });
      }
      return;
    }
  }

  if (activated && activatedOrderId && order.member_id && keyMapping) {
    try {
      const contact = await wix.findContactByPhone(
        phoneDisplay,
        client?.name ?? undefined,
      );
      await registerAndEnsureKey({
        paidOrderId: activatedOrderId,
        planId: order.plan_id,
        clientId: order.client_id,
        wixContactId: contact?.id ?? null,
        wixMemberId: order.member_id,
        startsAt: startsAt ?? new Date(),
        invitationCount: order.key_invitation_count,
        purchasedAt: order.paid_at,
        continuitySourceKind: order.continuity_source_kind,
        continuitySourceOrderId: order.continuity_source_order_id,
        continuitySourcePlanId: order.continuity_source_plan_id,
        continuityExpiresAt: order.continuity_expires_at,
        reviewGatePlanOrderId: order.id,
      });
    } catch (err) {
      // The paid Key is already active. Provisioning has its own retry/audit
      // path and must never roll back or misrepresent the payment.
      log.error({ err, planOrderId: order.id }, "Key bonus registration failed after activation");
    }
  }

  // A plan/Key may carry a first class selected before payment. Once the plan
  // is active (and the Key registry is durable), redeem that exact order's
  // benefit against the persisted Wix event.
  if (activated && order.discovery_booking_status === "PENDING" && order.event_id) {
    const activatedOrder = { ...order, wix_order_id: activatedOrderId };
    try {
      await fulfillInitialPlanBooking(activatedOrder, client, lang, log);
    } catch (error) {
      // Availability/contact/benefit lookups happen before the booking write
      // and may fail on their own. Keep those failures in the same durable
      // retry/terminal path as create, redeem and confirm failures.
      await failInitialPlanBooking(activatedOrder, client, "initial_booking", error, log);
    }
    return;
  }

  // Manual path is now reserved for explicit no-inbox/refusal fallback, or an
  // offline-order incident after payment. Notify reception once in either case.
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

  const msg = applyFrenchRegister(planConfirmationMessage(
    lang,
    order.plan_name,
    activated,
    startsInFuture ? startsAt! : null,
    client?.name,
  ), lang === "fr" && client?.fr_register === "vous");
  try {
    await sendText(client.wa_phone, msg);
    await repo.addTurn(order.client_id, "assistant", msg);
  } catch (err) {
    log.error({ err, planOrderId: order.id }, "Failed to send plan confirmation");
  }
}

async function failInitialPlanBooking(
  order: repo.PlanOrder,
  client: repo.Client,
  stage: string,
  error: unknown,
  log: PaymentLog,
): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  const failures = await repo.recordPlanFulfillmentFailure(order.id, message);
  log.error({ err: error, planOrderId: order.id, failures }, "Initial plan booking failed");
  if (failures < 2) return;
  await repo.markPlanTechnicalFailure(order.id, message);
  await repo.deferDiscoveryPlanBooking(order.id, "FAILED", message);
  await handleTechnicalFailure({
    client,
    kind: "plan",
    orderId: order.id,
    stage,
    cause: error,
  });
}

async function fulfillInitialPlanBooking(
  order: repo.PlanOrder,
  client: repo.Client,
  lang: string,
  log: PaymentLog,
): Promise<void> {
  if (!order.service_id || !order.service_name || !order.event_id || !order.slot_start) {
    await failInitialPlanBooking(
      order,
      client,
      "initial_booking_invariant",
      new Error("selected slot missing from plan order"),
      log,
    );
    return;
  }

  const slotStart = new Date(order.slot_start).toISOString();
  if (Date.parse(slotStart) <= Date.now()) {
    await repo.deferDiscoveryPlanBooking(order.id, "SLOT_UNAVAILABLE", "class already started");
    const msg = applyFrenchRegister(
      `✅ Ton abonnement ${order.plan_name} est actif. Le créneau choisi a déjà commencé. Nous allons te proposer ici un nouveau créneau, sans nouveau paiement.`,
      lang === "fr" && client?.fr_register === "vous",
    );
    await sendText(client.wa_phone, msg).catch(() => undefined);
    await repo.addTurn(order.client_id, "assistant", msg).catch(() => undefined);
    return;
  }

  const fresh: wix.WixSlot | null = order.wix_booking_id
    ? {
        eventId: order.event_id,
        serviceId: order.service_id,
        startDate: slotStart,
        endDate: order.slot_end ? new Date(order.slot_end).toISOString() : slotStart,
        openSpots: 0,
        totalSpots: 0,
        coach: null,
        coachId: null,
        raw: order.slot_json,
      }
    : await wix.isSlotStillOpen(order.service_id, order.event_id, slotStart, 1);
  if (!fresh) {
    await repo.deferDiscoveryPlanBooking(order.id, "SLOT_UNAVAILABLE", "selected slot filled while payment was pending");
    const msg = applyFrenchRegister(
      `✅ Ton abonnement ${order.plan_name} est actif. Le créneau choisi s’est rempli pendant le paiement. Nous allons te proposer ici un nouveau créneau, sans nouveau paiement.`,
      lang === "fr" && client?.fr_register === "vous",
    );
    await sendText(client.wa_phone, msg).catch(() => undefined);
    await repo.addTurn(order.client_id, "assistant", msg).catch(() => undefined);
    return;
  }

  const phone = `+${String(client?.wa_phone ?? "").replace(/^\+/, "")}`;
  const contact = await wix.findContactByPhone(phone, client?.name ?? undefined);
  const benefit = contact && order.member_id && order.wix_order_id && !order.benefit_transaction_id
    ? await wix.findExactBenefitWithFallback({
        serviceId: order.service_id,
        contactId: contact.id,
        memberId: order.member_id,
        planId: order.plan_id,
        orderId: order.wix_order_id,
      })
    : null;
  if (!contact || (!order.benefit_transaction_id && !benefit)) {
    await failInitialPlanBooking(
      order,
      client,
      "initial_benefit_selection",
      new Error("exact activated plan benefit not available for selected class"),
      log,
    );
    return;
  }

  let wixBookingId: string | null = order.wix_booking_id;
  // Occurrence auto-cancelled (empty) while the plan payment was pending → keep
  // the plan active and offer another slot via the existing deferred-slot flow.
  if (!wixBookingId && (await isSessionAutoCancelled(order.event_id))) {
    await repo.deferDiscoveryPlanBooking(order.id, "SLOT_UNAVAILABLE", "occurrence auto-cancelled (empty)");
    const msg = applyFrenchRegister(
      `✅ Ton abonnement ${order.plan_name} est actif. Le créneau choisi a été annulé (personne d'inscrit). Nous allons te proposer ici un nouveau créneau, sans nouveau paiement.`,
      lang === "fr" && client?.fr_register === "vous",
    );
    await sendText(client.wa_phone, msg).catch(() => undefined);
    await repo.addTurn(order.client_id, "assistant", msg).catch(() => undefined);
    return;
  }
  try {
    if (!wixBookingId) {
      wixBookingId = await guardBooking(order.event_id, () =>
        wix.createBookingRaw({
          slot: fresh.raw,
          name: contact.fullName || client?.name || "Client Revive",
          phone,
          participants: 1,
          paymentOption: "MEMBERSHIP",
          resolvedContact: contact,
        }),
      );
      await repo.saveInitialPlanBookingWixId(order.id, wixBookingId);
    }
    let transactionId = order.benefit_transaction_id;
    if (!transactionId) {
      const redemption = await wix.redeemMembershipForBooking({
        wixBookingId,
        serviceId: order.service_id,
        benefit: benefit!,
        count: 1,
      });
      transactionId = redemption.transactionId || null;
      if (transactionId) {
        await repo.saveInitialPlanBenefitTransaction(order.id, transactionId);
      }
    }
    let confirmationError: unknown = null;
    for (const delay of [0, 300, 900]) {
      if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
      try {
        await wix.confirmBookingPaid(wixBookingId);
        confirmationError = null;
        break;
      } catch (error) {
        confirmationError = error;
      }
    }
    if (confirmationError) throw confirmationError;
    const booking = await repo.createMembershipBooking({
      clientId: order.client_id,
      serviceId: order.service_id,
      serviceName: order.service_name,
      eventId: order.event_id,
      slotJson: fresh.raw,
      slotStart: fresh.startDate,
      slotEnd: fresh.endDate ?? null,
      wixBookingId,
      benefitTransactionId: transactionId,
      membershipPlanName: order.plan_name,
    });
    await repo.finishDiscoveryPlanBooking({
      planOrderId: order.id,
      wixBookingId,
      benefitTransactionId: transactionId,
      bookingId: booking.id,
    });
    invalidateMembershipCache(order.client_id);
    // Dashboard order ("séance déduite") — failure is retried by the sweep and
    // must never fail the already-confirmed booking.
    await recordWixOrderForBooking(booking.id, log).catch(() => undefined);
    const msg = applyFrenchRegister(
      confirmationMessage(lang, order.service_name, new Date(fresh.startDate)),
      lang === "fr" && client?.fr_register === "vous",
    );
    try {
      const waMessageId = await sendText(client.wa_phone, msg);
      await repo.addTurn(order.client_id, "assistant", msg, waMessageId ?? undefined);
    } catch (error) {
      await handleTechnicalFailure({
        client,
        kind: "plan",
        orderId: order.id,
        stage: "booking_confirmation_send",
        cause: error,
      });
    }
    log.info({ planOrderId: order.id, wixBookingId }, "Initial plan class activated and booked with membership");
  } catch (err) {
    if (err instanceof OccurrenceCancelledError) {
      // Lost the race: the empty-class engine cancelled the occurrence between
      // our pre-check and the create. Plan stays active; offer another slot.
      await repo.deferDiscoveryPlanBooking(order.id, "SLOT_UNAVAILABLE", "occurrence auto-cancelled (empty)");
      const msg = applyFrenchRegister(
        `✅ Ton abonnement ${order.plan_name} est actif. Le créneau choisi a été annulé (personne d'inscrit). Nous allons te proposer ici un nouveau créneau, sans nouveau paiement.`,
        lang === "fr" && client?.fr_register === "vous",
      );
      await sendText(client.wa_phone, msg).catch(() => undefined);
      await repo.addTurn(order.client_id, "assistant", msg).catch(() => undefined);
      return;
    }
    await failInitialPlanBooking(order, client, "initial_booking", err, log);
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

  // The name the KITCHEN/DELIVERY sees is the one TYPED on the page (web orders),
  // NOT the CRM name — a known client who orders under a different first name gets
  // that first name on the ticket. NULL customer_name = WhatsApp order → CRM name.
  const displayName = order.customer_name ?? client?.name ?? "Client Awa";
  const mode = (order.service_mode as CafeServiceMode | null) ?? null;

  // ── Web delivery: articles paid online → auto-create the delivery (no bar ticket) ──
  if (mode === "LIVRAISON") {
    const phone =
      normalizeDeliveryPhone(String(client?.wa_phone ?? "")) ??
      String(client?.wa_phone ?? "").replace(/\D/g, "");
    const method = (["wave", "orange_money", "maxit"].includes(order.payment_method)
      ? order.payment_method
      : "wave") as "wave" | "orange_money" | "maxit";
    const feeXof = config.DELIVERY_FEE_XOF > 0 ? config.DELIVERY_FEE_XOF : null;
    try {
      await deliveries.createWebDeliveryFromPaidCafeOrder({
        sourceCafeOrderId: order.id,
        clientName: displayName,
        clientPhone: phone,
        address: order.delivery_address ?? "",
        note: order.order_note,
        items: extras,
        amountXof: order.amount_xof,
        paymentMethod: method,
        paymentRef: order.wave_session_id ?? `cafe:${order.id}`,
        deliveryFeeXof: feeXof,
        slaMinutes: config.DELIVERY_SLA_MINUTES,
        isTest: client?.is_test === true,
      });
    } catch (err) {
      // Load-bearing: if the delivery can't be created, DO NOT mark the cafe order
      // fulfilled — leave it PAID so reconcileStuckCafeOrders retries (no lost order,
      // and idempotency on source_cafe_order_id guarantees no duplicate on retry).
      log.error({ err, cafeOrderId: order.id }, "Web delivery creation failed — leaving cafe order for reconcile");
      notifyReception(
        "⚠️ Livraison web payée non créée",
        `La commande web ${order.id} (payée) n'a pas pu créer sa livraison.\n` +
          `Client : ${displayName} (+${String(client?.wa_phone ?? "").replace(/^\+/, "")})\n` +
          `Adresse : ${order.delivery_address ?? "?"}\n` +
          `Articles : ${extras.map((line) => `${line.qty}× ${line.name}`).join(", ")}`,
      );
      return;
    }
    // The delivery's own created-ping (web variant) IS the client confirmation —
    // no generic cafe WhatsApp here (that would double-message the client).
    await repo.markCafeOrderFulfilled(order.id);
    return;
  }

  // ── Bar ticket modes (sur place / à emporter / retrait / historical WhatsApp) ──
  const standalone = !order.linked_booking_id;
  let takeaway = false;
  let subheading: string;
  if (mode === "SUR_PLACE") {
    subheading = `Sur place — servir à ${displayName}`;
  } else if (mode === "A_EMPORTER") {
    takeaway = true;
    subheading = "À emporter — comptoir";
  } else if (mode === "RETRAIT") {
    subheading = "Retrait au comptoir";
  } else {
    subheading = standalone ? "Retrait au comptoir" : `${order.service_name ?? "Cours"} · ${slotLabel}`;
  }
  try {
    await createBarTicket({
      sourceKey: `bar:cafe:${order.id}`,
      heading: displayName,
      subheading,
      lines: extras,
      amountXof: order.amount_xof,
      note: order.order_note ?? (standalone ? "dès que possible" : "prête après le cours"),
      isTest: client?.is_test === true,
      takeaway,
    });
  } catch (err) {
    log.error({ err, cafeOrderId: order.id }, "Paid cafe order ticket projection failed");
    notifyReception(
      "⚠️ Commande bar payée absente de l’iPad",
      `La commande bar ${order.id} n’a pas pu être affichée en cuisine.\n` +
        `Client : ${displayName} (+${String(client?.wa_phone ?? "").replace(/^\+/, "")})\n` +
        `Articles : ${extras.map((line) => `${line.qty}× ${line.name}`).join(", ")}`,
    );
  }

  const msg = applyFrenchRegister(
    cafeConfirmationMessage(lang, extras, order.order_note, order.service_name),
    lang === "fr" && client?.fr_register === "vous",
  );
  try {
    await sendText(client.wa_phone, msg);
    await repo.addTurn(order.client_id, "assistant", msg);
  } catch (err) {
    log.error({ err, cafeOrderId: order.id }, "Failed to send bar confirmation");
  }

  // Ticket creation is idempotent. If it failed, reception received a critical
  // exception alert; routine paid orders never WhatsApp the kitchen.
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
  earlyAfterInvitee = false,
): string {
  // Chained renewal: the plan is paid but activates on a future date.
  if (startsAt) {
    const d = startsAt.toISOString().slice(0, 10);
    if (earlyAfterInvitee) {
      switch (lang) {
        case "en":
          return (
            `✅ Payment received — your "${planName}" Key is ready!\n\n` +
            `It will start after your 3rd L'Invitée Reformer session, or on ${d} at the latest. Any unused L'Invitée bonus remains available until its own expiry.`
          );
        case "wo":
          return (
            `✅ Fey bi jot na — sa Clé "${planName}" pare na!\n\n` +
            `Dina tàmbali gannaaw sa 3e séance Reformer L'Invitée, walla ci ${d} bu ëppe. Bonus L'Invitée bi des dina dox ba bés bu mu jeex.`
          );
        default:
          return (
            `✅ Paiement reçu — ta Clé "${planName}" est prête !\n\n` +
            `Elle démarrera après ta 3e séance Reformer L'Invitée, ou au plus tard le ${d}. Ton éventuel bonus L'Invitée reste utilisable jusqu'à sa propre expiration.`
          );
      }
    }
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
/**
 * Whether the one-shot account-linking invitation is still due for this client:
 * never asked, no claimed email, and their WhatsApp number matches no unique Wix
 * contact. Shared by the commitment progress message (to decide the ms_link
 * button) and maybeHandleUnlinkedClient.
 */
async function shouldAskUnlinked(client: any): Promise<boolean> {
  if (client.email_prompted_at || client.claimed_email) return false;
  const contactId = await wix
    .findContactIdByPhone(`+${String(client.wa_phone).replace(/^\+/, "")}`, client.name ?? undefined)
    .catch(() => null);
  return !contactId;
}

/** Returns true when the linking invitation was actually sent this call. */
async function maybeHandleUnlinkedClient(
  client: any,
  booking: any,
  lang: string,
  log: any,
): Promise<boolean> {
  try {
    // Already prompted (incl. armed by the ms_link button on a progress message)
    // or already linked → nothing to send.
    if (!(await shouldAskUnlinked(client))) return false;

    await repo.markEmailPrompted(client.id);

    const ask = applyFrenchRegister(
      emailAskMessage(lang),
      lang === "fr" && client?.fr_register === "vous",
    );
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
    return true;
  } catch (err) {
    log.error({ err, clientId: client?.id }, "Unlinked-client handling failed (non-blocking)");
    return false;
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
  await recordBookingFunnelEvent({
    clientId: bookingRow?.client_id ?? client?.id,
    bookingId,
    stage: "technical_failure",
    paymentMethod: bookingRow?.payment_method ?? null,
    failureCode:
      reason === "class_started"
        ? "slot_already_started"
        : reason === "class_auto_cancelled"
          ? "class_auto_cancelled"
          : reason === "slot_taken"
            ? "slot_unavailable"
            : "wix_booking_failed",
    idempotencyKey: `booking:${bookingId}:refund-needed`,
    metadata: {
      refund_required: true,
      requested_spots: spots?.requested,
      remaining_spots: spots?.remaining,
    },
  }).catch((error) => log.error({ err: error, bookingId }, "Failed to record refund funnel event"));
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
  const msg = applyFrenchRegister(
    refundMessage(lang, spots, reason, client?.name),
    lang === "fr" && client?.fr_register === "vous",
  );
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
  // Extension bookings (add_spots_to_booking) carry the marker order_note
  // written in tools.ts ("Ajout de N place(s) à la résa <id>"). Their
  // confirmation must say it covers the ADDED spot(s) only: the generic "ta
  // place est confirmée" made both the client and the model read it as the
  // client's own (already booked) spot — real confusion Khadidjatou 02/08,
  // where Awa then denied the companion's paid booking. Cafe orders reuse
  // orderNote as free text, so only a no-extras booking can be an extension.
  const extensionMatch = !hasCafe && orderNote ? orderNote.match(/^Ajout de (\d+) place/) : null;
  const extensionSpots = extensionMatch ? Math.max(1, Number(extensionMatch[1])) : null;
  // Keyword tip from classTips (null when unknown — never invent).
  // Lazy import avoided: classTips is pure and safe at module load.
  const tip = classTip(serviceName, lang);
  const tipBlock = tip ? `${tip}\n\n` : "";
  switch (lang) {
    case "en":
      return (
        (extensionSpots
          ? `✅ Payment received — ${extensionSpots > 1 ? `the ${extensionSpots} extra spots are` : "the extra spot is"} confirmed!\n\n`
          : `✅ Payment received — your spot is confirmed!\n\n`) +
        `${serviceName}\n📅 ${formatSlot(slotStart, "en-GB")}\n📍 ${config.STUDIO_ADDRESS}\n\n` +
        (extensionSpots
          ? `👥 This covers only the added spot(s) — your own booking on this slot is unchanged; you'll be there together.\n\n`
          : "") +
        (hasCafe
          ? `☕ Your bar order (already paid):\n${formatExtrasMultiline(extras!)}\n→ ${orderNote ?? "ready after your class"}\n\n`
          : "") +
        tipBlock +
        `ℹ️ Free cancellation up to 16 hours before class — after that, the session is due.\n\n` +
        `Show this message at reception. See you soon! 💪🏾`
      );
    case "wo":
      return (
        (extensionSpots
          ? `✅ Fey bi jot na — palass bu yokk bi dëgg na!\n\n`
          : `✅ Fey bi jot na — sa palass dëgg na!\n\n`) +
        `${serviceName}\n📅 ${formatSlot(slotStart, "fr-FR")}\n📍 ${config.STUDIO_ADDRESS}\n\n` +
        (extensionSpots
          ? `👥 Palass bu ci yokk rekk la — sa réservation bu jëkk du soppiku.\n\n`
          : "") +
        (hasCafe
          ? `☕ Sa commande bar (fey nga ko ba noppi):\n${formatExtrasMultiline(extras!)}\n→ ${orderNote ?? "dina pare ginnaaw sa cours"}\n\n`
          : "") +
        tipBlock +
        `ℹ️ Man nga annuler ba 16 waxtu laata cours bi ; su weesoo loolu, séance bi dina jar.\n\n` +
        `Wone bataaxal bii ci réception. Ba beneen yoon! 💪🏾`
      );
    default:
      return (
        (extensionSpots
          ? `✅ Paiement reçu — ${extensionSpots > 1 ? `les ${extensionSpots} places supplémentaires sont confirmées` : "la place supplémentaire est confirmée"} !\n\n`
          : `✅ Paiement reçu — ta place est confirmée !\n\n`) +
        `${serviceName}\n📅 ${formatSlot(slotStart, "fr-FR")}\n📍 ${config.STUDIO_ADDRESS}\n\n` +
        (extensionSpots
          ? `👥 Cette confirmation couvre uniquement la/les place(s) ajoutée(s) — ta propre réservation sur ce créneau reste inchangée, vous y serez ensemble.\n\n`
          : "") +
        (hasCafe
          ? `☕ Ta commande bar (déjà payée) :\n${formatExtrasMultiline(extras!)}\n→ ${orderNote ?? "prête après ton cours"}\n\n`
          : "") +
        tipBlock +
        `ℹ️ Annulation gratuite jusqu'à 16h avant le cours ; passé ce délai, la séance est due.\n\n` +
        `Montre ce message à la réception. À très vite ! 💪🏾`
      );
  }
}

export type RefundReason =
  | "slot_taken"
  | "technical"
  | "class_started"
  | "class_auto_cancelled";

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
      if (reason === "class_auto_cancelled")
        return (
          `We're so sorry 😔 — that class was cancelled (no one was booked in), so we couldn't confirm your spot. ` +
          `You will be refunded within 24h. Reply here and I'll find you another slot! 🙏🏾`
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
      if (reason === "class_auto_cancelled")
        return (
          `Baal ma — cours bi ñu ko neenal (kenn bindu ci woon), kon mënuma woon confirmer sa palass. ` +
          `Dinañu la delloo sa xaalis balaa 24 waxtu. Bindal ma fii ma wut la beneen palass! 🙏🏾`
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
      if (reason === "class_auto_cancelled")
        return (
          `Désolé 😔 — ce cours a été annulé (personne n'était inscrit), je n'ai donc pas pu confirmer ta place. ` +
          `Tu seras remboursé(e) sous 24h. Écris-moi ici et je te trouve un autre créneau ! 🙏🏾`
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
