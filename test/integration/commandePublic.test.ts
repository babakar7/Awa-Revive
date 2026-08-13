import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../../src/server.js";
import { config } from "../../src/config.js";
import { pool } from "../../src/db/index.js";
import { setCafeMenu, type CafeMenuRow } from "../../src/lib/cafeMenu.js";
import { __resetPublicOrderLimiter } from "../../src/lib/rateLimit.js";
import { makeFetchMock, type FetchMock, deliverWaveWebhook, waitFor, settle, truncateAll } from "./helpers.js";

/**
 * The public /commander ordering flow against a REAL Postgres (all external HTTP
 * mocked). Exercises the exact money path: POST → draft cafe order → Wave link →
 * verified webhook → fulfillCafeOrder → BAR ticket OR auto-created web delivery.
 * Locks the review's invariants: idempotent web delivery, customer_name snapshot,
 * hybrid fee (articles PAID + fee CASH_DUE), fail-closed hours, no client price.
 */

let app: FastifyInstance;
let mock: FetchMock;

const MENU_ROWS: CafeMenuRow[] = [
  { id: "JANTBI", name: "Jant Bi", priceXof: 3000, category: "Smoothies", favourite: true, enabled: true, sortOrder: 1 },
  {
    id: "BRUNCH",
    name: "Brunch Mykonos",
    priceXof: 6000,
    category: "Brunch",
    favourite: false,
    enabled: true,
    sortOrder: 2,
    optionGroups: [
      { label: "Boisson", choices: ["Jus", "Café"] },
      { label: "Pain", choices: ["Blanc", "Complet"] },
    ],
  },
];

beforeAll(async () => {
  mock = makeFetchMock();
  mock.install();
  app = buildServer();
  await app.ready();
  // Delivery cutoff at 24:00 so delivery is time-open whenever the suite runs;
  // individual tests override this to exercise the cutoff.
  config.DELIVERY_ORDER_CUTOFF_MIN = 1440;
  config.DELIVERY_FEE_XOF = 1000;
});

afterAll(async () => {
  mock.restore();
  await app.close();
  await pool.end();
});

beforeEach(async () => {
  await truncateAll();
  await pool.query(`truncate pending_cafe_orders, kitchen_tickets, ops_events, service_sessions restart identity cascade`);
  mock.reset();
  __resetPublicOrderLimiter(); // shared test IP would otherwise trip suite-wide
  setCafeMenu(MENU_ROWS);
  config.DELIVERY_ORDER_CUTOFF_MIN = 1440;
  await seedBarOpen();
});

afterEach(async () => {
  await settle(400); // let the webhook's setImmediate fulfillment finish
});

/** A published planning with a bar staffer on shift 24/7 so barOpenNow() is open. */
async function seedBarOpen(): Promise<void> {
  const staff = await pool.query(`insert into staff_contacts (name, phone, role) values ('Bar Test','','bar') returning id`);
  const sched = await pool.query(`insert into staff_schedules (name, status) values ('Test', 'published') returning id`);
  const staffId = staff.rows[0].id as string;
  const schedId = sched.rows[0].id as string;
  const vals: string[] = [];
  for (let wd = 0; wd < 7; wd++) vals.push(`('${schedId}','${staffId}',${wd},0,1440)`);
  await pool.query(`insert into staff_shifts (schedule_id, staff_id, weekday, start_min, end_min) values ${vals.join(",")}`);
}

function order(body: Record<string, unknown>) {
  return app.inject({ method: "POST", url: "/commander/api/order", payload: body });
}

async function cafeOrderByReq(reqId: string): Promise<any> {
  const r = await pool.query(`select * from pending_cafe_orders where client_request_id = $1`, [reqId]);
  return r.rows[0] ?? null;
}
async function barTicket(cafeId: string): Promise<any> {
  return waitFor(async () => {
    const r = await pool.query(`select * from kitchen_tickets where client_request_id = $1`, [`bar:cafe:${cafeId}`]);
    return r.rows[0] ?? null;
  }, `BAR ticket for ${cafeId}`);
}
async function webDelivery(cafeId: string): Promise<any> {
  return waitFor(async () => {
    const r = await pool.query(`select * from delivery_orders where source_cafe_order_id = $1`, [cafeId]);
    return r.rows[0] ?? null;
  }, `web delivery for ${cafeId}`);
}

describe("/commander — public page serving", () => {
  it("serves the page, the app.js asset and the menu.json boot (with hours + fav)", async () => {
    const page = await app.inject({ method: "GET", url: "/commander" });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain("/commander/app.js");
    expect(page.body).not.toContain("window.__BOOT__"); // CSP-safe: boot via fetch

    const js = await app.inject({ method: "GET", url: "/commander/app.js" });
    expect(js.statusCode).toBe(200);
    expect(js.headers["content-type"]).toContain("javascript");

    const menu = await app.inject({ method: "GET", url: "/commander/menu.json" });
    expect(menu.statusCode).toBe(200);
    const j = JSON.parse(menu.body);
    expect(j.hours.open).toBe(true); // bar seeded open
    const jantbi = j.menu.flatMap((c: any) => c.items).find((i: any) => i.id === "JANTBI");
    expect(jantbi.fav).toBe(true);
    expect(jantbi.price).toBe(3000);
  });
});

describe("/commander — bar ticket modes", () => {
  it("à emporter: paid → BAR ticket with takeaway + typed name, no delivery", async () => {
    const res = await order({
      items: [{ item_id: "JANTBI", qty: 2 }],
      mode: "A_EMPORTER",
      method: "wave",
      first_name: "Awa",
      phone: "771234567",
      client_request_id: "req-emporter",
    });
    expect(res.statusCode).toBe(200);
    const j = JSON.parse(res.body);
    expect(j.ok).toBe(true);
    expect(j.payment_link).toContain("wave");

    const co = await cafeOrderByReq("req-emporter");
    expect(co.status).toBe("AWAITING_PAYMENT");
    expect(co.service_mode).toBe("A_EMPORTER");
    expect(co.amount_xof).toBe(6000); // 2 × 3000, priced server-side

    await deliverWaveWebhook(app, co.id);
    const tk = await barTicket(co.id);
    expect(tk.source).toBe("BAR");
    expect(tk.takeaway).toBe(true);
    expect(tk.heading).toBe("Awa");
    expect(tk.subheading).toContain("emporter");
    // No delivery was created for a bar-ticket mode.
    const del = await pool.query(`select count(*)::int n from delivery_orders where source_cafe_order_id = $1`, [co.id]);
    expect(del.rows[0].n).toBe(0);
  });

  it("sur place: takeaway false, subheading 'servir à {prénom}'", async () => {
    const res = await order({
      items: [{ item_id: "JANTBI", qty: 1 }],
      mode: "SUR_PLACE",
      method: "wave",
      first_name: "Bou",
      phone: "781112233",
      client_request_id: "req-place",
    });
    expect(res.statusCode).toBe(200);
    const co = await cafeOrderByReq("req-place");
    await deliverWaveWebhook(app, co.id);
    const tk = await barTicket(co.id);
    expect(tk.takeaway).toBe(false);
    expect(tk.subheading).toContain("servir à Bou");
  });

  it("multi-choice item: both option groups reach the ticket lines", async () => {
    const res = await order({
      items: [{ item_id: "BRUNCH", qty: 1, selections: [{ label: "Boisson", value: "Café" }, { label: "Pain", value: "Complet" }] }],
      mode: "SUR_PLACE",
      method: "wave",
      first_name: "Sel",
      phone: "770001122",
      client_request_id: "req-multi",
    });
    expect(res.statusCode).toBe(200);
    const co = await cafeOrderByReq("req-multi");
    await deliverWaveWebhook(app, co.id);
    const tk = await barTicket(co.id);
    const lines = tk.items_json as any[];
    expect(lines[0].selections).toEqual([
      { label: "Boisson", value: "Café" },
      { label: "Pain", value: "Complet" },
    ]);
  });

  it("a required choice left unpicked is rejected 400 (never reaches the kitchen)", async () => {
    const res = await order({
      items: [{ item_id: "BRUNCH", qty: 1 }], // no selections
      mode: "SUR_PLACE",
      method: "wave",
      first_name: "X",
      phone: "770002233",
      client_request_id: "req-nochoice",
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("/commander — web delivery (hybrid payment, idempotent)", () => {
  it("livraison: paid → delivery created (PAID articles + fee CASH_DUE), no bar ticket; webhook replay makes exactly one", async () => {
    const res = await order({
      items: [{ item_id: "JANTBI", qty: 1 }],
      mode: "LIVRAISON",
      method: "wave",
      first_name: "Liv",
      phone: "770003344",
      address: "Almadies, villa 12",
      client_request_id: "req-liv",
    });
    expect(res.statusCode).toBe(200);
    const co = await cafeOrderByReq("req-liv");
    expect(co.service_mode).toBe("LIVRAISON");
    expect(co.delivery_address).toBe("Almadies, villa 12");

    await deliverWaveWebhook(app, co.id);
    const del = await webDelivery(co.id);
    expect(del.created_by).toBe("web");
    expect(del.payment_status).toBe("PAID"); // articles paid online
    expect(del.delivery_fee_status).toBe("CASH_DUE"); // fee still cash to driver
    expect(del.delivery_fee_xof).toBe(1000);
    expect(del.client_name).toBe("Liv");
    expect(del.address).toBe("Almadies, villa 12");
    expect(del.activated_at).not.toBeNull(); // departs immediately (already paid)

    // No BAR ticket for a delivery.
    const bar = await pool.query(`select count(*)::int n from kitchen_tickets where client_request_id = $1`, [`bar:cafe:${co.id}`]);
    expect(bar.rows[0].n).toBe(0);

    // Replay the webhook → still exactly ONE delivery (idempotent).
    await deliverWaveWebhook(app, co.id, { eventId: "EV_replay_liv" });
    await settle(400);
    const count = await pool.query(`select count(*)::int n from delivery_orders where source_cafe_order_id = $1`, [co.id]);
    expect(count.rows[0].n).toBe(1);
  });
});

describe("/commander — customer name snapshot", () => {
  it("an existing CRM client keeps their name, but the ticket uses the TYPED first name", async () => {
    await pool.query(`insert into clients (wa_phone, name, language) values ('221775556677','Fatou Diop','fr')`);
    const res = await order({
      items: [{ item_id: "JANTBI", qty: 1 }],
      mode: "SUR_PLACE",
      method: "wave",
      first_name: "Awa",
      phone: "775556677",
      client_request_id: "req-name",
    });
    expect(res.statusCode).toBe(200);
    const co = await cafeOrderByReq("req-name");
    expect(co.customer_name).toBe("Awa");
    await deliverWaveWebhook(app, co.id);
    const tk = await barTicket(co.id);
    expect(tk.heading).toBe("Awa"); // typed, not "Fatou Diop"
    const cli = await pool.query(`select name from clients where wa_phone = '221775556677'`);
    expect(cli.rows[0].name).toBe("Fatou Diop"); // CRM untouched
  });
});

describe("/commander — hours gating (fail-closed)", () => {
  it("no published schedule → 409 (never fails open on a public endpoint)", async () => {
    await pool.query(`update staff_schedules set status = 'draft'`);
    const res = await order({
      items: [{ item_id: "JANTBI", qty: 1 }],
      mode: "SUR_PLACE",
      method: "wave",
      first_name: "Z",
      phone: "770009988",
      client_request_id: "req-noplan",
    });
    expect(res.statusCode).toBe(409);
  });

  it("past the delivery cutoff: LIVRAISON refused 409, A_EMPORTER still accepted", async () => {
    config.DELIVERY_ORDER_CUTOFF_MIN = 1; // 00:01 → any real time is past it
    const liv = await order({
      items: [{ item_id: "JANTBI", qty: 1 }],
      mode: "LIVRAISON",
      method: "wave",
      first_name: "Z",
      phone: "770001199",
      address: "Ngor, rue 3",
      client_request_id: "req-cutoff-liv",
    });
    expect(liv.statusCode).toBe(409);
    const emp = await order({
      items: [{ item_id: "JANTBI", qty: 1 }],
      mode: "A_EMPORTER",
      method: "wave",
      first_name: "Z",
      phone: "770001199",
      client_request_id: "req-cutoff-emp",
    });
    expect(emp.statusCode).toBe(200);
  });
});

describe("/commander — validation, OM gate, idempotency, rate limit", () => {
  it("rejects a non-Senegalese phone, a missing delivery address, and an unknown item", async () => {
    expect((await order({ items: [{ item_id: "JANTBI", qty: 1 }], mode: "SUR_PLACE", method: "wave", first_name: "A", phone: "12345", client_request_id: "r1" })).statusCode).toBe(400);
    expect((await order({ items: [{ item_id: "JANTBI", qty: 1 }], mode: "LIVRAISON", method: "wave", first_name: "A", phone: "770001100", address: "x", client_request_id: "r2" })).statusCode).toBe(400);
    expect((await order({ items: [{ item_id: "NOPE", qty: 1 }], mode: "SUR_PLACE", method: "wave", first_name: "A", phone: "770001101", client_request_id: "r3" })).statusCode).toBe(400);
  });

  it("refuses an unknown payment method (400)", async () => {
    const res = await order({ items: [{ item_id: "JANTBI", qty: 1 }], mode: "SUR_PLACE", method: "bitcoin", first_name: "A", phone: "770001102", client_request_id: "r-badpm" });
    expect(res.statusCode).toBe(400);
  });

  it("a repeated client_request_id returns the SAME order and link (idempotent POST)", async () => {
    const a = await order({ items: [{ item_id: "JANTBI", qty: 1 }], mode: "SUR_PLACE", method: "wave", first_name: "Id", phone: "770004455", client_request_id: "req-idem" });
    const b = await order({ items: [{ item_id: "JANTBI", qty: 1 }], mode: "SUR_PLACE", method: "wave", first_name: "Id", phone: "770004455", client_request_id: "req-idem" });
    expect(a.statusCode).toBe(200);
    expect(b.statusCode).toBe(200);
    expect(JSON.parse(a.body).payment_link).toBe(JSON.parse(b.body).payment_link);
    const n = await pool.query(`select count(*)::int n from pending_cafe_orders where client_request_id = 'req-idem'`);
    expect(n.rows[0].n).toBe(1);
  });

  it("rate-limits a burst of order attempts from the same phone (429)", async () => {
    __resetPublicOrderLimiter(); // start from a clean budget for a deterministic burst
    let got429 = false;
    for (let i = 0; i < 7; i++) {
      const res = await order({ items: [{ item_id: "JANTBI", qty: 1 }], mode: "SUR_PLACE", method: "wave", first_name: "Fl", phone: "770007766", client_request_id: `req-rl-${i}` });
      if (res.statusCode === 429) got429 = true;
    }
    expect(got429).toBe(true);
  });
});
