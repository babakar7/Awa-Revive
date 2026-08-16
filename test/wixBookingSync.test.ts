import { describe, expect, it } from "vitest";
import {
  matchBooking,
  matchPlanOrder,
  namesCompatible,
  planOrderRowFromWix,
  type MatchIndex,
} from "../src/domain/wixBookingSync.js";
import { parseRetryAfterMs, wixBackoffMs } from "../src/lib/wix.js";
import type { WixBookingSnapshot } from "../src/lib/wix.js";

function index(overrides: Partial<MatchIndex> = {}): MatchIndex {
  return {
    byPhoneKey: new Map(),
    byContactId: new Map(),
    byMemberId: new Map(),
    byAwaBookingId: new Map(),
    clientNames: new Map(),
    ...overrides,
  };
}

function snap(overrides: Partial<WixBookingSnapshot> = {}): WixBookingSnapshot {
  return {
    bookingId: "b1",
    status: "CONFIRMED",
    paymentStatus: null,
    contactId: null,
    clientName: null,
    clientPhone: null,
    serviceId: null,
    serviceName: null,
    sessionStart: null,
    numberOfParticipants: null,
    createdDate: null,
    updatedDate: null,
    wixOrderId: null,
    benefitTransactionId: null,
    raw: null,
    ...overrides,
  };
}

describe("namesCompatible", () => {
  it("matches identical, contained and shared-token names", () => {
    expect(namesCompatible("Rova Rajaonah", "Rova Rajaonah")).toBe(true);
    expect(namesCompatible("Rova", "Rova Rajaonah")).toBe(true);
    expect(namesCompatible("Rova Rajaonah", "Mme Rova")).toBe(true);
  });
  it("is fail-closed on an unknown or non-overlapping name", () => {
    expect(namesCompatible(null, "Rova")).toBe(false);
    expect(namesCompatible("Rova", null)).toBe(false);
    expect(namesCompatible("Awa Ba", "Fatou Sow")).toBe(false);
  });
  it("ignores accents and case", () => {
    expect(namesCompatible("ROVA rajaonah", "rôva Rajaonah")).toBe(true);
  });
});

describe("matchBooking — evidence hierarchy", () => {
  it("1. an Awa booking with the same wix_booking_id wins", () => {
    const idx = index({
      byAwaBookingId: new Map([["b1", "client-awa"]]),
      byContactId: new Map([["c1", "client-contact"]]),
    });
    expect(matchBooking(snap({ contactId: "c1" }), idx)).toEqual({
      clientId: "client-awa",
      basis: "awa_booking",
    });
  });

  it("2. a proven contact link wins over phone", () => {
    const idx = index({
      byContactId: new Map([["c1", "client-contact"]]),
      byPhoneKey: new Map([["221771234567", "client-phone"]]),
      clientNames: new Map([["client-phone", "Rova"]]),
    });
    expect(
      matchBooking(snap({ contactId: "c1", clientPhone: "+221771234567", clientName: "Rova" }), idx),
    ).toEqual({ clientId: "client-contact", basis: "contact_id" });
  });

  it("3. a unique phone with a compatible name matches", () => {
    const idx = index({
      byPhoneKey: new Map([["221771234567", "client-phone"]]),
      clientNames: new Map([["client-phone", "Rova Rajaonah"]]),
    });
    expect(
      matchBooking(snap({ clientPhone: "77 123 45 67", clientName: "Rova" }), idx),
    ).toEqual({ clientId: "client-phone", basis: "phone" });
  });

  it("refuses a phone shared by several clients (ambiguous → null)", () => {
    const idx = index({
      byPhoneKey: new Map([["221771234567", null]]), // ambiguous
      clientNames: new Map(),
    });
    expect(matchBooking(snap({ clientPhone: "+221771234567", clientName: "Rova" }), idx)).toEqual({
      clientId: null,
      basis: null,
    });
  });

  it("refuses a unique phone when the name does not match (kid under parent)", () => {
    const idx = index({
      byPhoneKey: new Map([["221771234567", "parent"]]),
      clientNames: new Map([["parent", "Mariata Kane"]]),
    });
    expect(
      matchBooking(snap({ clientPhone: "+221771234567", clientName: "Boubacar Kane" }), idx),
    ).toEqual({ clientId: "parent", basis: "phone" }); // shared token "kane" → compatible
    expect(
      matchBooking(snap({ clientPhone: "+221771234567", clientName: "Awa Diop" }), idx),
    ).toEqual({ clientId: null, basis: null }); // no shared token → unmatched
  });
});

describe("matchPlanOrder", () => {
  it("prefers a member link, then contact, then phone", () => {
    const idx = index({
      byMemberId: new Map([["m1", "by-member"]]),
      byContactId: new Map([["c1", "by-contact"]]),
    });
    expect(matchPlanOrder({ memberId: "m1", contactId: "c1", buyerName: null, buyerPhone: null }, idx))
      .toEqual({ clientId: "by-member", basis: "awa_order" });
    expect(matchPlanOrder({ memberId: null, contactId: "c1", buyerName: null, buyerPhone: null }, idx))
      .toEqual({ clientId: "by-contact", basis: "contact_id" });
  });
});

describe("planOrderRowFromWix", () => {
  it("extracts the exact plan name, amount and status", () => {
    const row = planOrderRowFromWix({
      id: "ord_1",
      planId: "plan_1",
      planName: "L'Invitée — Clé 3 séances",
      status: "ACTIVE",
      buyer: { memberId: "m1", contactId: "c1", phone: "+221771234567", fullName: "Rova" },
      priceDetails: { total: 45000, currency: "XOF" },
      startDate: "2026-08-01T00:00:00Z",
      createdDate: "2026-07-30T10:00:00Z",
      wixPayOrderId: "ecom_9",
    });
    expect(row).toMatchObject({
      orderId: "ord_1",
      planName: "L'Invitée — Clé 3 séances",
      amountXof: 45000,
      orderStatus: "ACTIVE",
      memberId: "m1",
      contactId: "c1",
      wixPayOrderId: "ecom_9",
    });
  });
  it("returns null without an order id", () => {
    expect(planOrderRowFromWix({ planName: "x" })).toBeNull();
  });
});

describe("Wix retry backoff", () => {
  it("parses Retry-After delta-seconds and HTTP dates", () => {
    expect(parseRetryAfterMs("2")).toBe(2000);
    expect(parseRetryAfterMs(null)).toBeNull();
    const now = Date.parse("2026-08-16T10:00:00Z");
    expect(parseRetryAfterMs("Sun, 16 Aug 2026 10:00:05 GMT", now)).toBe(5000);
  });
  it("honors Retry-After but stays bounded and never below exponential", () => {
    expect(wixBackoffMs(0, null)).toBe(500);
    expect(wixBackoffMs(3, null)).toBe(4000);
    expect(wixBackoffMs(0, 2000)).toBe(2000); // server hint wins when larger
    expect(wixBackoffMs(0, 60_000)).toBe(30_000); // capped
    expect(wixBackoffMs(5, null)).toBe(8000); // exponential ceiling
  });
});
