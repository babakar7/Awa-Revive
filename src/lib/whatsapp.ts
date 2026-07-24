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

/** POST a message payload to the Cloud API with retries (429/5xx/network).
 *  Returns the Meta message id (wamid) so callers can log it — the `statuses`
 *  webhook later maps an async failure back to that id. */
async function postMessage(payload: Record<string, unknown>): Promise<string | null> {
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
      if (res.ok) {
        const data: any = await res.json().catch(() => null);
        return data?.messages?.[0]?.id ?? null;
      }
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

/** Send a plain text message (inside the 24h window). Returns the wamid. */
export async function sendText(to: string, body: string): Promise<string | null> {
  return postMessage({
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
): Promise<string | null> {
  return postMessage({
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

/**
 * Send a template that has a DYNAMIC URL button (the first — index "0" — button
 * component). `urlButtonParam` fills the {{1}} suffix of the button's URL (e.g.
 * the magic-link token). Body params fill {{1}}, {{2}}… as usual. Returns wamid.
 */
export async function sendTemplateWithUrlButton(
  to: string,
  name: string,
  languageCode: string,
  bodyParams: string[],
  urlButtonParam: string,
): Promise<string | null> {
  return postMessage({
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to,
    type: "template",
    template: {
      name,
      language: { code: languageCode },
      components: [
        { type: "body", parameters: bodyParams.map((text) => ({ type: "text", text })) },
        {
          type: "button",
          sub_type: "url",
          index: "0",
          parameters: [{ type: "text", text: urlButtonParam }],
        },
      ],
    },
  });
}

/**
 * Send an image: upload the PNG to Meta's media endpoint, then send it by
 * media id (no public URL to host or protect). Throws on failure — callers
 * are expected to fall back to a text version.
 */
export async function sendImage(to: string, png: Buffer, caption?: string): Promise<string | null> {
  const form = new FormData();
  form.append("messaging_product", "whatsapp");
  form.append("file", new Blob([new Uint8Array(png)], { type: "image/png" }), "planning.png");
  const res = await fetch(`${GRAPH_BASE}/${config.WA_PHONE_NUMBER_ID}/media`, {
    method: "POST",
    headers: { Authorization: `Bearer ${config.WA_ACCESS_TOKEN}` },
    body: form,
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`WhatsApp media upload failed (${res.status}): ${await res.text()}`);
  }
  const mediaId = ((await res.json()) as { id?: string })?.id;
  if (!mediaId) throw new Error("WhatsApp media upload returned no id");
  return postMessage({
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to,
    type: "image",
    image: { id: mediaId, ...(caption ? { caption: caption.slice(0, 1024) } : {}) },
  });
}

/**
 * Send a PDF as a WhatsApp DOCUMENT: upload to Meta's media endpoint, then send
 * by media id with a filename (what the client sees). Same contract as
 * sendImage — throws on failure, returns the wamid.
 */
export async function sendDocument(
  to: string,
  pdf: Buffer,
  filename: string,
  caption?: string,
): Promise<string | null> {
  const form = new FormData();
  form.append("messaging_product", "whatsapp");
  form.append("file", new Blob([new Uint8Array(pdf)], { type: "application/pdf" }), filename);
  const res = await fetch(`${GRAPH_BASE}/${config.WA_PHONE_NUMBER_ID}/media`, {
    method: "POST",
    headers: { Authorization: `Bearer ${config.WA_ACCESS_TOKEN}` },
    body: form,
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`WhatsApp media upload failed (${res.status}): ${await res.text()}`);
  }
  const mediaId = ((await res.json()) as { id?: string })?.id;
  if (!mediaId) throw new Error("WhatsApp media upload returned no id");
  return postMessage({
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to,
    type: "document",
    document: {
      id: mediaId,
      filename,
      ...(caption ? { caption: caption.slice(0, 1024) } : {}),
    },
  });
}

// ---------- WhatsApp Business profile (about/address/description/photo) ----------

export interface BusinessProfile {
  about?: string;
  address?: string;
  description?: string;
  email?: string;
  websites?: string[];
  profile_picture_url?: string;
}

const PROFILE_FIELDS = "about,address,description,email,websites,profile_picture_url";

/** Fetch the current WhatsApp Business profile (used to prefill the admin form). */
export async function getBusinessProfile(): Promise<BusinessProfile> {
  const res = await fetch(
    `${GRAPH_BASE}/${config.WA_PHONE_NUMBER_ID}/whatsapp_business_profile?fields=${PROFILE_FIELDS}`,
    {
      headers: { Authorization: `Bearer ${config.WA_ACCESS_TOKEN}` },
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    },
  );
  if (!res.ok) {
    throw new Error(`WhatsApp business profile fetch failed (${res.status}): ${await res.text()}`);
  }
  const body = (await res.json()) as { data?: BusinessProfile[] };
  return body.data?.[0] ?? {};
}

/**
 * Update the WhatsApp Business profile. Only the fields passed in are sent —
 * Meta leaves anything omitted untouched. `about` (≤139 chars) and
 * `description` (≤512 chars) limits are Meta's; validate before calling.
 */
export async function updateBusinessProfile(fields: {
  about?: string;
  address?: string;
  description?: string;
  email?: string;
  profile_picture_handle?: string;
}): Promise<void> {
  const res = await fetch(`${GRAPH_BASE}/${config.WA_PHONE_NUMBER_ID}/whatsapp_business_profile`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.WA_ACCESS_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ messaging_product: "whatsapp", ...fields }),
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`WhatsApp business profile update failed (${res.status}): ${await res.text()}`);
  }
}

/**
 * Turn image bytes into a profile_picture_handle via Meta's resumable upload
 * API, so it can be passed to updateBusinessProfile(). Requires WA_APP_ID
 * (separate from the phone-number id) — throws a clear error if unset so the
 * admin route can show a friendly message instead of a raw Meta error.
 */
export async function uploadProfilePictureHandle(bytes: Buffer, mimeType: string): Promise<string> {
  if (!config.WA_APP_ID) {
    throw new Error(
      "WA_APP_ID n'est pas configuré — l'édition de la photo de profil est désactivée.",
    );
  }
  const startRes = await fetch(
    `${GRAPH_BASE}/${config.WA_APP_ID}/uploads?file_length=${bytes.length}&file_type=${encodeURIComponent(mimeType)}`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${config.WA_ACCESS_TOKEN}` },
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    },
  );
  if (!startRes.ok) {
    throw new Error(`Photo upload (start) failed (${startRes.status}): ${await startRes.text()}`);
  }
  const sessionId = ((await startRes.json()) as { id?: string })?.id;
  if (!sessionId) throw new Error("Photo upload: session id manquant dans la réponse Meta");

  const transferRes = await fetch(`${GRAPH_BASE}/${sessionId}`, {
    method: "POST",
    headers: {
      Authorization: `OAuth ${config.WA_ACCESS_TOKEN}`,
      file_offset: "0",
    },
    body: new Uint8Array(bytes),
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });
  if (!transferRes.ok) {
    throw new Error(`Photo upload (transfer) failed (${transferRes.status}): ${await transferRes.text()}`);
  }
  const handle = ((await transferRes.json()) as { h?: string })?.h;
  if (!handle) throw new Error("Photo upload: handle manquant dans la réponse Meta");
  return handle;
}

/**
 * Meta's whatsapp_business_profile has no "hours" field, so opening hours are
 * folded into the description as a trailing block. Pure (unit tested) so the
 * 512-char Meta limit is enforced predictably — truncates the description
 * first, then drops the hours block entirely if there's no room left for it
 * (never truncate the hours block itself, that would read as broken).
 */
export function composeBusinessDescription(description: string, hours: string): string {
  const MAX = 512;
  const trimmedDescription = description.trim();
  const trimmedHours = hours.trim();
  if (!trimmedHours) return trimmedDescription.slice(0, MAX);
  const block = `\n\n🕒 Horaires\n${trimmedHours}`;
  if (trimmedDescription.length + block.length <= MAX) return trimmedDescription + block;
  const room = MAX - block.length;
  if (room <= 0) return trimmedDescription.slice(0, MAX);
  return trimmedDescription.slice(0, room) + block;
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
  mediaId?: string; // Meta media id for audio (voice notes) and image messages
  caption?: string; // client-typed caption on an image message
  reactionEmoji?: string; // the emoji of a 'reaction' message (empty = reaction removed)
  filename?: string; // original filename of a 'document' message
  profileName?: string;
  referral?: WhatsAppReferral;
}
export interface WhatsAppReferral { sourceId?: string; sourceType?: string; sourceUrl?: string; headline?: string; ctwaClid?: string; }

/**
 * Human-readable label stored in the conversation for message types Awa can't
 * process (video, sticker, document…) — so the admin thread shows WHAT arrived
 * instead of an opaque "[non-text message]". Reactions are handled separately
 * (handleReaction) and never reach this.
 */
export function unsupportedMediaLabel(msg: InboundMessage): string {
  switch (msg.type) {
    case "sticker":
      return "[sticker]";
    case "video":
      return "[vidéo]";
    case "document":
      return msg.filename ? `[document : ${msg.filename}]` : "[document]";
    case "location":
      return "[localisation partagée]";
    case "contacts":
      return "[contact partagé]";
    default:
      return `[message non pris en charge : ${msg.type}]`;
  }
}

/**
 * Extract inbound messages from a webhook payload. Ignores statuses
 * (delivery receipts) and anything that isn't an individual message.
 */
/** A delivery-status callback from Meta (sent/delivered/read/failed). */
export interface StatusUpdate {
  wamid: string;
  status: string;
  errorCode?: number;
  errorTitle?: string;
}

/**
 * Parse the `statuses` callbacks Meta posts to the same webhook. We only act on
 * `failed` (to correct a log row that Meta accepted with 200 then dropped), but
 * all are returned for completeness.
 */
export function parseStatuses(payload: any): StatusUpdate[] {
  const out: StatusUpdate[] = [];
  for (const entry of payload?.entry ?? []) {
    for (const change of entry?.changes ?? []) {
      const value = change?.value;
      if (!value?.statuses) continue;
      for (const s of value.statuses) {
        if (!s?.id || !s?.status) continue;
        const err = Array.isArray(s.errors) ? s.errors[0] : undefined;
        out.push({
          wamid: s.id,
          status: s.status,
          errorCode: err?.code,
          errorTitle: err?.title ?? err?.message,
        });
      }
    }
  }
  return out;
}

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
          mediaId:
            msg.type === "audio"
              ? msg.audio?.id
              : msg.type === "image"
                ? msg.image?.id
                : msg.type === "sticker"
                  ? msg.sticker?.id
                  : undefined,
          caption: msg.type === "image" ? msg.image?.caption : undefined,
          reactionEmoji: msg.type === "reaction" ? msg.reaction?.emoji : undefined,
          filename: msg.type === "document" ? msg.document?.filename : undefined,
          profileName: contact?.profile?.name,
          referral: msg.referral ? { sourceId: msg.referral.source_id, sourceType: msg.referral.source_type, sourceUrl: msg.referral.source_url, headline: msg.referral.headline, ctwaClid: msg.referral.ctwa_clid } : undefined,
        });
      }
    }
  }
  return out;
}
