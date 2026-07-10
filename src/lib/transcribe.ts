import { config } from "../config.js";

/**
 * Voice-note transcription: download the audio from Meta's media API, then
 * transcribe it with OpenAI (gpt-4o-mini-transcribe by default — near-native
 * accuracy on French/English, which is what Revive's clientele speaks).
 * Optional feature: active only when OPENAI_API_KEY is set.
 */

const GRAPH_BASE = "https://graph.facebook.com/v21.0";
const HTTP_TIMEOUT_MS = 30_000;

// WhatsApp voice notes are OGG/Opus and small; anything above this is not a
// voice note we should be paying to transcribe (max WA audio is 16 MB anyway).
const MAX_AUDIO_BYTES = 16 * 1024 * 1024;

export function transcriptionEnabled(): boolean {
  return config.OPENAI_API_KEY !== "";
}

/**
 * Resolve a WhatsApp media id to its bytes. Two steps per Meta's docs:
 * GET /{media-id} → short-lived URL (+ mime type), then GET that URL with the
 * same bearer token.
 */
export async function downloadWhatsAppMedia(
  mediaId: string,
): Promise<{ data: Buffer; mimeType: string }> {
  const metaRes = await fetch(`${GRAPH_BASE}/${mediaId}`, {
    headers: { Authorization: `Bearer ${config.WA_ACCESS_TOKEN}` },
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });
  if (!metaRes.ok) throw new Error(`media lookup failed (${metaRes.status}): ${await metaRes.text()}`);
  const meta = (await metaRes.json()) as { url: string; mime_type?: string; file_size?: number };
  if (meta.file_size && meta.file_size > MAX_AUDIO_BYTES)
    throw new Error(`media too large (${meta.file_size} bytes)`);

  const fileRes = await fetch(meta.url, {
    headers: { Authorization: `Bearer ${config.WA_ACCESS_TOKEN}` },
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });
  if (!fileRes.ok) throw new Error(`media download failed (${fileRes.status})`);
  const data = Buffer.from(await fileRes.arrayBuffer());
  if (data.length > MAX_AUDIO_BYTES) throw new Error(`media too large (${data.length} bytes)`);
  return { data, mimeType: meta.mime_type ?? "audio/ogg" };
}

/** Transcribe audio bytes via OpenAI's transcription endpoint. */
export async function transcribeAudio(data: Buffer, mimeType: string): Promise<string> {
  const form = new FormData();
  // WhatsApp voice notes are audio/ogg; codecs=opus suffixes confuse filename
  // inference, so give an explicit .ogg name.
  const ext = mimeType.includes("mpeg") ? "mp3" : mimeType.includes("mp4") ? "m4a" : "ogg";
  form.append("file", new Blob([new Uint8Array(data)], { type: mimeType.split(";")[0] }), `note.${ext}`);
  form.append("model", config.TRANSCRIPTION_MODEL);

  const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${config.OPENAI_API_KEY}` },
    body: form,
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(`transcription failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
  const out = (await res.json()) as { text?: string };
  const text = (out.text ?? "").trim();
  if (!text) throw new Error("transcription returned empty text");
  return text;
}

/** Download + transcribe one WhatsApp voice note. Throws on any failure. */
export async function transcribeWhatsAppAudio(mediaId: string): Promise<string> {
  const { data, mimeType } = await downloadWhatsAppMedia(mediaId);
  return transcribeAudio(data, mimeType);
}
