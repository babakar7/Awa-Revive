import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { pool } from "../../src/db/index.js";
import { executeTool } from "../../src/agent/tools.js";
import { cacheSlots, joinWaitlist } from "../../src/domain/repo.js";
import { sweepWaitlist } from "../../src/domain/waitlistSweep.js";
import { makeFetchMock, seedClient, truncateAll, type FetchMock } from "./helpers.js";

let mock: FetchMock;

const fullClient = (client: { id: string; wa_phone: string }) => ({
  id: client.id,
  wa_phone: client.wa_phone,
  name: "Adjiaratou Aby Sissoko",
  language: "fr",
  email_prompted_at: null,
  claimed_email: "adjiaratou@example.com",
  capability_menu_at: null,
});

const log = {
  info: () => undefined,
  error: () => undefined,
};

beforeAll(() => {
  mock = makeFetchMock();
  mock.install();
});

afterAll(async () => {
  mock.restore();
  await pool.end();
});

beforeEach(async () => {
  await truncateAll();
  mock.reset();
  mock.wix.openSpots = 0;
  mock.wix.contacts = [
    {
      id: "contact_adjiaratou",
      primaryInfo: { email: "adjiaratou@example.com", phone: "+221776372807" },
      info: {
        name: { first: "Adjiaratou Aby", last: "Sissoko" },
        phones: { items: [{ primary: true, phone: "+221776372807", e164Phone: "+221776372807" }] },
        emails: { items: [{ primary: true, email: "adjiaratou@example.com" }] },
      },
    },
  ];
});

async function joinNativeWaitlist() {
  const client = await seedClient({
    wa_phone: "221776372807",
    name: "Adjiaratou Aby Sissoko",
  });
  await cacheSlots(client.id, mock.wix.serviceId, [
    {
      eventId: mock.wix.eventId,
      slot: {
        sessionId: mock.wix.eventId,
        eventId: mock.wix.eventId,
        serviceId: mock.wix.serviceId,
        startDate: mock.wix.slotStart,
        endDate: mock.wix.slotEnd,
      },
    },
  ]);
  const result = JSON.parse(
    await executeTool(fullClient(client), "join_waitlist", {
      service_id: mock.wix.serviceId,
      event_id: mock.wix.eventId,
      slot_start: mock.wix.slotStart,
    }),
  );
  return { client, result };
}

describe("native Wix waitlist mirror", () => {
  it("keeps Awa's durable entry and makes the client visible in the Wix session waitlist", async () => {
    const { result } = await joinNativeWaitlist();

    expect(result).toMatchObject({ joined: true, visible_in_wix_waitlist: true });
    const row = (
      await pool.query(
        `select status, wix_registration_id, wix_waitlist_booking_id, wix_sync_error
           from waitlist_entries`,
      )
    ).rows[0];
    expect(row).toMatchObject({
      status: "WAITING",
      wix_registration_id: "wlr_1",
      wix_waitlist_booking_id: "wlb_1",
      wix_sync_error: null,
    });

    const register = mock.calls.find((call) => call.url.endsWith("/bookings/v1/waitlist/register"));
    expect(register?.body).toMatchObject({
      waitingResource: mock.wix.eventId,
      formInfo: {
        contactDetails: {
          contactId: "contact_adjiaratou",
          firstName: "Adjiaratou",
          lastName: "Aby Sissoko",
          email: "adjiaratou@example.com",
          phone: "+221776372807",
        },
        paymentSelection: [{ rateLabel: "general", numberOfParticipants: 1 }],
      },
    });
  });

  it("keeps the local waitlist active when Wix's preview API is unavailable", async () => {
    mock.wix.failWaitlistRegister = true;
    const { result } = await joinNativeWaitlist();

    expect(result).toMatchObject({ joined: true, visible_in_wix_waitlist: false });
    const row = (
      await pool.query(
        `select status, wix_registration_id, wix_sync_error from waitlist_entries`,
      )
    ).rows[0];
    expect(row.status).toBe("WAITING");
    expect(row.wix_registration_id).toBeNull();
    expect(row.wix_sync_error).toContain("503");
  });

  it("backfills a local WAITING entry that predates the native Wix mirror", async () => {
    const client = await seedClient({
      wa_phone: "221776372807",
      name: "Adjiaratou Aby Sissoko",
    });
    await joinWaitlist({
      clientId: client.id,
      serviceId: mock.wix.serviceId,
      serviceName: "Pilates Reformer",
      eventId: mock.wix.eventId,
      slotStart: mock.wix.slotStart,
    });

    expect(await sweepWaitlist(log)).toBe(0);

    const row = (
      await pool.query(`select status, wix_registration_id from waitlist_entries`)
    ).rows[0];
    expect(row).toMatchObject({ status: "WAITING", wix_registration_id: "wlr_1" });
    expect(mock.wix.waitlistRegistrations[0]).toMatchObject({
      waitingResource: mock.wix.eventId,
      status: "WAITING",
    });
  });

  it("removes the native registration when the client asks Awa to leave", async () => {
    const { client } = await joinNativeWaitlist();
    const result = JSON.parse(
      await executeTool(fullClient(client), "leave_waitlist", {
        service_id: mock.wix.serviceId,
      }),
    );

    expect(result).toMatchObject({ removed: 1 });
    const row = (
      await pool.query(`select status, wix_left_at, wix_sync_error from waitlist_entries`)
    ).rows[0];
    expect(row.status).toBe("CANCELLED");
    expect(row.wix_left_at).toBeInstanceOf(Date);
    expect(row.wix_sync_error).toBeNull();
    expect(mock.wix.waitlistRegistrations[0].status).toBe("DECLINED");
  });

  it("notifies through Awa when Wix is holding the freed place as SUGGESTING", async () => {
    await joinNativeWaitlist();
    mock.calls.length = 0;
    mock.wix.waitlistRegistrations[0].status = "SUGGESTING";
    mock.wix.openSpots = 0;

    expect(await sweepWaitlist(log)).toBe(1);

    const row = (
      await pool.query(`select status, wix_left_at from waitlist_entries`)
    ).rows[0];
    expect(row.status).toBe("NOTIFIED");
    expect(row.wix_left_at).toBeInstanceOf(Date);
    expect(mock.wix.waitlistRegistrations[0].status).toBe("DECLINED");
    expect(mock.waTextsTo("221776372807")[0]).toContain("une place vient de se libérer");
  });
});
