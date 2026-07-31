import { describe, expect, it } from "vitest";
import { dynamicContext } from "../src/agent/systemPrompt.js";

describe("expired plan payment context", () => {
  it("exposes the auditable order and initial slot without the expired URL", () => {
    const context = dynamicContext({
      clientName: "Awa",
      clientLanguage: "fr",
      activeBooking: null,
      activePlanOrder: null,
      activeCafeOrder: null,
      memberships: [],
      recentRefunds: [],
      expiredPlanOrder: {
        id: "11111111-1111-4111-8111-111111111111",
        plan_name: "L'Habituée",
        amount_xof: 75000,
        payment_method: "wave",
        link_expires_at: new Date("2026-07-30T12:00:00Z"),
        payment_link: "https://pay.wave.com/expired-secret",
        service_name: "Pilates Reformer (Sculpt)",
        slot_start: new Date("2026-08-02T10:00:00Z"),
      } as never,
    });
    expect(context).toContain("11111111-1111-4111-8111-111111111111");
    expect(context).toContain("refresh_expired_plan_payment_link");
    expect(context).toContain("Pilates Reformer (Sculpt)");
    expect(context).not.toContain("pay.wave.com");
  });
});
