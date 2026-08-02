import { describe, expect, it } from "vitest";
import Anthropic from "@anthropic-ai/sdk";
import { isConnectionError, isOverloadedError, withOverloadRetry } from "../src/agent/index.js";

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

// 01/08: an Anthropic connection blip outlived the SDK's sub-second retries and
// Tout got "un problème technique" on her very first message. A connection error
// carries no HTTP status, so the app-level retry sleeps through it too — while
// real 4xx/5xx API responses still fail fast.
describe("isConnectionError", () => {
  it("matches an APIConnectionError instance and its timeout subclass", () => {
    expect(isConnectionError(new Anthropic.APIConnectionError({ message: "Connection error." }))).toBe(true);
    expect(isConnectionError(new Anthropic.APIConnectionTimeoutError())).toBe(true);
  });

  it("matches the name/message signature even without instanceof", () => {
    expect(isConnectionError({ name: "APIConnectionError" })).toBe(true);
    expect(isConnectionError({ name: "APIConnectionTimeoutError" })).toBe(true);
    expect(isConnectionError(new Error("Connection error."))).toBe(true);
  });

  it("does not match real HTTP responses or unrelated errors", () => {
    expect(isConnectionError({ status: 500 })).toBe(false);
    expect(isConnectionError({ status: 429 })).toBe(false);
    expect(isConnectionError({ status: 529 })).toBe(false);
    expect(isConnectionError(new Error("bad request (400)"))).toBe(false);
    expect(isConnectionError(undefined)).toBe(false);
  });
});

const overloaded = () => Object.assign(new Error("Overloaded"), { status: 529 });
const connectionError = () => new Anthropic.APIConnectionError({ message: "Connection error." });

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

  it("sleeps through a connection error then succeeds", async () => {
    let calls = 0;
    const out = await withOverloadRetry(
      async () => {
        calls++;
        if (calls < 2) throw connectionError();
        return "ok";
      },
      undefined,
      [1, 1],
    );
    expect(out).toBe("ok");
    expect(calls).toBe(2);
  });

  it("rethrows deterministic errors (no connection/overload signature) immediately", async () => {
    let calls = 0;
    await expect(
      withOverloadRetry(
        async () => (++calls, Promise.reject(Object.assign(new Error("bad request"), { status: 400 }))),
        undefined,
        [1, 1],
      ),
    ).rejects.toThrow("bad request");
    expect(calls).toBe(1);
  });
});
