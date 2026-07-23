import crypto from "node:crypto";
import { config } from "../config.js";

/**
 * Device sessions for the ops PWAs (cuisine iPad, later the reception phones).
 * Unlike the stateless admin HMAC cookie, these are SERVER-SIDE and revocable:
 * only the sha256 of the session token is stored (ops_devices.session_token_hash),
 * so revoking a device = deleting/flagging its row. The pairing code is likewise
 * only ever stored hashed. Tokens are compared by hash lookup (the DB unique
 * index), and any direct compare uses timingSafeEqual on equal-length digests.
 *
 * The PWA is served on its own host (cuisine.revive.sn), a different origin from
 * the admin host, so Path=/ here never collides with or leaks to the admin
 * cookie — the isolation the plan requires falls out of the origin split.
 */

export const OPS_COOKIE = "ops_device";
/** 60 days — a kitchen kiosque should rarely re-pair. */
export const OPS_SESSION_TTL_MS = 60 * 24 * 60 * 60 * 1000;
/** Pairing codes are short-lived: entered within minutes of being generated. */
export const PAIR_CODE_TTL_MS = 10 * 60 * 1000;

/** 192-bit opaque session token (only its hash is stored). */
export function newOpsToken(): string {
  return crypto.randomBytes(24).toString("hex");
}

export function hashOpsToken(token: string): string {
  return crypto.createHash("sha256").update(String(token)).digest("hex");
}

/**
 * Human-typeable pairing code: 8 chars from an unambiguous alphabet (no
 * 0/O/1/I/L). Shown once in the admin, entered on the device. Stored hashed.
 */
const PAIR_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
export function newPairCode(): string {
  const bytes = crypto.randomBytes(8);
  let code = "";
  for (let i = 0; i < 8; i++) code += PAIR_ALPHABET[bytes[i] % PAIR_ALPHABET.length];
  return code;
}

/** Normalize a user-entered pairing code (strip spaces, uppercase). */
export function normalizePairCode(raw: string): string {
  return String(raw ?? "").replace(/\s+/g, "").toUpperCase();
}

export function opsCookieHeader(
  token: string,
  maxAgeSec = Math.floor(OPS_SESSION_TTL_MS / 1000),
): string {
  const secure = config.BASE_URL.startsWith("https://") ? "; Secure" : "";
  return (
    `${OPS_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; ` +
    `Max-Age=${maxAgeSec}${secure}`
  );
}

export function clearOpsCookieHeader(): string {
  const secure = config.BASE_URL.startsWith("https://") ? "; Secure" : "";
  return `${OPS_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`;
}
