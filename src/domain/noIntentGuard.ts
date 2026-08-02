import { applyFrenchRegister } from "../lib/frenchRegister.js";

export const NO_INTENT_THRESHOLD = 3;
export const NO_INTENT_WINDOW_HOURS = 24;

export type ConversationSignal = "revive_intent" | "no_intent" | "substantive";

const SYSTEM_PREFIX_RE = /^\[(?:note vocale|image reçue|sticker reçu)[^\]]*\]\s*/i;

function normalizedText(value: string): string {
  return value
    .replace(SYSTEM_PREFIX_RE, "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[’']/g, " ")
    .replace(/[^a-z0-9@:+?]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

/**
 * OpenAI can return the transcription prompt verbatim for silence/noise. That
 * text is metadata, never something the client actually said.
 */
export const TRANSCRIPTION_CONTEXT_PROMPT =
  "Message vocal WhatsApp d'un client d'un studio de sport et bien-être à Dakar, " +
  "principalement en français, parfois en wolof ou en anglais. Vocabulaire courant : " +
  "Pilates Reformer, Aquabike, Bébé Nageur, réservation, créneau, abonnement, Wave, Orange Money.";

const NORMALIZED_TRANSCRIPTION_PROMPT = normalizedText(TRANSCRIPTION_CONTEXT_PROMPT);

export function isTranscriptionPromptEcho(text: string): boolean {
  const normalized = normalizedText(text);
  if (!normalized) return false;
  return (
    normalized === NORMALIZED_TRANSCRIPTION_PROMPT ||
    (normalized.includes("message vocal whatsapp") &&
      normalized.includes("vocabulaire courant") &&
      normalized.includes("pilates reformer"))
  );
}

const REVIVE_INTENT_RE =
  /\b(?:revive|studio|cours|classe|class|session|seance|booking|book|reserv\w*|creneau|slot|planning|schedule|horaire|dispo\w*|abonnement|membership|pack|cle|plan|tarif|price|prix|payer|paiement|payment|wave|orange money|max ?it|facture|invoice|recu|receipt|annul\w*|cancel\w*|report\w*|deplac\w*|reschedul\w*|rembours\w*|refund\w*|attente|waitlist|coach|piscine|pool|menu|bar|smoothie|livraison|delivery|adresse|address|localisation|location|telephone|reception|compte|account|email|code|essai|essay\w*|tester|test|decouvr\w*|interess\w*|information|infos?|pilates|reformer|aqua\w*|yoga|natation|nageur|swim\w*|step|fitness|massage|enfant|bebe|baby)\b/;

const DATE_OR_TIME_RE =
  /\b(?:aujourd hui|demain|today|tomorrow|lundi|mardi|mercredi|jeudi|vendredi|samedi|dimanche|monday|tuesday|wednesday|thursday|friday|saturday|sunday|matin|midi|soir|morning|afternoon|evening|\d{1,2}(?::|h)\d{0,2}|\d{1,2}[/-]\d{1,2})\b/;

const PLEASANTRY_RE =
  /^(?:bonjour|bonsoir|salut|hello|hi|hey|coucou|salam|ca va|comment ca va|what s up|whats up|awesome|merci|merci beaucoup|thank you|thanks|jerejef|avec plaisir|de rien|a bientot|a la prochaine|bonne journee|bonne soiree|bye|goodbye|see you|ok|okay|d accord|moralement)$/;

/**
 * Conservative deterministic classifier. Only clearly low-information turns
 * increment the circuit breaker. Longer unrecognized questions are treated as
 * substantive so a nuanced real request is never muted by a keyword miss.
 */
export function classifyConversationSignal(text: string): ConversationSignal {
  if (/^\[(?:choix cliqu[eé]|choix écrit résolu|r[eé]action 👍)/i.test(text.trim())) {
    return "revive_intent";
  }
  if (/\b[^\s@]+@[^\s@]+\.[^\s@]+\b/.test(text) || /^\s*\d{6}\s*$/.test(text)) {
    return "revive_intent";
  }
  if (isTranscriptionPromptEcho(text)) return "no_intent";

  const normalized = normalizedText(text);
  if (!normalized || /transcription echouee|lecture echouee/.test(normalized)) {
    return "no_intent";
  }
  if (REVIVE_INTENT_RE.test(normalized) || DATE_OR_TIME_RE.test(normalized)) {
    return "revive_intent";
  }
  if (PLEASANTRY_RE.test(normalized)) return "no_intent";

  const words = normalized.split(" ").filter(Boolean);
  return words.length <= 4 ? "no_intent" : "substantive";
}

export function noIntentClosingMessage(
  language: string | null | undefined,
  formal = false,
): string {
  if (language === "en") {
    return "I’m Revive’s automated assistant, and I’m here for the studio, classes and bookings 🙏🏾 Have a lovely day!";
  }
  if (language === "wo") {
    return "Man Awa laa, ndimbal bu otomatik bu Revive. Maa ngi fii ngir studio bi, cours yi ak réservation yi 🙏🏾 Bëccëg bu neex!";
  }
  return applyFrenchRegister(
    "Je suis l’assistante automatisée de Revive et je reste disponible pour le studio, les cours et les réservations 🙏🏾 Belle journée !",
    formal,
  );
}
