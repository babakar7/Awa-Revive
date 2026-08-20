import { afterEach, describe, expect, it, vi } from "vitest";
import { listContactFutureMembershipBookings } from "../src/lib/wix.js";

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

function response(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

describe("future membership bookings", () => {
  it("keeps only confirmed future Wix MEMBERSHIP bookings", async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("extended-bookings/query")) {
        return response({
          extendedBookings: [
            { booking: { id: "membership", status: "CONFIRMED", selectedPaymentOption: "MEMBERSHIP", numberOfParticipants: 1, bookedEntity: { title: "Reformer", slot: { startDate: "2030-06-10T10:00:00.000Z", serviceId: "r" } } } },
            { booking: { id: "direct", status: "CONFIRMED", selectedPaymentOption: "OFFLINE", bookedEntity: { slot: { startDate: "2030-06-11T10:00:00.000Z" } } } },
            { booking: { id: "cancelled", status: "CANCELED", selectedPaymentOption: "MEMBERSHIP", bookedEntity: { slot: { startDate: "2030-06-12T10:00:00.000Z" } } } },
            { booking: { id: "refunded", status: "CONFIRMED", selectedPaymentOption: "MEMBERSHIP", paymentStatus: "REFUNDED", bookedEntity: { slot: { startDate: "2030-06-13T10:00:00.000Z" } } } },
          ],
        });
      }
      if (url.includes("/bookings/v2/services/query")) return response({ services: [] });
      throw new Error(`Unexpected Wix request: ${url}`);
    }) as typeof fetch;

    await expect(listContactFutureMembershipBookings("contact-1")).resolves.toEqual([
      expect.objectContaining({ id: "membership", serviceName: "Reformer", status: "CONFIRMED" }),
    ]);
  });
});
