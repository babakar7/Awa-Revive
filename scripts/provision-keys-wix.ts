import "dotenv/config";
import { randomUUID } from "node:crypto";
import { config } from "../src/config.js";

const WIX_API = "https://www.wixapis.com";
const WIX_BOOKINGS_APP_ID = "13d21c63-b5ec-5912-8397-c3a5ddb27a97";
const PRICING_PLANS_NAMESPACE = "@wix/pricing-plans";

const REFORMER_SERVICE_IDS = [
  "0680b335-73db-41dc-8baf-a460dc796318",
  "32c617a0-eaa1-4acf-b2bd-e33f6dc39d10",
  "5dd24cf8-1e8d-472f-ac93-80ae7e94f379",
  "6ee0808a-e54d-4974-8efd-75a16b434959",
  "dfe638e5-0884-40cd-9dc0-4b816b5dc3d7",
] as const;

const BONUS_SERVICE_IDS = [
  "03200531-2229-4f36-bb26-b320d795a77a",
  "2e22790b-5582-46d2-b3bf-118e0826298f",
  "70693079-5c72-4360-908b-efd3c1b8e047",
  "7953e5f9-ce95-475d-a265-7219a13abdae",
  "d30d95d4-2209-4a46-89ab-c823b73c6521",
] as const;

type KeyPlanSpec = {
  code: "INVITEE" | "HABITUEE" | "RESIDENTE";
  name: string;
  description: string;
  days: number;
  priceXof: number;
  sessions: number;
  kind: "KEY" | "BONUS";
  maxPurchasesPerBuyer: number;
};

const specs: KeyPlanSpec[] = [
  {
    code: "INVITEE",
    name: "L'Invitée — Clé 3 séances",
    description: "3 séances Reformer · valable 21 jours",
    days: 21,
    priceXof: 30_000,
    sessions: 3,
    kind: "KEY",
    maxPurchasesPerBuyer: 1,
  },
  {
    code: "HABITUEE",
    name: "L'Habituée — Clé 6 séances",
    description: "6 séances Reformer · valable 30 jours",
    days: 30,
    priceXof: 72_000,
    sessions: 6,
    kind: "KEY",
    maxPurchasesPerBuyer: 0,
  },
  {
    code: "RESIDENTE",
    name: "La Résidente — Clé 12 séances",
    description: "12 séances Reformer · valable 60 jours",
    days: 60,
    priceXof: 144_000,
    sessions: 12,
    kind: "KEY",
    maxPurchasesPerBuyer: 0,
  },
  {
    code: "INVITEE",
    name: "Cours en plus — L'Invitée",
    description: "1 cours bonus Aquabike, Yoga, Mat ou Step · valable 21 jours",
    days: 21,
    priceXof: 0,
    sessions: 1,
    kind: "BONUS",
    maxPurchasesPerBuyer: 0,
  },
  {
    code: "HABITUEE",
    name: "Cours en plus — L'Habituée",
    description: "1 cours bonus Aquabike, Yoga, Mat ou Step · valable 30 jours",
    days: 30,
    priceXof: 0,
    sessions: 1,
    kind: "BONUS",
    maxPurchasesPerBuyer: 0,
  },
  {
    code: "RESIDENTE",
    name: "Cours en plus — La Résidente",
    description: "2 cours bonus Aquabike, Yoga, Mat ou Step · valables 60 jours",
    days: 60,
    priceXof: 0,
    sessions: 2,
    kind: "BONUS",
    maxPurchasesPerBuyer: 0,
  },
];

function headers(): Record<string, string> {
  return {
    Authorization: config.WIX_API_KEY,
    "wix-site-id": config.WIX_SITE_ID,
    "Content-Type": "application/json",
    "User-Agent": "resabot-key-provisioner/1.0",
  };
}

async function wix(path: string, init: RequestInit): Promise<any> {
  const response = await fetch(`${WIX_API}${path}`, {
    ...init,
    headers: { ...headers(), ...(init.headers ?? {}) },
    signal: AbortSignal.timeout(15_000),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Wix ${path} failed (${response.status}): ${text}`);
  }
  return text ? JSON.parse(text) : {};
}

async function queryPlans(): Promise<any[]> {
  const data = await wix("/pricing-plans/v3/plans/query", {
    method: "POST",
    body: JSON.stringify({ query: { paging: { limit: 100 } } }),
  });
  return data.plans ?? [];
}

async function createPrivatePlan(spec: KeyPlanSpec): Promise<any> {
  const variantId = randomUUID();
  const data = await wix("/pricing-plans/v3/plans", {
    method: "POST",
    body: JSON.stringify({
      plan: {
        name: spec.name,
        description: spec.description,
        maxPurchasesPerBuyer: spec.maxPurchasesPerBuyer,
        pricingVariants: [
          {
            id: variantId,
            name: spec.name,
            billingTerms: {
              billingCycle: { period: "DAY", count: spec.days },
              startType: "ON_PURCHASE",
              endType: "CYCLES_COMPLETED",
              cyclesCompletedDetails: { billingCycleCount: 1 },
            },
            pricingStrategies: [{ flatRate: { amount: String(spec.priceXof) } }],
            visible: true,
          },
        ],
        perks: [{ id: randomUUID(), description: spec.description }],
        visibility: "PRIVATE",
        buyable: true,
        status: "ACTIVE",
        buyerCanCancel: false,
      },
      idempotencyKey: randomUUID(),
    }),
  });
  if (!data.plan?.id) {
    throw new Error(`Create Plan returned no plan id for ${spec.name}`);
  }
  return data.plan;
}

async function ensurePurchaseLimit(spec: KeyPlanSpec, plan: any): Promise<any> {
  if (Number(plan.maxPurchasesPerBuyer ?? 0) === spec.maxPurchasesPerBuyer) {
    return plan;
  }
  const data = await wix(`/pricing-plans/v3/plans/${plan.id}`, {
    method: "PATCH",
    body: JSON.stringify({
      plan: {
        id: plan.id,
        revision: String(plan.revision),
        maxPurchasesPerBuyer: spec.maxPurchasesPerBuyer,
      },
    }),
  });
  if (!data.plan?.id) throw new Error(`Update Plan returned no plan for ${spec.name}`);
  return data.plan;
}

async function getProgramDefinition(planId: string): Promise<any> {
  const query = new URLSearchParams({
    namespace: PRICING_PLANS_NAMESPACE,
    externalId: planId,
  });
  const data = await wix(
    `/_api/benefit-programs/v1/program-definitions/by-namespace-and-external-id?${query}`,
    { method: "GET" },
  );
  if (!data.programDefinition?.id) {
    throw new Error(`No Pricing Plans program definition for ${planId}`);
  }
  return data.programDefinition;
}

async function queryPoolDefinitions(programDefinitionId: string): Promise<any[]> {
  const data = await wix("/_api/benefit-programs/v1/pool-definitions/query", {
    method: "POST",
    body: JSON.stringify({
      query: {
        filter: { programDefinitionIds: { $hasSome: [programDefinitionId] } },
        paging: { limit: 100 },
      },
    }),
  });
  return data.poolDefinitions ?? [];
}

async function createPoolDefinition(spec: KeyPlanSpec, programDefinitionId: string): Promise<any> {
  const benefitKey = randomUUID();
  const data = await wix("/_api/benefit-programs/v1/pool-definitions", {
    method: "POST",
    body: JSON.stringify({
      poolDefinition: {
        displayName: spec.name,
        namespace: PRICING_PLANS_NAMESPACE,
        programDefinitionIds: [programDefinitionId],
        details: {
          benefits: [
            {
              benefitKey,
              price: "1",
              providerAppId: WIX_BOOKINGS_APP_ID,
              displayName: spec.name,
            },
          ],
          creditConfiguration: {
            amount: String(spec.sessions),
            rolloverConfiguration: { enabled: false },
            unitType: "PUNCH_CARD",
          },
          policyExpression: {
            type: "OPERATOR_AND",
            operatorAndOptions: {
              expressions: [
                {
                  type: "POLICY",
                  policyOptions: {
                    type: "CUSTOM",
                    customOptions: {
                      id: "00000000-0000-0000-0000-000000000000",
                      appId: WIX_BOOKINGS_APP_ID,
                    },
                  },
                },
                {
                  type: "POLICY",
                  policyOptions: {
                    type: "CUSTOM",
                    customOptions: {
                      id: "00000000-0000-0000-0000-000000000000",
                      appId: "1522827f-c56c-a5c9-2ac9-00f9e6ae12d3",
                    },
                  },
                },
              ],
            },
          },
        },
        description: spec.description,
      },
      cascade: "IMMEDIATELY",
    }),
  });
  if (!data.poolDefinition?.id) {
    throw new Error(`Create Pool Definition returned no id for ${spec.name}`);
  }
  return data.poolDefinition;
}

async function queryBenefitItems(itemSetId: string): Promise<any[]> {
  const data = await wix("/benefit-programs/v1/items/query", {
    method: "POST",
    body: JSON.stringify({
      query: { filter: { itemSetId: { $eq: itemSetId } }, paging: { limit: 100 } },
    }),
  });
  return data.items ?? [];
}

async function createBenefitItem(serviceId: string, itemSetId: string): Promise<void> {
  await wix("/benefit-programs/v1/items", {
    method: "POST",
    body: JSON.stringify({
      item: {
        externalId: serviceId,
        itemSetId,
        providerAppId: WIX_BOOKINGS_APP_ID,
        namespace: PRICING_PLANS_NAMESPACE,
      },
    }),
  });
}

async function enablePlanForService(serviceId: string, planId: string): Promise<void> {
  await wix(`/_api/bookings/v2/services/${serviceId}/pricing-plans/add`, {
    method: "POST",
    body: JSON.stringify({ pricingPlanIds: [planId] }),
  });
}

async function ensureBenefit(spec: KeyPlanSpec, planId: string): Promise<{ poolDefinitionId: string; itemSetId: string }> {
  const programDefinition = await getProgramDefinition(planId);
  const pools = await queryPoolDefinitions(programDefinition.id);
  if (pools.length > 1) {
    throw new Error(`Several pool definitions exist for ${spec.name}; refusing to guess`);
  }
  const pool = pools[0] ?? (await createPoolDefinition(spec, programDefinition.id));
  const itemSetId = pool.details?.benefits?.[0]?.itemSetId;
  if (!itemSetId) throw new Error(`Pool definition has no itemSetId for ${spec.name}`);
  const configuredAmount = Number(pool.details?.creditConfiguration?.amount);
  if (configuredAmount !== spec.sessions) {
    throw new Error(
      `Wrong credit amount for ${spec.name}: expected ${spec.sessions}, found ${configuredAmount}`,
    );
  }

  const serviceIds = spec.kind === "KEY" ? REFORMER_SERVICE_IDS : BONUS_SERVICE_IDS;
  const items = await queryBenefitItems(itemSetId);
  const existingServiceIds = new Set(items.map((item) => String(item.externalId)));
  for (const serviceId of serviceIds) {
    if (!existingServiceIds.has(serviceId)) await createBenefitItem(serviceId, itemSetId);
    await enablePlanForService(serviceId, planId);
  }
  return { poolDefinitionId: pool.id, itemSetId };
}

async function main(): Promise<void> {
  const existing = await queryPlans();
  const duplicateNames = specs.filter(
    (spec) => existing.filter((plan) => plan.name === spec.name && !plan.archived).length > 1,
  );
  if (duplicateNames.length > 0) {
    throw new Error(`Duplicate active plan names: ${duplicateNames.map((spec) => spec.name).join(", ")}`);
  }

  const output: Array<Record<string, unknown>> = [];
  for (const spec of specs) {
    const found = existing.find((plan) => plan.name === spec.name && !plan.archived);
    const plan = await ensurePurchaseLimit(spec, found ?? (await createPrivatePlan(spec)));
    const benefit = await ensureBenefit(spec, plan.id);
    output.push({
      code: spec.code,
      kind: spec.kind,
      planId: plan.id,
      name: plan.name,
      created: !found,
      priceXof: spec.priceXof,
      days: spec.days,
      sessions: spec.sessions,
      poolDefinitionId: benefit.poolDefinitionId,
      itemSetId: benefit.itemSetId,
      visibility: plan.visibility,
      archived: plan.archived ?? false,
    });
  }
  console.log(JSON.stringify(output, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
