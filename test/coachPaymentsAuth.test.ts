import { beforeEach, describe, expect, it } from "vitest";
import { config } from "../src/config.js";
import {
  OWNER_PAYMENTS_TTL_MS,
  mintOwnerPaymentsToken,
  ownerPaymentsCookieHeader,
  recordOwnerAttempt,
  resetOwnerAttemptLimiter,
  ownerAttemptAllowed,
  verifyOwnerPaymentsPassword,
  verifyOwnerPaymentsToken,
} from "../src/admin/coachPaymentsAuth.js";
import type { FastifyRequest } from "fastify";

describe("owner payment lock", () => {
  beforeEach(() => {
    config.OWNER_PAYMENTS_PASSWORD = "owner-secret";
    resetOwnerAttemptLimiter();
  });

  it("compares the dedicated password and has no usable empty fallback", () => {
    expect(verifyOwnerPaymentsPassword("owner-secret")).toBe(true);
    expect(verifyOwnerPaymentsPassword("wrong")).toBe(false);
    config.OWNER_PAYMENTS_PASSWORD = "";
    expect(verifyOwnerPaymentsPassword("")).toBe(false);
  });

  it("signs a user-bound token that expires after 8 hours", () => {
    const now = Date.UTC(2026, 6, 20, 12);
    const token = mintOwnerPaymentsToken("babakar", now);
    expect(verifyOwnerPaymentsToken(token, "babakar", now + OWNER_PAYMENTS_TTL_MS - 1)).toBe(true);
    expect(verifyOwnerPaymentsToken(token, "reception", now)).toBe(false);
    expect(verifyOwnerPaymentsToken(`${token}x`, "babakar", now)).toBe(false);
    expect(verifyOwnerPaymentsToken(token, "babakar", now + OWNER_PAYMENTS_TTL_MS)).toBe(false);
    expect(verifyOwnerPaymentsToken(token, "babakar", now + OWNER_PAYMENTS_TTL_MS + 1)).toBe(false);
  });

  it("emits a restricted secure cookie", () => {
    const cookie = ownerPaymentsCookieHeader("token");
    expect(cookie).toContain("Path=/admin/paiements-coachs");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain("Max-Age=28800");
  });

  it("limits invalid attempts per admin and IP", () => {
    const req = { adminUser: "babakar", ip: "127.0.0.1" } as FastifyRequest;
    for (let i = 0; i < 5; i++) {
      expect(ownerAttemptAllowed(req)).toBe(true);
      recordOwnerAttempt(req, false);
    }
    expect(ownerAttemptAllowed(req)).toBe(false);
    recordOwnerAttempt(req, true);
    expect(ownerAttemptAllowed(req)).toBe(true);
  });
});
