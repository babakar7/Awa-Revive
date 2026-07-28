import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { migrate, pool } from "../../src/db/index.js";
import { executeTool } from "../../src/agent/tools.js";
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
});
