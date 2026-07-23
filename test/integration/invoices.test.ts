import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../../src/server.js";
import { pool, migrate } from "../../src/db/index.js";
import { makeFetchMock, type FetchMock, truncateAll, settle } from "./helpers.js";

/**
 * Admin invoices end-to-end against a real Postgres, all HTTP mocked. Exercises
 * the atomic per-year numbering, validation, the printable/view pages, and the
 * WhatsApp image send (media upload → message) with its notification_log entry.
 */

const AUTH = `Basic ${Buffer.from("revive:revive@5000").toString("base64")}`;
const YEAR = new Date().getUTCFullYear();

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

function form(fields: Record<string, string>): string {
  return new URLSearchParams(fields).toString();
}

async function createInvoice(over: Record<string, string> = {}): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: "/admin/factures",
    headers: { authorization: AUTH, "content-type": "application/x-www-form-urlencoded" },
    payload: form({
      client_name: "Aïssatou Ndiaye",
      client_phone: "771234567",
      line_label_0: "Pilates Reformer",
      line_qty_0: "4",
      line_unit_0: "12000",
      ...over,
    }),
  });
  expect(res.statusCode).toBe(303);
  return res.headers.location as string;
}

describe("invoice creation & numbering", () => {
  it("mints FAC-YEAR-0001 then 0002, totals server-side", async () => {
    await createInvoice();
    await createInvoice();
    const rows = (await pool.query(`select number, total_xof from invoices order by number`)).rows;
    expect(rows.map((r) => r.number)).toEqual([`FAC-${YEAR}-0001`, `FAC-${YEAR}-0002`]);
    expect(rows[0].total_xof).toBe(48000); // 4 × 12000, computed server-side
  });

  it("assigns 5 distinct numbers under concurrent creation (atomic counter)", async () => {
    await Promise.all(Array.from({ length: 5 }, () => createInvoice()));
    const nums = (await pool.query(`select number from invoices`)).rows.map((r) => r.number);
    expect(new Set(nums).size).toBe(5);
    const suffixes = nums.map((n) => Number(n.slice(-4))).sort((a, b) => a - b);
    expect(suffixes).toEqual([1, 2, 3, 4, 5]);
  });

  it("rejects empty name, no lines, and bad phone without creating a row", async () => {
    const post = (fields: Record<string, string>) =>
      app.inject({
        method: "POST",
        url: "/admin/factures",
        headers: { authorization: AUTH, "content-type": "application/x-www-form-urlencoded" },
        payload: form(fields),
      });
    expect((await post({ client_name: "", line_label_0: "X", line_qty_0: "1", line_unit_0: "1" })).statusCode).toBe(303);
    expect((await post({ client_name: "X" })).statusCode).toBe(303); // no lines
    expect(
      (await post({ client_name: "X", client_phone: "12", line_label_0: "A", line_qty_0: "1", line_unit_0: "5" })).statusCode,
    ).toBe(303); // bad phone
    expect((await pool.query(`select count(*) from invoices`)).rows[0].count).toBe("0");
  });
});

describe("invoice pages", () => {
  it("serves list, view, and print; 404 for an unknown id", async () => {
    const loc = await createInvoice();
    const view = await app.inject({ method: "GET", url: loc, headers: { authorization: AUTH } });
    expect(view.statusCode).toBe(200);
    expect(view.body).toContain(`FAC-${YEAR}-0001`);

    const id = loc.split("/")[3].split("?")[0];
    const print = await app.inject({ method: "GET", url: `/admin/factures/${id}/print`, headers: { authorization: AUTH } });
    expect(print.statusCode).toBe(200);
    expect(print.body).toContain(`Facture n° FAC-${YEAR}-0001`);
    expect(print.body).toContain("Facturer à :");
    expect(print.body).toContain("Total de la facture");
    expect(print.body).not.toContain("Reste à payer");

    const list = await app.inject({ method: "GET", url: "/admin/factures", headers: { authorization: AUTH } });
    expect(list.body).toContain(`FAC-${YEAR}-0001`);

    const missing = await app.inject({
      method: "GET",
      url: "/admin/factures/00000000-0000-0000-0000-000000000000",
      headers: { authorization: AUTH },
    });
    expect(missing.statusCode).toBe(404);
  });
});

describe("invoice WhatsApp send", () => {
  it("uploads the PDF then sends it as a document, and records sent_at + a log", async () => {
    const loc = await createInvoice();
    const id = loc.split("/")[3].split("?")[0];
    mock.reset();

    const res = await app.inject({ method: "POST", url: `/admin/factures/${id}/send`, headers: { authorization: AUTH } });
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toContain("done=sent");

    const media = mock.calls.filter((c) => c.url.includes("graph.facebook.com") && c.url.endsWith("/media"));
    expect(media.length).toBe(1);
    const docs = mock.calls.filter((c) => c.body?.type === "document" && c.body?.to === "221771234567");
    expect(docs.length).toBe(1);
    expect(docs[0].body?.document?.filename).toMatch(/^Facture-FAC-\d{4}-\d{4}\.pdf$/);

    const inv = (await pool.query(`select sent_status, sent_at from invoices where id=$1`, [id])).rows[0];
    expect(inv.sent_status).toBe("sent");
    expect(inv.sent_at).not.toBeNull();

    const log = (await pool.query(`select count(*) from notification_log where source='invoice'`)).rows[0];
    expect(Number(log.count)).toBe(1);
  });

  it("without a phone, does not call WhatsApp and shows an error", async () => {
    const loc = await createInvoice({ client_phone: "" });
    const id = loc.split("/")[3].split("?")[0];
    mock.reset();

    const res = await app.inject({ method: "POST", url: `/admin/factures/${id}/send`, headers: { authorization: AUTH } });
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toContain("err=");
    await settle();
    expect(mock.calls.filter((c) => c.url.includes("graph.facebook.com")).length).toBe(0);
  });
});

describe("one facture per payment (send_invoice dedup)", () => {
  it("findInvoiceBySource returns the emitted invoice, none for another source", async () => {
    const { createInvoice: create, findInvoiceBySource } = await import(
      "../../src/domain/invoiceRepo.js"
    );
    const sourceId = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
    const made = await create({
      client_name: "Nasita Fofana",
      client_phone: "221781428610",
      client_ref: null,
      lines: [{ label: "Rééducation Fonctionnelle", qty: 1, unit_xof: 225000, total_xof: 225000 }],
      total_xof: 225000,
      note: null,
      source_kind: "booking",
      source_id: sourceId,
      payment_method: "wave",
      payment_ref: "S-123",
      paid_at: new Date(),
      created_by: "awa",
    });
    const found = await findInvoiceBySource("booking", sourceId);
    expect(found?.id).toBe(made.id);
    expect(found?.number).toBe(made.number);
    expect(await findInvoiceBySource("plan", sourceId)).toBeNull();
    expect(await findInvoiceBySource("booking", "not-a-uuid")).toBeNull();
  });

  it("offers only paid deliveries and keeps the verified payment rail/reference", async () => {
    const paid = await pool.query(
      `insert into delivery_orders
         (client_name, client_phone, address, items_json, amount_xof, ready_token_hash,
          status, payment_status, payment_method, payment_ref, paid_at, delivered_at)
       values
         ('Rama Fall','221770009988','Ngor',
          '[{"id":"SMOOTHIE_JANT_BI","name":"Jant Bi","qty":2,"unitPriceXof":3000,"lineTotalXof":6000}]'::jsonb,
          6000,'invoice-delivery-paid','DELIVERED','PAID','wave','cos-delivery-1',now(),now())
       returning id`,
    );
    await pool.query(
      `insert into delivery_orders
         (client_name, client_phone, address, items_json, amount_xof, ready_token_hash,
          status, payment_status, delivered_at)
       values ('Non payée','221770001111','Ngor','[]'::jsonb,3000,
               'invoice-delivery-unpaid','DELIVERED','PENDING_CHOICE',now())`,
    );

    const { recentPaidCandidates } = await import("../../src/domain/invoiceRepo.js");
    const deliveries = (await recentPaidCandidates()).filter((candidate) => candidate.kind === "delivery");
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]).toMatchObject({
      id: paid.rows[0].id,
      clientName: "Rama Fall",
      totalXof: 6000,
      paidVia: "Wave",
      paymentRef: "cos-delivery-1",
    });
  });
});
