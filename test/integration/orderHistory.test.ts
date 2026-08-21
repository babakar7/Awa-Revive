import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../../src/server.js";
import { pool } from "../../src/db/index.js";
import { makeFetchMock, type FetchMock } from "./helpers.js";
import {
  listOrderHistory,
  orderHistoryStats,
  orderHistoryByChannel,
  orderHistoryDaily,
  type OrderHistoryFilters,
} from "../../src/admin/queries.js";

const AUTH = `Basic ${Buffer.from("revive:revive@5000").toString("base64")}`;

/**
 * Unified order history across the three channels (kitchen_tickets spine +
 * legacy deliveries + legacy cafe orders). Seeds one row per code path and
 * asserts channel mapping, no double counting, and test/cancelled exclusion
 * from revenue.
 */

const ITEMS = JSON.stringify([
  { id: "cafe", name: "Café", qty: 2, unitPriceXof: 1000, lineTotalXof: 2000 },
]);

let clientId: string;
let app: FastifyInstance;
let mock: FetchMock;

beforeAll(async () => {
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
  await pool.query(
    `truncate kitchen_tickets, delivery_orders, pending_cafe_orders, clients restart identity cascade`,
  );
  const c = await pool.query(
    `insert into clients (wa_phone, name, language) values ('221770000009','Awa Test','fr') returning id`,
  );
  clientId = c.rows[0].id;
});

async function seedCafeOrder(mode: string, status = "PAID"): Promise<string> {
  const r = await pool.query(
    `insert into pending_cafe_orders (client_id, extras_json, amount_xof, status, service_mode, customer_name, payment_method)
     values ($1, $2::jsonb, 3000, $3, $4, 'Awa', 'wave') returning id`,
    [clientId, ITEMS, status, mode],
  );
  return r.rows[0].id;
}

async function seedBarTicket(
  requestId: string,
  status = "COMPLETED",
  extra: { is_test?: boolean; takeaway?: boolean } = {},
): Promise<void> {
  await pool.query(
    `insert into kitchen_tickets (source, client_request_id, items_json, amount_xof, heading, status, is_test, takeaway)
     values ('BAR', $1, $2::jsonb, 3000, 'Awa', $3, $4, $5)`,
    [requestId, ITEMS, status, extra.is_test ?? false, extra.takeaway ?? false],
  );
}

async function seedDelivery(status: string, tokenSuffix: string): Promise<string> {
  const r = await pool.query(
    `insert into delivery_orders (client_name, client_phone, address, items_json, amount_xof, status, ready_token_hash)
     values ('Awa','221770000009','Dakar', $1::jsonb, 4000, $2, $3) returning id`,
    [ITEMS, status, `tok-${tokenSuffix}`],
  );
  return r.rows[0].id;
}

const ALL: OrderHistoryFilters = { period: "all", channel: "all", status: "all", page: 1 };

describe("order history queries", () => {
  it("maps every channel and excludes test + avoids double counting", async () => {
    // BAR ticket → cafe order, one per service mode
    const surPlaceId = await seedCafeOrder("SUR_PLACE");
    await seedBarTicket(`bar:cafe:${surPlaceId}`);
    const emporterId = await seedCafeOrder("A_EMPORTER");
    await seedBarTicket(`bar:cafe:${emporterId}`);
    // BAR ticket from a booking's extras → RETRAIT
    await seedBarTicket("bar:booking:00000000-0000-0000-0000-000000000001");
    // TABLE ticket → SUR_PLACE (no cafe order, POS pays)
    await pool.query(
      `insert into kitchen_tickets (source, items_json, amount_xof, heading, subheading, status)
       values ('TABLE', $1::jsonb, 2500, 'Table', 'C-24', 'COMPLETED')`,
      [ITEMS],
    );
    // DELIVERY ticket + its delivery order (web order path)
    const delId = await seedDelivery("DELIVERED", "web");
    await pool.query(
      `insert into kitchen_tickets (source, delivery_order_id, items_json, amount_xof, heading, status)
       values ('DELIVERY', $1, $2::jsonb, 4000, 'Awa', 'COMPLETED')`,
      [delId, ITEMS],
    );
    // Legacy delivery with NO kitchen ticket
    await seedDelivery("DELIVERED", "legacy");
    // Legacy PAID cafe order with no ticket and no delivery → RETRAIT
    await seedCafeOrder("RETRAIT");
    // A test ticket (excluded everywhere)
    await seedBarTicket("bar:booking:00000000-0000-0000-0000-000000000002", "COMPLETED", {
      is_test: true,
    });
    // A cancelled ticket (listed, excluded from revenue)
    await seedBarTicket("bar:booking:00000000-0000-0000-0000-000000000003", "CANCELLED");

    const list = await listOrderHistory(ALL);
    // 4 BAR (2 cafe + booking + cancelled) + 1 TABLE + 1 DELIVERY ticket
    //   + 1 legacy delivery + 1 legacy cafe = 8 visible (test excluded)
    expect(list.total).toBe(8);

    const channels = list.rows.map((r) => r.channel).sort();
    expect(channels).toEqual(
      ["A_EMPORTER", "LIVRAISON", "LIVRAISON", "RETRAIT", "RETRAIT", "RETRAIT", "SUR_PLACE", "SUR_PLACE"].sort(),
    );

    // the web delivery ticket must not be double-counted with a legacy row
    const deliveries = list.rows.filter((r) => r.channel === "LIVRAISON");
    expect(deliveries).toHaveLength(2);

    const stats = await orderHistoryStats(ALL);
    // completed = 8 visible minus the one cancelled = 7
    expect(stats.completed).toBe(7);
    expect(stats.cancelled).toBe(1);
    // revenue: 3000*2 (cafe bar) + 3000 (booking bar) + 2500 (table) + 4000 (del ticket)
    //   + 4000 (legacy del) + 3000 (legacy cafe) = 22500 (test + cancelled excluded)
    expect(stats.revenueXof).toBe(22500);

    const byChannel = await orderHistoryByChannel(ALL);
    const map = Object.fromEntries(byChannel.map((c) => [c.channel, c]));
    expect(map.SUR_PLACE.orders).toBe(2);
    expect(map.LIVRAISON.orders).toBe(2);
    expect(map.RETRAIT.orders).toBe(2); // booking bar + legacy cafe
    expect(map.A_EMPORTER.orders).toBe(1);
  });

  it("respects the channel filter", async () => {
    const id = await seedCafeOrder("SUR_PLACE");
    await seedBarTicket(`bar:cafe:${id}`);
    await seedDelivery("DELIVERED", "d1");
    const filtered = await listOrderHistory({ ...ALL, channel: "LIVRAISON" });
    expect(filtered.rows.every((r) => r.channel === "LIVRAISON")).toBe(true);
    expect(filtered.total).toBe(1);
  });

  it("zero-fills the daily series over the window", async () => {
    const id = await seedCafeOrder("SUR_PLACE");
    await seedBarTicket(`bar:cafe:${id}`);
    const daily = await orderHistoryDaily({ ...ALL, period: "7" });
    expect(daily).toHaveLength(7);
    const total = daily.reduce((s, d) => s + d.orders, 0);
    expect(total).toBe(1);
  });

  it("serves the admin page end-to-end", async () => {
    const id = await seedCafeOrder("SUR_PLACE");
    await seedBarTicket(`bar:cafe:${id}`);
    const res = await app.inject({
      method: "GET",
      url: "/admin/historique-commandes?period=all&channel=SUR_PLACE",
      headers: { authorization: AUTH },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("Historique des commandes");
    expect(res.body).toContain("Sur place");
    expect(res.body).toContain("le POS reste la seule source comptable");
  });

  it("serves the filter fragment without the page chrome", async () => {
    const id = await seedCafeOrder("SUR_PLACE");
    await seedBarTicket(`bar:cafe:${id}`);
    const res = await app.inject({
      method: "GET",
      url: "/admin/historique-commandes/fragment?period=all&channel=LIVRAISON",
      headers: { authorization: AUTH },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["cache-control"]).toContain("no-store");
    expect(res.body).toContain('id="oh-fragment"');
    // fragment only — no full-page header or enhancer script
    expect(res.body).not.toContain("page-header");
    expect(res.body).not.toContain("<script>");
    // channel filter applied → the SUR_PLACE order is not listed
    expect(res.body).toContain("Aucune commande");
  });

  // « Offert » : la commande a bien eu lieu (elle compte dans les volumes), mais
  // son montant est une dépense promo, pas une recette.
  it("keeps an offered order in the counts and out of every revenue figure", async () => {
    await pool.query(
      `insert into kitchen_tickets (source, items_json, amount_xof, heading, subheading, status)
       values ('TABLE', $1::jsonb, 2500, 'Table', 'C-24', 'COMPLETED')`,
      [ITEMS],
    );
    await pool.query(
      `insert into kitchen_tickets (source, items_json, amount_xof, heading, subheading, status, offert)
       values ('TABLE', $1::jsonb, 2000, 'Table', 'C-24', 'COMPLETED', true)`,
      [ITEMS],
    );

    // Listée, badgée — jamais escamotée (sinon on croit l'avoir perdue).
    const list = await listOrderHistory(ALL);
    expect(list.total).toBe(2);
    expect(list.rows.filter((r) => r.offert)).toHaveLength(1);

    const stats = await orderHistoryStats(ALL);
    expect(stats.completed).toBe(2); // le volume compte les deux
    expect(stats.revenueXof).toBe(2500); // le revenu, non
    expect(stats.avgTicketXof).toBe(2500); // ni le panier moyen
    expect(stats.offertsXof).toBe(2000); // suivi à part

    // Par canal : 2 commandes, un seul revenu (le filtre est sur la SOMME).
    const byChannel = await orderHistoryByChannel(ALL);
    const surPlace = byChannel.find((c) => c.channel === "SUR_PLACE")!;
    expect(surPlace.orders).toBe(2);
    expect(surPlace.revenueXof).toBe(2500);

    // Idem sur la série quotidienne.
    const daily = await orderHistoryDaily({ ...ALL, period: "7" });
    expect(daily.reduce((s, d) => s + d.orders, 0)).toBe(2);
    expect(daily.reduce((s, d) => s + d.revenueXof, 0)).toBe(2500);
  });

  it("shows the offered value on the admin page", async () => {
    await pool.query(
      `insert into kitchen_tickets (source, items_json, amount_xof, heading, subheading, status, offert)
       values ('TABLE', $1::jsonb, 2000, 'Table', 'C-24', 'COMPLETED', true)`,
      [ITEMS],
    );
    const res = await app.inject({
      method: "GET",
      url: "/admin/historique-commandes?period=all",
      headers: { authorization: AUTH },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("Offerts");
    expect(res.body).toContain("🎁 Offert");
  });
});
