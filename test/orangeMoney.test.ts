import { describe, expect, it } from "vitest";
import { pickDeepLink, transactionMatchesPending } from "../src/lib/orangeMoney.js";
import { resolvePaymentMethod } from "../src/agent/tools.js";

describe("pickDeepLink", () => {
  const links = {
    OM: "https://example.com/om",
    MAXIT: "https://example.com/maxit",
  };
  it("prefers OM / MAXIT keys", () => {
    expect(pickDeepLink("orange_money", "https://fallback", links)).toBe(links.OM);
    expect(pickDeepLink("maxit", "https://fallback", links)).toBe(links.MAXIT);
  });
  it("falls back to deepLink", () => {
    expect(pickDeepLink("orange_money", "https://fallback", {})).toBe("https://fallback");
  });
});

describe("transactionMatchesPending", () => {
  const base = {
    transactionId: "CI220511.1455.A00147",
    status: "SUCCESS",
    amountValue: 10000,
    partnerId: "553651",
    metadata: { order: "booking-uuid", channel: "awa" },
    customerId: "771234567",
    raw: {},
  };

  it("ok when SUCCESS, amount and merchant match", () => {
    expect(
      transactionMatchesPending(base, {
        amountXof: 10000,
        merchantCode: "553651",
        orderId: "booking-uuid",
      }),
    ).toEqual({ ok: true });
  });

  it("rejects low amount / wrong partner / wrong order", () => {
    expect(
      transactionMatchesPending(base, {
        amountXof: 15000,
        merchantCode: "553651",
        orderId: "booking-uuid",
      }).ok,
    ).toBe(false);
    expect(
      transactionMatchesPending(
        { ...base, partnerId: "000000" },
        { amountXof: 10000, merchantCode: "553651", orderId: "booking-uuid" },
      ).ok,
    ).toBe(false);
    expect(
      transactionMatchesPending(base, {
        amountXof: 10000,
        merchantCode: "553651",
        orderId: "other-id",
      }).ok,
    ).toBe(false);
  });
});

describe("resolvePaymentMethod", () => {
  it("defaults to wave when OM disabled and method omitted", () => {
    expect(resolvePaymentMethod(undefined, false)).toEqual({ ok: true, method: "wave" });
  });

  it("requires method when OM enabled", () => {
    const r = resolvePaymentMethod(undefined, true);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("payment_method_required");
  });

  it("accepts wave / orange_money / maxit when OM enabled", () => {
    expect(resolvePaymentMethod("wave", true)).toEqual({ ok: true, method: "wave" });
    expect(resolvePaymentMethod("orange_money", true)).toEqual({
      ok: true,
      method: "orange_money",
    });
    expect(resolvePaymentMethod("maxit", true)).toEqual({ ok: true, method: "maxit" });
  });

  it("rejects OM methods when feature off", () => {
    expect(resolvePaymentMethod("orange_money", false).ok).toBe(false);
    expect(resolvePaymentMethod("maxit", false).ok).toBe(false);
  });
});
