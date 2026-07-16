import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../../src/server.js";
import { pool, migrate } from "../../src/db/index.js";
import { executeTool } from "../../src/agent/tools.js";
import {
  makeFetchMock,
  type FetchMock,
  deliverWaveWebhook,
  deliverOmWebhook,
  seedClient,
  seedBooking,
  waitForStatus,
  settle,
  truncateAll,
  inHours,
} from "./helpers.js";

/**
 * add_spots_to_booking end-to-end: the tool creates a NEW pending_bookings row
 * on the same event for ONLY the extra spots; the unchanged payment-first
 * pipeline then confirms them in Wix. The paid booking is never touched.
 */

let app: FastifyInstance;
let mock: FetchMock;

const fullClient = (c: { id: string; wa_phone: string }) => ({
  id: c.id,
  wa_phone: c.wa_phone,
  name: "Test",
  language: "fr",
  email_prompted_at: null,
  claimed_email: null,
  capability_menu_at: null,
});

async function draftFor(clientId: string): Promise<any> {
  const res = await pool.query(
    `select * from pending_bookings where client_id=$1 and status='AWAITING_PAYMENT' order by created_at desc limit 1`,
    [clientId],
  );
  return res.rows[0];
}

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

describe("add_spots_to_booking", () => {
  it("adds 2 spots (Wave) → new AWAITING row → webhook confirms only the extra spots; original untouched", async () => {
    const client = await seedClient();
    const orig = await seedBooking(client.id, { status: "BOOKED", wix_booking_id: "wb_orig", participants: 3 });

    const out = JSON.parse(
      await executeTool(fullClient(client), "add_spots_to_booking", {
        booking_id: orig.id,
        extra_participants: 2,
        payment_method: "wave",
      }),
    );
    expect(out.payment_link).toBeTruthy();
    expect(out.amount_fcfa).toBe(30000); // 15000 × 2, server-priced
    expect(out.extra_participants).toBe(2);
    expect(out.total_after_payment).toBe(5);

    const draft = await draftFor(client.id);
    expect(draft.participants).toBe(2);
    expect(draft.event_id).toBe("ev_1");
    expect(draft.amount_xof).toBe(30000);
    expect(draft.id).not.toBe(orig.id);

    await deliverWaveWebhook(app, draft.id);
    await waitForStatus(draft.id, "BOOKED");

    const createCalls = mock.wixCreateBookingCalls();
    expect(createCalls.length).toBe(1);
    expect(createCalls[0].body?.booking?.numberOfParticipants).toBe(2);
    await settle();
    expect(mock.waTextsTo(client.wa_phone).join("\n")).toContain("2 place");

    // Original booking is untouched.
    const after = (await pool.query(`select status, wix_booking_id, participants from pending_bookings where id=$1`, [orig.id])).rows[0];
    expect(after).toMatchObject({ status: "BOOKED", wix_booking_id: "wb_orig", participants: 3 });
  });

  it("requires a payment method when OM is enabled", async () => {
    const client = await seedClient();
    const orig = await seedBooking(client.id, { status: "BOOKED", wix_booking_id: "wb_1", participants: 1 });
    const out = JSON.parse(
      await executeTool(fullClient(client), "add_spots_to_booking", { booking_id: orig.id, extra_participants: 2 }),
    );
    expect(out.error).toBe("payment_method_required");
  });

  it("rejects a booking that isn't the client's own", async () => {
    const mine = await seedClient({ wa_phone: "221770000001" });
    const other = await seedClient({ wa_phone: "221770000002" });
    const theirs = await seedBooking(other.id, { status: "BOOKED", wix_booking_id: "wb_x" });
    const out = JSON.parse(
      await executeTool(fullClient(mine), "add_spots_to_booking", {
        booking_id: theirs.id,
        extra_participants: 1,
        payment_method: "wave",
      }),
    );
    expect(out.error).toBe("unknown_booking");
  });

  it("rejects a non-confirmed source booking", async () => {
    const client = await seedClient();
    const draft = await seedBooking(client.id, { status: "AWAITING_PAYMENT" });
    const out = JSON.parse(
      await executeTool(fullClient(client), "add_spots_to_booking", {
        booking_id: draft.id,
        extra_participants: 1,
        payment_method: "wave",
      }),
    );
    expect(out.error).toBe("not_confirmed");
  });

  it("rejects a class that already started", async () => {
    const client = await seedClient();
    const orig = await seedBooking(client.id, {
      status: "BOOKED",
      wix_booking_id: "wb_1",
      slot_start: inHours(-2),
      slot_end: inHours(-1),
    });
    const out = JSON.parse(
      await executeTool(fullClient(client), "add_spots_to_booking", {
        booking_id: orig.id,
        extra_participants: 1,
        payment_method: "wave",
      }),
    );
    expect(out.error).toBe("class_already_started");
  });

  it("rejects when fewer spots remain than requested", async () => {
    mock.wix.openSpots = 1;
    const client = await seedClient();
    const orig = await seedBooking(client.id, { status: "BOOKED", wix_booking_id: "wb_1", participants: 1 });
    const out = JSON.parse(
      await executeTool(fullClient(client), "add_spots_to_booking", {
        booking_id: orig.id,
        extra_participants: 2,
        payment_method: "wave",
      }),
    );
    expect(out.error).toBe("not_enough_spots");
  });

  it("steers studio bookings to a normal new booking", async () => {
    const client = await seedClient();
    const out = JSON.parse(
      await executeTool(fullClient(client), "add_spots_to_booking", {
        booking_id: "studio:abc123",
        extra_participants: 2,
        payment_method: "wave",
      }),
    );
    expect(out.error).toBe("studio_booking_not_extendable");
  });

  it("sells out between link and payment → the extra booking lands in REFUND_NEEDED", async () => {
    const client = await seedClient();
    const orig = await seedBooking(client.id, { status: "BOOKED", wix_booking_id: "wb_orig", participants: 2 });
    await executeTool(fullClient(client), "add_spots_to_booking", {
      booking_id: orig.id,
      extra_participants: 2,
      payment_method: "wave",
    });
    const draft = await draftFor(client.id);

    mock.wix.openSpots = 0; // the class fills up before payment lands
    await deliverWaveWebhook(app, draft.id);
    await waitForStatus(draft.id, "REFUND_NEEDED");
    // Original booking still fine.
    expect((await pool.query(`select status from pending_bookings where id=$1`, [orig.id])).rows[0].status).toBe("BOOKED");
  });

  it("works over Orange Money too (amount verified against the order)", async () => {
    const client = await seedClient();
    const orig = await seedBooking(client.id, { status: "BOOKED", wix_booking_id: "wb_orig", participants: 1 });
    await executeTool(fullClient(client), "add_spots_to_booking", {
      booking_id: orig.id,
      extra_participants: 2,
      payment_method: "orange_money",
    });
    const draft = await draftFor(client.id);
    expect(draft.payment_method).toBe("orange_money");

    mock.om.defaultLookup!.amountValue = 30000; // OM webhook verifies amount == 2×15000
    await deliverOmWebhook(app, { orderId: draft.id });
    await waitForStatus(draft.id, "BOOKED");
    expect(mock.wixCreateBookingCalls().length).toBe(1);
  });
});
