import { describe, expect, it } from "vitest";
import { isTransientError, withTransientRetry } from "../src/lib/retry.js";

describe("isTransientError", () => {
  it("treats 5xx / 429 (by status field) as transient, 4xx as not", () => {
    expect(isTransientError({ status: 503 })).toBe(true);
    expect(isTransientError({ status: 429 })).toBe(true);
    expect(isTransientError({ statusCode: 500 })).toBe(true);
    expect(isTransientError({ status: 400 })).toBe(false);
    expect(isTransientError({ status: 404 })).toBe(false);
  });

  it("catches status folded into the message (Wix wrapper) and network/timeout errors", () => {
    expect(isTransientError(new Error("Wix /pricing-plans failed (503): upstream"))).toBe(true);
    expect(isTransientError(new Error("The service is temporarily unavailable"))).toBe(true);
    expect(isTransientError(new Error("read ECONNRESET"))).toBe(true);
    expect(isTransientError(new Error("The operation was aborted due to timeout"))).toBe(true);
  });

  it("does not retry a genuine 4xx folded in the message", () => {
    expect(isTransientError(new Error("Wix /contacts failed (404): not found"))).toBe(false);
    expect(isTransientError(new Error("bad request (400)"))).toBe(false);
  });
});

describe("withTransientRetry", () => {
  it("returns on first success without retrying", async () => {
    let calls = 0;
    const out = await withTransientRetry(async () => { calls++; return "ok"; }, { delayMs: 0 });
    expect(out).toBe("ok");
    expect(calls).toBe(1);
  });

  it("retries once on a transient error then succeeds", async () => {
    let calls = 0;
    const out = await withTransientRetry(
      async () => { calls++; if (calls === 1) throw new Error("temporarily unavailable"); return "ok"; },
      { delayMs: 0 },
    );
    expect(out).toBe("ok");
    expect(calls).toBe(2);
  });

  it("does not retry a non-transient error", async () => {
    let calls = 0;
    await expect(
      withTransientRetry(async () => { calls++; throw new Error("bad request (400)"); }, { delayMs: 0 }),
    ).rejects.toThrow(/400/);
    expect(calls).toBe(1);
  });

  it("rethrows the last error after exhausting retries", async () => {
    let calls = 0;
    await expect(
      withTransientRetry(async () => { calls++; throw new Error("timeout"); }, { retries: 2, delayMs: 0 }),
    ).rejects.toThrow(/timeout/);
    expect(calls).toBe(3);
  });
});
