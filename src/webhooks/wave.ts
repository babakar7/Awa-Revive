import type { FastifyInstance, FastifyRequest } from "fastify";
import { config } from "../config.js";
import { pool } from "../db/index.js";
import { verifyWaveSignature } from "../lib/wave.js";
import { sendText } from "../lib/whatsapp.js";
import * as wix from "../lib/wix.js";
import * as repo from "../domain/repo.js";
import { transition } from "../domain/stateMachine.js";
import { notifyReception } from "../lib/notify.js";
import { invalidateMembershipCache } from "../lib/membershipContext.js";
import { extrasFromJson, formatExtrasMultiline, type ExtraLine } from "../lib/cafeMenu.js";
import { sendCafeMenuOffer } from "../lib/cafeOffer.js";
import { emailAskMessage } from "../lib/linkAsk.js";

/**
 * Wave webhook handler — the critical path (SPEC §7).
 * Payment-first invariant: the Wix booking is created HERE and only here,
 * after signature + idempotency + state checks.
 */
export function registerWaveWebhook(app: FastifyInstance): void {
  app.post("/webhooks/wave", async (req: FastifyRequest, reply) => {
    const rawBody = (req as any).rawBody as Buffer | undefined;
    const signature = (req.headers["wave-signature"] ?? req.headers["Wave-Signature"]) as
      | string
      | undefined;

    // 1. Verify signature (with a 5-minute replay window). 401 on failure.
    if (
      !rawBody ||
      !verifyWaveSignature(rawBody, signature, config.WAVE_WEBHOOK_SECRET, {
        toleranceSeconds: 300,
      })
    ) {
      req.log.warn({ signature }, "Wave webhook: invalid signature — rejected");
      return reply.code(401).send("Invalid signature");
    }

    const event: any = req.body;
    const eventId: string | undefined = event?.id ?? event?.data?.id;
    const eventType: string | undefined = event?.type;
    const clientReference: string | undefined = event?.data?.client_reference;

    // 6. Always return 200 quickly; heavy work happens async below.
    reply.code(200).send("OK");

    if (eventType !== "checkout.session.completed") {
      req.log.info({ eventType }, "Wave webhook: ignoring event type");
      return;
    }
    if (!eventId || !clientReference) {
      req.log.warn({ event }, "Wave webhook: missing id/client_reference");
      return;
    }

    // 2. Idempotency — Wave may deliver the same session more than once.
    //    Read-only check here; the id is recorded only AFTER processing
    //    succeeds (below), so a transient failure stays retriable instead of
    //    being silently swallowed with the client's money already taken. A
    //    genuine duplicate that races us is caught by the atomic PAID
    //    transition inside processPayment (the loser no-ops).
    if (await repo.wasProcessed(`wave:${eventId}`)) {
      req.log.info({ eventId }, "Wave webhook: duplicate delivery, skipping");
      return;
    }

    setImmediate(() => {
      processPayment(clientReference, event, req.log)
        .then(() => repo.markProcessed(`wave:${eventId}`, "wave"))
        .catch((err) =>
          req.log.error(
            { err, clientReference },
            "Wave payment processing failed — id NOT marked processed so Wave can retry",
          ),
        );
    });
  });
}

async function processPayment(clientReference: string, event: any, log: any): Promise<void> {
  // 3. Look up pending_booking by client_reference — or a plan purchase.
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
    log.warn({ clientReference }, "Wave webhook: unknown client_reference — ignoring");
    return;
  }

  // 4. Set PAID (atomic; only from AWAITING_PAYMENT or EXPIRED — late payments
  //    are honored per SPEC §5). A null result means a duplicate delivery beat
  //    us OR an earlier attempt already set PAID but crashed before the Wix
  //    booking — either way we hand off to fulfillment, whose atomic claim
  //    resumes a stuck booking or safely no-ops.
  const payerPhone: string | null = event?.data?.mobile ?? event?.data?.payer_phone ?? null;
  const paid = await transition(pool, booking.id, "PAID", { payer_phone: payerPhone });
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
async function fulfillPaidBooking(bookingId: string, log: any): Promise<void> {
  const booking = await repo.claimBookingForFulfillment(bookingId);
  if (!booking) {
    log.info({ bookingId }, "Booking already fulfilled or being fulfilled elsewhere — skipping");
    return;
  }

  const clientRes = await pool.query(`select * from clients where id = $1`, [booking.client_id]);
  const client = clientRes.rows[0];
  const lang: string = client?.language ?? "fr";

  // 5. Re-check slot in Wix, then create the booking — or flag for refund.
  try {
    const participants = Math.max(1, booking.participants ?? 1);
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

    const wixBookingId = await wix.createBooking({
      slot: fresh.raw ?? booking.slot_json,
      name: client?.name ?? "Client Revive",
      phone: `+${client.wa_phone.replace(/^\+/, "")}`,
      participants,
    });

    await transition(pool, booking.id, "BOOKED", { wix_booking_id: wixBookingId });
    log.info({ bookingId: booking.id, wixBookingId, participants }, "Booking confirmed in Wix");

    const serviceLabel =
      participants > 1 ? `${booking.service_name} — ${participants} places` : booking.service_name;
    const extras = extrasFromJson(booking.extras_json);
    const confirmation = confirmationMessage(
      lang,
      serviceLabel,
      new Date(booking.slot_start),
      extras,
      booking.order_note,
    );
    await sendText(client.wa_phone, confirmation);
    await repo.addTurn(booking.client_id, "assistant", confirmation);

    // Book-first, menu-after: now that the class is confirmed, offer the café
    // menu as its own (separate) order. Skipped if a café was somehow already
    // attached to this booking. Non-blocking — a proposal hiccup must never
    // break the confirmed booking.
    if (extras.length === 0) {
      await sendCafeMenuOffer({ waPhone: client.wa_phone, clientId: booking.client_id, lang, log });
    }

    // Café order → tell the team to prepare it (email + WhatsApp reception).
    // Never let a notification problem break the rest of the flow.
    if (extras.length > 0) {
      try {
        notifyReception(
          `☕ Commande café payée — ${booking.extras_amount_xof} FCFA`,
          `Un client a payé une commande café avec sa réservation :\n` +
            `  Client : ${client?.name ?? "?"} (+${String(client.wa_phone).replace(/^\+/, "")})\n` +
            extras.map((l) => `  • ${l.qty}× ${l.name} — ${l.lineTotalXof} FCFA`).join("\n") +
            `\n  À servir : ${booking.order_note ?? "prête après le cours"}\n` +
            `  Cours : ${serviceLabel} — ${new Date(booking.slot_start).toLocaleString("fr-FR", { timeZone: config.TIMEZONE })}\n` +
            `  Total café : ${booking.extras_amount_xof} FCFA (payé, inclus dans le paiement Wave)`,
        );
      } catch (err) {
        log.error({ err, bookingId: booking.id }, "Café order notification failed");
      }
    }

    // Unlinked client? (phone→contact match failed → a duplicate contact was
    // just created in Wix). Two things, once per client: ask the client for
    // their account email HERE IN THE CHAT (never "send it to reception"),
    // and notify reception automatically.
    await maybeHandleUnlinkedClient(client, booking, lang, log);
  } catch (err) {
    log.error({ err, bookingId: booking.id }, "Wix booking failed after payment");
    // Not a capacity problem — don't tell the client the spot was taken.
    await markRefund(booking.id, client, lang, log, undefined, "technical");
  }
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

/**
 * Plan purchase paid via Wave. The Wix offline order (the actual activation)
 * happens HERE and only here, after the verified webhook — same payment-first
 * invariant as class bookings.
 *
 * Two outcomes:
 *  - client has a Wix member account (member_id resolved at link creation) →
 *    plan activated automatically, client told it's active;
 *  - no member account → stays PAID, reception is emailed to activate
 *    manually, client told the team is finalizing it.
 */
async function processPlanPayment(order: any, log: any): Promise<void> {
  const paid = await repo.markPlanOrderPaid(order.id);
  if (!paid) {
    log.info({ planOrderId: order.id, status: order.status }, "Plan order not payable — skipping");
    return;
  }

  const clientRes = await pool.query(`select * from clients where id = $1`, [order.client_id]);
  const client = clientRes.rows[0];
  const lang: string = client?.language ?? "fr";
  const phoneDisplay = `+${String(client?.wa_phone ?? "").replace(/^\+/, "")}`;

  // Chained renewal: a future start date makes Wix create the order as PENDING
  // and activate it automatically on that day (so an early renewal doesn't
  // waste the days left on the current plan).
  const startsAt: Date | null = order.starts_at ? new Date(order.starts_at) : null;
  const startsInFuture = startsAt !== null && startsAt.getTime() > Date.now();

  let activated = false;
  if (order.member_id) {
    try {
      const wixOrderId = await wix.createOfflinePlanOrder(
        order.plan_id,
        order.member_id,
        startsInFuture ? startsAt!.toISOString() : undefined,
      );
      await repo.markPlanOrderActivated(order.id, wixOrderId);
      activated = true;
      // The client's new plan is live now — drop the stale membership cache so
      // the next message sees it instead of waiting out the 10-min TTL.
      invalidateMembershipCache(order.client_id);
      log.info({ planOrderId: order.id, wixOrderId }, "Plan activated in Wix");
    } catch (err) {
      log.error({ err, planOrderId: order.id }, "Plan activation failed — falling back to manual");
    }
  }

  if (!activated) {
    notifyReception(
      `🎫 ABONNEMENT payé — activation manuelle : ${order.plan_name}`,
      `Un client a acheté un abonnement via Awa (paiement Wave reçu) mais l'activation ` +
        `automatique n'a pas pu se faire${order.member_id ? "" : " (pas de compte membre Wix relié à ce numéro)"}.\n` +
        `  Client : ${client?.name ?? "?"} (${phoneDisplay})\n` +
        `  Formule : ${order.plan_name}\n` +
        `  Montant payé : ${order.amount_xof} FCFA (session Wave : ${order.wave_session_id ?? "?"})\n` +
        (startsInFuture
          ? `  ⚠️ Démarrage voulu : ${startsAt!.toISOString().slice(0, 10)} (renouvellement à la fin de l'abonnement actuel) — régler la date de début en conséquence.\n`
          : "") +
        `\nÀ faire dans le dashboard Wix : Abonnements → attribuer "${order.plan_name}" au client ` +
        `(créer/relier sa fiche si besoin — numéro WhatsApp ci-dessus), en marquant l'ordre comme payé.`,
    );
  }

  const msg = planConfirmationMessage(
    lang,
    order.plan_name,
    activated,
    startsInFuture ? startsAt! : null,
  );
  try {
    await sendText(client.wa_phone, msg);
    await repo.addTurn(order.client_id, "assistant", msg);
  } catch (err) {
    log.error({ err, planOrderId: order.id }, "Failed to send plan confirmation");
  }
}

/**
 * Café-only order paid via Wave (menu order alongside a membership booking —
 * that flow has no payment link, so the café got its own). No Wix booking to
 * create: we only mark it paid, tell reception to prepare it, and confirm to
 * the client. Same payment-first stance — reception acts only after the
 * verified webhook.
 */
async function processCafePayment(order: any, log: any): Promise<void> {
  const paid = await repo.markCafeOrderPaid(order.id);
  if (!paid) {
    log.info({ cafeOrderId: order.id, status: order.status }, "Café order not payable — skipping");
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
        ? `☕ Commande café payée (sans réservation) — ${order.amount_xof} FCFA`
        : `☕ Commande café payée (résa existante) — ${order.amount_xof} FCFA`,
      (standalone
        ? `Un client a payé une commande café seule (aucun cours associé — retrait au comptoir) :\n`
        : `Un client a payé une commande café qui accompagne une réservation existante :\n`) +
        `  Client : ${client?.name ?? "?"} (+${String(client?.wa_phone ?? "").replace(/^\+/, "")})\n` +
        extras.map((l) => `  • ${l.qty}× ${l.name} — ${l.lineTotalXof} FCFA`).join("\n") +
        `\n  À servir : ${order.order_note ?? (standalone ? "dès que possible" : "prête après le cours")}\n` +
        (standalone ? "" : `  Cours associé : ${order.service_name ?? "?"} — ${slotLabel}\n`) +
        `  Total café : ${order.amount_xof} FCFA (payé via Wave)`,
    );
  } catch (err) {
    log.error({ err, cafeOrderId: order.id }, "Café order notification failed");
  }

  const msg = cafeConfirmationMessage(lang, extras, order.order_note, order.service_name);
  try {
    await sendText(client.wa_phone, msg);
    await repo.addTurn(order.client_id, "assistant", msg);
  } catch (err) {
    log.error({ err, cafeOrderId: order.id }, "Failed to send café confirmation");
  }
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
        `✅ Payment received — your café order is confirmed!\n\n` +
        `☕ Your order:\n${formatExtrasMultiline(extras)}\n→ ${orderNote ?? defaultNote.en}\n\n` +
        `See you soon! 💪🏾`
      );
    case "wo":
      return (
        `✅ Fey bi jot na — sa commande café dëgg na!\n\n` +
        `☕ Sa commande:\n${formatExtrasMultiline(extras)}\n→ ${orderNote ?? defaultNote.wo}\n\n` +
        `Ba beneen yoon! 💪🏾`
      );
    default:
      return (
        `✅ Paiement reçu — ta commande café est confirmée !\n\n` +
        `☕ Ta commande :\n${formatExtrasMultiline(extras)}\n→ ${orderNote ?? defaultNote.fr}\n\n` +
        `À très vite ! 💪🏾`
      );
  }
}

function planConfirmationMessage(
  lang: string,
  planName: string,
  activated: boolean,
  startsAt: Date | null,
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
  switch (lang) {
    case "en":
      return (
        `✅ Payment received for the "${planName}" plan!\n\n` +
        `The team is finalizing its activation on your account — you'll be able to book with it very soon. ` +
        `Any question: ${config.RECEPTION_PHONE}`
      );
    case "wo":
      return (
        `✅ Fey bi jot na ngir abonnement "${planName}"!\n\n` +
        `Ekib bi mungi sotal sa compte — dinga man a book ak moom léegi léegi. ` +
        `Soo amee laaj: ${config.RECEPTION_PHONE}`
      );
    default:
      return (
        `✅ Paiement reçu pour l'abonnement "${planName}" !\n\n` +
        `L'équipe finalise son activation sur ton compte — tu pourras réserver avec très vite. ` +
        `Une question : ${config.RECEPTION_PHONE}`
      );
  }
}

/**
 * Unlinked-client handling (one-shot per client). If this client's WhatsApp
 * number matches no unique Wix contact, their booking just created a
 * duplicate contact. We then:
 *   1. Ask the client — in this same WhatsApp chat, replying to Awa — for the
 *      email of their existing account (if any). Never phrased as "send it to
 *      the reception number".
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
  notifyReception(
    `💸 REMBOURSEMENT à faire — ${bookingRow?.amount_xof ?? "?"} FCFA`,
    `Un paiement doit être remboursé dans le portail Wave :\n` +
      `  Client : ${client?.name ?? "?"} (+${String(client?.wa_phone ?? "").replace(/^\+/, "")})\n` +
      `  Cours : ${bookingRow?.service_name ?? "?"} — ${bookingRow ? new Date(bookingRow.slot_start).toLocaleString("fr-FR", { timeZone: config.TIMEZONE }) : "?"}\n` +
      `  Montant : ${bookingRow?.amount_xof ?? "?"} FCFA\n` +
      (bookingRow && bookingRow.extras_amount_xof > 0
        ? `  Dont commande café : ${bookingRow.extras_amount_xof} FCFA (incluse dans le montant ci-dessus — la commande ne doit PAS être préparée).\n`
        : "") +
      `  Session Wave : ${bookingRow?.wave_session_id ?? "?"}\n` +
      `  Booking id : ${bookingId}\n\n` +
      `Après remboursement dans le portail Wave, clôturer avec :\n` +
      `  railway run npm run refund:done -- ${bookingId}\n\n` +
      `Le client a déjà été prévenu sur WhatsApp (remboursement sous 24h).`,
  );
  const msg = refundMessage(lang, spots, reason);
  try {
    await sendText(client.wa_phone, msg);
    await repo.addTurn(client.id, "assistant", msg);
  } catch (err) {
    log.error({ err, bookingId }, "Failed to notify client about refund");
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
  switch (lang) {
    case "en":
      return (
        `✅ Payment received — your spot is confirmed!\n\n` +
        `${serviceName}\n📅 ${formatSlot(slotStart, "en-GB")}\n📍 ${config.STUDIO_ADDRESS}\n\n` +
        (hasCafe
          ? `☕ Your café order (already paid):\n${formatExtrasMultiline(extras!)}\n→ ${orderNote ?? "ready after your class"}\n\n`
          : "") +
        `ℹ️ Free cancellation up to 16 hours before class — after that, the session is due.\n\n` +
        `Show this message at reception. See you soon! 💪🏾`
      );
    case "wo":
      return (
        `✅ Fey bi jot na — sa palass dëgg na!\n\n` +
        `${serviceName}\n📅 ${formatSlot(slotStart, "fr-FR")}\n📍 ${config.STUDIO_ADDRESS}\n\n` +
        (hasCafe
          ? `☕ Sa commande café (fey nga ko ba noppi):\n${formatExtrasMultiline(extras!)}\n→ ${orderNote ?? "dina pare ginnaaw sa cours"}\n\n`
          : "") +
        `ℹ️ Man nga annuler ba 16 waxtu laata cours bi ; su weesoo loolu, séance bi dina jar.\n\n` +
        `Wone bataaxal bii ci réception. Ba beneen yoon! 💪🏾`
      );
    default:
      return (
        `✅ Paiement reçu — ta place est confirmée !\n\n` +
        `${serviceName}\n📅 ${formatSlot(slotStart, "fr-FR")}\n📍 ${config.STUDIO_ADDRESS}\n\n` +
        (hasCafe
          ? `☕ Ta commande café (déjà payée) :\n${formatExtrasMultiline(extras!)}\n→ ${orderNote ?? "prête après ton cours"}\n\n`
          : "") +
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
): string {
  // Group shortage: be precise about why, so the client can adjust.
  const shortage = spots && spots.requested > 1 && spots.remaining > 0;
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
          `You will be refunded within 24h. Reply here if you'd like to try again, or contact reception: ${config.RECEPTION_PHONE} 🙏🏾`
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
          `Dinañu la delloo sa xaalis balaa 24 waxtu. Bindal ma fii walla jokkool ak réception bi: ${config.RECEPTION_PHONE} 🙏🏾`
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
          `Tu seras remboursé(e) sous 24h. Écris-moi ici si tu veux réessayer, ou contacte la réception : ${config.RECEPTION_PHONE} 🙏🏾`
        );
      return (
        `Désolé 😔 — cette place vient d'être prise pendant ton paiement. ` +
        `Tu seras remboursé(e) sous 24h. Écris-moi ici si tu veux que je te trouve un autre créneau ! 🙏🏾`
      );
  }
}
