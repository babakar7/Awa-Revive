import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { migrate, pool } from "../../src/db/index.js";
import {
  bookingConversionDashboard,
  closeInactiveBookingJourneys,
  recordBookingFunnelEvent,
} from "../../src/domain/bookingFunnel.js";
import { executeTool } from "../../src/agent/tools.js";
import { slotChoiceKey } from "../../src/domain/repo.js";
import { makeFetchMock, seedBooking, seedClient, truncateAll, type FetchMock } from "./helpers.js";

let mock: FetchMock;

const fullClient = (client: { id: string; wa_phone: string }) => ({
  id: client.id,
  wa_phone: client.wa_phone,
  name: "Test",
  language: "fr",
  email_prompted_at: null,
  claimed_email: null,
  capability_menu_at: null,
});

beforeAll(async () => {
  await migrate();
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
});

describe("booking funnel persistence", () => {
  it("correlates one journey, deduplicates transitions, and excludes team clients", async () => {
    const client = await seedClient();
    const booking = await seedBooking(client.id);
    const team = await seedClient({ wa_phone: "221770000099", name: "Team" });
    await pool.query(`update clients set is_test=true where id=$1`, [team.id]);

    await recordBookingFunnelEvent({ clientId: client.id, stage: "availability_requested" });
    await recordBookingFunnelEvent({ clientId: client.id, stage: "slots_shown" });
    await recordBookingFunnelEvent({
      clientId: client.id,
      bookingId: booking.id,
      stage: "payment_link_created",
      paymentMethod: "wave",
      idempotencyKey: `booking:${booking.id}:link`,
    });
    await recordBookingFunnelEvent({
      clientId: client.id,
      bookingId: booking.id,
      stage: "payment_link_created",
      paymentMethod: "wave",
      idempotencyKey: `booking:${booking.id}:link`,
    });
    await recordBookingFunnelEvent({
      clientId: client.id,
      bookingId: booking.id,
      stage: "booked",
      paymentMethod: "wave",
      idempotencyKey: `booking:${booking.id}:booked`,
    });
    await recordBookingFunnelEvent({ clientId: team.id, stage: "availability_requested" });

    const rows = await pool.query(
      `select count(distinct journey_id)::int as journeys, count(*)::int as events
         from booking_funnel_events where client_id=$1`,
      [client.id],
    );
    expect(rows.rows[0]).toEqual({ journeys: 1, events: 4 });
    const excluded = await pool.query(
      `select is_excluded from booking_funnel_events where client_id=$1`,
      [team.id],
    );
    expect(excluded.rows[0].is_excluded).toBe(true);

    const dashboard = await bookingConversionDashboard();
    expect(dashboard.thirtyDays.journeys).toBe(1);
    expect(dashboard.thirtyDays.paymentLinkToBooked).toBe(100);
  });

  it("closes an inactive journey and starts a new one after 24 hours", async () => {
    const client = await seedClient();
    await recordBookingFunnelEvent({
      clientId: client.id,
      stage: "availability_requested",
      occurredAt: new Date(Date.now() - 25 * 3_600_000),
    });
    expect(await closeInactiveBookingJourneys()).toBe(1);
    await recordBookingFunnelEvent({ clientId: client.id, stage: "availability_requested" });
    const statuses = await pool.query(
      `select status from booking_funnel_journeys where client_id=$1 order by started_at`,
      [client.id],
    );
    expect(statuses.rows.map((row) => row.status)).toEqual(["inactive", "open"]);
  });

  it("backfills historical link, expiry and booking stages idempotently", async () => {
    const client = await seedClient();
    const booked = await seedBooking(client.id, { status: "BOOKED", wix_booking_id: "wix-1" });
    const expired = await seedBooking(client.id, {
      event_id: "ev-2",
      status: "EXPIRED",
      link_expires_at: new Date(Date.now() - 60_000).toISOString(),
    });

    await migrate();
    await migrate();
    const stages = await pool.query(
      `select booking_id, stage, count(*)::int as n from booking_funnel_events
        where booking_id=any($1::uuid[]) group by booking_id, stage order by booking_id, stage`,
      [[booked.id, expired.id]],
    );
    expect(stages.rows).toHaveLength(4);
    expect(stages.rows).toEqual(
      expect.arrayContaining([
        { booking_id: booked.id, stage: "booked", n: 1 },
        { booking_id: booked.id, stage: "payment_link_created", n: 1 },
        { booking_id: expired.id, stage: "expired", n: 1 },
        { booking_id: expired.id, stage: "payment_link_created", n: 1 },
      ]),
    );
  });

  it("searches the following seven days once when the requested period is empty", async () => {
    const client = await seedClient();
    mock.wix.availabilityQueue.push(
      { eventId: "ev_full", openSpots: 0 },
      { eventId: "ev_next_week", openSpots: 4, slotStart: new Date(Date.now() + 8 * 86_400_000).toISOString() },
    );

    const result = JSON.parse(
      await executeTool(fullClient(client), "check_availability", {
        service_id: "svc_1",
        date_from: new Date(Date.now() + 86_400_000).toISOString(),
        date_to: new Date(Date.now() + 7 * 86_400_000).toISOString(),
      }),
    );

    expect(result.alternative_period).toBeTruthy();
    expect(result.slots.find((slot: any) => slot.choice_id === slotChoiceKey("ev_next_week"))).toMatchObject({
      open_spots: 4,
      alternative: true,
    });
    expect(mock.calls.filter((call) => call.url.includes("/availability/query"))).toHaveLength(2);
    const stages = await pool.query(
      `select stage from booking_funnel_events where client_id=$1 order by occurred_at, id`,
      [client.id],
    );
    expect(stages.rows.map((row) => row.stage)).toEqual([
      "availability_requested",
      "no_availability",
      "slots_shown",
    ]);
  });

  it("returns fresh alternatives when a selected slot fills before link creation", async () => {
    const client = await seedClient();
    const initial = JSON.parse(
      await executeTool(fullClient(client), "check_availability", {
        service_id: "svc_1",
        date_from: new Date(Date.now() + 86_400_000).toISOString(),
        date_to: new Date(Date.now() + 7 * 86_400_000).toISOString(),
      }),
    );
    mock.wix.availabilityQueue.push(
      { eventId: "ev_1", openSpots: 0 },
      { eventId: "ev_fresh", openSpots: 3, slotStart: new Date(Date.now() + 48 * 3_600_000).toISOString() },
    );

    const result = JSON.parse(
      await executeTool(fullClient(client), "create_payment_link", {
        service_id: "svc_1",
        event_id: initial.slots[0].choice_id,
        client_name: "Test",
        participants: 1,
        payment_method: "wave",
      }),
    );

    expect(result.error).toBe("not_enough_spots");
    expect(result.alternatives).toEqual([
      expect.objectContaining({ choice_id: slotChoiceKey("ev_fresh"), open_spots: 3, alternative: true }),
    ]);
    expect((await pool.query(`select count(*)::int as n from pending_bookings`)).rows[0].n).toBe(0);
    const failure = await pool.query(
      `select failure_code from booking_funnel_events where client_id=$1 and failure_code is not null`,
      [client.id],
    );
    expect(failure.rows).toEqual([{ failure_code: "slot_unavailable" }]);
  });

  it("books against an eligible membership and records the confirmed journey", async () => {
    const client = await seedClient({ name: "Awa Test" });
    mock.wix.contacts = [{ id: "contact_1", info: { name: { first: "Awa", last: "Test" } } }];
    const initial = JSON.parse(
      await executeTool(fullClient(client), "check_availability", {
        service_id: "svc_1",
        date_from: new Date(Date.now() + 86_400_000).toISOString(),
        date_to: new Date(Date.now() + 7 * 86_400_000).toISOString(),
      }),
    );

    const result = JSON.parse(
      await executeTool(fullClient(client), "book_with_membership", {
        service_id: "svc_1",
        event_id: initial.slots[0].choice_id,
        client_name: "Awa Test",
        participants: 2,
      }),
    );

    expect(result).toMatchObject({ booked: true, participants: 2, sessions_deducted: 2 });
    const booking = await pool.query(
      `select status, payment_method, participants, benefit_transaction_id from pending_bookings where id=$1`,
      [result.booking_id],
    );
    expect(booking.rows[0]).toMatchObject({
      status: "BOOKED",
      payment_method: "membership",
      participants: 2,
    });
    expect(booking.rows[0].benefit_transaction_id).toBeTruthy();
    const stages = await pool.query(
      `select stage from booking_funnel_events where booking_id=$1 order by occurred_at, id`,
      [result.booking_id],
    );
    expect(stages.rows.map((row) => row.stage)).toEqual(["payment_confirmed", "booked"]);
  });
});
