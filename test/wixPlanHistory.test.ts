import { afterEach, describe, expect, it } from "vitest";
import {
  hasPlanOrderHistory,
  latestPlanEndDateForPlans,
} from "../src/lib/wix.js";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function mockOrders(orders: any[]): void {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/pricing-plans/v2/orders")) {
      return new Response(
        JSON.stringify({ orders, pagingMetadata: { hasNext: false } }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    throw new Error(`Unexpected URL ${url}`);
  }) as typeof fetch;
}

describe("Wix plan history", () => {
  it("counts an ended or cancelled Pack/L'Invitée Wix order", async () => {
    mockOrders([
      {
        id: "old-pack-order",
        planId: "pack-plan",
        status: "CANCELED",
        buyer: { contactId: "contact-1", memberId: "member-1" },
      },
    ]);
    await expect(
      hasPlanOrderHistory({
        contactId: "contact-1",
        memberId: "member-1",
        planIds: ["pack-plan", "invitee-plan"],
      }),
    ).resolves.toBe(true);
  });

  it("does not confuse another contact's order with the client", async () => {
    mockOrders([
      {
        id: "other",
        planId: "invitee-plan",
        status: "ACTIVE",
        buyer: { contactId: "contact-2", memberId: "member-2" },
      },
    ]);
    await expect(
      hasPlanOrderHistory({
        contactId: "contact-1",
        memberId: "member-1",
        planIds: ["invitee-plan"],
      }),
    ).resolves.toBe(false);
  });

  it("chains only after the selected plan family, not a later Aquafitness plan", async () => {
    const now = Date.now();
    mockOrders([
      {
        id: "legacy",
        planId: "legacy-reformer",
        planName: "2x Reformer",
        endDate: new Date(now + 5 * 86_400_000).toISOString(),
        buyer: { contactId: "contact-1" },
      },
      {
        id: "aqua",
        planId: "aquafitness",
        planName: "Aquafitness",
        endDate: new Date(now + 30 * 86_400_000).toISOString(),
        buyer: { contactId: "contact-1" },
      },
    ]);
    const result = await latestPlanEndDateForPlans(
      "contact-1",
      ["legacy-reformer"],
    );
    expect(result).toBe(new Date(now + 5 * 86_400_000).toISOString());
  });
});
