import { afterEach, describe, expect, it, vi } from "vitest";
import {
  exactPlanPoolBalance,
  findExactBenefitWithFallback,
  redeemMembershipForBooking,
  type EligibleBenefit,
} from "../src/lib/wix.js";

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

const exact = (overrides: Partial<EligibleBenefit> = {}): EligibleBenefit => ({
  poolId: "pool-1",
  benefitKey: "benefit-1",
  memberId: "member-1",
  planName: "Clé 3 séances",
  planId: "plan-1",
  orderId: "order-1",
  available: 3,
  selectionSource: "exact_pool_fallback",
  ...overrides,
});

function response(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function installResolverMock(overrides: {
  eligible?: any[];
  balances?: any[];
  poolItems?: any[];
} = {}): string[] {
  const urls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    urls.push(url);
    if (url.includes("/members/v1/members/query")) {
      return response(200, { members: [{ id: "member-1" }] });
    }
    if (url.includes("/pools/eligible-pools")) {
      return response(200, { eligibleBenefits: overrides.eligible ?? [] });
    }
    if (url.includes("/balances/query")) {
      return response(200, {
        balances: overrides.balances ?? [{
          id: "pool-1",
          beneficiary: { memberId: "member-1" },
          amount: { available: "3" },
          poolInfo: {
            id: "pool-1",
            namespace: "@wix/pricing-plans",
            externalProgramDefinitionId: "plan-1",
            externalProgramId: "order-1",
            status: "ACTIVE",
          },
        }],
      });
    }
    if (url.includes("/pool-items/query")) {
      return response(200, {
        poolItems: overrides.poolItems ?? [{
          poolId: "pool-1",
          beneficiary: { memberId: "member-1" },
          externalProgramDefinitionId: "plan-1",
          externalProgramId: "order-1",
          providerAppId: "13d21c63-b5ec-5912-8397-c3a5ddb27a97",
          externalId: "service-1",
          namespace: "@wix/pricing-plans",
          benefitKey: "benefit-1",
          pool: { displayName: "Clé 3 séances" },
        }],
      });
    }
    throw new Error(`Unexpected URL ${url}`);
  }) as typeof fetch;
  return urls;
}

describe("findExactBenefitWithFallback", () => {
  it("keeps native eligible-pools selection when Wix returns the exact order", async () => {
    const urls = installResolverMock({
      eligible: [{
        poolId: "pool-1",
        benefitKey: "benefit-1",
        poolInfo: { displayName: "Clé", balance: { available: 3 } },
        programDefinitionInfo: { externalId: "plan-1" },
        programInfo: { externalId: "order-1" },
      }],
    });
    const benefit = await findExactBenefitWithFallback({
      serviceId: "service-1",
      contactId: "contact-1",
      memberId: "member-1",
      planId: "plan-1",
      orderId: "order-1",
    });
    expect(benefit?.selectionSource).toBe("eligible");
    expect(urls.some((url) => url.includes("/balances/query"))).toBe(false);
  });

  it("resolves one active, funded member/order pool connected to the exact service", async () => {
    installResolverMock();
    await expect(findExactBenefitWithFallback({
      serviceId: "service-1",
      contactId: "contact-1",
      memberId: "member-1",
      planId: "plan-1",
      orderId: "order-1",
      count: 1,
    })).resolves.toMatchObject({
      poolId: "pool-1",
      available: 3,
      selectionSource: "exact_pool_fallback",
    });
  });

  it.each([
    ["wrong member", { beneficiary: { memberId: "member-2" } }],
    ["wrong plan", { poolInfo: { id: "pool-1", namespace: "@wix/pricing-plans", externalProgramDefinitionId: "other", externalProgramId: "order-1", status: "ACTIVE" } }],
    ["wrong order", { poolInfo: { id: "pool-1", namespace: "@wix/pricing-plans", externalProgramDefinitionId: "plan-1", externalProgramId: "other", status: "ACTIVE" } }],
    ["inactive pool", { poolInfo: { id: "pool-1", namespace: "@wix/pricing-plans", externalProgramDefinitionId: "plan-1", externalProgramId: "order-1", status: "ENDED" } }],
    ["insufficient balance", { amount: { available: "0" } }],
  ])("fails closed for %s", async (_label, balancePatch) => {
    const base = {
      id: "pool-1",
      beneficiary: { memberId: "member-1" },
      amount: { available: "3" },
      poolInfo: { id: "pool-1", namespace: "@wix/pricing-plans", externalProgramDefinitionId: "plan-1", externalProgramId: "order-1", status: "ACTIVE" },
    };
    installResolverMock({ balances: [{ ...base, ...balancePatch }] });
    await expect(findExactBenefitWithFallback({
      serviceId: "service-1",
      contactId: "contact-1",
      memberId: "member-1",
      planId: "plan-1",
      orderId: "order-1",
    })).resolves.toBeNull();
  });

  it("fails closed for an unconnected service or multiple exact pools", async () => {
    installResolverMock({ poolItems: [] });
    await expect(findExactBenefitWithFallback({
      serviceId: "service-1", contactId: "contact-1", memberId: "member-1",
      planId: "plan-1", orderId: "order-1",
    })).resolves.toBeNull();

    const duplicate = {
      id: "pool-1", beneficiary: { memberId: "member-1" }, amount: { available: "3" },
      poolInfo: { id: "pool-1", namespace: "@wix/pricing-plans", externalProgramDefinitionId: "plan-1", externalProgramId: "order-1", status: "ACTIVE" },
    };
    installResolverMock({ balances: [duplicate, duplicate] });
    await expect(findExactBenefitWithFallback({
      serviceId: "service-1", contactId: "contact-1", memberId: "member-1",
      planId: "plan-1", orderId: "order-1",
    })).resolves.toBeNull();
  });
});

describe("exactPlanPoolBalance", () => {
  it("reports an authoritative zero for exactly one active pool", async () => {
    installResolverMock({
      balances: [{
        id: "pool-1",
        beneficiary: { memberId: "member-1" },
        amount: { available: "0" },
        poolInfo: {
          id: "pool-1",
          namespace: "@wix/pricing-plans",
          externalProgramDefinitionId: "plan-1",
          externalProgramId: "order-1",
          status: "ACTIVE",
        },
      }],
    });
    await expect(exactPlanPoolBalance({ memberId: "member-1", planId: "plan-1", orderId: "order-1" }))
      .resolves.toBe(0);
  });

  it("keeps missing or ambiguous pools unknown", async () => {
    installResolverMock({ balances: [] });
    await expect(exactPlanPoolBalance({ memberId: "member-1", planId: "plan-1", orderId: "order-1" }))
      .resolves.toBeNull();

    const duplicate = {
      id: "pool-1", beneficiary: { memberId: "member-1" }, amount: { available: "0" },
      poolInfo: { id: "pool-1", namespace: "@wix/pricing-plans", externalProgramDefinitionId: "plan-1", externalProgramId: "order-1", status: "ACTIVE" },
    };
    installResolverMock({ balances: [duplicate, duplicate] });
    await expect(exactPlanPoolBalance({ memberId: "member-1", planId: "plan-1", orderId: "order-1" }))
      .resolves.toBeNull();
  });
});

describe("exact-pool fallback redemption", () => {
  it("deducts only after native 428 and verifies the completed ledger transaction", async () => {
    const calls: Array<{ url: string; body: any }> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      calls.push({ url, body });
      if (url.includes("/benefits/redeem")) return response(428, { message: "not eligible" });
      if (url.includes("/balances/pool-1/change")) return response(200, { transactionId: "tx-1" });
      if (url.endsWith("/transactions/tx-1")) return response(200, { transaction: {
        id: "tx-1", pool: { id: "pool-1" }, beneficiary: { memberId: "member-1" },
        idempotencyKey: "awa-booking-booking-1-exact-pool", status: "COMPLETED",
        source: "AVAILABLE", target: "EXTERNAL", amount: "1",
      } });
      throw new Error(`Unexpected URL ${url}`);
    }) as typeof fetch;

    await expect(redeemMembershipForBooking({
      wixBookingId: "booking-1", serviceId: "service-1", benefit: exact(), count: 1,
    })).resolves.toMatchObject({ transactionId: "tx-1" });
    expect(calls.find((call) => call.url.includes("/balances/pool-1/change"))?.body)
      .toMatchObject({ type: "ADJUST", adjustOptions: { value: "-1" } });
  });

  it("recovers a timed-out or 409 balance change by its deterministic key", async () => {
    let changeCalls = 0;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/benefits/redeem")) return response(404, {});
      if (url.includes("/balances/pool-1/change")) {
        changeCalls++;
        throw new TypeError("network timeout after commit");
      }
      if (url.includes("/transactions/query")) return response(200, { transactions: [{
        id: "tx-recovered", pool: { id: "pool-1" }, beneficiary: { memberId: "member-1" },
        idempotencyKey: "awa-booking-booking-2-exact-pool", status: "COMPLETED",
        source: "AVAILABLE", target: "EXTERNAL", amount: "1",
      }] });
      throw new Error(`Unexpected URL ${url}`);
    }) as typeof fetch;
    await expect(redeemMembershipForBooking({
      wixBookingId: "booking-2", serviceId: "service-1", benefit: exact(),
    })).resolves.toMatchObject({ transactionId: "tx-recovered" });
    expect(changeCalls).toBe(1);
  });

  it("recovers the completed deduction after Wix answers 409 for the same key", async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/benefits/redeem")) return response(428, {});
      if (url.includes("/balances/pool-1/change")) return response(409, { message: "exists" });
      if (url.includes("/transactions/query")) return response(200, { transactions: [{
        id: "tx-existing", pool: { id: "pool-1" }, beneficiary: { memberId: "member-1" },
        idempotencyKey: "awa-booking-booking-409-exact-pool", status: "COMPLETED",
        source: "AVAILABLE", target: "EXTERNAL", amount: "1",
      }] });
      throw new Error(`Unexpected URL ${url}`);
    }) as typeof fetch;
    await expect(redeemMembershipForBooking({
      wixBookingId: "booking-409", serviceId: "service-1", benefit: exact(),
    })).resolves.toMatchObject({ transactionId: "tx-existing" });
  });

  it("never uses Change Balance after a native non-eligibility-unrelated failure", async () => {
    const urls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      urls.push(url);
      return response(500, { message: "outage" });
    }) as typeof fetch;
    await expect(redeemMembershipForBooking({
      wixBookingId: "booking-3", serviceId: "service-1", benefit: exact(),
    })).rejects.toThrow("(500)");
    expect(urls.some((url) => url.includes("/balances/") && url.endsWith("/change"))).toBe(false);
  });
});
