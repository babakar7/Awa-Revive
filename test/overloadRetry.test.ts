import { describe, expect, it } from "vitest";
import { isOverloadedError, withOverloadRetry } from "../src/agent/index.js";

// 16/07: a 529 overload spike outlived the SDK's sub-second retries and a
// brand-new client got the technical fallback on "Bonsoir". The app-level
// retry sleeps through the spike — but ONLY for overload errors: timeouts and
// other 5xx must keep failing fast (they'd stack with the 60s per-attempt
// timeout and block the client's serialized queue).
describe("isOverloadedError", () => {
  it("matches a 529 status and the overloaded_error body shape", () => {
    expect(isOverloadedError({ status: 529 })).toBe(true);
    expect(isOverloadedError({ error: { error: { type: "overloaded_error" } } })).toBe(true);
  });

  it("does not match timeouts, other 5xx or plain errors", () => {
    expect(isOverloadedError({ status: 500 })).toBe(false);
    expect(isOverloadedError({ status: 429 })).toBe(false);
    expect(isOverloadedError(new Error("Request timed out."))).toBe(false);
    expect(isOverloadedError(undefined)).toBe(false);
  });
});

const overloaded = () => Object.assign(new Error("Overloaded"), { status: 529 });

describe("withOverloadRetry", () => {
  it("returns the first success without retrying", async () => {
    let calls = 0;
    const out = await withOverloadRetry(async () => (++calls, "ok"), undefined, [1, 1]);
    expect(out).toBe("ok");
    expect(calls).toBe(1);
  });

  it("sleeps through overload errors then succeeds, signalling each retry", async () => {
    let calls = 0;
    let retries = 0;
    const out = await withOverloadRetry(
      async () => {
        calls++;
        if (calls < 3) throw overloaded();
        return "ok";
      },
      () => retries++,
      [1, 1],
    );
    expect(out).toBe("ok");
    expect(calls).toBe(3);
    expect(retries).toBe(2);
  });

  it("gives up after the delay budget and rethrows the overload error", async () => {
    let calls = 0;
    await expect(
      withOverloadRetry(async () => (++calls, Promise.reject(overloaded())), undefined, [1]),
    ).rejects.toMatchObject({ status: 529 });
    expect(calls).toBe(2); // initial + 1 retry
  });

  it("rethrows non-overload errors immediately (no retry)", async () => {
    let calls = 0;
    await expect(
      withOverloadRetry(
        async () => (++calls, Promise.reject(new Error("Request timed out."))),
        undefined,
        [1, 1],
      ),
    ).rejects.toThrow("timed out");
    expect(calls).toBe(1);
  });
});
