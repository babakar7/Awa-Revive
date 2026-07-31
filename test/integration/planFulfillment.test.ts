import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { migrate, pool } from "../../src/db/index.js";
import { createDraftPlanOrder, findPlanOrderById } from "../../src/domain/repo.js";
import { fulfillPlanOrder } from "../../src/domain/fulfillment.js";
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

async function draftWithInitialClass() {
  const client = await seedClient({
    wa_phone: "221770000071",
    name: "Zeina Sengold",
  });
  const order = await createDraftPlanOrder({
    clientId: client.id,
    planId: "plan-reformer",
    planName: "Clé Reformer",
    amountXof: 72_000,
    memberId: "member-zeina",
    isKey: true,
    serviceId: mock.wix.serviceId,
    serviceName: "Pilates Reformer (Sculpt)",
    eventId: mock.wix.eventId,
    slotJson: {
      sessionId: mock.wix.eventId,
      serviceId: mock.wix.serviceId,
      startDate: mock.wix.slotStart,
      endDate: mock.wix.slotEnd,
    },
    slotStart: mock.wix.slotStart,
    slotEnd: mock.wix.slotEnd,
  });
  mock.wix.memberId = "member-zeina";
  mock.wix.memberContactId = "contact-zeina";
  mock.wix.contacts = [{
    id: "contact-zeina",
    primaryInfo: { phone: "+221770000071" },
    info: {
      name: { first: "Zeina", last: "Sengold" },
      phones: { items: [{ e164Phone: "+221770000071" }] },
    },
  }];
  return { client, order };
}

const testLog = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

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

  it("enters technical takeover after a reconciled Wix activation fails twice", async () => {
    const { client, order } = await draft("member-zeina");
    mock.wix.failOfflinePlanOrder = true;

    await deliverWaveWebhook(app, order.id, { eventId: "EV_offline_failure" });
    await waitFor(
      async () => (await findPlanOrderById(order.id))?.fulfillment_failure_count === 1,
      "first offline activation failure",
    );
    await deliverWaveWebhook(app, order.id, { eventId: "EV_offline_failure_retry" });
    await waitFor(
      async () => (await findPlanOrderById(order.id))?.technical_failure_at,
      "offline failure technical takeover",
    );
    await settle();

    const stored = await findPlanOrderById(order.id);
    expect(stored?.status).toBe("PAID");
    expect(stored?.wix_order_id).toBeNull();
    expect(stored?.reception_notified_at).toBeNull();
    expect(stored?.technical_failure_at).toBeTruthy();
    const takeover = await pool.query(
      `select human_takeover_by from clients where id=$1`,
      [client.id],
    );
    expect(takeover.rows[0].human_takeover_by).toBe("awa-technical-failure");
    expect(mock.waTextsTo(client.wa_phone)).toContainEqual(
      expect.stringMatching(/rien à faire/i),
    );
  });

  it("activates, selects the exact plan order benefit and books the remembered class once", async () => {
    const { order } = await draftWithInitialClass();

    await deliverWaveWebhook(app, order.id, { eventId: "EV_key_initial_a" });
    await waitFor(
      async () => (await findPlanOrderById(order.id))?.discovery_booking_status === "BOOKED",
      "initial Key class booking",
    );
    await deliverWaveWebhook(app, order.id, { eventId: "EV_key_initial_replay" });
    await settle();

    const stored = await findPlanOrderById(order.id);
    expect(stored).toMatchObject({
      status: "ACTIVATED",
      wix_order_id: "plan_order_1",
      discovery_booking_status: "BOOKED",
      wix_booking_id: "wb_1",
      benefit_transaction_id: expect.any(String),
      linked_booking_id: expect.any(String),
    });
    expect(mock.wixCreateBookingCalls()).toHaveLength(1);
    expect(mock.calls.filter((call) => call.url.includes("/benefits/redeem"))).toHaveLength(1);
    const exactBenefitCall = mock.calls.find((call) => call.url.includes("eligible-pools"));
    expect(exactBenefitCall?.body).toMatchObject({ count: 1 });
    expect((await pool.query(
      `select count(*)::int as n from pending_bookings
        where wix_booking_id='wb_1' and payment_method='membership'`,
    )).rows[0].n).toBe(1);
  });

  it("enters technical takeover when the post-activation booking still fails on retry", async () => {
    const { client, order } = await draftWithInitialClass();
    mock.wix.failCreateBooking = true;

    await deliverWaveWebhook(app, order.id, { eventId: "EV_key_booking_failure" });
    await waitFor(
      async () => (await findPlanOrderById(order.id))?.fulfillment_failure_count === 1,
      "first initial booking failure",
    );
    await fulfillPlanOrder(order.id, testLog);
    await waitFor(
      async () => (await findPlanOrderById(order.id))?.technical_failure_at,
      "initial booking technical takeover",
    );

    const stored = await findPlanOrderById(order.id);
    expect(stored).toMatchObject({
      status: "ACTIVATED",
      discovery_booking_status: "FAILED",
      fulfillment_failure_count: 2,
      technical_failure_at: expect.any(Date),
    });
    expect(mock.wixCreateBookingCalls()).toHaveLength(2);
    expect(mock.waTextsTo(client.wa_phone)).toContainEqual(expect.stringMatching(/rien à faire/i));
    expect(mock.waTextsTo(client.wa_phone).join(" ")).not.toMatch(/https?:\/\/|wa\.me|\+221|réessa/i);
  });
});
