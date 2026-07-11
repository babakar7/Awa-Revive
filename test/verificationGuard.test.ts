import { describe, expect, it } from "vitest";
import { verificationBlocksPayment } from "../src/agent/tools.js";
import type { LinkRequest, LinkRequestStatus } from "../src/domain/linkRequests.js";

const NOW = new Date("2026-07-11T12:00:00Z");

function req(status: LinkRequestStatus, codeExpiresAt: Date | null): LinkRequest {
  return {
    id: "r1",
    client_id: "c1",
    claimed_email: "a@b.com",
    wix_contact_id: "w1",
    code_hash: "x",
    code_expires_at: codeExpiresAt,
    attempts: 0,
    emails_sent: 1,
    status,
    detail: null,
    reception_notified_at: null,
    created_at: NOW,
    updated_at: NOW,
  };
}

const inFuture = new Date(NOW.getTime() + 5 * 60_000);
const inPast = new Date(NOW.getTime() - 60_000);

describe("verificationBlocksPayment", () => {
  it("BLOCKS while a code is live (AWAITING_CODE, not expired)", () => {
    expect(verificationBlocksPayment(req("AWAITING_CODE", inFuture), NOW)).toBe(true);
  });

  it("does NOT block once the code has expired", () => {
    expect(verificationBlocksPayment(req("AWAITING_CODE", inPast), NOW)).toBe(false);
  });

  it("does NOT block when there is no open request", () => {
    expect(verificationBlocksPayment(null, NOW)).toBe(false);
  });

  it("does NOT block at the email step (AWAITING_EMAIL)", () => {
    expect(verificationBlocksPayment(req("AWAITING_EMAIL", null), NOW)).toBe(false);
  });

  it("does NOT block once verified / needs-reception / linked / dismissed", () => {
    for (const s of ["VERIFIED", "NEEDS_RECEPTION", "LINKED", "DISMISSED"] as LinkRequestStatus[]) {
      expect(verificationBlocksPayment(req(s, inFuture), NOW)).toBe(false);
    }
  });

  it("does NOT block if code_expires_at is missing", () => {
    expect(verificationBlocksPayment(req("AWAITING_CODE", null), NOW)).toBe(false);
  });
});
