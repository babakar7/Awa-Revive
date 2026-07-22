import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../../src/server.js";
import { pool, migrate } from "../../src/db/index.js";
import { initCafeMenu, refreshCafeMenu } from "../../src/domain/cafeMenuRepo.js";
import { config } from "../../src/config.js";
import { sweepDeliveries } from "../../src/domain/deliveryNotify.js";
import { markLogFailedByWamid, recordDeliveryLog } from "../../src/domain/notificationRepo.js";
import { hashReadyToken, newReadyToken } from "../../src/domain/deliveryRules.js";
import { planningNowSlot } from "../../src/domain/staffPlanningRules.js";
import { makeFetchMock, type FetchMock, truncateAll, waitFor, settle } from "./helpers.js";

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

/** Newest-first: the mock accumulates texts across a test, so the latest kitchen
 *  message (e.g. after a renotify/rotate) is at the end. Token-only URL. */
function magicLinkFrom(texts: string[]): string {
  for (let i = texts.length - 1; i >= 0; i--) {
    const m = texts[i].match(/\/livraison\/[0-9a-f]+/);
    if (m) return m[0];
  }
  throw new Error(`no magic link in: ${JSON.stringify(texts)}`);
}

describe("delivery order creation → kitchen notify", () => {
  it("prices server-side, creates IN_KITCHEN, and WhatsApps the kitchen a magic link", async () => {
    await seedKitchenContact();
    const id = await createOrder();

    const order = (await pool.query(`select * from delivery_orders where id=$1`, [id])).rows[0];
    expect(order.status).toBe("IN_KITCHEN");
    expect(order.amount_xof).toBe(6000); // 2 × Jant Bi @ 3000 — from the menu, not the form
    expect(order.client_phone).toBe("221770009988");
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

describe("magic link", () => {
  it("GET is read-only (prefetch-safe) and POST marks departure + pings the client once", async () => {
    await seedKitchenContact();
    const id = await createOrder();
    const link = magicLinkFrom(mock.waTextsTo("221770000099"));

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
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toContain("/livraisons/new?err=");
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
  });
});

describe("out for delivery (admin board)", () => {
  it("POST /admin/livraisons/:id/depart marks OUT_FOR_DELIVERY and pings the client", async () => {
    await seedKitchenContact();
    const id = await createOrder();

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
});
