import { config } from "../config.js";
import { sendText, sendTemplate } from "../lib/whatsapp.js";
import { notifyReception, sendWhatsAppNotification } from "../lib/notify.js";
import * as repo from "./repo.js";
import { normalizeName } from "./notificationRules.js";
import { listStaffContacts, phoneDigits, recordDeliveryLog } from "./notificationRepo.js";
import {
  aggregateKitchenOutcome,
  deliveryTemplateParams,
  kitchenMessage,
  magicLinkUrl,
  readyClientMessage,
  shouldFallbackDeliveryTemplate,
  type DeliveryOrderView,
} from "./deliveryRules.js";
import {
  claimClientNotify,
  claimDeliverySlaAlerts,
  claimKitchenNotify,
  findDeliveryOrder,
  orderItems,
  pendingClientNotifies,
  pendingKitchenNotifies,
  rotateReadyToken,
  setClientNotifyOutcome,
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
  const magicLink = magicLinkUrl(config.BASE_URL, order.id, token);
  const { subject, body } = kitchenMessage(view, magicLink);

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
    kitchen.map(async (c) => {
      try {
        const path = await sendWhatsAppNotification(c.phone, subject, body);
        await recordDeliveryLog(c.phone, `${tag} ${body}`, path, null);
        return path; // 'sent' | 'sent_template'
      } catch (err) {
        await recordDeliveryLog(c.phone, `${tag} ${body}`, "failed", String(err).slice(0, 300));
        log.error({ err, order: order.id, phone: c.phone }, "Delivery kitchen send failed");
        return "failed" as const;
      }
    }),
  );

  const status = aggregateKitchenOutcome(outcomes);
  const reached = outcomes.some((o) => o !== "failed");
  await setKitchenNotifyOutcome(order.id, status, reached);

  if (!reached) {
    // Every kitchen contact failed — escalate so someone acts.
    notifyReception(
      "⚠️ Cuisine NON notifiée — commande livraison",
      `L'envoi à la cuisine a échoué pour la commande de ${order.client_name} (+${order.client_phone}).\n\n${body}`,
      { whatsappFirst: true },
    );
  }
}

/**
 * Tell the client their order is ready (free-text inside the 24h window; the
 * FR Utility template on 131047). Never throws — a `failed`/`call_required`
 * status is what surfaces "📞 appeler le client" on the board. Caller has
 * already claimed the attempt.
 */
export async function notifyClientOrderReady(order: DeliveryOrder, log: Log): Promise<void> {
  const tag = `[livraison ${order.id.slice(0, 8)}]`;
  const view = viewOf(order);
  const client = await repo.findClientByPhone([order.client_phone]).catch(() => null);
  const lang = client?.language ?? "fr";
  const msg = readyClientMessage(lang, view);

  try {
    await sendText(order.client_phone, msg);
    await recordDeliveryLog(order.client_phone, `${tag} ${msg}`, "sent", null);
    await setClientNotifyOutcome(order.id, "sent");
    if (client) await repo.addTurn(client.id, "assistant", msg).catch(() => {});
    return;
  } catch (err) {
    if (shouldFallbackDeliveryTemplate(err, config.WA_DELIVERY_READY_TEMPLATE)) {
      try {
        await sendTemplate(
          order.client_phone,
          config.WA_DELIVERY_READY_TEMPLATE,
          config.WA_DELIVERY_READY_TEMPLATE_LANG,
          deliveryTemplateParams(view),
        );
        await recordDeliveryLog(order.client_phone, `${tag} (template) ${msg}`, "sent_template", null);
        await setClientNotifyOutcome(order.id, "sent_template");
        if (client) await repo.addTurn(client.id, "assistant", msg).catch(() => {});
        return;
      } catch (err2) {
        await recordDeliveryLog(order.client_phone, `${tag} ${msg}`, "failed", String(err2).slice(0, 300));
        await setClientNotifyOutcome(order.id, "failed");
        log.error({ err: err2, order: order.id }, "Delivery client template send failed");
        return;
      }
    }
    await recordDeliveryLog(order.client_phone, `${tag} ${msg}`, "failed", String(err).slice(0, 300));
    await setClientNotifyOutcome(order.id, "failed");
    log.error({ err, order: order.id }, "Delivery client ready-ping failed");
  }
}

/** Claim + attempt the client ready-ping for one order id (route + sweep entry). */
export async function attemptClientNotify(id: string, log: Log): Promise<void> {
  const order = await claimClientNotify(id);
  if (!order) return; // not claimable (already sent, capped, or in-flight)
  await notifyClientOrderReady(order, log);
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
  // 2. Client "ready" pings still pending/failed.
  for (const id of await pendingClientNotifies()) {
    await attemptClientNotify(id, log).catch((err) =>
      log.error({ err, order: id }, "Delivery client retry failed"),
    );
  }
  // 3. SLA alerts (one-shot per order).
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
  return late.length;
}

/** Manual "🔁 Renvoyer à la cuisine": rotate the token and resend now. */
export async function renotifyKitchen(order: DeliveryOrder, log: Log): Promise<boolean> {
  const token = await rotateReadyToken(order.id);
  if (!token) return false; // not IN_KITCHEN anymore
  await notifyKitchenForOrder(order, token, log);
  return true;
}
