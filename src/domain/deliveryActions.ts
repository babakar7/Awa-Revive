import { notifyReception } from "../lib/notify.js";
import * as delivery from "./deliveryRepo.js";
import { attemptActivationNotify, attemptRouteNotify, renotifyKitchen } from "./deliveryNotify.js";
import { cancelTicketForDelivery, completeTicketForDelivery, createDeliveryTicket } from "./kitchenTicketRepo.js";
import { config } from "../config.js";
import type { DeliveryLog } from "./deliveryCreate.js";

export type DeliveryActionResult = { ok: true } | { ok: false; code: 404 | 409; message: string };

async function currentOrNotFound(id: string): Promise<delivery.DeliveryOrder | null> {
  return delivery.findDeliveryOrder(id);
}

export async function depart(id: string, by: string, log: DeliveryLog): Promise<DeliveryActionResult> {
  const updated = await delivery.markOutForDelivery(id, by);
  if (updated) {
    await completeTicketForDelivery(id).catch((err) => log.error({ err, order: id }, "Ticket complete failed"));
    await attemptRouteNotify(id, log);
    return { ok: true };
  }
  const current = await currentOrNotFound(id);
  if (!current) return { ok: false, code: 404, message: "Commande introuvable." };
  return { ok: false, code: 409, message: current.status === "IN_KITCHEN" && !current.activated_at ? "Départ bloqué : cette livraison programmée n’est pas encore activée." : current.status === "IN_KITCHEN" && !delivery.deliveryMayDepart(current) ? "Départ bloqué : attendre le choix espèces ou la confirmation du paiement mobile." : "Commande déjà traitée — recharge le tableau." };
}

export async function deliver(id: string, by: string, log: DeliveryLog): Promise<DeliveryActionResult> {
  const updated = await delivery.markDelivered(id, by);
  if (updated) {
    await completeTicketForDelivery(id).catch((err) => log.error({ err, order: id }, "Ticket complete failed"));
    return { ok: true };
  }
  const current = await currentOrNotFound(id);
  if (!current) return { ok: false, code: 404, message: "Commande introuvable." };
  return { ok: false, code: 409, message: current.status === "IN_KITCHEN" && !current.activated_at ? "Livraison bloquée : la commande programmée n’est pas encore activée." : !delivery.deliveryMayDepart(current) ? "Livraison bloquée : paiement non choisi ou non confirmé." : "Commande déjà traitée." };
}

export async function cash(id: string, log: DeliveryLog): Promise<DeliveryActionResult> {
  const updated = await delivery.selectDeliveryCash(id);
  if (!updated) {
    const current = await currentOrNotFound(id);
    return current ? { ok: false, code: 409, message: "Paiement déjà traité." } : { ok: false, code: 404, message: "Commande introuvable." };
  }
  log.info({ order: id }, "Delivery cash selected");
  notifyReception(
    `${updated.is_test ? "🧪 TEST — " : ""}💵 Espèces choisies — livraison`,
    `Client : ${updated.client_name} (+${updated.client_phone})\n` +
      (updated.recipient_name && updated.recipient_phone
        ? `Contact remise : ${updated.recipient_name} (+${updated.recipient_phone})\n`
        : "") +
      `Montant à encaisser : ${updated.amount_xof} FCFA\n` +
      (updated.activated_at ? "Le départ est autorisé." : "Le départ sera autorisé à l’activation cuisine."),
    { whatsappFirst: true, preferTemplate: true },
  );
  return { ok: true };
}

export async function cancel(id: string, by: string, log: DeliveryLog): Promise<DeliveryActionResult> {
  const updated = await delivery.markCancelled(id, by);
  if (!updated) {
    const current = await currentOrNotFound(id);
    return current ? { ok: false, code: 409, message: "Commande déjà traitée." } : { ok: false, code: 404, message: "Commande introuvable." };
  }
  await cancelTicketForDelivery(id, "livraison annulée").catch((err) => log.error({ err, order: id }, "Ticket cancel failed"));
  if (updated.payment_status === "REFUND_NEEDED") notifyReception("💸 REMBOURSEMENT à faire — livraison annulée après paiement", `Client : ${updated.client_name} (+${updated.client_phone})\nMontant : ${updated.amount_xof} FCFA\nRéférence : ${updated.payment_ref ?? "?"}`, { whatsappFirst: true, preferTemplate: true });
  return { ok: true };
}

export async function activateNow(id: string, log: DeliveryLog): Promise<DeliveryActionResult> {
  const updated = await delivery.activateScheduledDeliveryNow(id);
  if (!updated) {
    const current = await currentOrNotFound(id);
    return current ? { ok: false, code: 409, message: "Alerte immédiate impossible : commande déjà activée ou traitée." } : { ok: false, code: 404, message: "Commande introuvable." };
  }
  await createDeliveryTicket(updated, config.OPS_KITCHEN_FALLBACK_SECONDS).catch((err) => log.error({ err, order: id }, "Kitchen ticket create failed after manual activation"));
  await attemptActivationNotify(id, log);
  return { ok: true };
}

export async function renotify(id: string, log: DeliveryLog): Promise<DeliveryActionResult> {
  const order = await currentOrNotFound(id);
  if (!order) return { ok: false, code: 404, message: "Commande introuvable." };
  return (await renotifyKitchen(order, log)) ? { ok: true } : { ok: false, code: 409, message: "Commande déjà partie ou clôturée." };
}
