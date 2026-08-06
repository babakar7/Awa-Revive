import { describe, expect, it } from "vitest";
import { resolveMassageUnitPricePure } from "../src/domain/massageMemberRate.js";

const MASSAGE = "massage-service-id";
const HABITUEE = "plan-habituee";
const RESIDENTE = "plan-residente";
const CUSTOM_3X = "plan-custom-3x";

const cfg = {
  serviceIds: [MASSAGE],
  memberPlanIds: [HABITUEE, RESIDENTE, CUSTOM_3X],
  memberXof: 25_000,
};

const resolve = (activePlanIds: string[], overrides: Partial<typeof cfg> = {}) =>
  resolveMassageUnitPricePure({
    serviceId: MASSAGE,
    catalogPriceXof: 35_000,
    activePlanIds,
    config: { ...cfg, ...overrides },
  });

describe("resolveMassageUnitPricePure", () => {
  it("charges the member rate to a qualifying subscriber", () => {
    expect(resolve([HABITUEE])).toEqual({ unitXof: 25_000, memberRateApplied: true });
    expect(resolve([RESIDENTE])).toEqual({ unitXof: 25_000, memberRateApplied: true });
    expect(resolve([CUSTOM_3X])).toEqual({ unitXof: 25_000, memberRateApplied: true });
  });

  it("applies the rate when at least one of several plans qualifies", () => {
    expect(resolve(["plan-invitee", RESIDENTE])).toEqual({ unitXof: 25_000, memberRateApplied: true });
  });

  it("charges the catalog price to a non-qualifying member (e.g. L'Invitée / session packs)", () => {
    expect(resolve(["plan-invitee"])).toEqual({ unitXof: 35_000, memberRateApplied: false });
    expect(resolve(["plan-aquabike-pack"])).toEqual({ unitXof: 35_000, memberRateApplied: false });
  });

  it("charges the catalog price when the client holds no plan", () => {
    expect(resolve([])).toEqual({ unitXof: 35_000, memberRateApplied: false });
  });

  it("never touches a non-massage service, even for a qualifying member", () => {
    expect(
      resolveMassageUnitPricePure({
        serviceId: "some-pilates-class",
        catalogPriceXof: 12_000,
        activePlanIds: [HABITUEE],
        config: cfg,
      }),
    ).toEqual({ unitXof: 12_000, memberRateApplied: false });
  });

  it("is inert when no massage service is configured (feature dark)", () => {
    expect(resolve([HABITUEE], { serviceIds: [] })).toEqual({ unitXof: 35_000, memberRateApplied: false });
  });

  it("is inert when no qualifying plans are configured", () => {
    expect(resolve([HABITUEE], { memberPlanIds: [] })).toEqual({ unitXof: 35_000, memberRateApplied: false });
  });

  it("never overcharges: a misconfigured rate >= catalog falls back to catalog", () => {
    expect(resolve([HABITUEE], { memberXof: 40_000 })).toEqual({ unitXof: 35_000, memberRateApplied: false });
    expect(resolve([HABITUEE], { memberXof: 35_000 })).toEqual({ unitXof: 35_000, memberRateApplied: false });
  });

  it("ignores a zero/negative configured rate", () => {
    expect(resolve([HABITUEE], { memberXof: 0 })).toEqual({ unitXof: 35_000, memberRateApplied: false });
  });
});
