import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../../src/server.js";
import { pool, migrate } from "../../src/db/index.js";
import { _resetOmTokenCacheForTests } from "../../src/lib/orangeMoney.js";
import {
  makeFetchMock,
  type FetchMock,
  deliverOmWebhook,
  seedClient,
  seedBooking,
  bookingById,
  waitForStatus,
  waitFor,
  settle,
  truncateAll,
  wasOmProcessed,
} from "./helpers.js";

/**
 * Integration tests for Orange Money / Max It payment path:
 *   unsigned callback → OAuth + verify-by-lookup → shared fulfillment
 *     → Wix booking (same SQL claim/lease as Wave).
 *
 * Real Postgres (throwaway Docker); all external HTTP mocked. Covers the
 * anti-forgery property that Wave gets from signatures: never fulfill on the
 * callback body alone.
 */

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
  _resetOmTokenCacheForTests();
});

// Payment callbacks are acknowledged before their background fulfillment ends.
afterEach(async () => {
  await settle(500);
});

describe("routing & ack", () => {
  it("always acks 200 quickly (even with an empty body)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/webhooks/orange-money",
      payload: {},
      headers: { "content-type": "application/json" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    await settle();
    expect(mock.omLookupCalls()).toHaveLength(0);
    expect(mock.wixCreateBookingCalls()).toHaveLength(0);
  });

  it("ignores non-MERCHANT_PAYMENT types without looking up", async () => {
    const client = await seedClient();
    const booking = await seedBooking(client.id, { payment_method: "orange_money" });

    const res = await deliverOmWebhook(app, {
      orderId: booking.id,
      type: "CASHIN",
      transactionId: "OM_TX_ignore_type",
    });
    expect(res.statusCode).toBe(200);
    await settle();
    expect((await bookingById(booking.id)).status).toBe("AWAITING_PAYMENT");
    expect(mock.omLookupCalls()).toHaveLength(0);
  });

  it("ignores non-SUCCESS status without looking up", async () => {
    const client = await seedClient();
    const booking = await seedBooking(client.id, { payment_method: "orange_money" });

    await deliverOmWebhook(app, {
      orderId: booking.id,
      status: "FAILED",
      transactionId: "OM_TX_failed",
    });
    await settle();
    expect((await bookingById(booking.id)).status).toBe("AWAITING_PAYMENT");
    expect(mock.omLookupCalls()).toHaveLength(0);
  });

  it("ignores missing transactionId or metadata.order", async () => {
    const client = await seedClient();
    const booking = await seedBooking(client.id, { payment_method: "orange_money" });

    await deliverOmWebhook(app, {
      orderId: booking.id,
      transactionId: "",
    });
    await deliverOmWebhook(app, {
      orderId: booking.id,
      transactionId: "OM_TX_no_order",
      includeOrder: false,
    });
    await settle();
    expect((await bookingById(booking.id)).status).toBe("AWAITING_PAYMENT");
    expect(mock.omLookupCalls()).toHaveLength(0);
  });

  it("unknown order id does NOT call Sonatel lookup (anti-spam)", async () => {
    const res = await deliverOmWebhook(app, {
      orderId: "00000000-0000-4000-8000-000000000000",
      transactionId: "OM_TX_unknown_order",
    });
    expect(res.statusCode).toBe(200);
    await settle(500);
    expect(mock.omLookupCalls()).toHaveLength(0);
    expect(mock.omTokenCalls()).toHaveLength(0);
    expect(mock.wixCreateBookingCalls()).toHaveLength(0);
    expect(mock.emailCalls()).toHaveLength(0);
  });
});

describe("happy path (verify-by-lookup → fulfill)", () => {
  it("SUCCESS callback + matching lookup → BOOKED + client confirmation", async () => {
    const client = await seedClient();
    const booking = await seedBooking(client.id, { payment_method: "orange_money" });
    const transactionId = "OM_TX_happy_1";

    // Tie lookup metadata.order to the booking (production echoes it).
    mock.om.transactions[transactionId] = {
      status: "SUCCESS",
      amountValue: 15000,
      partnerId: "553651",
      metadata: { order: booking.id, channel: "awa" },
      customerId: "221770000099",
    };

    const res = await deliverOmWebhook(app, {
      orderId: booking.id,
      transactionId,
      customerId: "221770000099",
    });
    expect(res.statusCode).toBe(200);

    const booked = await waitForStatus(booking.id, "BOOKED");
    expect(booked.wix_booking_id).toBe(mock.wix.createdBookingIds[0]);
    expect(booked.payer_phone).toBe("221770000099");
    expect(mock.wixCreateBookingCalls()).toHaveLength(1);
    expect(mock.omTokenCalls().length).toBeGreaterThanOrEqual(1);
    expect(mock.omLookupCalls().length).toBeGreaterThanOrEqual(1);

    const texts = await waitFor(
      async () =>
        mock.waTextsTo(client.wa_phone).length > 0 ? mock.waTextsTo(client.wa_phone) : null,
      "confirmation WhatsApp",
    );
    expect(texts[0]).toContain("ta place est confirmée");

    await waitFor(
      async () => ((await wasOmProcessed(transactionId)) ? true : null),
      "om idempotency marked after success",
    );
  });

  it("uses default lookup defaults when txn is not specially configured", async () => {
    const client = await seedClient();
    const booking = await seedBooking(client.id, { payment_method: "maxit" });
    const transactionId = "OM_TX_default_lookup";

    await deliverOmWebhook(app, { orderId: booking.id, transactionId });
    await waitForStatus(booking.id, "BOOKED");
    expect(mock.wixCreateBookingCalls()).toHaveLength(1);
  });
});

describe("verify-by-lookup guards (anti-forgery)", () => {
  it("does not fulfill when lookup finds no SUCCESS transaction", async () => {
    const client = await seedClient();
    const booking = await seedBooking(client.id, { payment_method: "orange_money" });
    const transactionId = "OM_TX_not_found";
    mock.om.transactions[transactionId] = null;

    await deliverOmWebhook(app, { orderId: booking.id, transactionId });
    await settle(600);
    expect((await bookingById(booking.id)).status).toBe("AWAITING_PAYMENT");
    expect(mock.wixCreateBookingCalls()).toHaveLength(0);

    // Reception warned (email).
    await waitFor(async () => (mock.emailCalls().length > 0 ? true : null), "reception email");
    expect(JSON.stringify(mock.emailCalls()[0].body)).toMatch(/introuvable|SUCCESS/i);

    // Handler returns without throw → marked processed (no infinite retries).
    await waitFor(
      async () => ((await wasOmProcessed(transactionId)) ? true : null),
      "marked processed after non-SUCCESS lookup",
    );
  });

  it("does not fulfill when lookup amount is below the pending amount", async () => {
    const client = await seedClient();
    const booking = await seedBooking(client.id, {
      payment_method: "orange_money",
      amount_xof: 15000,
    });
    const transactionId = "OM_TX_low_amount";
    mock.om.transactions[transactionId] = {
      status: "SUCCESS",
      amountValue: 100, // forgery / partial
      partnerId: "553651",
      metadata: { order: booking.id },
    };

    await deliverOmWebhook(app, { orderId: booking.id, transactionId });
    await settle(600);
    expect((await bookingById(booking.id)).status).toBe("AWAITING_PAYMENT");
    expect(mock.wixCreateBookingCalls()).toHaveLength(0);
    await waitFor(async () => (mock.emailCalls().length > 0 ? true : null), "mismatch email");
    expect(JSON.stringify(mock.emailCalls()[0].body)).toMatch(/mismatch|amount/i);
    const failure = await pool.query(
      `select stage, failure_code from booking_funnel_events where booking_id=$1`,
      [booking.id],
    );
    expect(failure.rows).toEqual([
      { stage: "technical_failure", failure_code: "payment_verification_failed" },
    ]);
  });

  it("does not fulfill when partner (merchant) does not match", async () => {
    const client = await seedClient();
    const booking = await seedBooking(client.id, { payment_method: "orange_money" });
    const transactionId = "OM_TX_bad_partner";
    mock.om.transactions[transactionId] = {
      status: "SUCCESS",
      amountValue: 15000,
      partnerId: "000000",
      metadata: { order: booking.id },
    };

    await deliverOmWebhook(app, { orderId: booking.id, transactionId });
    await settle(600);
    expect((await bookingById(booking.id)).status).toBe("AWAITING_PAYMENT");
    expect(mock.wixCreateBookingCalls()).toHaveLength(0);
  });

  it("does not fulfill when lookup metadata.order disagrees with callback order", async () => {
    const client = await seedClient();
    const booking = await seedBooking(client.id, { payment_method: "orange_money" });
    const transactionId = "OM_TX_order_mismatch";
    mock.om.transactions[transactionId] = {
      status: "SUCCESS",
      amountValue: 15000,
      partnerId: "553651",
      metadata: { order: "00000000-0000-4000-8000-111111111111" },
    };

    await deliverOmWebhook(app, { orderId: booking.id, transactionId });
    await settle(600);
    expect((await bookingById(booking.id)).status).toBe("AWAITING_PAYMENT");
    expect(mock.wixCreateBookingCalls()).toHaveLength(0);
  });
});

describe("idempotency & retriability", () => {
  it("the same transactionId delivered twice books exactly once", async () => {
    const client = await seedClient();
    const booking = await seedBooking(client.id, { payment_method: "orange_money" });
    const transactionId = "OM_TX_dup";

    await deliverOmWebhook(app, { orderId: booking.id, transactionId });
    await waitForStatus(booking.id, "BOOKED");

    await deliverOmWebhook(app, { orderId: booking.id, transactionId });
    await settle();
    expect(mock.wixCreateBookingCalls()).toHaveLength(1);
    // Second delivery skips before lookup when already processed.
    // (First path may have 1+ lookups; after mark, second skips entirely.)
    const lookupsAfter = mock.omLookupCalls().length;
    await deliverOmWebhook(app, { orderId: booking.id, transactionId });
    await settle();
    expect(mock.omLookupCalls().length).toBe(lookupsAfter);
  });

  it("a failed lookup does NOT mark the event processed (stays retriable)", async () => {
    const client = await seedClient();
    const booking = await seedBooking(client.id, { payment_method: "orange_money" });
    const transactionId = "OM_TX_lookup_fail";
    mock.om.failLookup = true;

    await deliverOmWebhook(app, { orderId: booking.id, transactionId });
    await settle(800);
    expect((await bookingById(booking.id)).status).toBe("AWAITING_PAYMENT");
    expect(await wasOmProcessed(transactionId)).toBe(false);
    expect(mock.wixCreateBookingCalls()).toHaveLength(0);

    // Reception alerted about verify failure.
    await waitFor(async () => (mock.emailCalls().length > 0 ? true : null), "lookup-fail email");

    // Retry with lookup healthy → books.
    mock.om.failLookup = false;
    mock.om.transactions[transactionId] = {
      status: "SUCCESS",
      amountValue: 15000,
      partnerId: "553651",
      metadata: { order: booking.id },
    };
    await deliverOmWebhook(app, { orderId: booking.id, transactionId });
    await waitForStatus(booking.id, "BOOKED");
    expect(mock.wixCreateBookingCalls()).toHaveLength(1);
    await waitFor(
      async () => ((await wasOmProcessed(transactionId)) ? true : null),
      "om id marked processed after successful retry",
    );
  });

  it("a different transactionId after BOOKED does not re-create the Wix booking", async () => {
    const client = await seedClient();
    const booking = await seedBooking(client.id, { payment_method: "orange_money" });

    await deliverOmWebhook(app, { orderId: booking.id, transactionId: "OM_TX_a" });
    await waitForStatus(booking.id, "BOOKED");

    await deliverOmWebhook(app, { orderId: booking.id, transactionId: "OM_TX_b" });
    await settle();
    expect(mock.wixCreateBookingCalls()).toHaveLength(1);
    expect((await bookingById(booking.id)).status).toBe("BOOKED");
  });
});

describe("fulfillment outcomes (shared with Wave)", () => {
  it("slot taken during payment → REFUND_NEEDED (OM rail)", async () => {
    const client = await seedClient();
    const booking = await seedBooking(client.id, { payment_method: "orange_money" });
    mock.wix.openSpots = 0;

    await deliverOmWebhook(app, { orderId: booking.id, transactionId: "OM_TX_full" });
    await waitForStatus(booking.id, "REFUND_NEEDED");
    expect(mock.wixCreateBookingCalls()).toHaveLength(0);

    const texts = await waitFor(
      async () =>
        mock.waTextsTo(client.wa_phone).length > 0 ? mock.waTextsTo(client.wa_phone) : null,
      "refund message",
    );
    expect(texts[0]).toContain("remboursé");
  });
});
