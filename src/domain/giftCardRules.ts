import { normalizeDeliveryPhone } from "./deliveryRules.js";

/**
 * Pure logic for gift cards ("cartes cadeaux"): admin-form parsing/validation.
 * No DB, no network. The visual is a marketing object — the offer text is free
 * (it is NOT tied to the Wix catalogue). Phone normalization is reused from
 * deliveryRules (empty → null allowed: a card may be downloaded, not sent).
 */

const MAX_OFFER = 60;
const MAX_NAME = 60;

export interface GiftCardFormData {
  offer_line1: string;
  offer_line2: string | null;
  recipient_name: string;
  from_name: string;
  send_phone: string | null;
}

function clean(v: unknown): string {
  return String(v ?? "").trim();
}

/** Validate + normalize the create form. */
export function parseGiftCardForm(
  body: Record<string, string>,
): { data: GiftCardFormData } | { error: string } {
  const offer_line1 = clean(body.offer_line1);
  if (!offer_line1) return { error: "l'intitulé de l'offre (ligne 1) est requis." };
  if (offer_line1.length > MAX_OFFER) return { error: "offre ligne 1 trop longue (max 60 caractères)." };

  const offer_line2raw = clean(body.offer_line2);
  if (offer_line2raw.length > MAX_OFFER) return { error: "offre ligne 2 trop longue (max 60 caractères)." };

  const recipient_name = clean(body.recipient_name);
  if (!recipient_name) return { error: "le destinataire (POUR) est requis." };
  if (recipient_name.length > MAX_NAME) return { error: "destinataire trop long (max 60 caractères)." };

  const from_name = clean(body.from_name);
  if (!from_name) return { error: "l'offreur (DE) est requis." };
  if (from_name.length > MAX_NAME) return { error: "offreur trop long (max 60 caractères)." };

  const phoneRaw = clean(body.send_phone);
  const send_phone = phoneRaw ? normalizeDeliveryPhone(phoneRaw) : null;
  if (phoneRaw && !send_phone) return { error: "numéro de téléphone invalide (laisse vide si aucun envoi)." };

  return {
    data: {
      offer_line1,
      offer_line2: offer_line2raw || null,
      recipient_name,
      from_name,
      send_phone,
    },
  };
}
