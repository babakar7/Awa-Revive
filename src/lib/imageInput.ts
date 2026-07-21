import Anthropic from "@anthropic-ai/sdk";
import { config } from "../config.js";
import { downloadWhatsAppMedia } from "./transcribe.js";

/**
 * Inbound image handling: download the image from Meta's media API, have the
 * model describe it (and transcribe any visible text), then the description is
 * injected into the conversation as a "[image reçue] …" user turn — the same
 * pattern as voice notes. Conversation history stays text-only.
 *
 * The typical client image is a Wave payment screenshot ("j'ai payé, regarde"):
 * the description extracts what is visible, but the prompt makes Awa treat it
 * as a CLAIM, never as proof — only the signed Wave webhook confirms a payment.
 */

// Timeout + retries so a hung describe-image call can't block the per-client
// message queue (same reasoning as the agent loop's client).
const anthropic = new Anthropic({
  apiKey: config.ANTHROPIC_API_KEY,
  timeout: 60_000,
  maxRetries: 2,
});

type ImageMediaType = "image/jpeg" | "image/png" | "image/gif" | "image/webp";

const SUPPORTED_MEDIA_TYPES: ImageMediaType[] = [
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
];

const DESCRIBE_PROMPT = `Cette image a été envoyée par un client sur le WhatsApp d'un studio de fitness/bien-être à Dakar (réservations de cours, paiements Wave, menu du bar). Décris-la en français, de façon factuelle et compacte (2 à 6 phrases) :
- retranscris TOUT le texte visible important (montants, dates, heures, noms, numéros de transaction, destinataires) ;
- si c'est une capture d'écran (paiement Wave, conversation, erreur), dis-le explicitement et détaille ce qu'elle montre ;
- si c'est une photo (lieu, document, personne, objet), décris ce qu'on voit de pertinent.
Réponds uniquement avec la description, sans préambule.`;

// Stickers are expressive, not informative (a 👍, a laughing character, a
// heart). We only need a few words so the admin can read WHAT was sent and the
// model can react naturally — not a paragraph.
const DESCRIBE_STICKER_PROMPT = `C'est un sticker WhatsApp envoyé par un client. Décris en français, en quelques mots seulement (max ~10), ce qu'il représente : l'emoji/personnage, l'émotion ou le geste (pouce levé, cœur, rire, applaudissements…) et tout texte visible. Réponds uniquement avec la description, sans préambule ni ponctuation finale.`;

/** Download one WhatsApp media item and describe it with the given prompt. */
async function describeMedia(mediaId: string, prompt: string, maxTokens: number): Promise<string> {
  const { data, mimeType } = await downloadWhatsAppMedia(mediaId);
  const mediaType = mimeType.split(";")[0].trim() as ImageMediaType;
  if (!SUPPORTED_MEDIA_TYPES.includes(mediaType)) {
    throw new Error(`unsupported image media type: ${mimeType}`);
  }

  const response = await anthropic.messages.create({
    model: config.CLAUDE_MODEL,
    max_tokens: maxTokens,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "image",
            source: { type: "base64", media_type: mediaType, data: data.toString("base64") },
          },
          { type: "text", text: prompt },
        ],
      },
    ],
  });

  const text = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
  if (!text) throw new Error("media description returned empty text");
  return text;
}

/**
 * Download one WhatsApp image and return a short French description of it
 * (visible text transcribed). Throws on any failure — the caller falls back
 * to the polite "can't read this" reply.
 */
export function describeWhatsAppImage(mediaId: string): Promise<string> {
  return describeMedia(mediaId, DESCRIBE_PROMPT, 500);
}

/**
 * Download one WhatsApp sticker (a WebP image) and return a few-word French
 * description of what it depicts — so the admin thread is readable and the
 * model can react to it naturally. Throws on any failure.
 */
export function describeWhatsAppSticker(mediaId: string): Promise<string> {
  return describeMedia(mediaId, DESCRIBE_STICKER_PROMPT, 60);
}

/**
 * Format the user turn injected into the conversation for one inbound image.
 * Kept as a pure function so it can be unit-tested.
 */
export function imageTurnText(description: string, caption?: string): string {
  const capt = (caption ?? "").trim();
  return capt ? `[image reçue] ${description}\n[légende du client] ${capt}` : `[image reçue] ${description}`;
}

/** User turn injected for one inbound sticker (kept pure for unit tests). */
export function stickerTurnText(description: string): string {
  return `[sticker reçu : ${description}]`;
}
