import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { migrate, pool } from "../../src/db/index.js";
import { createDraftPlanOrder, findPlanOrderById } from "../../src/domain/repo.js";
import { buildServer } from "../../src/server.js";
import {
  deliverWaveWebhook,
  makeFetchMock,
  seedClient,
  settle,
  truncateAll,
  waitFor,
  type FetchMock,
} from "./helpers.js";

let mock: FetchMock;
let app: FastifyInstance;

beforeAll(async () => {
  await migrate();
  mock = makeFetchMock();
  mock.install();
  app = buildServer();
  await app.ready();
});

afterAll(async () => {
  mock.restore();
  await app.close();
  await pool.end();
});

beforeEach(async () => {
  await truncateAll();
  mock.reset();
});

async function draft(memberId: string | null) {
  const client = await seedClient({
    wa_phone: "221770000071",
    name: "Zeina Sengold",
  });
  const order = await createDraftPlanOrder({
    clientId: client.id,
    planId: "plan-reformer",
    planName: "Pilates Reformer",
    amountXof: 72_000,
    memberId,
  });
  return { client, order };
}

describe("plan payment fulfillment", () => {
  it("activates once with member_id and sends the ACTIVE confirmation", async () => {
    const { client, order } = await draft("member-zeina");

    expect((await deliverWaveWebhook(app, order.id, { eventId: "EV_plan_a" })).statusCode).toBe(200);
    await waitFor(
      async () => (await findPlanOrderById(order.id))?.status === "ACTIVATED",
      "plan activation",
    );
    expect((await deliverWaveWebhook(app, order.id, { eventId: "EV_plan_b" })).statusCode).toBe(200);
    await settle();

    const stored = await findPlanOrderById(order.id);
    expect(stored).toMatchObject({
      status: "ACTIVATED",
      wix_order_id: "plan_order_1",
    });
    expect(mock.wix.offlinePlanOrderIds).toEqual(["plan_order_1"]);
    expect(mock.waTextsTo(client.wa_phone).filter((text) => /ACTIF/.test(text))).toHaveLength(1);
  });

  it("without member_id notifies reception once and keeps the manual message", async () => {
    const { client, order } = await draft(null);

    await deliverWaveWebhook(app, order.id, { eventId: "EV_manual_a" });
    await waitFor(
      async () => (await findPlanOrderById(order.id))?.reception_notified_at,
      "manual activation notification",
    );
    await deliverWaveWebhook(app, order.id, { eventId: "EV_manual_b" });
    await settle();

    const stored = await findPlanOrderById(order.id);
    expect(stored?.status).toBe("PAID");
    expect(stored?.reception_notified_at).toBeTruthy();
    expect(mock.wix.offlinePlanOrderIds).toHaveLength(0);
    expect(mock.emailCalls()).toHaveLength(1);
    expect(
      mock.waTextsTo(client.wa_phone).filter((text) => /finalise son activation/i.test(text)),
    ).toHaveLength(1);
  });

  it("falls back to manual activation when the Wix offline order fails", async () => {
    const { client, order } = await draft("member-zeina");
    mock.wix.failOfflinePlanOrder = true;

    await deliverWaveWebhook(app, order.id, { eventId: "EV_offline_failure" });
    await waitFor(
      async () => (await findPlanOrderById(order.id))?.reception_notified_at,
      "offline failure fallback",
    );
    await settle();

    const stored = await findPlanOrderById(order.id);
    expect(stored?.status).toBe("PAID");
    expect(stored?.wix_order_id).toBeNull();
    expect(stored?.reception_notified_at).toBeTruthy();
    expect(mock.emailCalls()).toHaveLength(1);
    expect(mock.waTextsTo(client.wa_phone).some((text) => /finalise son activation/i.test(text))).toBe(
      true,
    );
  });
});
