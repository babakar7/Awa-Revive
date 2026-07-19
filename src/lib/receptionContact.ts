const MAX_CLIENT_NAME_LENGTH = 80;
const MAX_HANDOFF_REASON_LENGTH = 180;

function cleanInlineText(value: unknown, maxLength: number): string {
  return String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength)
    .trim();
}

/** Build WhatsApp's official click-to-chat URL with a prefilled message. */
export function whatsappClickToChatUrl(phone: string, message: string): string {
  const digits = phone.replace(/\D/g, "");
  if (!digits) throw new Error("WhatsApp click-to-chat phone has no digits");

  const text = cleanInlineText(message, 500);
  if (!text) throw new Error("WhatsApp click-to-chat message is empty");

  return `https://wa.me/${digits}?text=${encodeURIComponent(text)}`;
}

/**
 * Keep reception handoffs short, useful and safe to place in a URL. The reason
 * must be operational rather than a transcript: no internal ids, amounts or
 * sensitive medical detail.
 */
export function receptionHandoffMessage(clientName: unknown, reason: unknown): string {
  const name = cleanInlineText(clientName, MAX_CLIENT_NAME_LENGTH);
  const reasonWithoutTrailingPunctuation = cleanInlineText(
    reason,
    MAX_HANDOFF_REASON_LENGTH,
  ).replace(/[.!?…]+$/, "");
  let cleanReason = reasonWithoutTrailingPunctuation
    .replace(/^(?:le|la) client(?:e)? souhaite\s+/i, "Je souhaite ")
    .replace(/^(?:le|la) client(?:e)? (?:veut|voudrait)\s+/i, "Je souhaite ")
    .replace(/^(?:le|la) client(?:e)? demande(?: à| de)?\s+/i, "Je souhaite ")
    .replace(/^souhaite\s+/i, "Je souhaite ")
    .replace(/^(?:veut|voudrait)\s+/i, "Je souhaite ")
    .replace(
      /parler directement à la réception/gi,
      "parler directement à quelqu'un de l'équipe Revive",
    )
    .replace(/(?:contacter|joindre) la réception/gi, "contacter l'équipe Revive");
  if (!cleanReason) cleanReason = "J'ai besoin de votre aide";

  const isFirstPerson = /^(?:je\b|j['’]|mon\b|ma\b|mes\b|nous\b|notre\b|nos\b)/i.test(
    cleanReason,
  );
  const request = isFirstPerson ? cleanReason : `Ma demande concerne : ${cleanReason}`;
  const intro = name ? `Bonjour, je suis ${name}.` : "Bonjour.";
  return `${intro} Awa m'a conseillé de vous écrire. ${request}.`;
}

export function receptionWhatsAppLink(
  phone: string,
  clientName: unknown,
  reason: unknown,
): { url: string; message: string } {
  const message = receptionHandoffMessage(clientName, reason);
  return { url: whatsappClickToChatUrl(phone, message), message };
}

/**
 * Reception-voice greeting to send TO the client, so reception can reach out in
 * one tap after a handoff (the client no longer sends anything). Kept generic
 * and editable: the detailed reason lives in the reception notification body,
 * not echoed here (the reason is phrased in the client's first person).
 */
export function clientOutreachMessage(clientName: unknown): string {
  const name = cleanInlineText(clientName, MAX_CLIENT_NAME_LENGTH);
  const hello = name ? `Bonjour ${name} 🙏🏾` : "Bonjour 🙏🏾";
  return `${hello} C'est la réception de Revive. Awa m'a transmis votre demande, je reviens vers vous.`;
}

/** wa.me link reception taps to write to the client (prefilled greeting). */
export function clientOutreachLink(
  clientPhone: string,
  clientName: unknown,
): { url: string; message: string } {
  const message = clientOutreachMessage(clientName);
  return { url: whatsappClickToChatUrl(clientPhone, message), message };
}

/** Client-facing instruction; the final tap on Send is mandatory in WhatsApp. */
export function receptionLinkInstruction(lang: string, url: string): string {
  switch (lang) {
    case "en":
      return (
        `Message reception directly here:\n${url}\n` +
        "The message is already filled in: open the link, then tap Send."
      );
    case "wo":
      return (
        `Bindal réception bi fii:\n${url}\n` +
        "Message bi pare na: ubbi lien bi, nga bës Envoyer."
      );
    default:
      return (
        `Écris directement à la réception ici :\n${url}\n` +
        "Le message est déjà préparé : ouvre le lien puis appuie sur Envoyer."
      );
  }
}
