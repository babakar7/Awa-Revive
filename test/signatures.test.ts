import { describe, it, expect } from "vitest";
import crypto from "node:crypto";
import { verifyWhatsAppSignature } from "../src/lib/whatsapp.js";
import { verifyWaveSignature, signWavePayload } from "../src/lib/wave.js";

describe("WhatsApp X-Hub-Signature-256 verification (SPEC §10.9)", () => {
  const secret = "test-app-secret";
  const body = Buffer.from(JSON.stringify({ entry: [{ changes: [] }] }));

  function sign(b: Buffer, s: string): string {
    return "sha256=" + crypto.createHmac("sha256", s).update(b).digest("hex");
  }

  it("accepts a valid signature", () => {
    expect(verifyWhatsAppSignature(body, sign(body, secret), secret)).toBe(true);
  });

  it("rejects a signature made with the wrong secret", () => {
    expect(verifyWhatsAppSignature(body, sign(body, "wrong-secret"), secret)).toBe(false);
  });

  it("rejects when the body was tampered with", () => {
    const sig = sign(body, secret);
    const tampered = Buffer.from(body.toString() + "x");
    expect(verifyWhatsAppSignature(tampered, sig, secret)).toBe(false);
  });

  it("rejects a missing header", () => {
    expect(verifyWhatsAppSignature(body, undefined, secret)).toBe(false);
  });

  it("rejects a malformed header (no sha256= prefix)", () => {
    expect(verifyWhatsAppSignature(body, "md5=abcdef", secret)).toBe(false);
  });

  it("rejects a truncated signature", () => {
    expect(verifyWhatsAppSignature(body, sign(body, secret).slice(0, 20), secret)).toBe(false);
  });
});

describe("Wave webhook signature verification (SPEC §10.4/§10.9)", () => {
  const secret = "wave-test-secret";
  const body = JSON.stringify({
    id: "EV_test",
    type: "checkout.session.completed",
    data: { client_reference: "abc-123" },
  });

  it("accepts a payload signed with signWavePayload", () => {
    const header = signWavePayload(body, secret);
    expect(verifyWaveSignature(body, header, secret)).toBe(true);
  });

  it("accepts Buffer bodies", () => {
    const header = signWavePayload(body, secret);
    expect(verifyWaveSignature(Buffer.from(body), header, secret)).toBe(true);
  });

  it("rejects a forged signature (acceptance #4)", () => {
    const header = "t=1234567890,v1=" + "0".repeat(64);
    expect(verifyWaveSignature(body, header, secret)).toBe(false);
  });

  it("rejects a signature made with the wrong secret", () => {
    const header = signWavePayload(body, "other-secret");
    expect(verifyWaveSignature(body, header, secret)).toBe(false);
  });

  it("rejects when the timestamp was altered (signature covers t + body)", () => {
    const header = signWavePayload(body, secret, 1000);
    const altered = header.replace("t=1000", "t=2000");
    expect(verifyWaveSignature(body, altered, secret)).toBe(false);
  });

  it("rejects when the body was tampered with", () => {
    const header = signWavePayload(body, secret);
    expect(verifyWaveSignature(body + " ", header, secret)).toBe(false);
  });

  it("rejects missing/malformed headers", () => {
    expect(verifyWaveSignature(body, undefined, secret)).toBe(false);
    expect(verifyWaveSignature(body, "garbage", secret)).toBe(false);
    expect(verifyWaveSignature(body, "t=123", secret)).toBe(false);
  });

  it("accepts if any v1 signature matches (multiple signatures)", () => {
    const good = signWavePayload(body, secret, 555);
    const goodSig = good.split("v1=")[1];
    const header = `t=555,v1=${"f".repeat(64)},v1=${goodSig}`;
    expect(verifyWaveSignature(body, header, secret)).toBe(true);
  });

  describe("replay protection (opt-in toleranceSeconds)", () => {
    const t = 1_000_000; // signing timestamp, seconds
    const header = signWavePayload(body, secret, t);
    const nowMs = t * 1000;

    it("accepts a fresh signature within the tolerance window", () => {
      expect(
        verifyWaveSignature(body, header, secret, { toleranceSeconds: 300, now: nowMs + 120_000 }),
      ).toBe(true);
    });

    it("rejects a valid-but-stale signature outside the window", () => {
      expect(
        verifyWaveSignature(body, header, secret, { toleranceSeconds: 300, now: nowMs + 600_000 }),
      ).toBe(false);
    });

    it("rejects a signature dated too far in the future", () => {
      expect(
        verifyWaveSignature(body, header, secret, { toleranceSeconds: 300, now: nowMs - 600_000 }),
      ).toBe(false);
    });

    it("skips the freshness check when no tolerance is given (default)", () => {
      expect(verifyWaveSignature(body, header, secret)).toBe(true);
    });
  });
});
