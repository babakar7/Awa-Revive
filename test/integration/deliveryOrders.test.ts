import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../../src/server.js";
import { pool, migrate } from "../../src/db/index.js";
import { config } from "../../src/config.js";
import { sweepDeliveries } from "../../src/domain/deliveryNotify.js";
import { hashReadyToken, newReadyToken } from "../../src/domain/deliveryRules.js";
import { makeFetchMock, type FetchMock, truncateAll, waitFor, settle } from "./helpers.js";

/**
 * Delivery-orders end-to-end against a real Postgres, all HTTP mocked. Exercises
 * the exact SQL/flow that makes the ops path safe: server-priced order, kitchen
 * WhatsApp with a magic link, GET-does-not-mutate (WhatsApp prefetch), atomic
 * mark-ready + single client ping, token rotation, and the one-shot SLA alert.
 */

const noopLog = { info: () => {}, warn: () => {}, error: () => {} };
const AUTH = `Basic ${Buffer.from("revive:revive").toString("base64")}`;
const RECEPTION = config.RECEPTION_PHONE.replace(/\D/g, "");

let app: FastifyInstance;
let mock: FetchMock;

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

async function seedKitchenContact(phone = "221770000099"): Promise<void> {
  await pool.query(
    `insert into staff_contacts (name, phone, role, muted) values ('Chef', $1, 'cuisine', false)`,
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
 *  message (e.g. after a renotify/rotate) is at the end. */
function magicLinkFrom(texts: string[]): string {
  for (let i = texts.length - 1; i >= 0; i--) {
    const m = texts[i].match(/\/livraison\/[0-9a-f-]+\/[0-9a-f]+/);
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
    expect(link).toContain(`/livraison/${id}/`);
  });

  it("with no cuisine contact, routes the ticket to reception with a warning", async () => {
    const id = await createOrder();
    await settle();
    const toReception = mock.waTextsTo(RECEPTION).join("\n");
    expect(toReception).toContain("Aucun contact");
    const order = (await pool.query(`select kitchen_notify_status from delivery_orders where id=$1`, [id])).rows[0];
    expect(order.kitchen_notify_status).toBe("fallback_reception");
  });
});

describe("magic link", () => {
  it("GET is read-only (prefetch-safe) and POST marks ready + pings the client once", async () => {
    await seedKitchenContact();
    const id = await createOrder();
    const link = magicLinkFrom(mock.waTextsTo("221770000099"));

    // GET must NOT mutate (WhatsApp prefetches links for previews).
    const get = await app.inject({ method: "GET", url: link });
    expect(get.statusCode).toBe(200);
    expect((await pool.query(`select status from delivery_orders where id=$1`, [id])).rows[0].status).toBe("IN_KITCHEN");

    // POST marks ready.
    const post = await app.inject({ method: "POST", url: link });
    expect(post.statusCode).toBe(303);
    const order = (await pool.query(`select * from delivery_orders where id=$1`, [id])).rows[0];
    expect(order.status).toBe("READY");
    expect(order.ready_by).toBe("kitchen-link");

    // The client gets exactly one "ready" ping (fire-and-forget → wait for it).
    await waitFor(async () => mock.waTextsTo("221770009988").length > 0, "client ready ping");
    const before = mock.waTextsTo("221770009988").length;

    // Second POST is idempotent — no second client ping.
    const post2 = await app.inject({ method: "POST", url: link });
    expect(post2.statusCode).toBe(303);
    await settle();
    expect(mock.waTextsTo("221770009988").length).toBe(before);
  });

  it("rejects a wrong token with 404 and does not mutate", async () => {
    await seedKitchenContact();
    const id = await createOrder();
    const bad = `/livraison/${id}/${"0".repeat(32)}`;
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
