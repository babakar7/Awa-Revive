import { describe, expect, it } from "vitest";
import {
  OM_QR_NAME_MAX_CHARS,
  omQrName,
  pickDeepLink,
  transactionMatchesPending,
} from "../src/lib/orangeMoney.js";
import { resolvePaymentMethod } from "../src/agent/tools.js";

describe("omQrName", () => {
  it("keeps short names as-is (trimmed)", () => {
    expect(omQrName("L'Invitée — Clé 3 séances")).toBe("L'Invitée — Clé 3 séances");
    expect(omQrName("  Awa test  ")).toBe("Awa test");
  });

  it("caps at 30 CHARACTERS — Sonatel 500s above (incident carnet 11/08)", () => {
    const carnet = "Carnet de 10 Bébé nageur et Natation ";
    const out = omQrName(carnet);
    expect(Array.from(out).length).toBeLessThanOrEqual(OM_QR_NAME_MAX_CHARS);
    expect(out).toBe("Carnet de 10 Bébé nageur et Na");
  });

  it("counts characters, not UTF-8 bytes (accents pass at 30 chars/32 bytes)", () => {
    const name = "X".repeat(28) + "éé"; // 30 chars, 32 bytes — accepted by OM (probe 11/08)
    expect(omQrName(name)).toBe(name);
  });

  it("never sends an empty name", () => {
    expect(omQrName("   ")).toBe("Revive");
    expect(omQrName("")).toBe("Revive");
  });
});

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

  it("falls back to the preferred method when OM enabled and method omitted (multi-booking)", () => {
    expect(resolvePaymentMethod(undefined, true, "wave")).toEqual({ ok: true, method: "wave" });
    expect(resolvePaymentMethod(undefined, true, "orange_money")).toEqual({
      ok: true,
      method: "orange_money",
    });
  });

  it("still requires a choice when there is no preferred method", () => {
    const r = resolvePaymentMethod(undefined, true, null);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("payment_method_required");
  });

  it("prefers an explicit method over the preferred fallback", () => {
    expect(resolvePaymentMethod("maxit", true, "wave")).toEqual({ ok: true, method: "maxit" });
  });

  it("ignores an unusable preferred method (e.g. OM later disabled)", () => {
    const r = resolvePaymentMethod(undefined, false, "orange_money");
    // OM off → omit still yields wave (the no-OM default), never a broken OM link.
    expect(r).toEqual({ ok: true, method: "wave" });
  });
});
