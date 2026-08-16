import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { pool } from "../../src/db/index.js";
import { syncAttendanceLeaderboard } from "../../src/domain/attendanceLeaderboard.js";
import { upsertPlanOrderFromWebhook } from "../../src/domain/wixBookingSync.js";
import { bookingsByServiceDate } from "../../src/domain/paymentsLedger.js";
import { makeFetchMock, truncateAll, type FetchMock } from "./helpers.js";

let mock: FetchMock;

function bookingFixture(args: {
  id: string;
  status?: string;
  contactId?: string;
  name?: string;
  phone?: string;
  service?: string;
  start?: string;
  updatedDate?: string;
}) {
  return {
    booking: {
      id: args.id,
      status: args.status ?? "CONFIRMED",
      paymentStatus: "PAID",
      numberOfParticipants: 1,
      createdDate: args.updatedDate ?? "2026-08-16T08:00:00Z",
      updatedDate: args.updatedDate ?? "2026-08-16T08:00:00Z",
      contactDetails: {
        contactId: args.contactId ?? "wix_contact_x",
        firstName: args.name ?? "Rova",
        phone: args.phone ?? "+221771234567",
      },
      bookedEntity: {
        title: args.service ?? "Bébé nageurs",
        slot: { serviceId: "svc_bebe", startDate: args.start ?? "2026-08-16T09:00:00Z" },
      },
    },
  };
}

async function createClient(name: string, phone: string): Promise<string> {
  const res = await pool.query(
    `insert into clients (wa_phone, name) values ($1,$2)
     on conflict (wa_phone) do update set name=excluded.name returning id`,
    [phone, name],
  );
  return String(res.rows[0].id);
}

beforeAll(async () => {
  mock = makeFetchMock();
  mock.install();
});

afterAll(async () => {
  mock.restore();
  await pool.end();
});

beforeEach(async () => {
  await truncateAll();
  await pool.query(
    `delete from wix_attendance_records;
     delete from wix_booking_records;
     delete from wix_plan_order_records;
     delete from wix_attendance_sync_state;
     insert into wix_attendance_sync_state (singleton) values (true);`,
  );
  mock.reset();
});

describe("Wix booking mirror", () => {
  it("surfaces a reception-made Wix booking and matches it to a client by phone (Rova case)", async () => {
    const clientId = await createClient("Rova Rajaonah", "221771234567");
    mock.wix.bookings = [bookingFixture({ id: "rova1", phone: "+221771234567", name: "Rova" })];

    await syncAttendanceLeaderboard(true);

    const row = (await pool.query(`select * from wix_booking_records where booking_id='rova1'`)).rows[0];
    expect(row).toMatchObject({
      booking_id: "rova1",
      status: "CONFIRMED",
      service_name: "Bébé nageurs",
      match_basis: "phone",
    });
    expect(String(row.matched_client_id)).toBe(clientId);
    expect(row.invalidated_at).toBeNull();
  });

  it("surfaces the Wix-manual booking in the by-reservation-date view (Rova acceptance)", async () => {
    await createClient("Rova Rajaonah", "221771234567");
    mock.wix.bookings = [
      bookingFixture({ id: "rova2", phone: "+221771234567", name: "Rova", start: "2026-08-16T09:00:00Z" }),
    ];
    await syncAttendanceLeaderboard(true);

    const from = new Date("2026-08-16T00:00:00Z");
    const to = new Date("2026-08-17T00:00:00Z");
    const rows = await bookingsByServiceDate(from, to);
    const rova = rows.find((r) => r.bookingId === "rova2");
    expect(rova).toBeDefined();
    expect(rova).toMatchObject({ source: "wix", serviceName: "Bébé nageurs" });
    expect(rova?.clientName).toContain("Rova");
  });

  it("keeps a canonical single row when an Awa booking has the same wix_booking_id", async () => {
    const clientId = await createClient("Awa Ba", "221770000001");
    await pool.query(
      `insert into pending_bookings
         (client_id, service_id, service_name, event_id, slot_start, amount_xof, status, wix_booking_id)
       values ($1,'svc_bebe','Bébé nageurs','evt1', now(), 12000, 'BOOKED', 'shared1')`,
      [clientId],
    );
    mock.wix.bookings = [bookingFixture({ id: "shared1", name: "Awa", phone: "+221770000001" })];

    await syncAttendanceLeaderboard(true);

    const rows = (await pool.query(`select * from wix_booking_records where booking_id='shared1'`)).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0].match_basis).toBe("awa_booking");
    expect(String(rows[0].matched_client_id)).toBe(clientId);
  });

  it("turns a cancellation into a status update, never a delete", async () => {
    mock.wix.bookings = [bookingFixture({ id: "c1", status: "CONFIRMED" })];
    await syncAttendanceLeaderboard(true);

    mock.wix.bookings = [bookingFixture({ id: "c1", status: "CANCELED", updatedDate: "2026-08-16T12:00:00Z" })];
    await syncAttendanceLeaderboard(true);

    const row = (await pool.query(`select * from wix_booking_records where booking_id='c1'`)).rows[0];
    expect(row).toBeDefined();
    expect(row.status).toBe("CANCELED");
    expect(row.invalidated_at).toBeNull();
  });

  it("invalidates a vanished row only after a complete full scan", async () => {
    mock.wix.bookings = [bookingFixture({ id: "gone1" })];
    await syncAttendanceLeaderboard(true);
    expect((await pool.query(`select invalidated_at from wix_booking_records where booking_id='gone1'`)).rows[0].invalidated_at).toBeNull();

    // A later full scan no longer sees it → tombstone (not delete).
    mock.wix.bookings = [];
    await syncAttendanceLeaderboard(true);
    const row = (await pool.query(`select * from wix_booking_records where booking_id='gone1'`)).rows[0];
    expect(row).toBeDefined();
    expect(row.invalidated_at).not.toBeNull();
  });

  it("mirrors a manual Wix pricing-plan order with its exact name", async () => {
    const clientId = await createClient("Fatou Sow", "221773334444");
    mock.wix.offlinePlanOrders = [
      {
        id: "plan_ord_1",
        planId: "plan_x",
        planName: "L'Invitée — Clé 3 séances",
        status: "ACTIVE",
        buyer: { contactId: "wc1", phone: "+221773334444", fullName: "Fatou Sow" },
        priceDetails: { total: 45000, currency: "XOF" },
        createdDate: "2026-08-15T10:00:00Z",
        updatedDate: "2026-08-15T10:00:00Z",
      },
    ];
    await syncAttendanceLeaderboard(true);

    const row = (await pool.query(`select * from wix_plan_order_records where order_id='plan_ord_1'`)).rows[0];
    expect(row).toMatchObject({
      plan_name: "L'Invitée — Clé 3 séances",
      order_status: "ACTIVE",
      amount_xof: 45000,
      match_basis: "phone",
    });
    expect(String(row.matched_client_id)).toBe(clientId);
  });

  it("ignores a stale plan-order webhook but applies a newer one", async () => {
    const order = (updated: string, name: string, status: string) => ({
      id: "wh1",
      planId: "plan_x",
      planName: name,
      status,
      buyer: { contactId: "wc9", phone: "+221770000009", fullName: "Test" },
      priceDetails: { total: 30000, currency: "XOF" },
      createdDate: "2026-08-10T00:00:00Z",
      updatedDate: updated,
    });

    await upsertPlanOrderFromWebhook(order("2026-08-15T12:00:00Z", "Nom récent", "ACTIVE"));
    // Older webhook must not overwrite.
    await upsertPlanOrderFromWebhook(order("2026-08-14T00:00:00Z", "Nom périmé", "CANCELED"));
    let row = (await pool.query(`select * from wix_plan_order_records where order_id='wh1'`)).rows[0];
    expect(row.plan_name).toBe("Nom récent");
    expect(row.order_status).toBe("ACTIVE");

    // Newer webhook applies.
    await upsertPlanOrderFromWebhook(order("2026-08-16T00:00:00Z", "Nom plus récent", "CANCELED"));
    row = (await pool.query(`select * from wix_plan_order_records where order_id='wh1'`)).rows[0];
    expect(row.plan_name).toBe("Nom plus récent");
    expect(row.order_status).toBe("CANCELED");
  });
});
