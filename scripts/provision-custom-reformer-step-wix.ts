import "dotenv/config";
import { randomUUID } from "node:crypto";
import { config } from "../src/config.js";

const WIX_API = "https://www.wixapis.com";
const WIX_BOOKINGS_APP_ID = "13d21c63-b5ec-5912-8397-c3a5ddb27a97";
const PRICING_PLANS_NAMESPACE = "@wix/pricing-plans";

const spec = {
  name: "2x Reformer 1x Step",
  description:
    "12 séances · 30 jours — Reformer (Foundation/Sculpt/Intense) et Step. Accès piscine pendant toute la durée, serviette comprise, bibliothèque, massage au tarif membre, 1 invitation Reformer (12h30, lun–ven), 7 jours de plus sur demande avant expiration.",
  priceXof: 120_000,
  sessions: 12,
  serviceIds: [
    "32c617a0-eaa1-4acf-b2bd-e33f6dc39d10",
    "5dd24cf8-1e8d-472f-ac93-80ae7e94f379",
    "6ee0808a-e54d-4974-8efd-75a16b434959",
    "d30d95d4-2209-4a46-89ab-c823b73c6521",
  ],
} as const;

const apply = process.argv.includes("--apply");

function headers(): Record<string, string> {
  return {
    Authorization: config.WIX_API_KEY,
    "wix-site-id": config.WIX_SITE_ID,
    "Content-Type": "application/json",
    "User-Agent": "resabot-custom-plan-provisioner/1.0",
  };
}

async function wix(path: string, init: RequestInit): Promise<any> {
  const response = await fetch(`${WIX_API}${path}`, {
    ...init,
    headers: { ...headers(), ...(init.headers ?? {}) },
    signal: AbortSignal.timeout(15_000),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`Wix ${path} failed (${response.status}): ${text}`);
  return text ? JSON.parse(text) : {};
}

async function queryPlans(): Promise<any[]> {
  const data = await wix("/pricing-plans/v3/plans/query", {
    method: "POST",
    body: JSON.stringify({ query: { paging: { limit: 100 } } }),
  });
  return data.plans ?? [];
}

async function createPlan(): Promise<any> {
  const data = await wix("/pricing-plans/v3/plans", {
    method: "POST",
    body: JSON.stringify({
      plan: {
        name: spec.name,
        description: spec.description,
        maxPurchasesPerBuyer: 0,
        pricingVariants: [{
          id: randomUUID(), name: spec.name,
          billingTerms: { billingCycle: { period: "MONTH", count: 1 }, startType: "CUSTOM", endType: "CYCLES_COMPLETED", cyclesCompletedDetails: { billingCycleCount: 1 } },
          pricingStrategies: [{ flatRate: { amount: String(spec.priceXof) } }], visible: true,
        }],
        perks: [{ id: randomUUID(), description: spec.description }],
        visibility: "PUBLIC", buyable: true, status: "ACTIVE", buyerCanCancel: false,
      },
      idempotencyKey: randomUUID(),
    }),
  });
  if (!data.plan?.id) throw new Error("Create Plan returned no plan id");
  return data.plan;
}

async function getProgramDefinition(planId: string): Promise<any> {
  const query = new URLSearchParams({ namespace: PRICING_PLANS_NAMESPACE, externalId: planId });
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    try {
      const data = await wix(`/_api/benefit-programs/v1/program-definitions/by-namespace-and-external-id?${query}`, { method: "GET" });
      if (data.programDefinition?.id) return data.programDefinition;
    } catch (error) { if (attempt === 5) throw error; }
    await new Promise((resolve) => setTimeout(resolve, attempt * 1_000));
  }
  throw new Error(`No Pricing Plans program definition for ${planId}`);
}

async function queryPoolDefinitions(programDefinitionId: string): Promise<any[]> {
  const data = await wix("/_api/benefit-programs/v1/pool-definitions/query", {
    method: "POST",
    body: JSON.stringify({ query: { filter: { programDefinitionIds: { $hasSome: [programDefinitionId] } }, paging: { limit: 100 } } }),
  });
  return data.poolDefinitions ?? [];
}

async function createPoolDefinition(programDefinitionId: string): Promise<any> {
  const data = await wix("/_api/benefit-programs/v1/pool-definitions", {
    method: "POST",
    body: JSON.stringify({
      poolDefinition: {
        displayName: spec.name, namespace: PRICING_PLANS_NAMESPACE, programDefinitionIds: [programDefinitionId],
        details: {
          benefits: [{ benefitKey: randomUUID(), price: "1", providerAppId: WIX_BOOKINGS_APP_ID, displayName: spec.name }],
          creditConfiguration: { amount: String(spec.sessions), rolloverConfiguration: { enabled: false }, unitType: "PUNCH_CARD" },
          policyExpression: { type: "OPERATOR_AND", operatorAndOptions: { expressions: [
            { type: "POLICY", policyOptions: { type: "CUSTOM", customOptions: { id: "00000000-0000-0000-0000-000000000000", appId: WIX_BOOKINGS_APP_ID } } },
            { type: "POLICY", policyOptions: { type: "CUSTOM", customOptions: { id: "00000000-0000-0000-0000-000000000000", appId: "1522827f-c56c-a5c9-2ac9-00f9e6ae12d3" } } },
          ] } },
        },
        description: spec.description,
      }, cascade: "IMMEDIATELY",
    }),
  });
  if (!data.poolDefinition?.id) throw new Error("Create Pool Definition returned no id");
  return data.poolDefinition;
}

async function queryBenefitItems(itemSetId: string): Promise<any[]> {
  const data = await wix("/benefit-programs/v1/items/query", {
    method: "POST", body: JSON.stringify({ query: { filter: { itemSetId: { $eq: itemSetId } }, paging: { limit: 100 } } }),
  });
  return data.items ?? [];
}

async function createBenefitItem(serviceId: string, itemSetId: string): Promise<void> {
  await wix("/benefit-programs/v1/items", { method: "POST", body: JSON.stringify({ item: { externalId: serviceId, itemSetId, providerAppId: WIX_BOOKINGS_APP_ID, namespace: PRICING_PLANS_NAMESPACE } }) });
}

async function enablePlanForService(serviceId: string, planId: string): Promise<void> {
  await wix(`/_api/bookings/v2/services/${serviceId}/pricing-plans/add`, { method: "POST", body: JSON.stringify({ pricingPlanIds: [planId] }) });
}

async function ensureBenefit(planId: string): Promise<{ poolDefinitionId: string; itemSetId: string }> {
  const programDefinition = await getProgramDefinition(planId);
  const pools = await queryPoolDefinitions(programDefinition.id);
  if (pools.length > 1) throw new Error("Several pool definitions exist; refusing to guess");
  const pool = pools[0] ?? await createPoolDefinition(programDefinition.id);
  const itemSetId = pool.details?.benefits?.[0]?.itemSetId;
  if (!itemSetId) throw new Error("Pool definition has no itemSetId");
  if (Number(pool.details?.creditConfiguration?.amount) !== spec.sessions) throw new Error(`Expected ${spec.sessions} credits in the pool`);
  const items = await queryBenefitItems(itemSetId);
  const existingServiceIds = new Set(items.map((item) => String(item.externalId)));
  for (const serviceId of spec.serviceIds) {
    if (!existingServiceIds.has(serviceId)) await createBenefitItem(serviceId, itemSetId);
    await enablePlanForService(serviceId, planId);
  }
  return { poolDefinitionId: pool.id, itemSetId };
}

async function main(): Promise<void> {
  const plans = await queryPlans();
  const matchingPlans = plans.filter((plan) => plan.name === spec.name && !plan.archived);
  if (matchingPlans.length > 1) throw new Error(`Duplicate active plan name: ${spec.name}`);
  if (!apply) {
    console.log(JSON.stringify({ mode: "dry-run", existingPlanId: matchingPlans[0]?.id ?? null, spec }, null, 2));
    return;
  }
  const plan = matchingPlans[0] ?? await createPlan();
  const configuredPrice = Number(plan.pricingVariants?.[0]?.pricingStrategies?.[0]?.flatRate?.amount);
  if (configuredPrice !== spec.priceXof) throw new Error(`Expected plan price ${spec.priceXof}, found ${configuredPrice}`);
  const benefit = await ensureBenefit(plan.id);
  console.log(JSON.stringify({ created: matchingPlans.length === 0, planId: plan.id, name: plan.name, priceXof: spec.priceXof, sessions: spec.sessions, serviceIds: spec.serviceIds, ...benefit }, null, 2));
}

main().catch((error) => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
