import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../../src/server.js";
import { migrate, pool } from "../../src/db/index.js";
import {
  attendanceDetail,
  attendanceLeaders,
  syncAttendanceLeaderboard,
} from "../../src/domain/attendanceLeaderboard.js";
import { makeFetchMock, truncateAll, type FetchMock } from "./helpers.js";

const AUTH = `Basic ${Buffer.from("revive:revive@5000").toString("base64")}`;
let app: FastifyInstance;
let mock: FetchMock;

function booking(args: {
  id: string;
  contactId: string;
  firstName: string;
  phone: string;
  service: string;
  start: string;
}) {
  return {
    booking: {
      id: args.id,
      revision: "1",
      status: "CONFIRMED",
      contactDetails: {
        contactId: args.contactId,
        firstName: args.firstName,
        phone: args.phone,
      },
      bookedEntity: {
        title: args.service,
        slot: { serviceId: `svc_${args.service}`, startDate: args.start },
      },
    },
  };
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
  await pool.query(`delete from wix_attendance_records; delete from wix_confirmed_booking_records; delete from wix_attendance_sync_state; insert into wix_attendance_sync_state (singleton) values (true);`);
  mock.reset();
});

describe("client attendance leaderboard", () => {
  it("syncs Wix attendance, combines duplicate phone profiles, and excludes future/not-attended rows", async () => {
    const past = new Date(Date.now() - 2 * 86_400_000).toISOString();
    const older = new Date(Date.now() - 45 * 86_400_000).toISOString();
    const future = new Date(Date.now() + 2 * 86_400_000).toISOString();
    mock.wix.attendanceRecords = [
      { id: "a1", bookingId: "b1", status: "ATTENDED", numberOfAttendees: 2 },
      { id: "a2", bookingId: "b2", status: "ATTENDED", numberOfAttendees: 1 },
      { id: "a3", bookingId: "b3", status: "NOT_ATTENDED", numberOfAttendees: 1 },
      { id: "a4", bookingId: "b4", status: "ATTENDED", numberOfAttendees: 1 },
    ];
    mock.wix.attendanceBookings = {
      b1: booking({ id: "b1", contactId: "c1", firstName: "Awa", phone: "+221771112233", service: "Pilates", start: past }),
      b2: booking({ id: "b2", contactId: "c2", firstName: "Awa", phone: "+221771112233", service: "Yoga", start: older }),
      b3: booking({ id: "b3", contactId: "c3", firstName: "Maya", phone: "+221772223344", service: "Pilates", start: past }),
      b4: booking({ id: "b4", contactId: "c4", firstName: "Future", phone: "+221773334455", service: "Pilates", start: future }),
      b5: booking({ id: "b5", contactId: "c1", firstName: "Awa", phone: "+221771112233", service: "Pilates", start: past }),
    };
    mock.wix.confirmedBookings = ["b1", "b2", "b3", "b4", "b5"].map((id) => mock.wix.attendanceBookings[id]);

    await syncAttendanceLeaderboard(true);

    const all = await attendanceLeaders({ period: "all" });
    const awa = all.rows.find((row) => row.client_name === "Awa");
    expect(awa).toMatchObject({ client_name: "Awa", session_count: 3, marked_attended_count: 2, duplicate_profiles: 2 });
    const recent = await attendanceLeaders({ period: "30" });
    expect(recent.rows.find((row) => row.client_name === "Awa")?.session_count).toBe(2);
    const detail = await attendanceDetail({ period: "all", wixContactId: "c1", phone: "+221771112233" });
    expect(detail).toMatchObject({ session_count: 3, marked_attended_count: 2 });
    expect(detail.by_service).toEqual(expect.arrayContaining([
      expect.objectContaining({ service_name: "Pilates", attended_count: 2 }),
      expect.objectContaining({ service_name: "Yoga", attended_count: 1 }),
    ]));
  });

  it("renders the leaderboard and lets staff find a client with zero attendance", async () => {
    const past = new Date(Date.now() - 86_400_000).toISOString();
    mock.wix.attendanceRecords = [{ id: "a1", bookingId: "b1", status: "ATTENDED" }];
    mock.wix.attendanceBookings = {
      b1: booking({ id: "b1", contactId: "c1", firstName: "Awa", phone: "+221771112233", service: "Pilates", start: past }),
    };
    mock.wix.confirmedBookings = [mock.wix.attendanceBookings.b1];
    mock.wix.contacts = [
      { id: "c1", info: { name: { first: "Awa", last: "Ndiaye" }, phones: { items: [{ phone: "+221771112233", primary: true }] } }, primaryInfo: { phone: "+221771112233" } },
      { id: "c0", info: { name: { first: "Soxna", last: "Ba" }, phones: { items: [{ phone: "+221779998877", primary: true }] } }, primaryInfo: { phone: "+221779998877" } },
    ];
    await syncAttendanceLeaderboard(true);

    const board = await app.inject({ method: "GET", url: "/admin/classement", headers: { authorization: AUTH } });
    expect(board.statusCode).toBe(200);
    expect(board.body).toContain("Classement clients");
    expect(board.body).toContain("Awa");
    expect(board.body).toContain("Depuis toujours");

    const search = await app.inject({ method: "GET", url: "/admin/classement?q=Soxna&client=c0", headers: { authorization: AUTH } });
    expect(search.statusCode).toBe(200);
    expect(search.body).toContain("Soxna Ba");
    expect(search.body).toContain("0</b><span>séance");
  });
});
