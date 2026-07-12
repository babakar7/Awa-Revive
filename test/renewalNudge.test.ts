import { describe, expect, it } from "vitest";
import { renewalNudgeCandidates } from "../src/domain/renewalNudge.js";

const now = new Date("2026-07-12T10:00:00Z");
const order = (over: Record<string, unknown>) => ({
  id: "ord_1",
  planName: "Illimité mensuel",
  buyer: { contactId: "c_1" },
  ...over,
});

describe("renewalNudgeCandidates", () => {
  it("keeps an order ending within the window (J-3)", () => {
    const out = renewalNudgeCandidates([order({ endDate: "2026-07-14T10:00:00Z" })], now, 3);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ orderId: "ord_1", contactId: "c_1", planName: "Illimité mensuel" });
  });

  it("keeps an order ending exactly at now and exactly at the horizon (inclusive bounds)", () => {
    const atNow = order({ id: "a", endDate: "2026-07-12T10:00:00Z" });
    const atHorizon = order({ id: "b", endDate: "2026-07-15T10:00:00Z" });
    const out = renewalNudgeCandidates([atNow, atHorizon], now, 3);
    expect(out.map((c) => c.orderId).sort()).toEqual(["a", "b"]);
  });

  it("drops an order ending beyond the window", () => {
    const out = renewalNudgeCandidates([order({ endDate: "2026-07-20T10:00:00Z" })], now, 3);
    expect(out).toHaveLength(0);
  });

  it("drops an order that already ended (in the past)", () => {
    const out = renewalNudgeCandidates([order({ endDate: "2026-07-10T10:00:00Z" })], now, 3);
    expect(out).toHaveLength(0);
  });

  it("skips valid-until-cancelled plans (no endDate) and orders missing ids", () => {
    const noEnd = order({ id: "x", endDate: undefined });
    const noContact = order({ id: "y", endDate: "2026-07-13T10:00:00Z", buyer: {} });
    const noId = order({ id: undefined, endDate: "2026-07-13T10:00:00Z" });
    const out = renewalNudgeCandidates([noEnd, noContact, noId], now, 3);
    expect(out).toHaveLength(0);
  });

  it("falls back to a default plan name when Wix returns none", () => {
    const out = renewalNudgeCandidates([order({ planName: undefined, endDate: "2026-07-13T10:00:00Z" })], now, 3);
    expect(out[0].planName).toBe("ton abonnement");
  });
});
