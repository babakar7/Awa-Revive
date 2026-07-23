import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../../src/server.js";
import { pool, migrate } from "../../src/db/index.js";
import { initCafeMenu, refreshCafeMenu } from "../../src/domain/cafeMenuRepo.js";
import { config } from "../../src/config.js";
import { sweepDeliveries } from "../../src/domain/deliveryNotify.js";
import {
  deliveryStats,
  expireStaleDeliveryPaymentAttempts,
  markClientPingFailedByWamid,
  recentDeliveryClients,
} from "../../src/domain/deliveryRepo.js";
import * as clientRepo from "../../src/domain/repo.js";
import { executeTool } from "../../src/agent/tools.js";
import { markLogFailedByWamid, recordDeliveryLog } from "../../src/domain/notificationRepo.js";
import { hashReadyToken, newReadyToken } from "../../src/domain/deliveryRules.js";
import { planningNowSlot } from "../../src/domain/staffPlanningRules.js";
import {
  deliverOmWebhook,
  deliverWaveWebhook,
  makeFetchMock,
  type FetchMock,
  truncateAll,
  waitFor,
  settle,
} from "./helpers.js";

/**
 * Delivery-orders end-to-end against a real Postgres, all HTTP mocked. Exercises
 * the exact SQL/flow that makes the ops path safe: server-priced order, kitchen
 * WhatsApp (role `bar`) with a magic link, GET-does-not-mutate (WhatsApp
 * prefetch), atomic single-step departure (IN_KITCHEN → OUT_FOR_DELIVERY) with
 * one en-route ping, creation confirmation + reception ping, token rotation,
 * and the one-shot SLA alert.
 */

const noopLog = { info: () => {}, warn: () => {}, error: () => {} };
const AUTH = `Basic ${Buffer.from("revive:revive@5000").toString("base64")}`;
const RECEPTION = config.RECEPTION_PHONE.replace(/\D/g, "");

let app: FastifyInstance;
let mock: FetchMock;

beforeAll(async () => {
  await migrate();
  await initCafeMenu(); // seed + snapshot so the livraisons form prices menu items
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

async function seedKitchenContact(phone = "221770000099"): Promise<void> {
  await pool.query(
    `insert into staff_contacts (name, phone, role, muted) values ('Chef', $1, 'bar', false)`,
    [phone],
  );
}

async function createOrder(overrides: Record<string, string> = {}): Promise<string> {
  const form = new URLSearchParams({
    client_name: "Rama",
    client_phone: "770009988",
    address: "Almadies",
    sla_minutes: "20",
    qty_SMOOTHIE_JANT_BI: "2",
    ...overrides,
  }).toString();
  const res = await app.inject({
    method: "POST",
    url: "/admin/livraisons",
    headers: { authorization: AUTH, "content-type": "application/x-www-form-urlencoded" },
    payload: form,
  });
  expect(res.statusCode).toBe(303);
  const row = await pool.query(`select id from delivery_orders order by created_at desc limit 1`);
  return row.rows[0].id as string;
}

async function chooseCash(id: string): Promise<void> {
  const res = await app.inject({
    method: "POST",
    url: `/admin/livraisons/${id}/cash`,
    headers: { authorization: AUTH },
  });
  expect(res.statusCode).toBe(303);
  expect(res.headers.location).toContain("done=cash");
}

/** Newest-first: the mock accumulates texts across a test, so the latest kitchen
 *  message (e.g. after a renotify/rotate) is at the end. Token-only URL. */
function magicLinkFrom(texts: string[]): string {
  for (let i = texts.length - 1; i >= 0; i--) {
    const m = texts[i].match(/\/livraison\/[0-9a-f]+/);
    if (m) return m[0];
  }
  throw new Error(`no magic link in: ${JSON.stringify(texts)}`);
}

function dakarInputIn(minutes: number): string {
  return new Date(Date.now() + minutes * 60_000).toISOString().slice(0, 16);
}

describe("delivery order creation → kitchen notify", () => {
  it("prices server-side, creates IN_KITCHEN, and WhatsApps the kitchen a magic link", async () => {
    await seedKitchenContact();
    const id = await createOrder({ wix_contact_id: "wix-contact-123" });

    const order = (await pool.query(`select * from delivery_orders where id=$1`, [id])).rows[0];
    expect(order.status).toBe("IN_KITCHEN");
    expect(order.amount_xof).toBe(6000); // 2 × Jant Bi @ 3000 — from the menu, not the form
    expect(order.client_phone).toBe("221770009988");
    expect(order.wix_contact_id).toBe("wix-contact-123");
    expect(order.payment_status).toBe("PENDING_CHOICE");
    expect(order.payment_method).toBeNull();
    expect(["sent", "sent_template"]).toContain(order.kitchen_notify_status);

    const link = magicLinkFrom(mock.waTextsTo("221770000099"));
    expect(link).toMatch(/\/livraison\/[0-9a-f]{32}$/);
    void id;
  });

  it("with no reachable bar contact (none, or empty phone), falls back to reception", async () => {
    // A bar contact WITHOUT a phone must not count as reachable.
    await pool.query(
      `insert into staff_contacts (name, phone, role, muted) values ('SansTel', '', 'bar', false)`,
    );
    const id = await createOrder();
    await settle();
    const toReception = mock.waTextsTo(RECEPTION).join("\n");
    expect(toReception).toContain("Aucun contact");
    const order = (await pool.query(`select kitchen_notify_status from delivery_orders where id=$1`, [id])).rows[0];
    expect(order.kitchen_notify_status).toBe("fallback_reception");
  });

  it("pings reception on every new order (owner may be the one entering it)", async () => {
    await seedKitchenContact();
    await createOrder();
    await waitFor(
      async () => mock.waTextsTo(RECEPTION).some((t) => t.includes("Nouvelle commande livraison")),
      "reception new-order ping",
    );
  });

  it("falls back to the approved generic template when ticket_cuisine is misconfigured", async () => {
    const previousKitchen = config.WA_KITCHEN_TICKET_TEMPLATE;
    const previousReception = config.WA_RECEPTION_TEMPLATE;
    const previousLang = config.WA_RECEPTION_TEMPLATE_LANG;
    config.WA_KITCHEN_TICKET_TEMPLATE = "ticket_cuisine";
    config.WA_RECEPTION_TEMPLATE = "awa_notification";
    config.WA_RECEPTION_TEMPLATE_LANG = "en";
    mock.waTemplateFailures.add("ticket_cuisine");
    try {
      await seedKitchenContact();
      const id = await createOrder();
      const kitchenCalls = mock.waCalls().filter((c) => c.body?.to === "221770000099");
      expect(kitchenCalls.some((c) => c.body?.template?.name === "ticket_cuisine")).toBe(true);
      expect(kitchenCalls.some((c) => c.body?.template?.name === "awa_notification")).toBe(true);
      expect(mock.waTextsTo("221770000099")).toHaveLength(0);
      const order = (
        await pool.query(`select kitchen_notify_status from delivery_orders where id=$1`, [id])
      ).rows[0];
      expect(order.kitchen_notify_status).toBe("sent_template");
    } finally {
      config.WA_KITCHEN_TICKET_TEMPLATE = previousKitchen;
      config.WA_RECEPTION_TEMPLATE = previousReception;
      config.WA_RECEPTION_TEMPLATE_LANG = previousLang;
    }
  });
});

describe("scheduled deliveries", () => {
  it("rejects a past arrival and activates immediately when the kitchen deadline is already due", async () => {
    const past = await app.inject({
      method: "POST",
      url: "/admin/livraisons",
      headers: { authorization: AUTH, "content-type": "application/x-www-form-urlencoded" },
      payload: new URLSearchParams({
        client_name: "Rama",
        client_phone: "770009988",
        address: "Almadies",
        delivery_mode: "scheduled",
        scheduled_for: dakarInputIn(-10),
        kitchen_lead_minutes: "60",
        qty_SMOOTHIE_JANT_BI: "1",
      }).toString(),
    });
    expect(past.statusCode).toBe(200);
    expect(past.body).toContain("doit être dans le futur");
    expect((await pool.query(`select count(*)::int as n from delivery_orders`)).rows[0].n).toBe(0);

    await seedKitchenContact();
    const id = await createOrder({
      delivery_mode: "scheduled",
      scheduled_for: dakarInputIn(20),
      kitchen_lead_minutes: "60",
    });
    const active = (await pool.query(`select * from delivery_orders where id=$1`, [id])).rows[0];
    expect(active.scheduled_for).not.toBeNull();
    expect(active.activated_at).not.toBeNull();
    expect(["sent", "sent_template"]).toContain(active.kitchen_notify_status);
    expect(mock.waTextsTo("221770000099").some((text) => text.includes("/livraison/"))).toBe(true);
  });

  it("confirms payment immediately but keeps a week-ahead order away from the kitchen and SLA", async () => {
    await seedKitchenContact();
    const id = await createOrder({
      delivery_mode: "scheduled",
      scheduled_for: dakarInputIn(7 * 24 * 60),
      kitchen_lead_minutes: "60",
    });
    await waitFor(
      async () =>
        mock.waTextsTo("221770009988").some(
          (text) => text.includes("arrivée prévue") && text.includes("WAVE"),
        ),
      "scheduled client confirmation",
    );
    await settle();

    const order = (await pool.query(`select * from delivery_orders where id=$1`, [id])).rows[0];
    expect(order.scheduled_for).not.toBeNull();
    expect(order.kitchen_notify_at).not.toBeNull();
    expect(order.activated_at).toBeNull();
    expect(order.payment_status).toBe("PENDING_CHOICE");
    expect(order.kitchen_notify_status).toBe("pending");
    expect(mock.waTextsTo("221770000099")).toHaveLength(0);

    expect(await sweepDeliveries(noopLog)).toBe(0);
    const afterSweep = (
      await pool.query(`select activated_at, alerted_at from delivery_orders where id=$1`, [id])
    ).rows[0];
    expect(afterSweep.activated_at).toBeNull();
    expect(afterSweep.alerted_at).toBeNull();

    const board = await app.inject({
      method: "GET",
      url: "/admin/livraisons",
      headers: { authorization: AUTH },
    });
    expect(board.body).toContain("Programmées");
    expect(board.body).toContain("Reprogrammer");
    expect(board.body).not.toContain(`/admin/livraisons/${id}/depart`);

    const client = await clientRepo.upsertClient("221770009988");
    const paymentChoice = JSON.parse(
      await executeTool(client, "create_delivery_payment_link", {
        delivery_order_id: id,
        payment_method: "cash",
      }),
    );
    expect(paymentChoice.cash_selected).toBe(true);
    expect(
      (await pool.query(`select payment_status from delivery_orders where id=$1`, [id])).rows[0]
        .payment_status,
    ).toBe("CASH_DUE");
    expect(mock.waTextsTo("221770000099")).toHaveLength(0);
  });

  it("activates after restart, alerts kitchen/reception once, and resists concurrent sweeps", async () => {
    await seedKitchenContact();
    const id = await createOrder({
      delivery_mode: "scheduled",
      scheduled_for: dakarInputIn(24 * 60),
      kitchen_lead_minutes: "60",
    });
    await waitFor(
      async () => mock.waTextsTo("221770009988").some((text) => text.includes("bien reçue")),
      "initial scheduled confirmation",
    );
    await settle();
    mock.reset();
    await pool.query(
      `update delivery_orders
          set kitchen_notify_at=now() - interval '30 seconds',
              scheduled_for=now() + interval '30 minutes',
              activated_at=null
        where id=$1`,
      [id],
    );

    await Promise.all([sweepDeliveries(noopLog), sweepDeliveries(noopLog)]);
    const order = (await pool.query(`select * from delivery_orders where id=$1`, [id])).rows[0];
    expect(order.activated_at).not.toBeNull();
    expect(["sent", "sent_template"]).toContain(order.kitchen_notify_status);
    expect(["sent", "sent_template"]).toContain(order.activation_notify_status);
    expect(
      mock.waTextsTo("221770000099").filter((text) => text.includes("/livraison/")),
    ).toHaveLength(1);

    const activationLogs = await pool.query(
      `select count(*)::int as n from notification_log
        where source='delivery' and body like '% activation] %'`,
    );
    expect(activationLogs.rows[0].n).toBe(1);
    const promisedBefore = new Date(order.scheduled_for).toISOString();
    const blockedMove = await app.inject({
      method: "POST",
      url: `/admin/livraisons/${id}/reschedule`,
      headers: { authorization: AUTH, "content-type": "application/x-www-form-urlencoded" },
      payload: new URLSearchParams({
        scheduled_for: dakarInputIn(120),
        kitchen_lead_minutes: "60",
      }).toString(),
    });
    expect(blockedMove.headers.location).toContain("err=");
    expect(
      new Date(
        (
          await pool.query(`select scheduled_for from delivery_orders where id=$1`, [id])
        ).rows[0].scheduled_for,
      ).toISOString(),
    ).toBe(promisedBefore);
    await sweepDeliveries(noopLog);
    expect(
      mock.waTextsTo("221770000099").filter((text) => text.includes("/livraison/")),
    ).toHaveLength(1);
  });

  it("reprograms only before activation, preserves payment, and warns the client only for arrival changes", async () => {
    await seedKitchenContact();
    const firstArrival = dakarInputIn(7 * 24 * 60);
    const secondArrival = dakarInputIn(8 * 24 * 60);
    const id = await createOrder({
      delivery_mode: "scheduled",
      scheduled_for: firstArrival,
      kitchen_lead_minutes: "60",
    });
    await chooseCash(id);
    await waitFor(
      async () => mock.waTextsTo("221770009988").some((text) => text.includes("bien reçue")),
      "scheduled confirmation before reschedule",
    );

    const moved = await app.inject({
      method: "POST",
      url: `/admin/livraisons/${id}/reschedule`,
      headers: { authorization: AUTH, "content-type": "application/x-www-form-urlencoded" },
      payload: new URLSearchParams({
        scheduled_for: secondArrival,
        kitchen_lead_minutes: "90",
      }).toString(),
    });
    expect(moved.statusCode).toBe(303);
    expect(moved.headers.location).toContain("done=reprogrammed");
    const afterMove = (
      await pool.query(
        `select scheduled_for, kitchen_notify_at, payment_status, payment_method,
                reschedule_notify_status, activated_at
           from delivery_orders where id=$1`,
        [id],
      )
    ).rows[0];
    expect(new Date(afterMove.scheduled_for).toISOString().slice(0, 16)).toBe(
      `${secondArrival}:00.000Z`.slice(0, 16),
    );
    expect(afterMove.payment_status).toBe("CASH_DUE");
    expect(afterMove.payment_method).toBe("cash");
    expect(afterMove.activated_at).toBeNull();
    expect(["sent", "sent_template"]).toContain(afterMove.reschedule_notify_status);

    const rescheduleCount = async () =>
      Number(
        (
          await pool.query(
            `select count(*) as n from notification_log
              where source='delivery' and recipient_phone='221770009988'
                and body like '%Mise à jour%'`,
          )
        ).rows[0].n,
      );
    expect(await rescheduleCount()).toBe(1);

    const leadOnly = await app.inject({
      method: "POST",
      url: `/admin/livraisons/${id}/reschedule`,
      headers: { authorization: AUTH, "content-type": "application/x-www-form-urlencoded" },
      payload: new URLSearchParams({
        scheduled_for: secondArrival,
        kitchen_lead_minutes: "30",
      }).toString(),
    });
    expect(leadOnly.headers.location).toContain("done=reprogrammed");
    await sweepDeliveries(noopLog);
    expect(await rescheduleCount()).toBe(1);
  });

  it("blocks premature departure/closure/resend and flags refund after a paid scheduled cancellation", async () => {
    await seedKitchenContact();
    const id = await createOrder({
      delivery_mode: "scheduled",
      scheduled_for: dakarInputIn(7 * 24 * 60),
      kitchen_lead_minutes: "60",
    });
    await chooseCash(id);
    await settle();
    mock.reset();

    for (const action of ["depart", "delivered", "renotify-kitchen"]) {
      const res = await app.inject({
        method: "POST",
        url: `/admin/livraisons/${id}/${action}`,
        headers: { authorization: AUTH },
      });
      expect(res.statusCode).toBe(303);
      expect(res.headers.location).toContain("err=");
    }
    expect(
      (await pool.query(`select status from delivery_orders where id=$1`, [id])).rows[0].status,
    ).toBe("IN_KITCHEN");
    expect(mock.waTextsTo("221770000099")).toHaveLength(0);

    await pool.query(
      `update delivery_orders
          set payment_status='PAID', payment_method='wave', payment_ref='wave-paid', paid_at=now()
        where id=$1`,
      [id],
    );
    await app.inject({
      method: "POST",
      url: `/admin/livraisons/${id}/cancel`,
      headers: { authorization: AUTH },
    });
    const cancelled = (
      await pool.query(`select status, payment_status, payment_issue from delivery_orders where id=$1`, [
        id,
      ])
    ).rows[0];
    expect(cancelled.status).toBe("CANCELLED");
    expect(cancelled.payment_status).toBe("REFUND_NEEDED");
    expect(cancelled.payment_issue).toBe("cancelled_after_online_payment");
  });

  it("bases preparation statistics on activation rather than week-early creation", async () => {
    const token = newReadyToken();
    await pool.query(
      `insert into delivery_orders
         (client_name, client_phone, address, items_json, amount_xof, status,
          ready_token_hash, payment_status, payment_method, scheduled_for,
          kitchen_notify_at, activated_at, out_for_delivery_at, delivered_at, created_at)
       values ('Stats','221770001234','Ngor','[]'::jsonb,3000,'DELIVERED',$1,
          'PAID','wave',now() + interval '20 minutes',now() - interval '10 minutes',
          now() - interval '10 minutes',now(),now(),now() - interval '7 days')`,
      [hashReadyToken(token)],
    );
    const stats = await deliveryStats();
    expect(stats.avgPrepMinutes).not.toBeNull();
    expect(stats.avgPrepMinutes!).toBeGreaterThan(9);
    expect(stats.avgPrepMinutes!).toBeLessThan(11);
  });
});

describe("Wix client picker", () => {
  it("returns only the delivery snapshot needed by the admin form", async () => {
    mock.wix.contacts = [
      {
        id: "wix-1",
        revision: 7,
        info: {
          name: { first: "Rama", last: "Fall" },
          phones: { items: [{ tag: "MAIN", e164Phone: "+221770009988" }] },
          emails: { items: [{ tag: "MAIN", email: "rama@example.com" }] },
          addresses: {
            items: [{ tag: "MAIN", address: { addressLine: "Ngor", city: "Dakar" } }],
          },
        },
      },
    ];

    const res = await app.inject({
      method: "GET",
      url: "/admin/livraisons/clients?q=Rama",
      headers: { authorization: AUTH },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      clients: [
        {
          id: "wix-1",
          name: "Rama Fall",
          phone: "+221770009988",
          email: "rama@example.com",
          address: "Ngor, Dakar",
        },
      ],
    });
  });
});

describe("kitchen shift gate (published staff planning)", () => {
  const OWNER = config.OWNER_PHONE.replace(/\D/g, "");

  async function seedBarContact(name: string, phone: string): Promise<string> {
    const r = await pool.query(
      `insert into staff_contacts (name, phone, role, muted) values ($1,$2,'bar',false) returning id`,
      [name, phone],
    );
    return r.rows[0].id as string;
  }

  async function publishShifts(
    shifts: { staff_id: string; weekday: number; start_min: number; end_min: number }[],
  ): Promise<void> {
    const s = await pool.query(
      `insert into staff_schedules (name, status) values ('Gate test','published') returning id`,
    );
    for (const sh of shifts) {
      await pool.query(
        `insert into staff_shifts (schedule_id, staff_id, weekday, start_min, end_min)
         values ($1,$2,$3,$4,$5)`,
        [s.rows[0].id, sh.staff_id, sh.weekday, sh.start_min, sh.end_min],
      );
    }
  }

  // Seed shifts relative to the REAL current instant (no clock mocking): a
  // full-day shift today = on shift now; a shift tomorrow only = off shift now.
  const today = () => planningNowSlot(new Date()).weekday;

  it("pings only the bar contact on shift now; the off-shift one stays quiet", async () => {
    const onId = await seedBarContact("OnShift", "221770000031");
    await seedBarContact("OffShift", "221770000032");
    await publishShifts([{ staff_id: onId, weekday: today(), start_min: 0, end_min: 1440 }]);

    const id = await createOrder();
    expect(magicLinkFrom(mock.waTextsTo("221770000031"))).toMatch(/\/livraison\/[0-9a-f]{32}$/);
    expect(mock.waTextsTo("221770000032")).toHaveLength(0);
    const order = (await pool.query(`select kitchen_notify_status from delivery_orders where id=$1`, [id])).rows[0];
    expect(["sent", "sent_template"]).toContain(order.kitchen_notify_status);
  });

  it("nobody on shift → warning ticket to reception AND the owner, status fallback_reception", async () => {
    const offId = await seedBarContact("OffShift", "221770000033");
    await publishShifts([{ staff_id: offId, weekday: (today() + 1) % 7, start_min: 0, end_min: 1440 }]);

    const id = await createOrder();
    await settle();
    expect(mock.waTextsTo("221770000033")).toHaveLength(0);
    expect(mock.waTextsTo(RECEPTION).some((t) => t.includes("en service"))).toBe(true);
    expect(mock.waTextsTo(OWNER).some((t) => t.includes("en service"))).toBe(true);
    const order = (await pool.query(`select kitchen_notify_status from delivery_orders where id=$1`, [id])).rows[0];
    expect(order.kitchen_notify_status).toBe("fallback_reception");
  });

  it("no published planning → no gating, every reachable bar contact gets the ticket", async () => {
    await seedBarContact("A", "221770000034");
    await seedBarContact("B", "221770000035");
    // Draft schedules don't gate either.
    await pool.query(`insert into staff_schedules (name, status) values ('Brouillon','draft')`);

    await createOrder();
    expect(magicLinkFrom(mock.waTextsTo("221770000034"))).toMatch(/\/livraison\//);
    expect(magicLinkFrom(mock.waTextsTo("221770000035"))).toMatch(/\/livraison\//);
  });
});

describe("delivery payment handover to Awa", () => {
  it("blocks both admin and kitchen departure until cash or a verified payment", async () => {
    await seedKitchenContact();
    const id = await createOrder();
    const link = magicLinkFrom(mock.waTextsTo("221770000099"));

    const boardDepart = await app.inject({
      method: "POST",
      url: `/admin/livraisons/${id}/depart`,
      headers: { authorization: AUTH },
    });
    expect(boardDepart.statusCode).toBe(303);
    expect(boardDepart.headers.location).toContain("err=");

    const kitchenPage = await app.inject({ method: "GET", url: link });
    expect(kitchenPage.body).toContain("Départ bloqué");
    expect(kitchenPage.body).not.toContain("type=\"submit\"");
    await app.inject({ method: "POST", url: link });
    expect(
      (await pool.query(`select status from delivery_orders where id=$1`, [id])).rows[0].status,
    ).toBe("IN_KITCHEN");

    await chooseCash(id);
    const departed = await app.inject({
      method: "POST",
      url: `/admin/livraisons/${id}/depart`,
      headers: { authorization: AUTH },
    });
    expect(departed.headers.location).toContain("done=departed");
  });

  it("lets Awa record cash for the exact client delivery", async () => {
    await seedKitchenContact();
    const id = await createOrder();
    const client = await clientRepo.upsertClient("221770009988");

    const result = JSON.parse(
      await executeTool(client, "create_delivery_payment_link", {
        delivery_order_id: id,
        payment_method: "cash",
      }),
    );
    expect(result).toMatchObject({
      cash_selected: true,
      delivery_order_id: id,
      amount_fcfa: 6000,
    });
    const order = (await pool.query(`select * from delivery_orders where id=$1`, [id])).rows[0];
    expect(order.payment_status).toBe("CASH_DUE");
    expect(order.payment_method).toBe("cash");
  });

  it("creates a Wave link, verifies the webhook, and unlocks departure", async () => {
    await seedKitchenContact();
    const id = await createOrder();
    const client = await clientRepo.upsertClient("221770009988");

    const result = JSON.parse(
      await executeTool(client, "create_delivery_payment_link", {
        delivery_order_id: id,
        payment_method: "wave",
      }),
    );
    expect(result).toMatchObject({
      payment_link: "https://pay.wave.com/c/test",
      payment_method: "wave",
      amount_fcfa: 6000,
      delivery_order_id: id,
    });
    const attempt = (
      await pool.query(
        `select * from delivery_payment_attempts where delivery_order_id=$1 order by created_at desc limit 1`,
        [id],
      )
    ).rows[0];
    expect(attempt.status).toBe("AWAITING_PAYMENT");

    expect((await deliverWaveWebhook(app, attempt.id)).statusCode).toBe(200);
    const paid = await waitFor(async () => {
      const row = (await pool.query(`select * from delivery_orders where id=$1`, [id])).rows[0];
      return row?.payment_status === "PAID" ? row : null;
    }, "delivery Wave payment");
    expect(paid.payment_method).toBe("wave");
    expect(paid.payment_ref).toBe(attempt.session_id);

    const departed = await app.inject({
      method: "POST",
      url: `/admin/livraisons/${id}/depart`,
      headers: { authorization: AUTH },
    });
    expect(departed.headers.location).toContain("done=departed");
    const routeText = mock
      .waTextsTo("221770009988")
      .find((text) => text.includes("en route"));
    expect(routeText).toBeDefined();
    expect(routeText).not.toContain("6000");
    expect(routeText).not.toContain("paiement");
  });

  it("uses the verified Orange Money callback for a Max It delivery payment", async () => {
    await seedKitchenContact();
    const id = await createOrder();
    const client = await clientRepo.upsertClient("221770009988");
    const result = JSON.parse(
      await executeTool(client, "create_delivery_payment_link", {
        delivery_order_id: id,
        payment_method: "maxit",
      }),
    );
    expect(result.payment_method).toBe("maxit");
    expect(result.payment_link).toBe("https://sugu.orange-sonatel.com/maxit");

    const attempt = (
      await pool.query(
        `select * from delivery_payment_attempts where delivery_order_id=$1 order by created_at desc limit 1`,
        [id],
      )
    ).rows[0];
    const transactionId = "OM_TX_delivery_maxit";
    mock.om.transactions[transactionId] = {
      status: "SUCCESS",
      amountValue: 6000,
      partnerId: "553651",
      metadata: { order: attempt.id, channel: "awa" },
      customerId: "221770009988",
    };
    await deliverOmWebhook(app, { orderId: attempt.id, transactionId });

    const paid = await waitFor(async () => {
      const row = (await pool.query(`select * from delivery_orders where id=$1`, [id])).rows[0];
      return row?.payment_status === "PAID" ? row : null;
    }, "delivery Max It payment");
    expect(paid.payment_method).toBe("maxit");
  });

  it("expires stale links and flags a payment received after cancellation for refund", async () => {
    await seedKitchenContact();
    const firstId = await createOrder({ client_phone: "770009987" });
    const firstClient = await clientRepo.upsertClient("221770009987");
    await executeTool(firstClient, "create_delivery_payment_link", {
      delivery_order_id: firstId,
      payment_method: "wave",
    });
    const staleAttempt = (
      await pool.query(
        `select * from delivery_payment_attempts where delivery_order_id=$1 order by created_at desc limit 1`,
        [firstId],
      )
    ).rows[0];
    await pool.query(
      `update delivery_payment_attempts set link_expires_at=now() - interval '1 minute' where id=$1`,
      [staleAttempt.id],
    );
    expect(await expireStaleDeliveryPaymentAttempts()).toBe(1);
    expect(
      (await pool.query(`select payment_status from delivery_orders where id=$1`, [firstId])).rows[0]
        .payment_status,
    ).toBe("PENDING_CHOICE");

    const secondId = await createOrder();
    const secondClient = await clientRepo.upsertClient("221770009988");
    await executeTool(secondClient, "create_delivery_payment_link", {
      delivery_order_id: secondId,
      payment_method: "wave",
    });
    const lateAttempt = (
      await pool.query(
        `select * from delivery_payment_attempts where delivery_order_id=$1 order by created_at desc limit 1`,
        [secondId],
      )
    ).rows[0];
    await app.inject({
      method: "POST",
      url: `/admin/livraisons/${secondId}/cancel`,
      headers: { authorization: AUTH },
    });
    expect((await deliverWaveWebhook(app, lateAttempt.id)).statusCode).toBe(200);
    const review = await waitFor(async () => {
      const row = (await pool.query(`select * from delivery_orders where id=$1`, [secondId])).rows[0];
      return row?.payment_status === "REFUND_NEEDED" ? row : null;
    }, "late delivery payment refund flag");
    expect(review.status).toBe("CANCELLED");
    expect(review.payment_issue).toBe("late_or_duplicate_online_payment");
  });
});

describe("magic link", () => {
  it("GET is read-only (prefetch-safe) and POST marks departure + pings the client once", async () => {
    await seedKitchenContact();
    const id = await createOrder();
    const link = magicLinkFrom(mock.waTextsTo("221770000099"));
    await chooseCash(id);

    // GET must NOT mutate (WhatsApp prefetches links for previews).
    const get = await app.inject({ method: "GET", url: link });
    expect(get.statusCode).toBe(200);
    expect(get.body).toContain("Partie en livraison");
    expect((await pool.query(`select status from delivery_orders where id=$1`, [id])).rows[0].status).toBe("IN_KITCHEN");

    // POST marks the single departure step.
    const post = await app.inject({ method: "POST", url: link });
    expect(post.statusCode).toBe(303);
    const order = (await pool.query(`select * from delivery_orders where id=$1`, [id])).rows[0];
    expect(order.status).toBe("OUT_FOR_DELIVERY");
    expect(order.out_for_delivery_by).toBe("kitchen-link");

    // The client gets exactly one "en route" ping (fire-and-forget → wait for it).
    // (A separate creation-confirmation ping already arrived at creation, so we
    // match the route ping by content, not by total count.)
    const routeCount = () =>
      mock.waTextsTo("221770009988").filter((t) => t.includes("en route")).length;
    await waitFor(async () => routeCount() > 0, "client en-route ping");
    expect(routeCount()).toBe(1);

    // Second POST is idempotent — no second en-route ping.
    const post2 = await app.inject({ method: "POST", url: link });
    expect(post2.statusCode).toBe(303);
    await settle();
    expect(routeCount()).toBe(1);
  });

  it("rejects a wrong token with 404 and does not mutate", async () => {
    await seedKitchenContact();
    const id = await createOrder();
    const bad = `/livraison/${"0".repeat(32)}`;
    const get = await app.inject({ method: "GET", url: bad });
    expect(get.statusCode).toBe(404);
    const post = await app.inject({ method: "POST", url: bad });
    expect(post.statusCode).toBe(404);
    expect((await pool.query(`select status from delivery_orders where id=$1`, [id])).rows[0].status).toBe("IN_KITCHEN");
  });
});

describe("renotify rotates the token", () => {
  it("invalidates the old link and issues a working new one", async () => {
    await seedKitchenContact();
    const id = await createOrder();
    const link1 = magicLinkFrom(mock.waTextsTo("221770000099"));

    const res = await app.inject({
      method: "POST",
      url: `/admin/livraisons/${id}/renotify-kitchen`,
      headers: { authorization: AUTH },
    });
    expect(res.statusCode).toBe(303);

    const link2 = magicLinkFrom(mock.waTextsTo("221770000099"));
    expect(link2).not.toBe(link1);
    expect((await app.inject({ method: "GET", url: link1 })).statusCode).toBe(404); // old dead
    expect((await app.inject({ method: "GET", url: link2 })).statusCode).toBe(200); // new works
  });
});

describe("SLA alert sweep", () => {
  it("alerts reception once for an overdue order, then never again", async () => {
    const token = newReadyToken();
    const ins = await pool.query(
      `insert into delivery_orders
         (client_name, client_phone, address, items_json, amount_xof, sla_minutes,
          ready_token_hash, kitchen_notify_status, client_notify_status, created_at)
       values ('Late','221770001111','Ngor','[]'::jsonb, 3000, 20, $1, 'sent', 'pending',
               now() - interval '25 minutes')
       returning id`,
      [hashReadyToken(token)],
    );
    const id = ins.rows[0].id;

    const n1 = await sweepDeliveries(noopLog);
    expect(n1).toBeGreaterThanOrEqual(1);
    expect((await pool.query(`select alerted_at from delivery_orders where id=$1`, [id])).rows[0].alerted_at).not.toBeNull();
    await waitFor(async () => mock.waTextsTo(RECEPTION).some((t) => t.includes("en retard")), "reception late alert");

    // One-shot: a second sweep does not re-alert this order.
    const n2 = await sweepDeliveries(noopLog);
    expect(n2).toBe(0);
  });
});

describe("item with a built-in choice", () => {
  // cafe_menu_items isn't truncated between tests, so restore the item afterwards
  // to avoid leaking the option into other suites sharing this DB.
  afterAll(async () => {
    await pool.query(
      `update cafe_menu_items set option_label=null, option_choices=null where id='BRUNCH_MYKONOS'`,
    );
  });
  async function giveBrunchAChoice(): Promise<void> {
    await pool.query(
      `update cafe_menu_items set option_label='Boisson', option_choices=$1 where id='BRUNCH_MYKONOS'`,
      ["Jus d'orange | Boisson chaude"],
    );
    await refreshCafeMenu();
  }
  async function postBrunch(choice?: string) {
    const fields: Record<string, string> = {
      client_name: "Rama",
      client_phone: "770009988",
      address: "Almadies",
      sla_minutes: "20",
      qty_BRUNCH_MYKONOS: "1",
    };
    if (choice !== undefined) fields.choice_BRUNCH_MYKONOS = choice;
    return app.inject({
      method: "POST",
      url: "/admin/livraisons",
      headers: { authorization: AUTH, "content-type": "application/x-www-form-urlencoded" },
      payload: new URLSearchParams(fields).toString(),
    });
  }

  it("rejects the order when the choice is missing and creates nothing", async () => {
    await seedKitchenContact();
    await giveBrunchAChoice();
    const res = await postBrunch(); // no choice
    // Since the tap-friendly form (22/07), validation errors re-render the
    // submitted form in place so the receptionist does not lose quantities.
    expect(res.statusCode).toBe(200);
    expect(res.headers.location).toBeUndefined();
    expect(res.body).toContain("choisis une option");
    expect(res.body).toContain(`name="qty_BRUNCH_MYKONOS" value="1"`);
    expect((await pool.query(`select count(*)::int as n from delivery_orders`)).rows[0].n).toBe(0);
  });

  it("records the choice on the line and shows it on the kitchen ticket", async () => {
    await seedKitchenContact();
    await giveBrunchAChoice();
    const res = await postBrunch("Jus d'orange");
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).not.toContain("err=");

    const order = (await pool.query(`select * from delivery_orders order by created_at desc limit 1`)).rows[0];
    expect(order.amount_xof).toBe(7500);
    expect(order.items_json[0].choice).toBe("Jus d'orange");

    const kitchenText = mock.waTextsTo("221770000099").join("\n");
    expect(kitchenText).toContain("Brunch Mykonos (Jus d'orange)");
  });
});

describe("creation confirmation ping", () => {
  it("WhatsApps the client a « bien reçue » confirmation right after creation", async () => {
    await seedKitchenContact();
    const id = await createOrder();
    await waitFor(
      async () => mock.waTextsTo("221770009988").some((t) => t.includes("bien reçue")),
      "client creation confirmation",
    );
    const order = (await pool.query(`select created_notify_status from delivery_orders where id=$1`, [id])).rows[0];
    expect(["sent", "sent_template"]).toContain(order.created_notify_status);
    const logged = (
      await pool.query(
        `select body from notification_log
          where source='delivery' and recipient_phone='221770009988'
         order by created_at desc limit 1`,
      )
    ).rows[0];
    expect(logged.body).toContain("WAVE, OM, MAXIT ou ESPÈCES");
    expect(logged.body).not.toContain("à régler à la livraison");
  });

  it("uses the approved delivery template first when it is configured", async () => {
    const previousTemplate = config.WA_DELIVERY_UPDATE_TEMPLATE;
    const previousLang = config.WA_DELIVERY_UPDATE_TEMPLATE_LANG;
    config.WA_DELIVERY_UPDATE_TEMPLATE = "livraison_update";
    config.WA_DELIVERY_UPDATE_TEMPLATE_LANG = "en";
    try {
      await seedKitchenContact();
      const id = await createOrder();
      await waitFor(
        async () =>
          mock.waCalls().some(
            (c) =>
              c.body?.to === "221770009988" &&
              c.body?.type === "template" &&
              c.body?.template?.name === "livraison_update",
          ),
        "client delivery template",
      );
      expect(mock.waTextsTo("221770009988")).toHaveLength(0);
      const order = (
        await pool.query(
          `select created_notify_status, created_notify_wamid from delivery_orders where id=$1`,
          [id],
        )
      ).rows[0];
      expect(order.created_notify_status).toBe("sent_template");
      expect(order.created_notify_wamid).toMatch(/^wamid\.test\./);
    } finally {
      config.WA_DELIVERY_UPDATE_TEMPLATE = previousTemplate;
      config.WA_DELIVERY_UPDATE_TEMPLATE_LANG = previousLang;
    }
  });

  it("sends the new-order reception alert template-first and stores its wamid", async () => {
    const previousTemplate = config.WA_RECEPTION_TEMPLATE;
    const previousLang = config.WA_RECEPTION_TEMPLATE_LANG;
    config.WA_RECEPTION_TEMPLATE = "awa_notification";
    config.WA_RECEPTION_TEMPLATE_LANG = "en";
    try {
      await seedKitchenContact();
      await createOrder();
      await waitFor(
        async () =>
          mock.waCalls().some(
            (c) =>
              c.body?.to === RECEPTION &&
              c.body?.type === "template" &&
              c.body?.template?.name === "awa_notification",
          ),
        "reception delivery template",
      );
      expect(
        mock.waTextsTo(RECEPTION).some((text) => text.includes("Nouvelle commande livraison")),
      ).toBe(false);
      const row = (
        await pool.query(
          `select status, wa_message_id from notification_log
            where source='reception' and body like '%Nouvelle commande livraison%'
            order by created_at desc limit 1`,
        )
      ).rows[0];
      expect(row.status).toBe("sent_template");
      expect(row.wa_message_id).toMatch(/^wamid\.test\./);
    } finally {
      config.WA_RECEPTION_TEMPLATE = previousTemplate;
      config.WA_RECEPTION_TEMPLATE_LANG = previousLang;
    }
  });
});

describe("test delivery mode", () => {
  it("runs the alert flow but is excluded from business stats and recent clients", async () => {
    await seedKitchenContact();
    const id = await createOrder({ is_test: "1" });
    await waitFor(
      async () => mock.waTextsTo("221770009988").some((t) => t.includes("TEST")),
      "test client alert",
    );

    const order = (await pool.query(`select is_test from delivery_orders where id=$1`, [id])).rows[0];
    expect(order.is_test).toBe(true);
    expect((await deliveryStats()).openCount).toBe(0);
    expect(await recentDeliveryClients()).toHaveLength(0);
    expect(mock.waTextsTo("221770000099").some((t) => t.includes("COMMANDE DE TEST"))).toBe(true);
    await waitFor(
      async () => mock.waTextsTo(RECEPTION).some((t) => t.includes("COMMANDE DE TEST")),
      "test reception alert",
    );
  });
});

describe("out for delivery (admin board)", () => {
  it("POST /admin/livraisons/:id/depart marks OUT_FOR_DELIVERY and pings the client", async () => {
    await seedKitchenContact();
    const id = await createOrder();
    await chooseCash(id);

    const res = await app.inject({
      method: "POST",
      url: `/admin/livraisons/${id}/depart`,
      headers: { authorization: AUTH },
    });
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toContain("done=departed");
    const order = (await pool.query(`select * from delivery_orders where id=$1`, [id])).rows[0];
    expect(order.status).toBe("OUT_FOR_DELIVERY");
    expect(order.out_for_delivery_by).toContain("admin");
    expect(["sent", "sent_template"]).toContain(order.route_notify_status);
  });

  it("marking delivered directly from IN_KITCHEN (departure never tapped) sends no en-route ping", async () => {
    await seedKitchenContact();
    const id = await createOrder();
    await chooseCash(id);
    await settle();

    const res = await app.inject({
      method: "POST",
      url: `/admin/livraisons/${id}/delivered`,
      headers: { authorization: AUTH },
    });
    expect(res.statusCode).toBe(303);
    expect((await pool.query(`select status from delivery_orders where id=$1`, [id])).rows[0].status).toBe("DELIVERED");
    await settle();
    expect(mock.waTextsTo("221770009988").some((t) => t.includes("en route"))).toBe(false);
  });

  it("cancelling from OUT_FOR_DELIVERY is allowed and sends no client message", async () => {
    await seedKitchenContact();
    const id = await createOrder();
    await chooseCash(id);
    await app.inject({ method: "POST", url: `/admin/livraisons/${id}/depart`, headers: { authorization: AUTH } });
    await settle();
    const before = mock.waTextsTo("221770009988").length;

    const res = await app.inject({
      method: "POST",
      url: `/admin/livraisons/${id}/cancel`,
      headers: { authorization: AUTH },
    });
    expect(res.statusCode).toBe(303);
    expect((await pool.query(`select status from delivery_orders where id=$1`, [id])).rows[0].status).toBe("CANCELLED");
    await settle();
    expect(mock.waTextsTo("221770009988").length).toBe(before); // no cancellation message
  });
});

describe("async delivery-failure correction (statuses webhook)", () => {
  it("flips a logged 'sent' row to 'failed' when Meta reports the wamid failed", async () => {
    const wamid = "wamid.TEST123";
    await recordDeliveryLog("221770009988", "[livraison test] prête", "sent", null, wamid);

    const flipped = await markLogFailedByWamid(wamid, "131047 Re-engagement message");
    expect(flipped).toBe(1);

    const row = (
      await pool.query(`select status, error from notification_log where wa_message_id = $1`, [wamid])
    ).rows[0];
    expect(row.status).toBe("failed");
    expect(row.error).toContain("131047");

    // Unknown wamid → no-op.
    expect(await markLogFailedByWamid("wamid.UNKNOWN", "x")).toBe(0);
  });

  it("puts the matching current client ping back in failed so the sweep can retry it", async () => {
    await seedKitchenContact();
    const id = await createOrder();
    await waitFor(
      async () => {
        const row = (
          await pool.query(
            `select created_notify_status, created_notify_wamid from delivery_orders where id=$1`,
            [id],
          )
        ).rows[0];
        return row?.created_notify_status === "sent" && !!row?.created_notify_wamid;
      },
      "client ping wamid stored",
    );
    const before = (
      await pool.query(
        `select created_notify_wamid, created_notify_attempts from delivery_orders where id=$1`,
        [id],
      )
    ).rows[0];

    expect(await markClientPingFailedByWamid(before.created_notify_wamid)).toBe(1);
    const failed = (
      await pool.query(
        `select created_notify_status, created_notify_wamid from delivery_orders where id=$1`,
        [id],
      )
    ).rows[0];
    expect(failed).toEqual({ created_notify_status: "failed", created_notify_wamid: null });

    await sweepDeliveries(noopLog);
    const retried = (
      await pool.query(
        `select created_notify_status, created_notify_attempts, created_notify_wamid
           from delivery_orders where id=$1`,
        [id],
      )
    ).rows[0];
    expect(retried.created_notify_status).toBe("sent");
    expect(retried.created_notify_attempts).toBe(before.created_notify_attempts + 1);
    expect(retried.created_notify_wamid).toMatch(/^wamid\.test\./);
  });
});
