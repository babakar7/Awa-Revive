import { describe, expect, it } from "vitest";
import { validateAddSpots } from "../src/agent/tools.js";

const NOW = new Date("2026-07-16T12:00:00Z");
const future = new Date(NOW.getTime() + 2 * 3600_000); // 2h away — inside 16h, still fine
const past = new Date(NOW.getTime() - 60_000);

type B = Parameters<typeof validateAddSpots>[0];
const booking = (over: Partial<NonNullable<B>> = {}): B => ({
  status: "BOOKED",
  slot_start: future,
  wix_booking_id: "wb_1",
  ...over,
});

describe("validateAddSpots", () => {
  it("accepts a confirmed future booking with a valid count", () => {
    expect(validateAddSpots(booking(), 2, NOW)).toEqual({ ok: true, extra: 2 });
  });

  it("accepts a class starting in 2h — NO 16h rule (it's a purchase, not a cancellation)", () => {
    expect(validateAddSpots(booking({ slot_start: future }), 1, NOW)).toEqual({ ok: true, extra: 1 });
  });

  it("rejects a missing booking", () => {
    expect(validateAddSpots(null, 2, NOW)).toMatchObject({ ok: false, error: "unknown_booking" });
  });

  it("rejects a non-confirmed booking (any status but BOOKED, or no wix id)", () => {
    for (const status of ["DRAFT", "AWAITING_PAYMENT", "CANCELLED", "EXPIRED", "REFUND_NEEDED"]) {
      expect(validateAddSpots(booking({ status }), 2, NOW)).toMatchObject({ ok: false, error: "not_confirmed" });
    }
    expect(validateAddSpots(booking({ wix_booking_id: null }), 2, NOW)).toMatchObject({
      ok: false,
      error: "not_confirmed",
    });
  });

  it("rejects a class that already started", () => {
    expect(validateAddSpots(booking({ slot_start: past }), 2, NOW)).toMatchObject({
      ok: false,
      error: "class_already_started",
    });
  });

  it("rejects invalid counts and accepts the bounds", () => {
    for (const bad of [0, -1, 11, NaN, "abc" as unknown, undefined]) {
      expect(validateAddSpots(booking(), bad, NOW)).toMatchObject({ ok: false, error: "invalid_participants" });
    }
    expect(validateAddSpots(booking(), 1, NOW)).toEqual({ ok: true, extra: 1 });
    expect(validateAddSpots(booking(), 10, NOW)).toEqual({ ok: true, extra: 10 });
    expect(validateAddSpots(booking(), 2.6, NOW)).toEqual({ ok: true, extra: 3 }); // rounded
  });
});
