import { describe, expect, it } from "vitest";
import { deriveItemState } from "../src/domain/commitments.js";

/**
 * Pure per-item state derivation — the heart of the "state is derived, never
 * duplicated" design. Precedence:
 *   BOOKED → PAID/REFUND_NEEDED → AWAITING_PAYMENT/DRAFT → item intent.
 * EXPIRED-only attempts must leave the item retryable, not cancel it.
 */
describe("deriveItemState", () => {
  it("falls back to intent when there are no attempts", () => {
    expect(deriveItemState([], "PLANNED")).toBe("PLANNED");
    expect(deriveItemState([], "NEEDS_RESELECTION")).toBe("NEEDS_RESELECTION");
    expect(deriveItemState([], "CANCELLED")).toBe("CANCELLED");
  });

  it("treats EXPIRED-only attempts as retryable (intent wins, not cancelled)", () => {
    expect(deriveItemState(["EXPIRED"], "PLANNED")).toBe("PLANNED");
    expect(deriveItemState(["EXPIRED", "EXPIRED"], "NEEDS_RESELECTION")).toBe("NEEDS_RESELECTION");
    // REFUNDED/CANCELLED attempts are terminal & non-blocking too.
    expect(deriveItemState(["EXPIRED", "REFUNDED"], "PLANNED")).toBe("PLANNED");
  });

  it("surfaces a live DRAFT/AWAITING attempt", () => {
    expect(deriveItemState(["DRAFT"], "PLANNED")).toBe("AWAITING");
    expect(deriveItemState(["AWAITING_PAYMENT"], "PLANNED")).toBe("AWAITING");
    expect(deriveItemState(["EXPIRED", "AWAITING_PAYMENT"], "PLANNED")).toBe("AWAITING");
  });

  it("surfaces a PAID / REFUND_NEEDED attempt as needing attention", () => {
    expect(deriveItemState(["PAID"], "PLANNED")).toBe("PAID_PENDING");
    expect(deriveItemState(["REFUND_NEEDED"], "PLANNED")).toBe("PAID_PENDING");
    // PAID outranks a stale AWAITING on the same item.
    expect(deriveItemState(["AWAITING_PAYMENT", "PAID"], "PLANNED")).toBe("PAID_PENDING");
  });

  it("BOOKED always wins", () => {
    expect(deriveItemState(["BOOKED"], "PLANNED")).toBe("BOOKED");
    expect(deriveItemState(["EXPIRED", "BOOKED"], "PLANNED")).toBe("BOOKED");
    expect(deriveItemState(["PAID", "BOOKED"], "PLANNED")).toBe("BOOKED");
    // Even if the intent was somehow left NEEDS_RESELECTION, a booked attempt wins.
    expect(deriveItemState(["BOOKED"], "NEEDS_RESELECTION")).toBe("BOOKED");
  });
});
