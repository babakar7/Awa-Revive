import type { NotifyStatus, OpenDeliveryOrder } from "./deliveryRepo.js";

/**
 * Pure reception-board presentation logic. This module decides only how an
 * existing order should be shown; all state transitions remain in
 * deliveryRepo and keep their current SQL guards.
 */

export const DELIVERY_GROUP_ORDER = [
  "intervention",
  "preparing",
  "ready",
  "en_route",
  "scheduled",
] as const;

export type DeliveryGroup = (typeof DELIVERY_GROUP_ORDER)[number];
export type DeliveryUrgency = "late" | "soon" | "normal";
export type DeliveryPrimaryAction =
  | "resolve_payment"
  | "mark_departed"
  | "mark_delivered";

export interface DeliveryPresentation {
  order: OpenDeliveryOrder;
  group: DeliveryGroup;
  urgency: DeliveryUrgency;
  /** Exact operational explanation, shown prominently when work is blocked. */
  blockingReason: string | null;
  primaryAction: DeliveryPrimaryAction | null;
  /** Next meaningful operational deadline, used for urgency ordering. */
  dueAt: Date | null;
}

export type DeliveryGroups = Record<DeliveryGroup, DeliveryPresentation[]>;

const DUE_SOON_MS = 15 * 60_000;

function isSent(status: NotifyStatus): boolean {
  return status === "sent" || status === "sent_template";
}

function notificationIncident(order: OpenDeliveryOrder): string | null {
  if (
    order.status === "IN_KITCHEN" &&
    ["failed", "partial", "fallback_reception"].includes(order.kitchen_notify_status)
  ) {
    return order.kitchen_notify_status === "partial"
      ? "Ticket cuisine reçu par une partie de l’équipe seulement."
      : order.kitchen_notify_status === "fallback_reception"
        ? "Équipe bar injoignable : le ticket a été envoyé à la réception."
        : "Échec d’envoi du ticket cuisine : renvoi nécessaire.";
  }
  if (!isSent(order.created_notify_status) && order.created_notify_status === "failed") {
    return `Confirmation client échouée : appeler le +${order.client_phone}.`;
  }
  if (
    order.scheduled_for &&
    !order.activated_at &&
    order.reschedule_notify_status === "failed"
  ) {
    return `Nouvel horaire non reçu : appeler le +${order.client_phone}.`;
  }
  if (order.status === "OUT_FOR_DELIVERY" && order.route_notify_status === "failed") {
    return `Alerte de départ client échouée : appeler le +${order.client_phone}.`;
  }
  if (
    order.status === "OUT_FOR_DELIVERY" &&
    order.recipient_phone &&
    order.recipient_route_notify_status === "failed"
  ) {
    return `Alerte du contact de remise échouée : appeler le +${order.recipient_phone}.`;
  }
  if (
    order.scheduled_for &&
    order.activated_at &&
    order.activation_notify_status === "failed"
  ) {
    return "Rappel d’activation à la réception non envoyé.";
  }
  return null;
}

function paymentBlock(order: OpenDeliveryOrder): string | null {
  switch (order.payment_status) {
    case "REFUND_NEEDED":
      return `Remboursement de ${order.amount_xof} FCFA à traiter avant toute suite.`;
    case "PENDING_CHOICE":
      return "Moyen de paiement non choisi : le départ reste bloqué.";
    case "AWAITING_PAYMENT":
      return "Paiement mobile en attente de confirmation : le départ reste bloqué.";
    default:
      return null;
  }
}

function kitchenProjectionBlock(order: OpenDeliveryOrder): string | null {
  if (order.status !== "IN_KITCHEN" || !order.activated_at) return null;
  if (
    order.kitchen_ticket_status === "NEW" ||
    order.kitchen_ticket_status === "PREPARING" ||
    order.kitchen_ticket_status === "READY"
  ) {
    return null;
  }
  return "Ticket cuisine manquant : renvoyer la commande au bar.";
}

function operationalDueAt(order: OpenDeliveryOrder): Date | null {
  if (order.status === "OUT_FOR_DELIVERY") {
    return order.out_for_delivery_at ? new Date(order.out_for_delivery_at) : null;
  }
  if (!order.activated_at && order.scheduled_for) return new Date(order.scheduled_for);
  if (order.activated_at) {
    const start = new Date(order.kitchen_notify_at ?? order.activated_at ?? order.created_at);
    return new Date(start.getTime() + order.sla_minutes * 60_000);
  }
  return null;
}

function urgencyFor(
  order: OpenDeliveryOrder,
  dueAt: Date | null,
  now: Date,
): DeliveryUrgency {
  // No new transit SLA is invented here: en-route cards are ordered by age.
  if (order.status === "OUT_FOR_DELIVERY") return "normal";
  if (!dueAt) return "normal";
  const remaining = dueAt.getTime() - now.getTime();
  if (remaining <= 0) return "late";
  return remaining <= DUE_SOON_MS ? "soon" : "normal";
}

export function deriveDeliveryPresentation(
  order: OpenDeliveryOrder,
  now: Date = new Date(),
): DeliveryPresentation {
  const paymentReason = paymentBlock(order);
  const notificationReason = notificationIncident(order);
  const ticketReason = kitchenProjectionBlock(order);
  const blockingReason = paymentReason ?? notificationReason ?? ticketReason;

  let group: DeliveryGroup;
  if (blockingReason) group = "intervention";
  else if (order.status === "OUT_FOR_DELIVERY") group = "en_route";
  else if (order.scheduled_for && !order.activated_at) group = "scheduled";
  else if (order.kitchen_ticket_status === "READY") group = "ready";
  else group = "preparing";

  let primaryAction: DeliveryPrimaryAction | null = null;
  if (
    order.payment_status === "PENDING_CHOICE" ||
    order.payment_status === "AWAITING_PAYMENT"
  ) {
    primaryAction = "resolve_payment";
  } else if (order.status === "OUT_FOR_DELIVERY") {
    primaryAction = "mark_delivered";
  } else if (
    order.status === "IN_KITCHEN" &&
    order.activated_at &&
    order.kitchen_ticket_status === "READY" &&
    (order.payment_status === "CASH_DUE" || order.payment_status === "PAID") &&
    !notificationReason &&
    !ticketReason
  ) {
    primaryAction = "mark_departed";
  }

  const dueAt = operationalDueAt(order);
  return {
    order,
    group,
    urgency: urgencyFor(order, dueAt, now),
    blockingReason,
    primaryAction,
    dueAt,
  };
}

function urgencyRank(urgency: DeliveryUrgency): number {
  return urgency === "late" ? 0 : urgency === "soon" ? 1 : 2;
}

export function sortDeliveryPresentations(
  items: DeliveryPresentation[],
): DeliveryPresentation[] {
  return [...items].sort((a, b) => {
    const urgency = urgencyRank(a.urgency) - urgencyRank(b.urgency);
    if (urgency) return urgency;
    const aDue = a.dueAt?.getTime() ?? Number.POSITIVE_INFINITY;
    const bDue = b.dueAt?.getTime() ?? Number.POSITIVE_INFINITY;
    if (aDue !== bDue) return aDue - bDue;
    return (
      new Date(a.order.created_at).getTime() -
      new Date(b.order.created_at).getTime()
    );
  });
}

export function groupDeliveryOrders(
  orders: OpenDeliveryOrder[],
  now: Date = new Date(),
): DeliveryGroups {
  const groups: DeliveryGroups = {
    intervention: [],
    preparing: [],
    ready: [],
    en_route: [],
    scheduled: [],
  };
  for (const order of orders) {
    const presented = deriveDeliveryPresentation(order, now);
    groups[presented.group].push(presented);
  }
  for (const group of DELIVERY_GROUP_ORDER) {
    groups[group] = sortDeliveryPresentations(groups[group]);
  }
  return groups;
}
