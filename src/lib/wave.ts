import crypto from "node:crypto";
import { config } from "../config.js";

const WAVE_API = "https://api.wave.com";

export interface WaveSession {
  id: string;
  wave_launch_url: string;
}

/**
 * Create a Wave checkout session (SPEC §4.3).
 * `clientReference` is our pending_booking.id — the join key for the webhook.
 */
export async function createCheckoutSession(args: {
  amountXof: number;
  clientReference: string;
}): Promise<WaveSession> {
  const body = JSON.stringify({
    amount: String(args.amountXof), // XOF: integer amount, no decimals
    currency: "XOF",
    client_reference: args.clientReference,
    success_url: `${config.BASE_URL}/payment/success`,
    error_url: `${config.BASE_URL}/payment/error`,
  });

  const headers: Record<string, string> = {
    Authorization: `Bearer ${config.WAVE_API_KEY}`,
    "Content-Type": "application/json",
    // Wave supports idempotency keys; reusing the booking id means a retried
    // create never produces two live sessions for one booking.
    "Idempotency-Key": args.clientReference,
  };
  // Request signing (enforced on accounts with a wave_sn_AKS_ signing secret):
  // Wave-Signature: t=<ts>,v1=HMAC-SHA256(signing secret, ts + body)
  if (config.WAVE_SIGNING_SECRET) {
    headers["Wave-Signature"] = signWavePayload(body, config.WAVE_SIGNING_SECRET);
  }

  const res = await fetch(`${WAVE_API}/v1/checkout/sessions`, {
    method: "POST",
    headers,
    body,
    // Cap the call so a hung connection can't stall the caller indefinitely.
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Wave checkout session creation failed (${res.status}): ${text}`);
  }
  const data: any = await res.json();
  if (!data?.id || !data?.wave_launch_url) {
    throw new Error(`Wave response missing id/wave_launch_url: ${JSON.stringify(data)}`);
  }
  return { id: data.id, wave_launch_url: data.wave_launch_url };
}

/**
 * Verify a Wave webhook signature (SPEC §4.3).
 *
 * Header format:  Wave-Signature: t=<unix ts>,v1=<hex hmac>[,v1=<hex hmac>...]
 * Signed payload: HMAC-SHA256(secret, timestamp + rawBody)
 *
 * Pure function (secret passed in) for unit testing.
 */
export function verifyWaveSignature(
  rawBody: Buffer | string,
  signatureHeader: string | undefined,
  webhookSecret: string,
  opts: { toleranceSeconds?: number; now?: number } = {},
): boolean {
  if (!signatureHeader) return false;
  const parts = signatureHeader.split(",").map((p) => p.trim());
  const timestamp = parts.find((p) => p.startsWith("t="))?.slice(2);
  const signatures = parts.filter((p) => p.startsWith("v1=")).map((p) => p.slice(3));
  if (!timestamp || signatures.length === 0) return false;

  // Optional replay protection: reject signatures whose timestamp is too far
  // from now. Off by default (toleranceSeconds unset) so the crypto stays a
  // pure, deterministic function for unit tests; the webhook handler opts in.
  const tolerance = opts.toleranceSeconds ?? 0;
  if (tolerance > 0) {
    const ts = Number(timestamp);
    const nowSec = Math.floor((opts.now ?? Date.now()) / 1000);
    if (!Number.isFinite(ts) || Math.abs(nowSec - ts) > tolerance) return false;
  }

  const body = typeof rawBody === "string" ? rawBody : rawBody.toString("utf8");
  const expected = crypto
    .createHmac("sha256", webhookSecret)
    .update(timestamp + body)
    .digest("hex");

  return signatures.some(
    (sig) =>
      sig.length === expected.length &&
      crypto.timingSafeEqual(Buffer.from(sig, "utf8"), Buffer.from(expected, "utf8")),
  );
}

/** Build a signature header for a given body — used by the webhook simulator. */
export function signWavePayload(rawBody: string, webhookSecret: string, timestamp?: number): string {
  const t = timestamp ?? Math.floor(Date.now() / 1000);
  const sig = crypto.createHmac("sha256", webhookSecret).update(t + rawBody).digest("hex");
  return `t=${t},v1=${sig}`;
}
