import type { FastifyInstance, FastifyRequest } from "fastify";
import { config } from "../config.js";
import { verifyWhatsAppSignature, parseInboundMessages, sendText } from "../lib/whatsapp.js";
import {
  handleInboundText,
  handleUnsupportedMedia,
  handleFailedVoiceNote,
  handleFailedImage,
} from "../agent/index.js";
import { transcribeWhatsAppAudio, transcriptionEnabled } from "../lib/transcribe.js";
import { describeWhatsAppImage, imageTurnText } from "../lib/imageInput.js";
import { wasProcessed, markProcessed } from "../domain/repo.js";
import { allowMessage } from "../lib/rateLimit.js";
import { enqueue } from "../lib/serialize.js";

/** In-memory claim so concurrent Meta re-deliveries can't both process. */
const inFlightMessages = new Set<string>();

export function registerWhatsAppWebhook(app: FastifyInstance): void {
  // GET challenge handshake (SPEC §4.1)
  app.get("/webhooks/whatsapp", async (req, reply) => {
    const q = req.query as Record<string, string>;
    if (q["hub.mode"] === "subscribe" && q["hub.verify_token"] === config.WA_VERIFY_TOKEN) {
      return reply.code(200).send(q["hub.challenge"]);
    }
    return reply.code(403).send("Forbidden");
  });

  // Inbound messages
  app.post("/webhooks/whatsapp", async (req: FastifyRequest, reply) => {
    const rawBody = (req as any).rawBody as Buffer | undefined;
    const signature = req.headers["x-hub-signature-256"] as string | undefined;

    if (!rawBody || !verifyWhatsAppSignature(rawBody, signature, config.WA_APP_SECRET)) {
      req.log.warn({ signature }, "WhatsApp webhook: invalid signature");
      return reply.code(401).send("Invalid signature");
    }

    const messages = parseInboundMessages(req.body);

    for (const msg of messages) {
      const dedupeId = `wa:${msg.id}`;
      // Dedupe by WhatsApp message id — webhooks retry (SPEC §4.1). RETRIABLE
      // pattern: claim the id in-memory synchronously (before any await, so a
      // concurrent re-delivery can't slip through), read-only DB check, and
      // record it as processed only AFTER the message is fully handled (in the
      // enqueue task below). A crash mid-processing thus leaves the id
      // UNrecorded → Meta's retry reprocesses it instead of the message being
      // lost forever (the old mark-before pattern lost every message a crash
      // interrupted).
      if (inFlightMessages.has(msg.id)) {
        req.log.info({ id: msg.id }, "WhatsApp message already in flight, skipping");
        continue;
      }
      inFlightMessages.add(msg.id);
      if (await wasProcessed(dedupeId)) {
        inFlightMessages.delete(msg.id);
        req.log.info({ id: msg.id }, "Duplicate WhatsApp message, skipping");
        continue;
      }
      // Rate limit per phone (SPEC §9). Warn the client once per window so a
      // dropped burst isn't just silence, without spamming during a flood.
      const rate = allowMessage(msg.from);
      if (!rate.allowed) {
        inFlightMessages.delete(msg.id);
        req.log.warn({ from: msg.from }, "Rate limit exceeded, dropping message");
        if (rate.notifyThrottle) {
          void sendText(
            msg.from,
            "Tu m'écris un peu vite 😅 laisse-moi une minute puis réessaie 🙏🏾\n" +
              "(You're sending messages a bit fast — please wait a minute and try again.)",
          ).catch(() => {});
        }
        continue;
      }

      // Ack fast; process async, serialized per client. Mark processed only on
      // success; release the in-flight claim either way.
      enqueue(msg.from, async () => {
        try {
          if (msg.type === "text" && msg.text) {
            await handleInboundText({
              waPhone: msg.from,
              text: msg.text,
              waMessageId: msg.id,
              profileName: msg.profileName,
            });
          } else if (msg.type === "interactive" && msg.text) {
            // A tapped option is a user message like any other — formatted so
            // the model sees both the label and the exact option id.
            await handleInboundText({
              waPhone: msg.from,
              text: `[choix cliqué] ${msg.text}${msg.interactiveId ? ` (id: ${msg.interactiveId})` : ""}`,
              waMessageId: msg.id,
              profileName: msg.profileName,
            });
          } else if (msg.type === "audio" && msg.mediaId && transcriptionEnabled()) {
            // Voice note → transcribe, then treat as a normal user message.
            try {
              const transcript = await transcribeWhatsAppAudio(msg.mediaId);
              req.log.info({ from: msg.from, chars: transcript.length }, "Voice note transcribed");
              await handleInboundText({
                waPhone: msg.from,
                text: `[note vocale] ${transcript}`,
                waMessageId: msg.id,
                profileName: msg.profileName,
              });
            } catch (err) {
              req.log.error({ err, from: msg.from }, "Voice note transcription failed");
              await handleFailedVoiceNote(msg.from, msg.id);
            }
          } else if (msg.type === "image" && msg.mediaId) {
            // Image (often a Wave payment screenshot) → describe it with the
            // model, then treat the description as a normal user message. The
            // prompt makes Awa treat screenshots as claims, never as proof.
            try {
              const description = await describeWhatsAppImage(msg.mediaId);
              req.log.info({ from: msg.from, chars: description.length }, "Inbound image described");
              await handleInboundText({
                waPhone: msg.from,
                text: imageTurnText(description, msg.caption),
                waMessageId: msg.id,
                profileName: msg.profileName,
              });
            } catch (err) {
              req.log.error({ err, from: msg.from }, "Inbound image description failed");
              await handleFailedImage(msg.from, msg.id);
            }
          } else {
            await handleUnsupportedMedia(msg.from, msg.id);
          }
          // Success only: so a crash mid-handling leaves the id free for Meta retry.
          await markProcessed(dedupeId, "whatsapp");
        } catch (err) {
          req.log.error({ err, from: msg.from }, "Inbound message processing failed");
        } finally {
          inFlightMessages.delete(msg.id);
        }
      });
    }

    // Always 200 quickly so Meta doesn't retry-loop.
    return reply.code(200).send("OK");
  });
}
