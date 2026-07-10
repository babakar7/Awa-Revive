import crypto from "node:crypto";
import { config } from "../config.js";

const GRAPH_BASE = "https://graph.facebook.com/v21.0";

// Cap each Cloud API call; a timeout is treated as a retriable error below.
const HTTP_TIMEOUT_MS = 15_000;

/**
 * Verify Meta's X-Hub-Signature-256 header: "sha256=" + HMAC-SHA256(app
 * secret, raw request body). Pure function (secret passed in) so it's unit
 * testable without env.
 */
export function verifyWhatsAppSignature(
  rawBody: Buffer | string,
  signatureHeader: string | undefined,
  appSecret: string,
): boolean {
  if (!signatureHeader || !signatureHeader.startsWith("sha256=")) return false;
  const expected = crypto.createHmac("sha256", appSecret).update(rawBody).digest("hex");
  const received = signatureHeader.slice("sha256=".length);
  if (received.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(received, "utf8"), Buffer.from(expected, "utf8"));
}

/** POST a message payload to the Cloud API with retries (429/5xx/network). */
async function postMessage(payload: Record<string, unknown>): Promise<void> {
  const url = `${GRAPH_BASE}/${config.WA_PHONE_NUMBER_ID}/messages`;
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${config.WA_ACCESS_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
      });
      if (res.ok) return;
      const text = await res.text();
      lastError = new Error(`WhatsApp send failed (${res.status}): ${text}`);
      // 4xx other than 429 won't succeed on retry
      if (res.status >= 400 && res.status < 500 && res.status !== 429) break;
    } catch (err) {
      lastError = err;
    }
    await new Promise((r) => setTimeout(r, attempt * 1000));
  }
  throw lastError;
}

/** Send a plain text message (Phase 1: text only, inside the 24h window). */
export async function sendText(to: string, body: string): Promise<void> {
  await postMessage({
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to,
    type: "text",
    text: { preview_url: true, body },
  });
}

/**
 * Send an approved template message. Works outside the 24h window (that's the
 * point). bodyParams fill {{1}}, {{2}}… in order; Meta rejects params that
 * contain newlines/tabs or 4+ consecutive spaces — sanitize before calling.
 */
export async function sendTemplate(
  to: string,
  name: string,
  languageCode: string,
  bodyParams: string[],
): Promise<void> {
  await postMessage({
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to,
    type: "template",
    template: {
      name,
      language: { code: languageCode },
      components: [
        {
          type: "body",
          parameters: bodyParams.map((text) => ({ type: "text", text })),
        },
      ],
    },
  });
}

// ---------- interactive messages (reply buttons / lists) ----------

export interface InteractiveOption {
  id: string;
  title: string;
  description?: string;
  /** Optional group header — rows sharing a section render under it in ONE list. */
  section?: string;
}

const truncate = (s: string, max: number) => (s.length <= max ? s : `${s.slice(0, max - 1)}…`);

/**
 * Build the Cloud API payload for a clickable choice message. Pure (unit
 * tested). Picks the native format for the option count:
 *  - ≤3 options, none with a description or section → reply buttons (tap directly);
 *  - otherwise → list message (a button opens up to 10 rows, optionally grouped
 *    into sections so several categories show at once without re-opening).
 * Meta hard limits are enforced by truncation (button title 20, row/section
 * title 24, row description 72, body 1024) and by rejecting >10 rows total
 * (WhatsApp caps a list at 10 rows across ALL sections combined).
 */
export function buildInteractivePayload(
  to: string,
  body: string,
  buttonLabel: string,
  options: InteractiveOption[],
): { kind: "buttons" | "list"; payload: Record<string, unknown> } {
  if (options.length === 0 || options.length > 10)
    throw new Error(`interactive message needs 1-10 options, got ${options.length}`);
  const ids = new Set(options.map((o) => o.id));
  if (ids.size !== options.length) throw new Error("interactive option ids must be unique");

  const base = {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to,
    type: "interactive",
  };

  if (options.length <= 3 && options.every((o) => !o.description && !o.section)) {
    return {
      kind: "buttons",
      payload: {
        ...base,
        interactive: {
          type: "button",
          body: { text: truncate(body, 1024) },
          action: {
            buttons: options.map((o) => ({
              type: "reply",
              reply: { id: o.id.slice(0, 200), title: truncate(o.title, 20) },
            })),
          },
        },
      },
    };
  }

  const row = (o: InteractiveOption) => ({
    id: o.id.slice(0, 200),
    title: truncate(o.title, 24),
    description: o.description ? truncate(o.description, 72) : undefined,
  });

  // Group rows by section, preserving first-seen order. When there are several
  // sections, WhatsApp requires each to carry a title (fallback "Autres").
  const order: string[] = [];
  const grouped = new Map<string, InteractiveOption[]>();
  for (const o of options) {
    const key = o.section ?? "";
    if (!grouped.has(key)) {
      grouped.set(key, []);
      order.push(key);
    }
    grouped.get(key)!.push(o);
  }
  const multi = order.length > 1;
  const sections = order.map((key) => ({
    ...(key || multi ? { title: truncate(key || "Autres", 24) } : {}),
    rows: grouped.get(key)!.map(row),
  }));

  return {
    kind: "list",
    payload: {
      ...base,
      interactive: {
        type: "list",
        body: { text: truncate(body, 1024) },
        action: { button: truncate(buttonLabel || "Choisir", 20), sections },
      },
    },
  };
}

/** Send a clickable choice message; returns which format was used. */
export async function sendInteractive(
  to: string,
  body: string,
  buttonLabel: string,
  options: InteractiveOption[],
): Promise<"buttons" | "list"> {
  const { kind, payload } = buildInteractivePayload(to, body, buttonLabel, options);
  await postMessage(payload);
  return kind;
}

/**
 * Mark an inbound message as read AND show the "typing…" indicator.
 * The indicator stays until we send a message (or ~25s max). Fire-and-forget:
 * failures here must never block the actual reply.
 */
export async function sendTypingIndicator(inboundMessageId: string): Promise<void> {
  try {
    const res = await fetch(`${GRAPH_BASE}/${config.WA_PHONE_NUMBER_ID}/messages`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.WA_ACCESS_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        status: "read",
        message_id: inboundMessageId,
        typing_indicator: { type: "text" },
      }),
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
    if (!res.ok) {
      console.warn(`[typing] Meta rejected typing indicator (${res.status}): ${await res.text()}`);
    }
  } catch (err) {
    console.warn("[typing] typing indicator failed:", err);
  }
}

export interface InboundMessage {
  from: string; // client phone (wa_id)
  id: string; // WhatsApp message id (dedupe key)
  type: string; // 'text' | 'interactive' | 'audio' | 'image' | 'sticker' | ...
  text?: string; // body text, or the clicked option's title for interactive replies
  interactiveId?: string; // clicked option id (list_reply / button_reply)
  mediaId?: string; // Meta media id for audio messages (voice notes)
  profileName?: string;
}

/**
 * Extract inbound messages from a webhook payload. Ignores statuses
 * (delivery receipts) and anything that isn't an individual message.
 */
export function parseInboundMessages(payload: any): InboundMessage[] {
  const out: InboundMessage[] = [];
  for (const entry of payload?.entry ?? []) {
    for (const change of entry?.changes ?? []) {
      const value = change?.value;
      if (change?.field !== "messages" || !value?.messages) continue;
      const contacts: any[] = value.contacts ?? [];
      for (const msg of value.messages) {
        if (!msg?.from || !msg?.id) continue;
        // Group/broadcast/status traffic is not delivered as individual
        // messages by the Cloud API, but guard anyway (SPEC §8).
        if (typeof msg.from !== "string") continue;
        const contact = contacts.find((c) => c?.wa_id === msg.from);
        // Interactive replies (client tapped a list row or a reply button).
        const reply =
          msg.type === "interactive"
            ? (msg.interactive?.list_reply ?? msg.interactive?.button_reply)
            : undefined;
        out.push({
          from: msg.from,
          id: msg.id,
          type: msg.type,
          text: msg.type === "text" ? msg.text?.body : reply?.title,
          interactiveId: reply?.id,
          mediaId: msg.type === "audio" ? msg.audio?.id : undefined,
          profileName: contact?.profile?.name,
        });
      }
    }
  }
  return out;
}
