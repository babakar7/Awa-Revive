import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { migrate, pool } from "../../src/db/index.js";
import { executeTool } from "../../src/agent/tools.js";
import { cacheSlots, slotChoiceKey } from "../../src/domain/repo.js";
import {
  makeFetchMock,
  seedClient,
  truncateAll,
  type FetchMock,
} from "./helpers.js";

let mock: FetchMock;

beforeAll(async () => {
  await migrate();
  mock = makeFetchMock();
  mock.install();
});

afterAll(async () => {
  mock.restore();
  await pool.end();
});

beforeEach(async () => {
  await truncateAll();
  mock.reset();
  mock.wix.memberId = null;
  mock.wix.plans = [
    {
      id: "plan-monthly",
      name: "Pilates Reformer Mensuel",
      description: "6 séances",
      pricing: {
        price: { value: 72_000 },
        singlePaymentForDuration: { count: 1, unit: "MONTH" },
      },
    },
  ];
  mock.wix.contacts = [
    {
      id: "contact-zeina",
      primaryInfo: {
        phone: "+221770000072",
        email: "zeinasengold@gmail.com",
      },
      info: {
        name: { first: "Zeina", last: "Sengold" },
        phones: { items: [{ phone: "770000072", e164Phone: "+221770000072" }] },
        emails: {
          items: [{ email: "zeinasengold@gmail.com", primary: true }],
        },
      },
    },
  ];
});

function clientShape(client: { id: string; wa_phone: string }) {
  return {
    id: client.id,
    wa_phone: client.wa_phone,
    name: "Zeina",
    language: "fr",
    email_prompted_at: null,
    claimed_email: null,
    capability_menu_at: null,
  } as any;
}

async function call(
  client: { id: string; wa_phone: string },
  extra: Record<string, unknown> = {},
) {
  return JSON.parse(
    await executeTool(clientShape(client), "create_plan_payment_link", {
      plan_id: "plan-monthly",
      plan_name_confirm: "Pilates Reformer Mensuel",
      client_name: "Zeina",
      payment_method: "wave",
      ...extra,
    }),
  );
}

async function expireCreatedPlanOrder(
  client: { id: string; wa_phone: string },
  extra: Record<string, unknown> = {},
) {
  mock.wix.memberId = "member-existing";
  mock.wix.memberContactId = "contact-zeina";
  const created = await call(client, extra);
  expect(created.order_id).toBeTruthy();
  await pool.query(
    `update pending_plan_orders
        set status='EXPIRED', link_expires_at=now() - interval '1 minute', updated_at=now()
      where id=$1`,
    [created.order_id],
  );
  return created;
}

async function insertVerification(
  clientId: string,
  values: {
    status: "AWAITING_CODE" | "VERIFIED";
    expiresAt?: Date | null;
    linkedContactId?: string | null;
  },
) {
  await pool.query(
    `insert into link_requests
       (client_id, claimed_email, wix_contact_id, linked_contact_id, code_expires_at,
        status, updated_at)
     values ($1, 'zeinasengold@gmail.com', 'contact-zeina', $2, $3, $4, now())`,
    [
      clientId,
      values.linkedContactId ?? null,
      values.expiresAt ?? null,
      values.status,
    ],
  );
}

describe("create_plan_payment_link member self-service", () => {
  it("requires verification and takes no payment before proof", async () => {
    const client = await seedClient({
      wa_phone: "221770000072",
      name: "Zeina",
    });

    const result = await call(client);

    expect(result).toMatchObject({
      error: "plan_member_verification_required",
      verification: "email_required",
    });
    expect(mock.wix.createdMemberIds).toHaveLength(0);
    expect(mock.calls.some((call) => call.url.includes("api.wave.com"))).toBe(false);
  });

  it("asks for email verification before offering payment methods", async () => {
    const client = await seedClient({
      wa_phone: "221770000072",
      name: "Zeina",
    });

    const result = await call(client, { payment_method: undefined });

    expect(result).toMatchObject({
      error: "plan_member_verification_required",
      verification: "email_required",
    });
    expect(result.error).not.toBe("payment_method_required");
    expect(mock.wix.createdMemberIds).toHaveLength(0);
    expect(mock.calls.some((call) => call.url.includes("api.wave.com"))).toBe(false);
  });

  it("does not resend while a valid code is active, but allows an expired code to restart", async () => {
    const activeClient = await seedClient({
      wa_phone: "221770000072",
      name: "Zeina",
    });
    await insertVerification(activeClient.id, {
      status: "AWAITING_CODE",
      expiresAt: new Date(Date.now() + 5 * 60_000),
    });
    expect(await call(activeClient)).toMatchObject({
      error: "plan_member_verification_required",
      verification: "code_active",
    });

    await truncateAll();
    mock.reset();
    mock.wix.memberId = null;
    mock.wix.contacts = [
      {
        id: "contact-zeina",
        primaryInfo: {
          phone: "+221770000072",
          email: "zeinasengold@gmail.com",
        },
        info: {
          name: { first: "Zeina" },
          phones: { items: [{ e164Phone: "+221770000072" }] },
          emails: { items: [{ email: "zeinasengold@gmail.com", primary: true }] },
        },
      },
    ];
    const expiredClient = await seedClient({
      wa_phone: "221770000072",
      name: "Zeina",
    });
    await insertVerification(expiredClient.id, {
      status: "AWAITING_CODE",
      expiresAt: new Date(Date.now() - 60_000),
    });
    expect(await call(expiredClient)).toMatchObject({
      error: "plan_member_verification_required",
      verification: "email_required",
    });
  });

  it("creates the member after verification and stores auto_after_payment", async () => {
    const client = await seedClient({
      wa_phone: "221770000072",
      name: "Zeina",
    });
    await insertVerification(client.id, {
      status: "VERIFIED",
      linkedContactId: "contact-zeina",
    });

    const result = await call(client);
    const stored = await pool.query(
      `select member_id, status from pending_plan_orders where client_id=$1`,
      [client.id],
    );

    expect(result.activation).toBe("auto_after_payment");
    expect(result.payment_link).toMatch(/^https:\/\//);
    expect(mock.wix.createdMemberIds).toEqual(["member_created_1"]);
    expect(stored.rows[0]).toMatchObject({
      member_id: "member_created_1",
      status: "AWAITING_PAYMENT",
    });
  });

  it("persists an indivisible initial class selection on the plan order", async () => {
    const client = await seedClient({ wa_phone: "221770000072", name: "Zeina" });
    await insertVerification(client.id, {
      status: "VERIFIED",
      linkedContactId: "contact-zeina",
    });
    await cacheSlots(client.id, mock.wix.serviceId, [{
      eventId: mock.wix.eventId,
      slot: {
        sessionId: mock.wix.eventId,
        serviceId: mock.wix.serviceId,
        startDate: mock.wix.slotStart,
        endDate: mock.wix.slotEnd,
      },
    }]);

    const result = await call(client, {
      service_id: mock.wix.serviceId,
      event_id: slotChoiceKey(mock.wix.eventId),
      slot_start: mock.wix.slotStart,
    });
    const stored = (await pool.query(
      `select service_id, event_id, slot_start, discovery_booking_status
         from pending_plan_orders where client_id=$1`,
      [client.id],
    )).rows[0];

    expect(result).toMatchObject({
      payment_link: expect.any(String),
      initial_class: "Pilates Reformer",
    });
    expect(stored).toMatchObject({
      service_id: mock.wix.serviceId,
      event_id: mock.wix.eventId,
      discovery_booking_status: "PENDING",
    });
    expect(new Date(stored.slot_start).toISOString()).toBe(mock.wix.slotStart);
  });

  it("rejects a partial initial-slot group before creating any payment", async () => {
    const client = await seedClient({ wa_phone: "221770000072", name: "Zeina" });
    const result = await call(client, { service_id: mock.wix.serviceId });
    expect(result.error).toBe("invalid_arguments");
    expect((await pool.query(`select count(*)::int as n from pending_plan_orders`)).rows[0].n).toBe(0);
  });

  it("does not create the member before the payment-method guard", async () => {
    const client = await seedClient({
      wa_phone: "221770000072",
      name: "Zeina",
    });
    await insertVerification(client.id, {
      status: "VERIFIED",
      linkedContactId: "contact-zeina",
    });

    const result = await call(client, { payment_method: undefined });

    expect(result.error).toBe("payment_method_required");
    expect(mock.wix.createdMemberIds).toHaveLength(0);
    expect(
      await pool.query(`select count(*)::int as n from pending_plan_orders`),
    ).toMatchObject({ rows: [{ n: 0 }] });
  });

  it("keeps the explicit refusal/no-inbox manual fallback", async () => {
    const client = await seedClient({
      wa_phone: "221770000072",
      name: "Zeina",
    });

    const result = await call(client, { client_declined_verification: true });
    const stored = await pool.query(
      `select member_id from pending_plan_orders where client_id=$1`,
      [client.id],
    );

    expect(result.activation).toBe("manual_after_payment");
    expect(stored.rows[0].member_id).toBeNull();
    expect(mock.wix.createdMemberIds).toHaveLength(0);
  });

  it("refreshes a recent expired order through a new auditable payment attempt", async () => {
    const client = await seedClient({ wa_phone: "221770000072", name: "Zeina" });
    const expired = await expireCreatedPlanOrder(client);

    const refreshed = JSON.parse(
      await executeTool(clientShape(client), "refresh_expired_plan_payment_link", {
        order_id: expired.order_id,
      }),
    );
    const attempts = await pool.query(
      `select id, status, retry_of_order_id, amount_xof, payment_method
         from pending_plan_orders where client_id=$1 order by created_at`,
      [client.id],
    );

    expect(refreshed).toMatchObject({
      payment_link: expect.any(String),
      order_id: expect.any(String),
      replaces_order_id: expired.order_id,
      amount_fcfa: 72_000,
      payment_method: "wave",
    });
    expect(refreshed.order_id).not.toBe(expired.order_id);
    expect(attempts.rows).toEqual([
      expect.objectContaining({ id: expired.order_id, status: "EXPIRED", retry_of_order_id: null }),
      expect.objectContaining({
        id: refreshed.order_id,
        status: "AWAITING_PAYMENT",
        retry_of_order_id: expired.order_id,
        amount_xof: 72_000,
        payment_method: "wave",
      }),
    ]);
  });

  it("refuses foreign, paid and more-than-seven-day-old plan orders", async () => {
    const owner = await seedClient({ wa_phone: "221770000072", name: "Zeina" });
    const expired = await expireCreatedPlanOrder(owner);
    const stranger = await seedClient({ wa_phone: "221770000073", name: "Mame" });

    expect(JSON.parse(await executeTool(clientShape(stranger), "refresh_expired_plan_payment_link", {
      order_id: expired.order_id,
    }))).toMatchObject({ error: "plan_order_not_found" });

    await pool.query(`update pending_plan_orders set status='PAID' where id=$1`, [expired.order_id]);
    expect(JSON.parse(await executeTool(clientShape(owner), "refresh_expired_plan_payment_link", {
      order_id: expired.order_id,
    }))).toMatchObject({ error: "plan_order_already_paid" });

    await pool.query(
      `update pending_plan_orders
          set status='EXPIRED', link_expires_at=now() - interval '8 days', updated_at=now() - interval '8 days'
        where id=$1`,
      [expired.order_id],
    );
    expect(JSON.parse(await executeTool(clientShape(owner), "refresh_expired_plan_payment_link", {
      order_id: expired.order_id,
    }))).toMatchObject({ error: "plan_order_too_old" });
  });

  it("does not create a refreshed payment when the remembered initial class filled", async () => {
    const client = await seedClient({ wa_phone: "221770000072", name: "Zeina" });
    await cacheSlots(client.id, mock.wix.serviceId, [{
      eventId: mock.wix.eventId,
      slot: {
        sessionId: mock.wix.eventId,
        serviceId: mock.wix.serviceId,
        startDate: mock.wix.slotStart,
        endDate: mock.wix.slotEnd,
      },
    }]);
    const expired = await expireCreatedPlanOrder(client, {
      service_id: mock.wix.serviceId,
      event_id: slotChoiceKey(mock.wix.eventId),
      slot_start: mock.wix.slotStart,
    });
    const paymentCallsBefore = mock.calls.filter((item) => item.url.includes("api.wave.com")).length;
    mock.wix.openSpots = 0;

    const refreshed = JSON.parse(
      await executeTool(clientShape(client), "refresh_expired_plan_payment_link", {
        order_id: expired.order_id,
      }),
    );

    expect(refreshed).toMatchObject({ error: "initial_slot_unavailable" });
    expect(mock.calls.filter((item) => item.url.includes("api.wave.com"))).toHaveLength(paymentCallsBefore);
    expect((await pool.query(
      `select count(*)::int as n from pending_plan_orders where client_id=$1`,
      [client.id],
    )).rows[0].n).toBe(1);
  });

  it("does not create a refreshed payment when the remembered initial class started", async () => {
    const client = await seedClient({ wa_phone: "221770000072", name: "Zeina" });
    const expired = await expireCreatedPlanOrder(client);
    await pool.query(
      `update pending_plan_orders
          set service_id=$2, service_name='Pilates Reformer', event_id=$3,
              slot_start=now() - interval '1 minute', slot_end=now() + interval '59 minutes',
              slot_json=jsonb_build_object('sessionId',$3::text,'serviceId',$2::text)
        where id=$1`,
      [expired.order_id, mock.wix.serviceId, mock.wix.eventId],
    );
    const paymentCallsBefore = mock.calls.filter((item) => item.url.includes("api.wave.com")).length;

    const refreshed = JSON.parse(
      await executeTool(clientShape(client), "refresh_expired_plan_payment_link", {
        order_id: expired.order_id,
      }),
    );

    expect(refreshed).toMatchObject({ error: "initial_slot_started" });
    expect(mock.calls.filter((item) => item.url.includes("api.wave.com"))).toHaveLength(paymentCallsBefore);
    expect((await pool.query(
      `select count(*)::int as n from pending_plan_orders where client_id=$1`,
      [client.id],
    )).rows[0].n).toBe(1);
  });
});
