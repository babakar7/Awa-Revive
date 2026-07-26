import crypto from "node:crypto";

export interface WixWebhookEvent {
  id: string;
  entityFqdn: string;
  entityId: string;
  slug: string;
  actionEvent?: { body?: Record<string, unknown> };
}

export function decodeWixPublicKey(raw: string): string {
  const value = raw.trim().replace(/\\n/g, "\n");
  if (!value) throw new Error("missing Wix webhook public key");
  if (value.startsWith("-----BEGIN")) return value;
  return Buffer.from(value, "base64").toString("utf8");
}

function parseJson(value: unknown): any {
  if (typeof value !== "string") return value;
  return JSON.parse(value);
}

export function verifyAndNormalizeWixWebhook(
  token: string,
  rawPublicKey: string,
): WixWebhookEvent {
  const parts = token.trim().split(".");
  if (parts.length !== 3) throw new Error("invalid JWT");
  const [encodedHeader, encodedPayload, signature] = parts;
  const header = JSON.parse(Buffer.from(encodedHeader, "base64url").toString("utf8"));
  if (header?.alg !== "RS256") throw new Error("unsupported JWT algorithm");
  const valid = crypto.verify(
    "RSA-SHA256",
    Buffer.from(`${encodedHeader}.${encodedPayload}`),
    decodeWixPublicKey(rawPublicKey),
    Buffer.from(signature, "base64url"),
  );
  if (!valid) throw new Error("invalid Wix webhook signature");
  const claims = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8"));
  const envelope = parseJson(claims?.data) ?? claims;
  const nested = parseJson(envelope?.data);
  const event =
    nested && typeof nested === "object" && (nested.id || nested.entityFqdn)
      ? nested
      : envelope;
  return {
    id: String(event?.id ?? envelope?.id ?? ""),
    entityFqdn: String(event?.entityFqdn ?? envelope?.entityFqdn ?? ""),
    entityId: String(event?.entityId ?? envelope?.entityId ?? ""),
    slug: String(event?.slug ?? envelope?.slug ?? ""),
    actionEvent: event?.actionEvent ?? envelope?.actionEvent,
  };
}
