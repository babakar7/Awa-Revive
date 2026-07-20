import crypto from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import { config } from "../config.js";

/**
 * Admin auth: long-lived signed session cookie (login form) so reception can
 * open /admin all day without retyping the password. HTTP Basic is still
 * accepted for scripts/curl but we no longer challenge browsers with
 * WWW-Authenticate (that dialog is what felt like "every time").
 *
 * Team accounts come from ADMIN_USERS (unset → revive/revive@5000). A separate
 * OWNER_ADMIN_USER / OWNER_ADMIN_PASSWORD account receives the owner role and
 * therefore has access to every section in one login.
 */

export const SESSION_COOKIE = "awa_admin_session";
/** 30 days — visit often without re-login. */
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export type AdminRole = "team" | "owner";
export type AdminIdentity = { username: string; role: AdminRole };

/** Parse "u1:p1,u2:p2" into a map. Malformed entries are dropped. */
export function parseAdminUsers(raw: string): Map<string, string> {
  const users = new Map<string, string>();
  for (const entry of raw.split(",")) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const sep = trimmed.indexOf(":");
    if (sep <= 0 || sep === trimmed.length - 1) continue;
    users.set(trimmed.slice(0, sep).trim(), trimmed.slice(sep + 1));
  }
  return users;
}

function safeEqual(a: string, b: string): boolean {
  const ha = crypto.createHash("sha256").update(a, "utf8").digest();
  const hb = crypto.createHash("sha256").update(b, "utf8").digest();
  return crypto.timingSafeEqual(ha, hb);
}

/** Active account map (env or fallback). */
export function adminUsers(): Map<string, string> {
  const configured = parseAdminUsers(config.ADMIN_USERS);
  return configured.size > 0 ? configured : FALLBACK_USERS;
}

/**
 * Built-in fallback when ADMIN_USERS is unset. Dashboard is never open.
 */
export const FALLBACK_USERS = new Map([["revive", "revive@5000"]]);

export function ownerAdminAccount(): { username: string; password: string } | null {
  const username = config.OWNER_ADMIN_USER.trim();
  const password = config.OWNER_ADMIN_PASSWORD;
  return username && password ? { username, password } : null;
}

/**
 * Check username/password against the account map.
 * Always runs a comparison so unknown-vs-wrong timing matches.
 */
export function verifyCredentials(
  username: string,
  password: string,
  users: Map<string, string>,
): string | null {
  const expected = users.get(username);
  const ok = safeEqual(password, expected ?? `\0${password}\0`);
  return ok && expected !== undefined ? username : null;
}

/** Authenticate either a restricted team account or the separate owner. */
export function verifyAdminCredentials(username: string, password: string): AdminIdentity | null {
  const owner = ownerAdminAccount();
  const ownerNameMatches = safeEqual(username, owner?.username ?? `\0${username}\0`);
  const ownerPasswordMatches = safeEqual(password, owner?.password ?? `\0${password}\0`);
  const teamUser = verifyCredentials(username, password, adminUsers());

  if (owner && ownerNameMatches && ownerPasswordMatches) {
    return { username: owner.username, role: "owner" };
  }
  return teamUser ? { username: teamUser, role: "team" } : null;
}

function decodeBasicAuth(authorizationHeader: string | undefined): [string, string] | null {
  if (!authorizationHeader?.startsWith("Basic ")) return null;
  let decoded: string;
  try {
    decoded = Buffer.from(authorizationHeader.slice(6), "base64").toString("utf8");
  } catch {
    return null;
  }
  const sep = decoded.indexOf(":");
  if (sep < 0) return null;
  return [decoded.slice(0, sep), decoded.slice(sep + 1)];
}

/**
 * Check an Authorization header against the account map.
 * Returns the authenticated username, or null.
 */
export function verifyBasicAuth(
  authorizationHeader: string | undefined,
  users: Map<string, string>,
): string | null {
  const credentials = decodeBasicAuth(authorizationHeader);
  return credentials ? verifyCredentials(credentials[0], credentials[1], users) : null;
}

export function verifyAdminBasicAuth(
  authorizationHeader: string | undefined,
): AdminIdentity | null {
  const credentials = decodeBasicAuth(authorizationHeader);
  return credentials ? verifyAdminCredentials(credentials[0], credentials[1]) : null;
}

/** Stable HMAC key so sessions survive process restarts without a new env var. */
export function sessionSecret(): string {
  // Derived from existing env so no extra Railway var is required. Changing
  // configured OR fallback credentials invalidates all sessions (acceptable).
  const teamMaterial = config.ADMIN_USERS || [...FALLBACK_USERS.entries()].map(([user, pass]) => `${user}:${pass}`).join(",");
  const authMaterial = `${teamMaterial}|owner:${config.OWNER_ADMIN_USER}:${config.OWNER_ADMIN_PASSWORD}`;
  return crypto
    .createHash("sha256")
    .update(`awa-admin-v1|${authMaterial}|${config.DATABASE_URL}`)
    .digest("hex");
}

function hmac(payload: string): string {
  return crypto.createHmac("sha256", sessionSecret()).update(payload, "utf8").digest("base64url");
}

/**
 * Token: role.base64url(username).expMs.sig
 */
export function mintSessionToken(
  identityOrUsername: AdminIdentity | string,
  nowMs = Date.now(),
): string {
  const identity: AdminIdentity =
    typeof identityOrUsername === "string"
      ? { username: identityOrUsername, role: "team" }
      : identityOrUsername;
  const exp = nowMs + SESSION_TTL_MS;
  const userB64 = Buffer.from(identity.username, "utf8").toString("base64url");
  const payload = `${identity.role}.${userB64}.${exp}`;
  return `${payload}.${hmac(payload)}`;
}

export function verifySessionToken(
  token: string | undefined,
  users: Map<string, string>,
  nowMs = Date.now(),
): AdminIdentity | null {
  if (!token) return null;
  const lastDot = token.lastIndexOf(".");
  if (lastDot <= 0) return null;
  const payload = token.slice(0, lastDot);
  const sig = token.slice(lastDot + 1);
  if (!sig || !safeEqual(sig, hmac(payload))) return null;
  const parts = payload.split(".");
  if (parts.length !== 3) return null;
  const [role, userB64, rawExpiry] = parts;
  if (role !== "team" && role !== "owner") return null;
  const exp = Number(rawExpiry);
  if (!Number.isFinite(exp) || exp < nowMs) return null;
  let username: string;
  try {
    username = Buffer.from(userB64, "base64url").toString("utf8");
  } catch {
    return null;
  }
  // Account removed or role configuration changed → session invalid.
  if (role === "team" && !users.has(username)) return null;
  const owner = ownerAdminAccount();
  if (role === "owner" && owner?.username !== username) return null;
  return { username, role };
}

export function parseCookies(header: string | undefined): Record<string, string> {
  if (!header) return {};
  const out: Record<string, string> = {};
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (!k) continue;
    try {
      out[k] = decodeURIComponent(part.slice(i + 1).trim());
    } catch {
      out[k] = part.slice(i + 1).trim();
    }
  }
  return out;
}

/** Only same-site admin paths — never open redirects. */
export function safeNextPath(raw: string | undefined): string {
  if (!raw) return "/admin";
  const path = raw.trim();
  if (!path.startsWith("/admin")) return "/admin";
  if (path.startsWith("//") || path.includes("://")) return "/admin";
  if (path.includes("\\") || path.includes("\n") || path.includes("\r")) return "/admin";
  return path;
}

export function sessionCookieHeader(token: string, maxAgeSec = Math.floor(SESSION_TTL_MS / 1000)): string {
  const secure = config.BASE_URL.startsWith("https://") ? "; Secure" : "";
  return (
    `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/admin; HttpOnly; SameSite=Lax; ` +
    `Max-Age=${maxAgeSec}${secure}`
  );
}

export function clearSessionCookieHeader(): string {
  const secure = config.BASE_URL.startsWith("https://") ? "; Secure" : "";
  return `${SESSION_COOKIE}=; Path=/admin; HttpOnly; SameSite=Lax; Max-Age=0${secure}`;
}

declare module "fastify" {
  interface FastifyRequest {
    adminUser?: string;
    adminRole?: AdminRole;
  }
}

/** Login + logout are public (logout clears cookie even if session expired). */
function isPublicAdminPath(url: string): boolean {
  const path = url.split("?")[0];
  return (
    path === "/login" ||
    path === "/admin/login" ||
    path === "/logout" ||
    path === "/admin/logout"
  );
}

function wantsHtml(req: FastifyRequest): boolean {
  const accept = String(req.headers.accept ?? "");
  // Navigations send text/html; fetch/API often omit it or send */* with XHR.
  if (accept.includes("text/html")) return true;
  if (req.method === "GET" && (!accept || accept === "*/*")) {
    // Bare browser GET without Accept quirks
    return !req.headers["x-requested-with"];
  }
  return false;
}

/** onRequest hook guarding every /admin route except the login form. */
export async function adminAuthHook(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  reply.header("Cache-Control", "no-store");
  reply.header("X-Robots-Tag", "noindex, nofollow");

  if (isPublicAdminPath(req.url)) return;

  const users = adminUsers();
  const cookies = parseCookies(req.headers.cookie);
  const fromCookie = verifySessionToken(cookies[SESSION_COOKIE], users);
  const fromBasic = verifyAdminBasicAuth(req.headers.authorization);
  const identity = fromCookie ?? fromBasic;

  if (identity) {
    req.adminUser = identity.username;
    req.adminRole = identity.role;
    return;
  }

  // Browser: send to login form (no Basic challenge — that was the re-prompt).
  if (req.method === "GET" && wantsHtml(req)) {
    const next = encodeURIComponent(safeNextPath(req.url.startsWith("/admin") ? req.url : `/admin${req.url}`));
    return reply.redirect(`/admin/login?next=${next}`, 302);
  }

  reply
    .code(401)
    .type("text/plain")
    .send("Authentification requise. Ouvre /admin/login ou envoie un cookie de session.");
}
