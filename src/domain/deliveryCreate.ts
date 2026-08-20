import { config } from "../config.js";
import { computeExtras, formatExtrasOneLine, getCafeMenu, type CafeMenuItem, type ExtraLine } from "../lib/cafeMenu.js";
import { notifyReception } from "../lib/notify.js";
import {
  formatDakarDateTime,
  normalizeDeliveryPhone,
  parseDakarDateTime,
  parseDeliveryRecipientFields,
  parseKitchenLeadMinutes,
} from "./deliveryRules.js";
import * as delivery from "./deliveryRepo.js";
import { attemptActivationNotify, attemptCreatedNotify } from "./deliveryNotify.js";
import { createDeliveryTicket } from "./kitchenTicketRepo.js";

export type DeliveryLog = {
  info: (o: unknown, m?: string) => void;
  error: (o: unknown, m?: string) => void;
};

export interface DeliveryCreateInput {
  client_name: string;
  client_phone: string;
  address: string;
  note?: string | null;
  wix_contact_id?: string | null;
  recipient_name?: string | null;
  recipient_phone?: string | null;
  delivery_mode?: "now" | "scheduled" | string | null;
  scheduled_for?: string | null;
  kitchen_lead_minutes?: number | string | null;
  sla_minutes?: number | string | null;
  is_test?: boolean;
  client_request_id?: string | null;
  items: unknown;
}

export interface PreparedDelivery {
  client_name: string;
  client_phone: string;
  address: string;
  note: string | null;
  wix_contact_id: string | null;
  recipient_name: string | null;
  recipient_phone: string | null;
  items: ExtraLine[];
  amount_xof: number;
  sla_minutes: number;
  is_test: boolean;
  scheduled_for: Date | null;
  kitchen_notify_at: Date | null;
  kitchen_lead_minutes: number | null;
  client_request_id: string | null;
}

export type DeliveryCreateResult =
  | { ok: true; order: delivery.DeliveryOrder; created: boolean; done: "created" | "scheduled" | "created-kitchen-failed" | "replayed" }
  | { ok: false; field: string; message: string };

/** Pure normalization + pricing boundary shared by admin and device JSON routes. */
export function prepareDeliveryCreateInput(
  input: DeliveryCreateInput,
  menu: Map<string, CafeMenuItem>,
  now: Date,
): { ok: true; prepared: PreparedDelivery } | { ok: false; field: string; message: string } {
  const client_name = String(input.client_name ?? "").trim();
  if (!client_name) return { ok: false, field: "client_name", message: "Le nom du client est obligatoire." };
  const client_phone = normalizeDeliveryPhone(String(input.client_phone ?? ""));
  if (!client_phone) return { ok: false, field: "client_phone", message: "Le numéro de téléphone est invalide." };
  const address = String(input.address ?? "").trim();
  if (!address) return { ok: false, field: "address", message: "L’adresse de livraison est obligatoire." };
  const recipient = parseDeliveryRecipientFields(input);
  if ("error" in recipient) {
    return {
      ok: false,
      field: String(input.recipient_name ?? "").trim() ? "recipient_phone" : "recipient_name",
      message: recipient.error,
    };
  }
  const deliveryMode = input.delivery_mode === "scheduled" ? "scheduled" : "now";
  let scheduled_for: Date | null = null;
  let kitchen_notify_at: Date | null = null;
  let kitchen_lead_minutes: number | null = null;
  if (deliveryMode === "scheduled") {
    kitchen_lead_minutes = parseKitchenLeadMinutes(input);
    if (kitchen_lead_minutes === null) {
      return { ok: false, field: "kitchen_lead_minutes", message: "Le délai cuisine doit être compris entre 1 et 12 heures." };
    }
    scheduled_for = parseDakarDateTime(String(input.scheduled_for ?? ""));
    if (!scheduled_for) return { ok: false, field: "scheduled_for", message: "La date et l’heure d’arrivée sont invalides." };
    if (scheduled_for.getTime() <= now.getTime()) {
      return { ok: false, field: "scheduled_for", message: "L’heure d’arrivée doit être dans le futur." };
    }
    kitchen_notify_at = new Date(scheduled_for.getTime() - kitchen_lead_minutes * 60_000);
  }
  const priced = computeExtras(menu, input.items, { requireChoices: true });
  if (!priced.ok) return { ok: false, field: "articles", message: priced.message };
  const parsedSla = Number.parseInt(String(input.sla_minutes ?? "").trim(), 10);
  const sla_minutes = Number.isFinite(parsedSla) && parsedSla >= 5 && parsedSla <= 180
    ? parsedSla
    : config.DELIVERY_SLA_MINUTES;
  return {
    ok: true,
    prepared: {
      client_name,
      client_phone,
      address,
      note: String(input.note ?? "").trim().slice(0, 1_000) || null,
      wix_contact_id: String(input.wix_contact_id ?? "").trim().slice(0, 100) || null,
      recipient_name: recipient.recipientName,
      recipient_phone: recipient.recipientPhone,
      items: priced.lines,
      amount_xof: priced.totalXof,
      sla_minutes,
      is_test: input.is_test === true,
      scheduled_for,
      kitchen_notify_at,
      kitchen_lead_minutes,
      client_request_id: String(input.client_request_id ?? "").trim().slice(0, 80) || null,
    },
  };
}

function kitchenLeadLabel(minutes: number): string {
  const hours = minutes / 60;
  return `${hours} ${hours === 1 ? "heure" : "heures"} avant`;
}

export async function createDeliveryFromInput(
  input: DeliveryCreateInput,
  createdBy: string | null,
  log: DeliveryLog,
): Promise<DeliveryCreateResult> {
  const parsed = prepareDeliveryCreateInput(input, getCafeMenu().items, new Date());
  if (!parsed.ok) return parsed;
  const p = parsed.prepared;
  const result = await delivery.createDeliveryOrder({ ...p, created_by: createdBy });
  if (!result.created) return { ok: true, order: result.order, created: false, done: "replayed" };
  const order = result.order;
  log.info({ order: order.id, by: createdBy }, "Delivery order created");
  void attemptCreatedNotify(order.id, log);
  notifyReception(
    order.is_test
      ? "🧪 TEST — nouvelle commande livraison"
      : order.scheduled_for
        ? "🗓️ Nouvelle livraison programmée"
        : "🛵 Nouvelle commande livraison",
    `${order.is_test ? "🧪 COMMANDE DE TEST — exclue des statistiques.\n" : ""}` +
      `Client : ${order.client_name} (+${order.client_phone})\n` +
      (order.recipient_name && order.recipient_phone
        ? `Contact remise : ${order.recipient_name} (+${order.recipient_phone}) — à appeler par le livreur\n`
        : "") +
      `Commande : ${formatExtrasOneLine(p.items)}\nTotal : ${order.amount_xof} FCFA\n` +
      `Paiement : choix client en attente via Awa — départ bloqué\nAdresse : ${order.address}\n` +
      (order.scheduled_for
        ? `Arrivée promise : ${formatDakarDateTime(order.scheduled_for, "fr")} (heure de Dakar)\n` +
          `Alerte cuisine : ${formatDakarDateTime(order.kitchen_notify_at!, "fr")} (${kitchenLeadLabel(p.kitchen_lead_minutes!)} l’arrivée)\n`
        : "") +
      (order.note ? `Note : ${order.note}\n` : "") +
      "Suivi : /admin/livraisons",
    { whatsappFirst: true, preferTemplate: true },
  );
  let kitchenOk = false;
  if (order.activated_at) {
    const ticket = await createDeliveryTicket(order, config.OPS_KITCHEN_FALLBACK_SECONDS)
      .then((r) => r.ticket)
      .catch((error) => {
        log.error({ err: error, order: order.id }, "Kitchen ticket create failed");
        return null;
      });
    kitchenOk = !!ticket;
    if (order.scheduled_for) await attemptActivationNotify(order.id, log);
  }
  return {
    ok: true,
    order,
    created: true,
    done: order.scheduled_for && !order.activated_at ? "scheduled" : kitchenOk ? "created" : "created-kitchen-failed",
  };
}
