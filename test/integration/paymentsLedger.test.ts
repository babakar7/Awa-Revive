import crypto from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { pool } from "../../src/db/index.js";
import { buildServer } from "../../src/server.js";
import { markBookingRefunded } from "../../src/domain/repo.js";
import {
  addManualMovement,
  appendTagEvent,
  bookingsByServiceDate,
  movements,
  periodMethodTotals,
} from "../../src/domain/paymentsLedger.js";
import { seedBooking, seedClient, truncateAll } from "./helpers.js";
import { syncWixPayments } from "../../src/domain/wixPaymentSync.js";

let app: FastifyInstance;
beforeAll(async () => {
  app = buildServer();
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await pool.end();
});

beforeEach(async () => {
  await truncateAll();
  await pool.query(`truncate wix_payment_movements, wix_payment_sync_diagnostics,
                    payment_method_tag_events, manual_payment_movements restart identity cascade`);
  await pool.query(`update wix_payment_sync_state set last_started_at=null,last_succeeded_at=null,
                    last_updated_date_seen=null,last_full_reconciled_at=null,last_error=null,record_count=0`);
});

afterEach(() => vi.unstubAllGlobals());

const from = new Date("2026-08-01T00:00:00Z");
const to = new Date("2026-09-01T00:00:00Z");

describe("payment ledger persistence", () => {
  it("lists clients by class date rather than payment date", async () => {
    const client = await seedClient({ name: "Cliente du jour" });
    await seedBooking(client.id, {
      status: "BOOKED", slot_start: "2026-08-15T09:00:00Z",
      paid_at: "2026-08-02T10:00:00Z", payment_method: "wave",
    });
    await seedBooking(client.id, {
      status: "CANCELLED", slot_start: "2026-08-15T11:00:00Z",
      paid_at: "2026-08-02T10:00:00Z", payment_method: "wave",
    });
    await seedBooking(client.id, {
      status: "BOOKED", slot_start: "2026-08-16T09:00:00Z",
      paid_at: "2026-08-15T10:00:00Z", payment_method: "wave",
    });
    const rows = await bookingsByServiceDate(
      new Date("2026-08-15T00:00:00Z"),
      new Date("2026-08-16T00:00:00Z"),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      clientName: "Cliente du jour",
      paymentMethod: "wave",
      paidAt: new Date("2026-08-02T10:00:00Z"),
      slotStart: new Date("2026-08-15T09:00:00Z"),
    });
  });

  it("keeps the original booking payment and records one idempotent refund", async () => {
    const client = await seedClient();
    const booking = await seedBooking(client.id, {
      status: "REFUND_NEEDED", paid_at: "2026-08-05T10:00:00Z", payment_method: "wave",
    });
    expect(await markBookingRefunded(booking.id)).toMatchObject({ status: "REFUNDED" });
    expect(await markBookingRefunded(booking.id)).toBeNull();
    const rows = await movements({ from, to });
    expect(rows.map((r) => [r.movementType, r.amountXof])).toEqual([
      ["refund", -15000], ["payment", 15000],
    ]);
    expect((await periodMethodTotals({ from, to })).find((r) => r.method === "wave"))
      .toMatchObject({ grossXof: 15000, refundsXof: 15000, netXof: 0 });
  });

  it("is append-only/idempotent and includes historical Wix XAF at XOF parity", async () => {
    const key = crypto.randomUUID();
    const base = {
      movementType: "payment" as const, occurredAt: new Date("2026-08-06T12:00:00Z"),
      amountXof: 24000, method: "maxit" as const, label: "Lien Max It ad hoc",
      providerReference: "MAXIT-24000-1", note: "Reçu portail", createdBy: "owner",
      idempotencyKey: key,
    };
    expect(await addManualMovement(base)).toBe(true);
    expect(await addManualMovement(base)).toBe(false);
    await pool.query(
      `insert into wix_payment_movements
       (wix_order_id,source,movement_type,wix_entry_id,provider_status,occurred_at,
        amount_xof,currency,label,provider_method,raw_method,offline,raw)
       values ('wix-xaf','ecom','payment','tx-xaf','APPROVED','2026-08-06',12000,'XAF','Cours','wave','Wave money',false,'{}')`,
    );
    const totals = await periodMethodTotals({ from, to });
    expect(totals.find((r) => r.method === "maxit")?.netXof).toBe(24000);
    expect(totals.find((r) => r.method === "wave")?.netXof).toBe(12000);
  });

  it("keeps tag history and resolves the latest tag", async () => {
    const inserted = await pool.query(
      `insert into wix_payment_movements
       (wix_order_id,source,movement_type,wix_entry_id,provider_status,occurred_at,
        amount_xof,currency,label,provider_method,raw_method,offline,raw)
       values ('wix-offline','ecom','payment','tx-offline','APPROVED','2026-08-07',12000,'XOF','Cours',null,'Payer en personne',true,'{}') returning id`,
    );
    const targetId = inserted.rows[0].id;
    await appendTagEvent({ targetId, method: "cash", taggedBy: "team" });
    await appendTagEvent({ targetId, method: "orange_money", note: "Correction reçu OM", taggedBy: "team" });
    expect(Number((await pool.query(`select count(*) n from payment_method_tag_events where target_id=$1`, [targetId])).rows[0].n)).toBe(2);
    expect((await movements({ from, to }))[0]).toMatchObject({ method: "orange_money", methodOrigin: "tag" });
  });

  it("imports payment/refund entries idempotently and never advances the watermark on failure", async () => {
    let fail = false;
    vi.stubGlobal("fetch", vi.fn(async (input: URL | RequestInfo) => {
      const url = String(input);
      if (fail) return new Response(JSON.stringify({ message: "page failed" }), { status: 500 });
      if (url.endsWith("/ecom/v1/orders/search")) return new Response(JSON.stringify({ orders: [{
        id: "site-order-1", createdDate: "2026-08-08T10:00:00Z", updatedDate: "2026-08-08T11:00:00Z",
        paymentStatus: "FULLY_REFUNDED", currency: "XOF", channelInfo: { type: "WEB" },
        buyerInfo: { contactId: "contact-1", email: "awa@example.com" },
        billingInfo: { contactDetails: { firstName: "", lastName: "" } },
        lineItems: [{ productName: { original: "Cours" } }],
      }], pagingMetadata: { cursors: {} } }), { status: 200 });
      if (url.includes("/ecom/v1/payments/orders/site-order-1")) return new Response(JSON.stringify({
        orderTransactions: {
          payments: [{ id: "pay-1", createdDate: "2026-08-08T10:00:00Z", amount: { amount: "12000" },
            regularPaymentDetails: { paymentMethod: "Wave money", status: "APPROVED", offlinePayment: false } }],
          refunds: [{ id: "refund-1", createdDate: "2026-08-08T11:00:00Z",
            transactions: [{ paymentId: "pay-1", refundStatus: "SUCCEEDED" }] }],
        },
      }), { status: 200 });
      if (url.endsWith("/contacts/v4/contacts/contact-1")) return new Response(JSON.stringify({
        contact: {
          id: "contact-1",
          info: {
            name: { first: "Papa amadou", last: "Kante" },
            phones: { items: [{ primary: true, e164Phone: "+221776896054" }] },
          },
        },
      }), { status: 200 });
      return new Response("not found", { status: 404 });
    }));
    expect(await syncWixPayments({}, true)).toMatchObject({ ran: true, recordCount: 2 });
    expect(Number((await pool.query(`select count(*) n from wix_payment_movements`)).rows[0].n)).toBe(2);
    expect((await pool.query(
      `select provider_method,buyer_name,buyer_phone,buyer_contact_id,buyer_identity_synced_at
         from wix_payment_movements where movement_type='refund'`,
    )).rows[0]).toMatchObject({
      provider_method: "wave",
      buyer_name: "Papa amadou Kante",
      buyer_phone: "+221776896054",
      buyer_contact_id: "contact-1",
      buyer_identity_synced_at: expect.any(Date),
    });
    expect(await syncWixPayments({}, true)).toMatchObject({ ran: true, recordCount: 2 });
    expect(Number((await pool.query(`select count(*) n from wix_payment_movements`)).rows[0].n)).toBe(2);
    const before = (await pool.query(`select last_updated_date_seen from wix_payment_sync_state`)).rows[0].last_updated_date_seen;
    fail = true;
    await expect(syncWixPayments({}, true)).rejects.toThrow(/page failed/);
    const state = (await pool.query(`select last_updated_date_seen,last_error from wix_payment_sync_state`)).rows[0];
    expect(new Date(state.last_updated_date_seen).toISOString()).toBe(new Date(before).toISOString());
    expect(state.last_error).toMatch(/page failed/);
    expect(Number((await pool.query(`select count(*) n from wix_payment_movements where invalidated_at is not null`)).rows[0].n)).toBe(0);
  });

  it("serves the team page but keeps manual monetary POSTs owner-only and idempotent", async () => {
    const login = async (username: string, password: string) => {
      const response = await app.inject({ method: "POST", url: "/admin/login",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        payload: new URLSearchParams({ username, password, next: "/admin/paiements" }).toString() });
      expect(response.statusCode).toBe(303);
      return String(response.headers["set-cookie"]).split(";")[0];
    };
    const team = await login("revive", "revive@5000");
    const page = await app.inject({ method: "GET", url: "/admin/paiements", headers: { cookie: team } });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain("Rapprochement comptable");
    expect(page.body).not.toContain("Ajouter un mouvement manuel");
    const fields = {
      idempotency_key: crypto.randomUUID(), movement_type: "payment", occurred_at: "2026-08-08T12:00",
      amount_xof: "24000", method: "maxit", label: "Lien Max It", note: "Reçu portail",
    };
    const post = (cookie: string) => app.inject({ method: "POST", url: "/admin/paiements/manuel",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      payload: new URLSearchParams(fields).toString() });
    expect((await post(team)).statusCode).toBe(403);
    const owner = await login("owner", "test-owner-password");
    expect((await post(owner)).statusCode).toBe(303);
    expect((await post(owner)).statusCode).toBe(303);
    expect(Number((await pool.query(`select count(*) n from manual_payment_movements`)).rows[0].n)).toBe(1);
  });

  it("shows the plan name and payment rail on payment and reservation pages", async () => {
    const client = await seedClient({ name: "Aminata Diallo" });
    await seedBooking(client.id, {
      amount_xof: 0,
      status: "BOOKED",
      payment_method: "membership",
      membership_plan_name: "La Résidente",
      wix_booking_id: "wix-membership-booking-1",
      wave_session_id: null,
      payment_link: null,
      link_expires_at: null,
    });
    await pool.query(
      `insert into pending_plan_orders
         (client_id,plan_id,plan_name,amount_xof,status,payment_method,paid_at)
       values ($1,'plan-residente','La Résidente',90000,'PAID','maxit',now())`,
      [client.id],
    );
    const login = await app.inject({ method: "POST", url: "/admin/login",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: new URLSearchParams({ username: "revive", password: "revive@5000", next: "/admin/paiements" }).toString() });
    const cookie = String(login.headers["set-cookie"]).split(";")[0];

    const payments = await app.inject({ method: "GET", url: "/admin/paiements", headers: { cookie } });
    expect(payments.statusCode).toBe(200);
    expect(payments.body).toContain("La Résidente");
    expect(payments.body).toContain("Max It");

    const bookings = await app.inject({ method: "GET", url: "/admin/bookings", headers: { cookie } });
    expect(bookings.statusCode).toBe(200);
    expect(bookings.body).toContain("La Résidente");
    expect(bookings.body).toContain('data-label="Paiement">La Résidente');
    expect(bookings.body).toContain('data-label="Paiement">Max It');
    expect(bookings.body).not.toContain("· membership");
  });
});
