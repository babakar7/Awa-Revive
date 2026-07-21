import { config } from "../config.js";
import { sendText, sendTemplate, sendTemplateWithUrlButton } from "../lib/whatsapp.js";
import { notifyReception, sendWhatsAppNotification } from "../lib/notify.js";
import * as repo from "./repo.js";
import { normalizeName } from "./notificationRules.js";
import { listStaffContacts, phoneDigits, recordDeliveryLog } from "./notificationRepo.js";
import {
  aggregateKitchenOutcome,
  createdClientMessage,
  deliveryTemplateParams,
  deliveryUpdateTemplateParams,
  kitchenMessage,
  kitchenTemplateParams,
  magicLinkUrl,
  readyClientMessage,
  routeClientMessage,
  shouldFallbackDeliveryTemplate,
  type ClientPingKind,
  type DeliveryOrderView,
} from "./deliveryRules.js";
import {
  claimClientNotify,
  claimCreatedNotify,
  claimDeliveryPickupAlerts,
  claimDeliverySlaAlerts,
  claimKitchenNotify,
  claimRouteNotify,
  findDeliveryOrder,
  orderItems,
  pendingClientNotifies,
  pendingCreatedNotifies,
  pendingKitchenNotifies,
  pendingRouteNotifies,
  rotateReadyToken,
  setClientNotifyOutcome,
  setCreatedNotifyOutcome,
  setRouteNotifyOutcome,
  setKitchenNotifyOutcome,
  type DeliveryOrder,
} from "./deliveryRepo.js";

/**
 * WhatsApp effects for delivery orders + the 60-second reconciliation sweep.
 * Kitchen contacts are staff_contacts with the EXACT role `cuisine` (no fuzzy
 * match — a typo/bilingual role shouldn't silently opt a person in or out); if
 * none is configured the ticket falls back to reception with a warning. Every
 * send is journaled (source='delivery'). Notifications never throw to their
 * caller — a failed send flips a status the dashboard/sweep act on, it never
 * breaks the order.
 */

type Log = { info: (o: unknown, m?: string) => void; error: (o: unknown, m?: string) => void };

const KITCHEN_ROLE = "cuisine";

function viewOf(o: DeliveryOrder): DeliveryOrderView {
  return {
    client_name: o.client_name,
    client_phone: o.client_phone,
    address: o.address,
    note: o.note,
    items: orderItems(o),
    amount_xof: o.amount_xof,
  };
}

/**
 * Send the kitchen ticket to ONE recipient. Kitchen staff are ~always outside
 * the 24h window, so we send the `ticket_cuisine` TEMPLATE first (with its
 * dynamic URL button = the magic-link token); if that template isn't configured
 * or errors, we fall back to free-text (which itself falls back to the generic
 * reception template on 131047). The template wamid is logged so the statuses
 * webhook can catch an async failure.
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
      log.error({ err, phone }, "Kitchen ticket template failed — falling back to free-text");
    }
  }
  try {
    const path = await sendWhatsAppNotification(phone, subject, body);
    await recordDeliveryLog(phone, `${tag} ${body}`, path, null);
    return path;
  } catch (err) {
    await recordDeliveryLog(phone, `${tag} ${body}`, "failed", String(err).slice(0, 300));
    log.error({ err, phone }, "Delivery kitchen send failed");
    return "failed";
  }
}

/**
 * Notify the kitchen for one order (already claimed by the caller). Sends to
 * every `cuisine` contact — or to reception with a warning if none exists — and
 * records the aggregate outcome. `token` is the current magic-link token
 * (created fresh, or rotated by the sweep, since the cleartext is never stored).
 */
export async function notifyKitchenForOrder(
  order: DeliveryOrder,
  token: string,
  log: Log,
): Promise<void> {
  const tag = `[livraison ${order.id.slice(0, 8)}]`;
  const view = viewOf(order);
  const magicLink = magicLinkUrl(config.BASE_URL, token);

  const contacts = (await listStaffContacts()).filter(
    (c) => normalizeName(c.role) === KITCHEN_ROLE && !c.muted,
  );
  // Dedup by phone (two contacts, same number).
  const seen = new Set<string>();
  const kitchen = contacts.filter((c) => {
    const d = phoneDigits(c.phone);
    if (seen.has(d)) return false;
    seen.add(d);
    return true;
  });

  if (kitchen.length === 0) {
    // No kitchen contact: route the ticket to reception so it's never lost.
    const { subject, body } = kitchenMessage(view, magicLink);
    const warnBody =
      `⚠️ Aucun contact « cuisine » dans le répertoire (/admin/notifications) — ` +
      `commande envoyée à la réception :\n\n${body}`;
    try {
      const path = await sendWhatsAppNotification(config.RECEPTION_PHONE, subject, warnBody);
      await recordDeliveryLog(config.RECEPTION_PHONE, `${tag} ${warnBody}`, path, null);
    } catch (err) {
      await recordDeliveryLog(config.RECEPTION_PHONE, `${tag} ${warnBody}`, "failed", String(err).slice(0, 300));
      log.error({ err, order: order.id }, "Delivery kitchen fallback-to-reception send failed");
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
      "⚠️ Cuisine NON notifiée — commande livraison",
      `L'envoi à la cuisine a échoué pour la commande de ${order.client_name} (+${order.client_phone}).\n\n${body}`,
      { whatsappFirst: true },
    );
  }
}

// Per-ping wiring: message body, the 131047 template fallback, and the outcome
// setter. `ready` keeps the dedicated livraison_prete template; created/route
// share the generic livraison_update template (one Meta approval for both).
const CLIENT_PING: Record<
  ClientPingKind,
  {
    message: (lang: string | null, o: DeliveryOrderView) => string;
    template: string;
    templateLang: string;
    templateParams: (o: DeliveryOrderView) => string[];
    setOutcome: (id: string, status: "sent" | "sent_template" | "failed") => Promise<void>;
    label: string;
  }
> = {
  created: {
    message: createdClientMessage,
    template: config.WA_DELIVERY_UPDATE_TEMPLATE,
    templateLang: config.WA_DELIVERY_UPDATE_TEMPLATE_LANG,
    templateParams: (o) => deliveryUpdateTemplateParams("created", o),
    setOutcome: setCreatedNotifyOutcome,
    label: "created-confirmation",
  },
  ready: {
    message: readyClientMessage,
    template: config.WA_DELIVERY_READY_TEMPLATE,
    templateLang: config.WA_DELIVERY_READY_TEMPLATE_LANG,
    templateParams: deliveryTemplateParams,
    setOutcome: setClientNotifyOutcome,
    label: "ready-ping",
  },
  route: {
    message: routeClientMessage,
    template: config.WA_DELIVERY_UPDATE_TEMPLATE,
    templateLang: config.WA_DELIVERY_UPDATE_TEMPLATE_LANG,
    templateParams: (o) => deliveryUpdateTemplateParams("route", o),
    setOutcome: setRouteNotifyOutcome,
    label: "route-ping",
  },
};

/**
 * Send one client-facing delivery ping (created / ready / route): free-text
 * inside the 24h window, the Utility template on 131047. Never throws — a
 * `failed` status is what surfaces "📞 appeler le client" (or a softer flag) on
 * the board. Caller has already claimed the attempt.
 */
async function sendClientPing(
  order: DeliveryOrder,
  kind: ClientPingKind,
  log: Log,
): Promise<void> {
  const cfg = CLIENT_PING[kind];
  const tag = `[livraison ${order.id.slice(0, 8)}]`;
  const view = viewOf(order);
  const client = await repo.findClientByPhone([order.client_phone]).catch(() => null);
  const lang = client?.language ?? "fr";
  const msg = cfg.message(lang, view);

  try {
    const wamid = await sendText(order.client_phone, msg);
    await recordDeliveryLog(order.client_phone, `${tag} ${msg}`, "sent", null, wamid);
    await cfg.setOutcome(order.id, "sent");
    if (client) await repo.addTurn(client.id, "assistant", msg).catch(() => {});
    return;
  } catch (err) {
    if (shouldFallbackDeliveryTemplate(err, cfg.template)) {
      try {
        const wamid = await sendTemplate(
          order.client_phone,
          cfg.template,
          cfg.templateLang,
          cfg.templateParams(view),
        );
        await recordDeliveryLog(order.client_phone, `${tag} (template) ${msg}`, "sent_template", null, wamid);
        await cfg.setOutcome(order.id, "sent_template");
        if (client) await repo.addTurn(client.id, "assistant", msg).catch(() => {});
        return;
      } catch (err2) {
        await recordDeliveryLog(order.client_phone, `${tag} ${msg}`, "failed", String(err2).slice(0, 300));
        await cfg.setOutcome(order.id, "failed");
        log.error({ err: err2, order: order.id }, `Delivery ${cfg.label} template send failed`);
        return;
      }
    }
    await recordDeliveryLog(order.client_phone, `${tag} ${msg}`, "failed", String(err).slice(0, 300));
    await cfg.setOutcome(order.id, "failed");
    log.error({ err, order: order.id }, `Delivery ${cfg.label} send failed`);
  }
}

/** Claim + attempt the client ready-ping for one order id (route + sweep entry). */
export async function attemptClientNotify(id: string, log: Log): Promise<void> {
  const order = await claimClientNotify(id);
  if (!order) return; // not claimable (already sent, capped, or in-flight)
  await sendClientPing(order, "ready", log);
}

/** Claim + attempt the creation-confirmation ping (create route + sweep entry). */
export async function attemptCreatedNotify(id: string, log: Log): Promise<void> {
  const order = await claimCreatedNotify(id);
  if (!order) return;
  await sendClientPing(order, "created", log);
}

/** Claim + attempt the "out for delivery" ping (depart routes + sweep entry). */
export async function attemptRouteNotify(id: string, log: Log): Promise<void> {
  const order = await claimRouteNotify(id);
  if (!order) return;
  await sendClientPing(order, "route", log);
}

/** Claim + attempt the kitchen notification for one order id, minting a fresh
 *  token (the cleartext is never stored, so a retry rotates it). Sweep entry. */
async function attemptKitchenNotify(id: string, log: Log): Promise<void> {
  const order = await claimKitchenNotify(id);
  if (!order) return;
  const token = await rotateReadyToken(id);
  if (!token) return; // no longer IN_KITCHEN
  await notifyKitchenForOrder(order, token, log);
}

/**
 * 60s sweep: reconcile the three durable deliveries (a crash between commit and
 * send doesn't lose them), then fire one-shot SLA alerts to reception. Returns
 * how many SLA alerts were sent (for the log line).
 */
export async function sweepDeliveries(log: Log): Promise<number> {
  // 1. Kitchen notifications still pending/failed (e.g. crash right after create).
  for (const id of await pendingKitchenNotifies()) {
    await attemptKitchenNotify(id, log).catch((err) =>
      log.error({ err, order: id }, "Delivery kitchen retry failed"),
    );
  }
  // 2. Creation-confirmation pings still pending/failed.
  for (const id of await pendingCreatedNotifies()) {
    await attemptCreatedNotify(id, log).catch((err) =>
      log.error({ err, order: id }, "Delivery created-confirmation retry failed"),
    );
  }
  // 3. Client "ready" pings still pending/failed.
  for (const id of await pendingClientNotifies()) {
    await attemptClientNotify(id, log).catch((err) =>
      log.error({ err, order: id }, "Delivery client retry failed"),
    );
  }
  // 4. "Out for delivery" pings still pending/failed.
  for (const id of await pendingRouteNotifies()) {
    await attemptRouteNotify(id, log).catch((err) =>
      log.error({ err, order: id }, "Delivery route retry failed"),
    );
  }
  // 5. Prep SLA alerts (one-shot per order): never marked ready in time.
  const late = await claimDeliverySlaAlerts();
  for (const order of late) {
    const elapsed = Math.round((Date.now() - new Date(order.created_at).getTime()) / 60000);
    notifyReception(
      `⏰ Commande livraison en retard (+${elapsed} min)`,
      `Pas marquée « prête » après ${order.sla_minutes} min.\n` +
        `Client : ${order.client_name} (+${order.client_phone})\n` +
        `Adresse : ${order.address}\n` +
        `Voir /admin/livraisons.`,
      { whatsappFirst: true },
    );
  }
  // 6. Pickup SLA alerts (one-shot): ready but not departed within the window.
  const stuck = await claimDeliveryPickupAlerts(config.DELIVERY_PICKUP_SLA_MINUTES);
  for (const order of stuck) {
    const waiting = order.ready_at
      ? Math.round((Date.now() - new Date(order.ready_at).getTime()) / 60000)
      : config.DELIVERY_PICKUP_SLA_MINUTES;
    notifyReception(
      `⏱️ Commande prête non partie (+${waiting} min)`,
      `Prête depuis ${waiting} min et toujours pas partie en livraison.\n` +
        `Client : ${order.client_name} (+${order.client_phone})\n` +
        `Adresse : ${order.address}\n` +
        `Voir /admin/livraisons.`,
      { whatsappFirst: true },
    );
  }
  return late.length + stuck.length;
}

/** Manual "🔁 Renvoyer à la cuisine": rotate the token and resend now. */
export async function renotifyKitchen(order: DeliveryOrder, log: Log): Promise<boolean> {
  const token = await rotateReadyToken(order.id);
  if (!token) return false; // not IN_KITCHEN anymore
  await notifyKitchenForOrder(order, token, log);
  return true;
}
