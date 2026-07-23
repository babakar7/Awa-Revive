import { config } from "../config.js";
import { sendText, sendTemplate, sendTemplateWithUrlButton } from "../lib/whatsapp.js";
import {
  notifyReception,
  sendWhatsAppNotificationDetailed,
} from "../lib/notify.js";
import * as repo from "./repo.js";
import { normalizeName } from "./notificationRules.js";
import { listStaffContacts, phoneDigits, recordDeliveryLog } from "./notificationRepo.js";
import { planningNowSlot } from "./staffPlanningRules.js";
import { onShiftStaffIds } from "./staffPlanningRepo.js";
import {
  aggregateKitchenOutcome,
  createdClientMessage,
  deliveryRecipientStaffLine,
  deliveryUpdateTemplateParams,
  formatDakarDateTime,
  kitchenMessage,
  kitchenTemplateParams,
  magicLinkUrl,
  recipientRouteMessage,
  recipientRouteTemplateParams,
  rescheduledClientMessage,
  routeClientMessage,
  type ClientPingKind,
  type DeliveryOrderView,
} from "./deliveryRules.js";
import {
  activateDueScheduledDeliveries,
  claimActivationNotify,
  claimCreatedNotify,
  claimDeliverySlaAlerts,
  claimKitchenNotifyWithFreshToken,
  claimRecipientRouteNotify,
  claimRescheduleNotify,
  claimRouteNotify,
  findDeliveryOrder,
  orderItems,
  pendingActivationNotifies,
  pendingCreatedNotifies,
  pendingKitchenNotifies,
  pendingRecipientRouteNotifies,
  pendingRescheduleNotifies,
  pendingRouteNotifies,
  rotateReadyToken,
  setActivationNotifyOutcome,
  setCreatedNotifyOutcome,
  setRescheduleNotifyOutcome,
  setRouteNotifyOutcome,
  setKitchenNotifyOutcome,
  setRecipientRouteNotifyOutcome,
  type DeliveryOrder,
} from "./deliveryRepo.js";

/**
 * WhatsApp effects for delivery orders + the 60-second reconciliation sweep.
 * Kitchen contacts are staff_contacts with the EXACT role `bar` (the bar team IS
 * the kitchen at Revive; no fuzzy match — a typo/bilingual role shouldn't
 * silently opt a person in or out) that have a usable phone AND are on shift
 * right now per the published staff planning (nobody gets pinged off-hours;
 * no published planning = no gating). If nobody qualifies, the ticket falls
 * back to reception + the owner with a warning. Every send is journaled
 * (source='delivery'). Notifications never throw to their caller — a failed
 * send flips a status the dashboard/sweep act on, it never breaks the order.
 */

type Log = { info: (o: unknown, m?: string) => void; error: (o: unknown, m?: string) => void };

const KITCHEN_ROLE = "bar";

function viewOf(o: DeliveryOrder): DeliveryOrderView {
  return {
    client_name: o.client_name,
    client_phone: o.client_phone,
    recipient_name: o.recipient_name,
    recipient_phone: o.recipient_phone,
    address: o.address,
    note: o.note,
    items: orderItems(o),
    amount_xof: o.amount_xof,
    is_test: o.is_test,
    scheduled_for: o.scheduled_for,
    payment_status: o.payment_status,
    payment_method: o.payment_method,
  };
}

/**
 * Send the kitchen ticket to ONE recipient. Kitchen staff are ~always outside
 * the 24h window, so we send the `ticket_cuisine` TEMPLATE first (with its
 * dynamic URL button = the magic-link token); if that template isn't configured
 * or errors, we fall back TEMPLATE-FIRST to the generic reception template.
 * This is intentional: Meta can accept out-of-window free text with HTTP 200
 * and reject it asynchronously, so a free-text-first fallback is not reliable.
 * The wamid is logged so the statuses webhook can catch an async failure.
 */
async function sendKitchenTo(
  phone: string,
  view: DeliveryOrderView,
  token: string,
  magicLink: string,
  tag: string,
  log: Log,
): Promise<"sent" | "sent_template" | "failed"> {
  const { subject, body } = kitchenMessage(view, magicLink);
  if (config.WA_KITCHEN_TICKET_TEMPLATE) {
    try {
      const wamid = await sendTemplateWithUrlButton(
        phone.replace(/\D/g, ""),
        config.WA_KITCHEN_TICKET_TEMPLATE,
        config.WA_KITCHEN_TICKET_TEMPLATE_LANG,
        kitchenTemplateParams(view),
        token,
      );
      await recordDeliveryLog(phone, `${tag} (ticket) ${body}`, "sent_template", null, wamid);
      return "sent_template";
    } catch (err) {
      log.error({ err, phone }, "Kitchen ticket template failed — falling back to generic template");
    }
  }
  try {
    const { path, waMessageId } = await sendWhatsAppNotificationDetailed(phone, subject, body, {
      preferTemplate: true,
    });
    await recordDeliveryLog(phone, `${tag} ${body}`, path, null, waMessageId);
    return path;
  } catch (err) {
    await recordDeliveryLog(phone, `${tag} ${body}`, "failed", String(err).slice(0, 300));
    log.error({ err, phone }, "Delivery kitchen send failed");
    return "failed";
  }
}

/**
 * Notify the kitchen for one order (already claimed by the caller). Sends to
 * every `bar` contact with a phone — or to reception with a warning if none
 * exists — and records the aggregate outcome. `token` is the current magic-link
 * token (created fresh, or rotated by the sweep, since the cleartext is never
 * stored).
 */
export async function notifyKitchenForOrder(
  order: DeliveryOrder,
  token: string,
  log: Log,
): Promise<void> {
  const tag = `[${order.is_test ? "TEST " : ""}livraison ${order.id.slice(0, 8)}]`;
  const view = viewOf(order);
  const magicLink = magicLinkUrl(config.BASE_URL, token);

  const reachable = (await listStaffContacts()).filter(
    (c) => normalizeName(c.role) === KITCHEN_ROLE && !c.muted && phoneDigits(c.phone).length >= 8,
  );
  // Shift gate: only ping the bar staff ON SHIFT right now per the PUBLISHED
  // staff planning (/admin/staff). No published planning (null) → no gating.
  // Re-evaluated at every attempt (create, sweep retry, manual « Renvoyer »).
  const slot = planningNowSlot(new Date());
  const onShift = await onShiftStaffIds(slot.weekday, slot.minute);
  const contacts = onShift === null ? reachable : reachable.filter((c) => onShift.has(c.id));
  // Dedup by phone (two contacts, same number).
  const seen = new Set<string>();
  const kitchen = contacts.filter((c) => {
    const d = phoneDigits(c.phone);
    if (seen.has(d)) return false;
    seen.add(d);
    return true;
  });

  if (kitchen.length === 0) {
    // Nobody to ping (no reachable bar contact, or none on shift): route the
    // ticket to reception AND the owner so it's never lost.
    const { subject, body } = kitchenMessage(view, magicLink);
    const reason =
      reachable.length > 0
        ? `Aucun contact « bar » en service en ce moment (planning /admin/staff)`
        : `Aucun contact « bar » joignable dans le répertoire (/admin/notifications)`;
    const warnBody = `⚠️ ${reason} — commande envoyée à la réception :\n\n${body}`;
    const recipients = [
      { phone: config.RECEPTION_PHONE, preferTemplate: true },
      { phone: config.OWNER_PHONE, preferTemplate: true }, // owner's 24h window is ~always closed
    ].filter(
      // Skip the owner leg if unset or same number as reception.
      (r, i) => i === 0 || (phoneDigits(r.phone).length >= 8 && phoneDigits(r.phone) !== phoneDigits(config.RECEPTION_PHONE)),
    );
    for (const r of recipients) {
      try {
        const { path, waMessageId } = await sendWhatsAppNotificationDetailed(r.phone, subject, warnBody, {
          preferTemplate: r.preferTemplate,
        });
        await recordDeliveryLog(r.phone, `${tag} ${warnBody}`, path, null, waMessageId);
      } catch (err) {
        await recordDeliveryLog(r.phone, `${tag} ${warnBody}`, "failed", String(err).slice(0, 300));
        log.error({ err, order: order.id, phone: r.phone }, "Delivery kitchen fallback send failed");
      }
    }
    await setKitchenNotifyOutcome(order.id, "fallback_reception", false);
    return;
  }

  const outcomes = await Promise.all(
    kitchen.map((c) => sendKitchenTo(c.phone, view, token, magicLink, tag, log)),
  );

  const status = aggregateKitchenOutcome(outcomes);
  const reached = outcomes.some((o) => o !== "failed");
  await setKitchenNotifyOutcome(order.id, status, reached);

  if (!reached) {
    // Every kitchen contact failed — escalate so someone acts.
    const { body } = kitchenMessage(view, magicLink);
    notifyReception(
      `${order.is_test ? "🧪 TEST — " : ""}⚠️ Cuisine NON notifiée — commande livraison`,
      `${order.is_test ? "Commande de test — exclue des statistiques.\n" : ""}` +
        `L'envoi à la cuisine a échoué pour la commande de ${order.client_name} (+${order.client_phone}).\n\n${body}`,
      { whatsappFirst: true, preferTemplate: true },
    );
  }
}

// Per-ping wiring: message body, the 131047 template fallback, and the outcome
// setter. Both pings share the generic livraison_update template (one Meta
// approval for both).
const CLIENT_PING: Record<
  ClientPingKind,
  {
    message: (lang: string | null, o: DeliveryOrderView) => string;
    template: () => string;
    templateLang: () => string;
    templateParams: (o: DeliveryOrderView) => string[];
    setOutcome: (
      id: string,
      status: "sent" | "sent_template" | "failed",
      waMessageId?: string | null,
    ) => Promise<void>;
    label: string;
  }
> = {
  created: {
    message: createdClientMessage,
    template: () => config.WA_DELIVERY_UPDATE_TEMPLATE,
    templateLang: () => config.WA_DELIVERY_UPDATE_TEMPLATE_LANG,
    templateParams: (o) => deliveryUpdateTemplateParams("created", o),
    setOutcome: setCreatedNotifyOutcome,
    label: "created-confirmation",
  },
  route: {
    message: routeClientMessage,
    template: () => config.WA_DELIVERY_UPDATE_TEMPLATE,
    templateLang: () => config.WA_DELIVERY_UPDATE_TEMPLATE_LANG,
    templateParams: (o) => deliveryUpdateTemplateParams("route", o),
    setOutcome: setRouteNotifyOutcome,
    label: "route-ping",
  },
  rescheduled: {
    message: rescheduledClientMessage,
    template: () => config.WA_DELIVERY_UPDATE_TEMPLATE,
    templateLang: () => config.WA_DELIVERY_UPDATE_TEMPLATE_LANG,
    templateParams: (o) => deliveryUpdateTemplateParams("rescheduled", o),
    setOutcome: setRescheduleNotifyOutcome,
    label: "reschedule-update",
  },
};

/**
 * Send one client-facing delivery ping (created / route). These orders are
 * entered by phone, so the client usually has NO open 24h Awa window: use the
 * approved Utility template first, with free text only as a degraded fallback.
 * Never throws — a `failed` status is what surfaces "📞 appeler le client" (or
 * a softer flag) on the board. Caller has already claimed the attempt.
 */
async function sendClientPing(
  order: DeliveryOrder,
  kind: ClientPingKind,
  log: Log,
): Promise<void> {
  const cfg = CLIENT_PING[kind];
  const tag = `[${order.is_test ? "TEST " : ""}livraison ${order.id.slice(0, 8)}]`;
  const view = viewOf(order);
  const client = await repo.upsertClient(order.client_phone);
  if (!client.name) {
    await repo.updateClientName(client.id, order.client_name).catch(() => {});
    client.name = order.client_name;
  }
  const lang = client.language ?? "fr";
  const msg = cfg.message(lang, view);
  const template = cfg.template();

  if (template) {
    try {
      const wamid = await sendTemplate(
        order.client_phone,
        template,
        cfg.templateLang(),
        cfg.templateParams(view),
      );
      await recordDeliveryLog(order.client_phone, `${tag} (template) ${msg}`, "sent_template", null, wamid);
      await cfg.setOutcome(order.id, "sent_template", wamid);
      return;
    } catch (err) {
      log.error({ err, order: order.id }, `Delivery ${cfg.label} template send failed — trying free-text`);
    }
  }

  try {
    const wamid = await sendText(order.client_phone, msg);
    await recordDeliveryLog(order.client_phone, `${tag} ${msg}`, "sent", null, wamid);
    await cfg.setOutcome(order.id, "sent", wamid);
  } catch (err) {
    await recordDeliveryLog(order.client_phone, `${tag} ${msg}`, "failed", String(err).slice(0, 300));
    await cfg.setOutcome(order.id, "failed");
    log.error({ err, order: order.id }, `Delivery ${cfg.label} send failed`);
  }
}

async function sendRecipientRoutePing(order: DeliveryOrder, log: Log): Promise<void> {
  if (!order.recipient_name || !order.recipient_phone) return;
  const view = viewOf(order);
  const msg = recipientRouteMessage(view);
  const tag = `[${order.is_test ? "TEST " : ""}livraison ${order.id.slice(0, 8)} contact-remise]`;
  if (config.WA_DELIVERY_UPDATE_TEMPLATE) {
    try {
      const wamid = await sendTemplate(
        order.recipient_phone,
        config.WA_DELIVERY_UPDATE_TEMPLATE,
        config.WA_DELIVERY_UPDATE_TEMPLATE_LANG,
        recipientRouteTemplateParams(view),
      );
      await recordDeliveryLog(
        order.recipient_phone,
        `${tag} (template) ${msg}`,
        "sent_template",
        null,
        wamid,
      );
      await setRecipientRouteNotifyOutcome(order.id, "sent_template", wamid);
      return;
    } catch (err) {
      log.error(
        { err, order: order.id },
        "Delivery recipient route template failed — trying free-text",
      );
    }
  }
  try {
    const wamid = await sendText(order.recipient_phone, msg);
    await recordDeliveryLog(order.recipient_phone, `${tag} ${msg}`, "sent", null, wamid);
    await setRecipientRouteNotifyOutcome(order.id, "sent", wamid);
  } catch (err) {
    await recordDeliveryLog(
      order.recipient_phone,
      `${tag} ${msg}`,
      "failed",
      String(err).slice(0, 300),
    );
    await setRecipientRouteNotifyOutcome(order.id, "failed");
    log.error({ err, order: order.id }, "Delivery recipient route send failed");
  }
}

/** Claim + attempt the creation-confirmation ping (create route + sweep entry). */
export async function attemptCreatedNotify(id: string, log: Log): Promise<void> {
  const order = await claimCreatedNotify(id);
  if (!order) return; // not claimable (already sent, capped, or in-flight)
  await sendClientPing(order, "created", log);
}

/** Claim + attempt the "out for delivery" ping (depart routes + sweep entry). */
export async function attemptRouteNotify(id: string, log: Log): Promise<void> {
  const order = await claimRouteNotify(id);
  if (order) await sendClientPing(order, "route", log);
  await attemptRecipientRouteNotify(id, log);
}

/** Claim + attempt only the optional handoff contact's departure alert. */
export async function attemptRecipientRouteNotify(id: string, log: Log): Promise<void> {
  const order = await claimRecipientRouteNotify(id);
  if (!order) return;
  await sendRecipientRoutePing(order, log);
}

/** Claim + attempt the client update after a promised-arrival change. */
export async function attemptRescheduleNotify(id: string, log: Log): Promise<void> {
  const order = await claimRescheduleNotify(id);
  if (!order) return;
  await sendClientPing(order, "rescheduled", log);
}

/** Durable one-shot reception reminder when a future order becomes active. */
export async function attemptActivationNotify(id: string, log: Log): Promise<void> {
  const order = await claimActivationNotify(id);
  if (!order) return;
  const arrival = order.scheduled_for
    ? formatDakarDateTime(order.scheduled_for, "fr")
    : "horaire prévu";
  const subject = `${order.is_test ? "🧪 TEST — " : ""}⏰ Livraison programmée à activer`;
  const body =
    `${order.is_test ? "Commande de test — exclue des statistiques.\n" : ""}` +
    `La cuisine doit préparer la commande de ${order.client_name} (+${order.client_phone}).\n` +
    (deliveryRecipientStaffLine(order) ? `${deliveryRecipientStaffLine(order)}\n` : "") +
    `Arrivée promise : ${arrival} (heure de Dakar)\n` +
    `Adresse : ${order.address}\n` +
    `Commande : ${orderItems(order).map((line) => `${line.qty}× ${line.name}`).join(" + ")}\n` +
    `Paiement : ${order.payment_status}.`;
  try {
    const { path, waMessageId } = await sendWhatsAppNotificationDetailed(
      config.RECEPTION_PHONE,
      subject,
      body,
      { preferTemplate: true },
    );
    await recordDeliveryLog(
      config.RECEPTION_PHONE,
      `[livraison ${order.id.slice(0, 8)} activation] ${body}`,
      path,
      null,
      waMessageId,
    );
    await setActivationNotifyOutcome(order.id, path, waMessageId);
  } catch (err) {
    await recordDeliveryLog(
      config.RECEPTION_PHONE,
      `[livraison ${order.id.slice(0, 8)} activation] ${body}`,
      "failed",
      String(err).slice(0, 300),
    );
    await setActivationNotifyOutcome(order.id, "failed");
    log.error({ err, order: order.id }, "Delivery activation reception reminder failed");
  }
}

/** Claim + attempt the kitchen notification for one order id, minting a fresh
 *  token (the cleartext is never stored, so a retry rotates it). Sweep entry. */
async function attemptKitchenNotify(id: string, log: Log): Promise<void> {
  const claimed = await claimKitchenNotifyWithFreshToken(id);
  if (!claimed) return;
  await notifyKitchenForOrder(claimed.order, claimed.token, log);
}

/**
 * 60s sweep: reconcile the durable deliveries (a crash between commit and send
 * doesn't lose them), then fire one-shot SLA alerts to reception. Returns how
 * many SLA alerts were sent (for the log line).
 */
export async function sweepDeliveries(log: Log): Promise<number> {
  // 0. Durable activation gate. Concurrent sweeps return disjoint rows.
  await activateDueScheduledDeliveries();
  // 1. Kitchen notifications still pending/failed (including newly activated).
  for (const id of await pendingKitchenNotifies()) {
    await attemptKitchenNotify(id, log).catch((err) =>
      log.error({ err, order: id }, "Delivery kitchen retry failed"),
    );
  }
  // 2. Reception reminders for newly activated scheduled orders.
  for (const id of await pendingActivationNotifies()) {
    await attemptActivationNotify(id, log).catch((err) =>
      log.error({ err, order: id }, "Delivery activation reminder retry failed"),
    );
  }
  // 3. Creation-confirmation pings still pending/failed.
  for (const id of await pendingCreatedNotifies()) {
    await attemptCreatedNotify(id, log).catch((err) =>
      log.error({ err, order: id }, "Delivery created-confirmation retry failed"),
    );
  }
  // 4. Reprogramming updates still pending/failed.
  for (const id of await pendingRescheduleNotifies()) {
    await attemptRescheduleNotify(id, log).catch((err) =>
      log.error({ err, order: id }, "Delivery reschedule-update retry failed"),
    );
  }
  // 5. "Out for delivery" pings still pending/failed.
  for (const id of await pendingRouteNotifies()) {
    await attemptRouteNotify(id, log).catch((err) =>
      log.error({ err, order: id }, "Delivery route retry failed"),
    );
  }
  // 5b. The handoff contact has an independent durable ping. Keeping the loops
  // separate means retrying this alert never repeats the client's message.
  for (const id of await pendingRecipientRouteNotifies()) {
    await attemptRecipientRouteNotify(id, log).catch((err) =>
      log.error({ err, order: id }, "Delivery recipient route retry failed"),
    );
  }
  // 6. SLA alerts (one-shot per order): never departed in time.
  const late = await claimDeliverySlaAlerts();
  for (const order of late) {
    const slaStartedAt = order.kitchen_notify_at ?? order.created_at;
    const elapsed = Math.round((Date.now() - new Date(slaStartedAt).getTime()) / 60000);
    notifyReception(
      `${order.is_test ? "🧪 TEST — " : ""}⏰ Commande livraison en retard (+${elapsed} min)`,
      `${order.is_test ? "Commande de test — exclue des statistiques.\n" : ""}` +
        `Pas partie en livraison après ${order.sla_minutes} min.\n` +
        `Client : ${order.client_name} (+${order.client_phone})\n` +
        (deliveryRecipientStaffLine(order) ? `${deliveryRecipientStaffLine(order)}\n` : "") +
        `Adresse : ${order.address}\n` +
        `Voir /admin/livraisons.`,
      { whatsappFirst: true, preferTemplate: true },
    );
  }
  return late.length;
}

/** Manual "🔁 Renvoyer à la cuisine": rotate the token and resend now. */
export async function renotifyKitchen(order: DeliveryOrder, log: Log): Promise<boolean> {
  const token = await rotateReadyToken(order.id);
  if (!token) return false; // not IN_KITCHEN anymore
  await notifyKitchenForOrder(order, token, log);
  return true;
}
