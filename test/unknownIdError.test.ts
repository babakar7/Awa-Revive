import { afterEach, describe, expect, it, vi } from "vitest";
import * as wix from "../src/lib/wix.js";
import { unknownServiceIdResult, unknownPlanIdResult } from "../src/agent/tools.js";

// Prod 01/08: the model called tools with invented ids ("sculpt",
// "invitee_key_id_placeholder"), costing an extra error→re-lookup round-trip.
// The unknown-id errors now return the live valid ids so the model self-heals in
// one turn — and those technical ids are only ever read by the model, never sent
// to the client.
afterEach(() => vi.restoreAllMocks());

describe("unknownServiceIdResult", () => {
  it("returns the valid service ids (capped) so the model can correct in one turn", async () => {
    const many = Array.from({ length: 25 }, (_, i) => ({
      id: `svc-${i}`,
      name: `Class ${i}`,
    }));
    vi.spyOn(wix, "listServices").mockResolvedValue(many as never);
    const parsed = JSON.parse(await unknownServiceIdResult());
    expect(parsed.error).toBe("unknown_service_id");
    expect(parsed.message).toMatch(/never invent/i);
    expect(parsed.valid_services).toHaveLength(20);
    expect(parsed.valid_services[0]).toEqual({ service_id: "svc-0", name: "Class 0" });
  });

  it("still returns an actionable error when the catalog fetch fails", async () => {
    vi.spyOn(wix, "listServices").mockRejectedValue(new Error("wix down"));
    const parsed = JSON.parse(await unknownServiceIdResult());
    expect(parsed.error).toBe("unknown_service_id");
    expect(parsed.valid_services).toEqual([]);
    expect(parsed.message).toMatch(/list_classes/);
  });
});

describe("unknownPlanIdResult", () => {
  it("returns the valid plan ids so the model stops guessing", async () => {
    vi.spyOn(wix, "listPlans").mockResolvedValue([
      { id: "plan-invitee", name: "L'Invitée — Clé 3 séances" },
    ] as never);
    const parsed = JSON.parse(await unknownPlanIdResult());
    expect(parsed.error).toBe("unknown_plan_id");
    expect(parsed.valid_plans).toEqual([
      { plan_id: "plan-invitee", name: "L'Invitée — Clé 3 séances" },
    ]);
  });

  it("degrades gracefully when the catalog fetch fails", async () => {
    vi.spyOn(wix, "listPlans").mockRejectedValue(new Error("wix down"));
    const parsed = JSON.parse(await unknownPlanIdResult());
    expect(parsed.error).toBe("unknown_plan_id");
    expect(parsed.valid_plans).toEqual([]);
    expect(parsed.message).toMatch(/list_plans/);
  });
});
