import { describe, it, expect } from "vitest";
import { canTransition, TRANSITIONS, type BookingStatus } from "../src/domain/stateMachine.js";

const ALL: BookingStatus[] = ["DRAFT", "AWAITING_PAYMENT", "PAID", "BOOKED", "EXPIRED", "REFUND_NEEDED", "REFUNDED", "CANCELLED"];

describe("pending_bookings state machine (SPEC §5, §10.9)", () => {
  it("DRAFT → AWAITING_PAYMENT (payment link created)", () => {
    expect(canTransition("DRAFT", "AWAITING_PAYMENT")).toBe(true);
  });

  it("AWAITING_PAYMENT → EXPIRED (TTL passed)", () => {
    expect(canTransition("AWAITING_PAYMENT", "EXPIRED")).toBe(true);
  });

  it("AWAITING_PAYMENT → PAID (valid Wave webhook)", () => {
    expect(canTransition("AWAITING_PAYMENT", "PAID")).toBe(true);
  });

  it("PAID → BOOKED (slot free, Wix booking OK)", () => {
    expect(canTransition("PAID", "BOOKED")).toBe(true);
  });

  it("PAID → REFUND_NEEDED (slot gone or Wix error)", () => {
    expect(canTransition("PAID", "REFUND_NEEDED")).toBe(true);
  });

  it("EXPIRED → PAID (late payment is honored — SPEC §5 edge case)", () => {
    expect(canTransition("EXPIRED", "PAID")).toBe(true);
  });

  it("DRAFT → EXPIRED (superseded before a link was issued)", () => {
    expect(canTransition("DRAFT", "EXPIRED")).toBe(true);
  });

  it("payment-first invariant: BOOKED is only reachable from PAID", () => {
    for (const from of ALL) {
      expect(canTransition(from, "BOOKED")).toBe(from === "PAID");
    }
  });

  it("BOOKED → CANCELLED (Wix/reception or Awa) or REFUND_NEEDED (Awa cancels a Wave-paid booking ≥16h) and nothing else", () => {
    for (const to of ALL) {
      expect(canTransition("BOOKED", to)).toBe(to === "CANCELLED" || to === "REFUND_NEEDED");
    }
  });

  it("REFUND_NEEDED → REFUNDED (manual Wave refund done) and nothing else", () => {
    for (const to of ALL) {
      expect(canTransition("REFUND_NEEDED", to)).toBe(to === "REFUNDED");
    }
  });

  it("REFUNDED and CANCELLED are terminal", () => {
    for (const to of ALL) {
      expect(canTransition("REFUNDED", to)).toBe(false);
      expect(canTransition("CANCELLED", to)).toBe(false);
    }
  });

  it("a booking can never be paid twice (PAID → PAID is invalid — duplicate webhook)", () => {
    expect(canTransition("PAID", "PAID")).toBe(false);
  });

  it("no state transitions to itself (idempotent duplicate deliveries are no-ops)", () => {
    for (const s of ALL) {
      expect(canTransition(s, s)).toBe(false);
    }
  });

  it("transition table only contains known states", () => {
    for (const [from, tos] of Object.entries(TRANSITIONS)) {
      expect(ALL).toContain(from);
      for (const to of tos) expect(ALL).toContain(to);
    }
  });
});
