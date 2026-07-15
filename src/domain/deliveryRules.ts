import crypto from "node:crypto";
import {
  type ExtraLine,
  formatExtrasMultiline,
  formatExtrasOneLine,
} from "../lib/cafeMenu.js";
import { toTemplateParam } from "../lib/notify.js";

/**
 * Pure logic for bar delivery orders: status transitions, phone normalization,
 * magic-link token (create/hash/verify), form-quantity parsing, and the WhatsApp
 * message bodies. No DB, no network — everything here is unit-testable, and the
 * server (not the model) owns every decision (prices come from computeExtras
 * upstream; this file never sees the menu). SQL lives in deliveryRepo, WhatsApp
 * effects in deliveryNotify.
 */

export type DeliveryStatus = "IN_KITCHEN" | "READY" | "DELIVERED" | "CANCELLED";

const TRANSITIONS: Record<DeliveryStatus, DeliveryStatus[]> = {
  IN_KITCHEN: ["READY", "CANCELLED"],
  READY: ["DELIVERED", "CANCELLED"], // cancel-after-ready allowed (order aborted en route)
  DELIVERED: [],
  CANCELLED: [],
};

export function canTransition(from: DeliveryStatus, to: DeliveryStatus): boolean {
  return TRANSITIONS[from]?.includes(to) ?? false;
}

/** The minimal shape the message builders need (row ∪ {items} satisfies it). */
export interface DeliveryOrderView {
  client_name: string;
  client_phone: string;
  address: string;
  note: string | null;
  items: ExtraLine[];
  amount_xof: number;
}

/**
 * Normalize a phone into wa_id digits (no '+'), or null if it can't be a mobile
 * WhatsApp number. Handles `00`/`+` international prefixes and the local
 * Senegalese entry `77xxxxxxx` (9 digits starting with 7) → prefixed with 221.
 * A landline or too-short number returns null so we never store an un-WhatsApp-able
 * number that would silently fail every notify.
 */
export function normalizeDeliveryPhone(raw: string): string | null {
  let d = String(raw ?? "").replace(/\D/g, "");
  if (d.startsWith("00")) d = d.slice(2); // 00221… → 221…
  if (d.length === 9 && d.startsWith("7")) d = `221${d}`; // 77xxxxxxx → 22177xxxxxxx
  if (d.length < 10 || d.length > 15) return null;
  return d;
}

// ---------- magic-link token ----------

/** 128-bit token, only ever known in cleartext at creation time (never stored). */
export function newReadyToken(): string {
  return crypto.randomBytes(16).toString("hex");
}

export function hashReadyToken(token: string): string {
  return crypto.createHash("sha256").update(String(token)).digest("hex");
}

/** Constant-time, length-safe compare of a candidate token against the stored hash. */
export function verifyReadyToken(candidate: string, storedHash: string): boolean {
  const a = crypto.createHash("sha256").update(String(candidate)).digest();
  let b: Buffer;
  try {
    b = Buffer.from(String(storedHash), "hex");
  } catch {
    return false;
  }
  return b.length === a.length && crypto.timingSafeEqual(a, b);
}

export function magicLinkUrl(baseUrl: string, token: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/livraison/${token}`;
}

// ---------- admin form parsing ----------

/**
 * Collect the `qty_<ID>` fields of the create form into computeExtras entries.
 * Only quantities ≥ 1 are kept (zeros are the untouched default for every menu
 * row); an empty basket is rejected here, BEFORE computeExtras (which also
 * rejects unknown ids / qty > 10). Pure.
 */
export function parseDeliveryQtyFields(
  body: Record<string, string>,
): { entries: { item_id: string; qty: number }[] } | { error: string } {
  const entries: { item_id: string; qty: number }[] = [];
  for (const [key, val] of Object.entries(body)) {
    if (!key.startsWith("qty_")) continue;
    const qty = parseInt(String(val ?? "").trim(), 10);
    if (!Number.isFinite(qty) || qty <= 0) continue;
    entries.push({ item_id: key.slice(4), qty });
  }
  if (entries.length === 0) return { error: "sélectionne au moins un article." };
  return { entries };
}

// ---------- WhatsApp message bodies ----------

function firstName(name: string): string {
  return String(name ?? "").trim().split(/\s+/)[0] ?? "";
}

/** Kitchen ticket: contents, address, amount, and the one-tap "mark ready" link. */
export function kitchenMessage(
  o: DeliveryOrderView,
  magicLink: string,
): { subject: string; body: string } {
  const lines = [
    `Client : ${o.client_name} (+${o.client_phone})`,
    `Adresse : ${o.address}`,
    "",
    formatExtrasMultiline(o.items),
    `Total : ${o.amount_xof} FCFA (à encaisser à la livraison)`,
  ];
  if (o.note) lines.push(`Note : ${o.note}`);
  lines.push("", `✅ Quand c'est prêt, touchez ici : ${magicLink}`);
  return { subject: "🛵 Nouvelle commande livraison", body: lines.join("\n") };
}

/** Client "your order is ready" free-text (localized; template fallback is FR-only). */
export function readyClientMessage(lang: string | null, o: DeliveryOrderView): string {
  const first = firstName(o.client_name);
  const summary = formatExtrasOneLine(o.items);
  if (lang === "en") {
    return (
      `🛵 Good news${first ? ` ${first}` : ""}! Your Revive order is ready and on its way: ` +
      `${summary} — ${o.amount_xof} FCFA to pay on delivery. See you soon!`
    );
  }
  return (
    `🛵 Bonne nouvelle${first ? ` ${first}` : ""} ! Votre commande Revive est prête et va partir ` +
    `en livraison : ${summary} — ${o.amount_xof} FCFA à régler à la livraison. À tout de suite !`
  );
}

/** Should we try the Utility template after a free-text 131047 (window closed)? Pure. */
export function shouldFallbackDeliveryTemplate(err: unknown, templateName: string): boolean {
  return !!templateName && String(err).includes("131047");
}

/** Client template body params: {{1}} first name, {{2}} order summary + amount. */
export function deliveryTemplateParams(o: DeliveryOrderView): [string, string] {
  return [
    toTemplateParam(firstName(o.client_name) || o.client_name || "client", 60),
    toTemplateParam(`${formatExtrasOneLine(o.items)} — ${o.amount_xof} FCFA`, 200),
  ];
}

/**
 * Kitchen ticket template body params: {{1}} client name, {{2}} phone,
 * {{3}} address, {{4}} items one-line, {{5}} total. The URL button's own {{1}}
 * (the token) is passed separately by the sender.
 */
export function kitchenTemplateParams(
  o: DeliveryOrderView,
): [string, string, string, string, string] {
  return [
    toTemplateParam(o.client_name, 60),
    toTemplateParam(`+${o.client_phone}`, 20),
    toTemplateParam(o.address, 90),
    toTemplateParam(formatExtrasOneLine(o.items), 200),
    toTemplateParam(String(o.amount_xof), 12),
  ];
}

/**
 * Fold several kitchen-recipient outcomes into one status. `partial` = at least
 * one landed and at least one failed; distinguishing it from a clean `sent`
 * keeps the dashboard honest when the kitchen has multiple contacts.
 */
export function aggregateKitchenOutcome(
  results: ("sent" | "sent_template" | "failed")[],
): "sent" | "sent_template" | "partial" | "failed" {
  if (results.length === 0) return "failed";
  const ok = results.filter((r) => r !== "failed");
  if (ok.length === 0) return "failed";
  if (ok.length < results.length) return "partial";
  return ok.every((r) => r === "sent") ? "sent" : "sent_template";
}
