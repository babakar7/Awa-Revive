import crypto from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import { config } from "../config.js";
import { parseCookies, sessionSecret } from "./auth.js";

export const OWNER_PAYMENTS_COOKIE = "awa_owner_payments";
export const OWNER_PAYMENTS_TTL_MS = 8 * 60 * 60 * 1000;
const ATTEMPT_WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILED_ATTEMPTS = 5;
const attempts = new Map<string, number[]>();

function safeEqual(a: string, b: string): boolean {
  const ah = crypto.createHash("sha256").update(a, "utf8").digest();
  const bh = crypto.createHash("sha256").update(b, "utf8").digest();
  return crypto.timingSafeEqual(ah, bh);
}

export function ownerPaymentsConfigured(): boolean {
  return config.OWNER_PAYMENTS_PASSWORD.length > 0;
}

export function verifyOwnerPaymentsPassword(candidate: string): boolean {
  const configured = config.OWNER_PAYMENTS_PASSWORD;
  const expected = configured || "\0owner-payments-not-configured\0";
  return safeEqual(candidate, expected) && configured.length > 0;
}

function signingKey(): string {
  return crypto
    .createHash("sha256")
    .update(`awa-owner-payments-v1|${sessionSecret()}|${config.OWNER_PAYMENTS_PASSWORD}`)
    .digest("hex");
}

function signature(payload: string): string {
  return crypto.createHmac("sha256", signingKey()).update(payload).digest("base64url");
}

export function mintOwnerPaymentsToken(adminUser: string, nowMs = Date.now()): string {
  const payload = `${Buffer.from(adminUser, "utf8").toString("base64url")}.${nowMs + OWNER_PAYMENTS_TTL_MS}`;
  return `${payload}.${signature(payload)}`;
}

export function verifyOwnerPaymentsToken(
  token: string | undefined,
  adminUser: string | undefined,
  nowMs = Date.now(),
): boolean {
  if (!token || !adminUser || !ownerPaymentsConfigured()) return false;
  const lastDot = token.lastIndexOf(".");
  if (lastDot < 1) return false;
  const payload = token.slice(0, lastDot);
  const sig = token.slice(lastDot + 1);
  if (!sig || !safeEqual(sig, signature(payload))) return false;
  const sep = payload.indexOf(".");
  if (sep < 1) return false;
  const expiry = Number(payload.slice(sep + 1));
  if (!Number.isFinite(expiry) || expiry <= nowMs) return false;
  try {
    return safeEqual(Buffer.from(payload.slice(0, sep), "base64url").toString("utf8"), adminUser);
  } catch {
    return false;
  }
}

export function ownerPaymentsCookieHeader(token: string): string {
  return (
    `${OWNER_PAYMENTS_COOKIE}=${encodeURIComponent(token)}; ` +
    `Path=/admin/paiements-coachs; HttpOnly; Secure; SameSite=Lax; Max-Age=${OWNER_PAYMENTS_TTL_MS / 1000}`
  );
}

export function clearOwnerPaymentsCookieHeader(): string {
  return (
    `${OWNER_PAYMENTS_COOKIE}=; Path=/admin/paiements-coachs; ` +
    "HttpOnly; Secure; SameSite=Lax; Max-Age=0"
  );
}

function attemptKey(req: FastifyRequest): string {
  return `${req.adminUser ?? "?"}|${req.ip}`;
}

function freshAttempts(key: string, nowMs = Date.now()): number[] {
  const fresh = (attempts.get(key) ?? []).filter((at) => nowMs - at < ATTEMPT_WINDOW_MS);
  if (fresh.length) attempts.set(key, fresh);
  else attempts.delete(key);
  return fresh;
}

export function ownerAttemptAllowed(req: FastifyRequest, nowMs = Date.now()): boolean {
  return freshAttempts(attemptKey(req), nowMs).length < MAX_FAILED_ATTEMPTS;
}

export function recordOwnerAttempt(req: FastifyRequest, success: boolean, nowMs = Date.now()): void {
  const key = attemptKey(req);
  if (success) {
    attempts.delete(key);
    return;
  }
  attempts.set(key, [...freshAttempts(key, nowMs), nowMs]);
}

export function resetOwnerAttemptLimiter(): void {
  attempts.clear();
}

export function safeOwnerNext(raw: string | undefined): string {
  const value = String(raw ?? "").trim();
  if (
    !value.startsWith("/admin/paiements-coachs") ||
    value.startsWith("//") ||
    value.includes("://") ||
    value.includes("\\") ||
    value.includes("\n") ||
    value.includes("\r")
  ) {
    return "/admin/paiements-coachs";
  }
  return value;
}

function wantsHtml(req: FastifyRequest): boolean {
  const accept = String(req.headers.accept ?? "");
  return req.method === "GET" && (accept.includes("text/html") || !accept || accept === "*/*");
}

declare module "fastify" {
  interface FastifyRequest {
    ownerPaymentsUnlocked?: boolean;
  }
}

/** Second authorization layer for every page, PDF and mutation in the section. */
export async function ownerPaymentsAuthHook(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  reply.header("Cache-Control", "no-store");
  const path = req.url.split("?")[0];
  if (path === "/unlock" || path === "/admin/paiements-coachs/unlock") return;
  const cookie = parseCookies(req.headers.cookie)[OWNER_PAYMENTS_COOKIE];
  if (verifyOwnerPaymentsToken(cookie, req.adminUser)) {
    req.ownerPaymentsUnlocked = true;
    return;
  }
  if (wantsHtml(req)) {
    const next = encodeURIComponent(
      safeOwnerNext(path.startsWith("/admin/") ? req.url : `/admin/paiements-coachs${req.url}`),
    );
    return reply.redirect(`/admin/paiements-coachs/unlock?next=${next}`, 302);
  }
  return reply.code(403).type("text/plain").send("Déverrouillage propriétaire requis.");
}
