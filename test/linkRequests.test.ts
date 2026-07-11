import { describe, expect, it } from "vitest";
import {
  canSendCode,
  generateCode,
  hashCode,
  looksLikeCode,
  verifyCode,
  MAX_EMAILS_PER_DAY,
} from "../src/domain/linkRequests.js";

describe("verification code helpers", () => {
  it("generateCode returns 6 digits, zero-padded", () => {
    for (let i = 0; i < 50; i++) {
      expect(generateCode()).toMatch(/^\d{6}$/);
    }
  });

  it("verifyCode accepts the right code for the right request only", () => {
    const hash = hashCode("042817", "req-1");
    expect(verifyCode("042817", "req-1", hash)).toBe(true);
    expect(verifyCode("042818", "req-1", hash)).toBe(false); // wrong code
    expect(verifyCode("042817", "req-2", hash)).toBe(false); // right code, other request
  });

  it("the hash never contains the code", () => {
    expect(hashCode("123456", "req-1")).not.toContain("123456");
  });

  it("looksLikeCode: exactly 6 digits, whitespace tolerated", () => {
    expect(looksLikeCode("042817")).toBe(true);
    expect(looksLikeCode("  042817 ")).toBe(true);
    expect(looksLikeCode("42817")).toBe(false);
    expect(looksLikeCode("0428171")).toBe(false);
    expect(looksLikeCode("mon code est 042817")).toBe(false);
  });
});

describe("canSendCode", () => {
  const base = { updated_at: new Date() } as any;

  it("under the daily cap → true", () => {
    expect(canSendCode({ ...base, emails_sent: MAX_EMAILS_PER_DAY - 1 })).toBe(true);
  });

  it("at the daily cap → false", () => {
    expect(canSendCode({ ...base, emails_sent: MAX_EMAILS_PER_DAY })).toBe(false);
  });

  it("cap reached but request idle for >24h → true again (legit retry next day)", () => {
    const old = new Date(Date.now() - 25 * 3600 * 1000);
    expect(canSendCode({ ...base, updated_at: old, emails_sent: MAX_EMAILS_PER_DAY })).toBe(true);
  });
});
