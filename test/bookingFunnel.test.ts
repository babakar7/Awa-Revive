import { describe, expect, it } from "vitest";
import {
  calculateBookingConversion,
  isDuplicateFunnelEvent,
  normalizeBookingFailureCode,
  sanitizeBookingFunnelMetadata,
  selectJourneyCandidate,
  shouldExcludeBookingFunnelClient,
  type BookingFunnelEvent,
} from "../src/domain/bookingFunnel.js";
import { nextSevenDayWindow } from "../src/agent/tools.js";
import { orderedPaymentMethodOptions } from "../src/lib/paymentMethod.js";
import { renderConversionPage } from "../src/admin/conversionPage.js";

function event(
  journey: string,
  stage: BookingFunnelEvent["stage"],
  overrides: Partial<BookingFunnelEvent> = {},
): BookingFunnelEvent {
  return {
    journey_id: journey,
    client_id: `client-${journey}`,
    booking_id: null,
    stage,
    payment_method: null,
    failure_code: null,
    metadata_json: {},
    idempotency_key: null,
    is_excluded: false,
    occurred_at: new Date("2026-07-20T10:00:00Z"),
    ...overrides,
  };
}

describe("booking funnel correlation", () => {
  it("prefers a booking match, otherwise the latest open journey inside 24h", () => {
    const now = new Date("2026-07-20T12:00:00Z");
    const candidates = [
      { id: "old", status: "open" as const, last_event_at: new Date("2026-07-19T10:00:00Z") },
      { id: "recent", status: "open" as const, last_event_at: new Date("2026-07-20T11:00:00Z") },
      {
        id: "closed-booking",
        status: "failed" as const,
        last_event_at: new Date("2026-07-18T11:00:00Z"),
        booking_ids: ["booking-1"],
      },
    ];
    expect(selectJourneyCandidate(candidates, { bookingId: "booking-1", occurredAt: now })?.id).toBe(
      "closed-booking",
    );
    expect(selectJourneyCandidate(candidates, { occurredAt: now })?.id).toBe("recent");
    expect(
      selectJourneyCandidate(candidates.slice(0, 1), { occurredAt: now }),
    ).toBeNull();
  });

  it("recognizes idempotency keys deterministically", () => {
    expect(isDuplicateFunnelEvent(["booking:1:paid"], "booking:1:paid")).toBe(true);
    expect(isDuplicateFunnelEvent(["booking:1:paid"], "booking:1:booked")).toBe(false);
    expect(isDuplicateFunnelEvent(["booking:1:paid"], null)).toBe(false);
  });
});

describe("booking funnel normalization and privacy", () => {
  it("normalizes provider and business errors into a bounded code set", () => {
    expect(normalizeBookingFailureCode("slot_full")).toBe("slot_unavailable");
    expect(normalizeBookingFailureCode("Wix create booking timeout")).toBe("wix_booking_failed");
    expect(normalizeBookingFailureCode("callback_signature_mismatch")).toBe(
      "payment_verification_failed",
    );
    expect(normalizeBookingFailureCode("something brand new")).toBe("unknown");
  });

  it("excludes staff/test clients and strips transcript/link-like metadata", () => {
    expect(shouldExcludeBookingFunnelClient(true)).toBe(true);
    expect(shouldExcludeBookingFunnelClient(false)).toBe(false);
    expect(
      sanitizeBookingFunnelMetadata({
        service_id: "svc-1",
        payment_link: "https://secret.example",
        transcript: "client words",
        amount_xof: 12000,
      }),
    ).toEqual({ service_id: "svc-1", amount_xof: 12000 });
  });
});

describe("booking conversion calculations", () => {
  it("counts unique journeys, method performance, and post-nudge recovery", () => {
    const events: BookingFunnelEvent[] = [
      event("a", "availability_requested"),
      event("a", "slots_shown"),
      event("a", "slot_selected"),
      event("a", "payment_link_created", { payment_method: "wave" }),
      event("a", "payment_confirmed", { payment_method: "wave" }),
      event("a", "booked", { payment_method: "wave" }),
      event("b", "availability_requested"),
      event("b", "slots_shown"),
      event("b", "slot_selected"),
      event("b", "payment_link_created", { payment_method: "maxit" }),
      event("b", "expired", { payment_method: "maxit" }),
      event("b", "recovery_sent", {
        payment_method: "maxit",
        occurred_at: new Date("2026-07-20T11:00:00Z"),
      }),
      event("b", "booked", {
        payment_method: "maxit",
        occurred_at: new Date("2026-07-20T12:00:00Z"),
      }),
      event("test", "availability_requested", { is_excluded: true }),
      event("test", "booked", { is_excluded: true }),
    ];
    const metrics = calculateBookingConversion(events);
    expect(metrics.journeys).toBe(2);
    expect(metrics.overallConversion).toBe(100);
    expect(metrics.paymentLinkToBooked).toBe(100);
    expect(metrics.expiryRecovery).toEqual({
      expired: 1,
      recoverySent: 1,
      recoveredBookings: 1,
      recoveryRate: 100,
    });
    expect(metrics.paymentMethods.find((row) => row.method === "wave")).toMatchObject({
      links: 1,
      confirmed: 1,
      booked: 1,
    });
  });
});

describe("booking conversion quick wins", () => {
  it("builds exactly the following seven-day window", () => {
    expect(nextSevenDayWindow("2026-07-20T23:59:59Z")).toEqual({
      dateFrom: "2026-07-21T00:00:00Z",
      dateTo: "2026-07-27T23:59:59Z",
    });
  });

  it("puts the last successful payment method first without choosing it", () => {
    expect(orderedPaymentMethodOptions("maxit").map((option) => option.method)).toEqual([
      "maxit",
      "wave",
      "orange_money",
    ]);
    expect(orderedPaymentMethodOptions(null).map((option) => option.method)).toEqual([
      "wave",
      "orange_money",
      "maxit",
    ]);
  });

  it("renders incident links and escapes client-controlled labels", () => {
    const empty = calculateBookingConversion([]);
    const html = renderConversionPage({
      sevenDays: empty,
      thirtyDays: empty,
      incidents: [
        {
          booking_id: "booking-1",
          client_id: "client-1",
          client_name: "<script>Awa</script>",
          service_name: "Pilates",
          status: "REFUND_NEEDED",
          payment_method: "wave",
          amount_xof: 12000,
          updated_at: new Date("2026-07-20T12:00:00Z"),
        },
      ],
      recentFailures: [],
    });
    expect(html).toContain('/admin/conversations/client-1');
    expect(html).toContain("&lt;script&gt;Awa&lt;/script&gt;");
    expect(html).not.toContain("<script>Awa</script>");
    expect(html).toContain("équipe/tests exclus");
  });
});
