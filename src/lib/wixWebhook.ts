import crypto from "node:crypto";

export interface WixWebhookEvent {
  id: string;
  entityFqdn: string;
  entityId: string;
  slug: string;
  eventTime?: string;
  actionEvent?: { body?: Record<string, unknown> };
}

export function verifyWixSharedSecret(provided: string, expected: string): boolean {
  if (!provided || !expected) return false;
  const providedBytes = Buffer.from(provided, "utf8");
  const expectedBytes = Buffer.from(expected, "utf8");
  if (providedBytes.length !== expectedBytes.length) return false;
  return crypto.timingSafeEqual(providedBytes, expectedBytes);
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

export function normalizeWixWebhookEvent(raw: unknown): WixWebhookEvent {
  const event = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  return {
    id: String(event.id ?? ""),
    entityFqdn: String(event.entityFqdn ?? ""),
    entityId: String(event.entityId ?? ""),
    slug: String(event.slug ?? ""),
    eventTime: event.eventTime ? String(event.eventTime) : undefined,
    actionEvent: event.actionEvent as WixWebhookEvent["actionEvent"],
  };
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
  return normalizeWixWebhookEvent({
    id: event?.id ?? envelope?.id,
    entityFqdn: event?.entityFqdn ?? envelope?.entityFqdn,
    entityId: event?.entityId ?? envelope?.entityId,
    slug: event?.slug ?? envelope?.slug,
    eventTime: event?.eventTime ?? envelope?.eventTime,
    actionEvent: event?.actionEvent ?? envelope?.actionEvent,
  });
}
