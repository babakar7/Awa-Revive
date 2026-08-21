import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { pool } from "../../src/db/index.js";
import { executeTool } from "../../src/agent/tools.js";
import * as repo from "../../src/domain/repo.js";
import * as keyRepo from "../../src/domain/keyRepo.js";
import { makeFetchMock, type FetchMock, inHours, seedBooking, seedClient, truncateAll } from "./helpers.js";

let mock: FetchMock;

const asClient = (c: { id: string; wa_phone: string }) => ({
  id: c.id,
  wa_phone: c.wa_phone,
  name: "Test",
  language: "fr",
  email_prompted_at: null,
  claimed_email: null,
  capability_menu_at: null,
});

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
  mock.reset();
});

describe("reschedule_booking", () => {
  it("moves an Awa-paid same-class booking without refund, extra payment or a new booking", async () => {
    const client = await seedClient();
    const oldStart = inHours(30);
    const booking = await seedBooking(client.id, {
      status: "BOOKED",
      wix_booking_id: "wb_existing",
      payment_method: "wave",
      wave_session_id: "cos_paid",
      slot_start: oldStart,
      slot_end: inHours(31),
      participants: 2,
    });
    mock.wix.eventId = "ev_monday";
    mock.wix.slotStart = inHours(48);
    mock.wix.slotEnd = inHours(49);

    const availability = JSON.parse(
      await executeTool(asClient(client), "check_availability", {
        service_id: "svc_1",
        date_from: inHours(24),
        date_to: inHours(72),
      }),
    );
    const out = JSON.parse(
      await executeTool(asClient(client), "reschedule_booking", {
        booking_id: booking.id,
        event_id: availability.slots[0].choice_id,
      }),
    );

    expect(out).toMatchObject({ rescheduled: true, payment_preserved: true, participants: 2 });
    const after = (await pool.query(`select * from pending_bookings where id=$1`, [booking.id])).rows[0];
    expect(after).toMatchObject({
      status: "BOOKED",
      event_id: "ev_monday",
      payment_method: "wave",
      wave_session_id: "cos_paid",
      amount_xof: 15000,
      participants: 2,
    });
    expect(new Date(after.slot_start).toISOString()).toBe(mock.wix.slotStart);
    expect(mock.wixCreateBookingCalls()).toHaveLength(0);
    expect(mock.calls.some((c) => c.url.endsWith("/cancel"))).toBe(false);
    const moved = mock.calls.find((c) => c.url.endsWith("/reschedule"));
    expect(moved?.body).toMatchObject({ revision: "1", slot: { eventId: "ev_monday" } });
  });

  it("uses slot.eventId, never the overlong availability sessionId (Kadiatou regression)", async () => {
    const client = await seedClient();
    const booking = await seedBooking(client.id, {
      status: "BOOKED",
      wix_booking_id: "wb_kadiatou",
      slot_start: inHours(30),
      slot_end: inHours(31),
    });
    const overlongSessionId = "s".repeat(334);
    const wixEventId = "e".repeat(119);
    mock.wix.eventId = overlongSessionId;
    mock.wix.rescheduleEventId = wixEventId;
    mock.wix.slotStart = inHours(48);
    mock.wix.slotEnd = inHours(49);

    const availability = JSON.parse(
      await executeTool(asClient(client), "check_availability", {
        service_id: "svc_1",
        date_from: inHours(24),
        date_to: inHours(72),
      }),
    );
    const out = JSON.parse(
      await executeTool(asClient(client), "reschedule_booking", {
        booking_id: booking.id,
        event_id: availability.slots[0].choice_id,
      }),
    );

    expect(out).toMatchObject({ rescheduled: true, payment_preserved: true });
    const moved = mock.calls.find((call) => call.url.endsWith("/reschedule"));
    expect(moved?.body.slot.eventId).toBe(wixEventId);
    expect(moved?.body.slot.eventId).not.toBe(overlongSessionId);
  });

  it("refuses an invalid Wix event id before any rescheduling write", async () => {
    const client = await seedClient();
    const booking = await seedBooking(client.id, {
      status: "BOOKED",
      wix_booking_id: "wb_invalid_reschedule_event",
      slot_start: inHours(30),
      slot_end: inHours(31),
    });
    mock.wix.eventId = "session_valid_for_availability";
    mock.wix.rescheduleEventId = "e".repeat(251);
    mock.wix.slotStart = inHours(48);
    mock.wix.slotEnd = inHours(49);

    const availability = JSON.parse(
      await executeTool(asClient(client), "check_availability", {
        service_id: "svc_1",
        date_from: inHours(24),
        date_to: inHours(72),
      }),
    );
    await expect(
      executeTool(asClient(client), "reschedule_booking", {
        booking_id: booking.id,
        event_id: availability.slots[0].choice_id,
      }),
    ).rejects.toThrow("Invalid Wix reschedule event id (251 characters)");

    expect(mock.calls.some((call) => call.url.endsWith("/reschedule"))).toBe(false);
  });

  it("rejects a move inside the 16-hour window without touching Wix", async () => {
    const client = await seedClient();
    const booking = await seedBooking(client.id, {
      status: "BOOKED",
      wix_booking_id: "wb_existing",
      slot_start: inHours(15),
      slot_end: inHours(16),
    });
    await repo.cacheSlots(client.id, "svc_1", [{
      eventId: "ev_monday",
      slot: { serviceId: "svc_1", sessionId: "ev_monday", startDate: inHours(48), endDate: inHours(49) },
    }]);

    const out = JSON.parse(
      await executeTool(asClient(client), "reschedule_booking", { booking_id: booking.id, event_id: "ev_monday" }),
    );
    expect(out.error).toBe("too_late_16h_policy");
    expect(mock.calls.some((c) => c.url.endsWith("/reschedule") || c.url.endsWith("/cancel"))).toBe(false);
    expect((await pool.query(`select status from pending_bookings where id=$1`, [booking.id])).rows[0].status).toBe("BOOKED");
  });

  it("labels an already-started local class distinctly instead of a 0-hour 16h refusal", async () => {
    const client = await seedClient();
    const booking = await seedBooking(client.id, {
      status: "BOOKED",
      wix_booking_id: "wb_started",
      slot_start: inHours(-1),
      slot_end: inHours(0),
    });
    await repo.cacheSlots(client.id, "svc_1", [{
      eventId: "ev_monday",
      slot: { serviceId: "svc_1", sessionId: "ev_monday", startDate: inHours(48), endDate: inHours(49) },
    }]);

    const out = JSON.parse(await executeTool(asClient(client), "reschedule_booking", {
      booking_id: booking.id, event_id: "ev_monday",
    }));
    expect(out.error).toBe("class_already_started");
    expect(mock.calls.some((c) => c.url.endsWith("/reschedule") || c.url.endsWith("/cancel"))).toBe(false);
  });

  it("rejects a different-class target without cancelling the original booking", async () => {
    const client = await seedClient();
    const booking = await seedBooking(client.id, { status: "BOOKED", wix_booking_id: "wb_existing", slot_start: inHours(30) });
    await repo.cacheSlots(client.id, "svc_other", [{
      eventId: "ev_other",
      slot: { serviceId: "svc_other", sessionId: "ev_other", startDate: inHours(48), endDate: inHours(49) },
    }]);

    const out = JSON.parse(
      await executeTool(asClient(client), "reschedule_booking", { booking_id: booking.id, event_id: "ev_other" }),
    );
    expect(out.error).toBe("different_class_not_reschedulable");
    expect(mock.calls.some((c) => c.url.endsWith("/reschedule") || c.url.endsWith("/cancel"))).toBe(false);
  });

  it("never cancels or reschedules a Key bonus once it is booked", async () => {
    const client = await seedClient();
    const booking = await seedBooking(client.id, {
      status: "BOOKED",
      wix_booking_id: "wb_key_bonus",
      payment_method: "membership",
      slot_start: inHours(30),
      slot_end: inHours(31),
    });
    const key = await keyRepo.upsertKey({
      paidOrderId: "paid-key-protected-benefit",
      clientId: client.id,
      wixContactId: "contact-key-protected-benefit",
      wixMemberId: "member-key-protected-benefit",
      mapping: {
        type: "HABITUEE",
        planId: "hab-plan",
        family: "REFORMER",
        durationDays: 30,
        baseInvitations: 0,
        continuityInvitation: true,
        invitation: {
          planId: "invitation-plan",
          serviceIds: ["svc-reformer"],
          slotRule: "CALM_SLOT",
          friendRule: "NEVER_REFORMER",
        },
        bonus: { planId: "hab-bonus", serviceIds: ["svc-mat"], slotRule: "ANY_WEEKDAY_HOUR" },
      },
      startsAt: new Date(inHours(-24)),
      endsAt: new Date(inHours(29 * 24)),
      status: "ACTIVE",
    });
    await keyRepo.markProtectedBenefitBooking({
      wixBookingId: "wb_key_bonus",
      localBookingId: booking.id,
      keyId: key.id,
      kind: "BONUS",
    });
    await repo.cacheSlots(client.id, "svc_1", [{
      eventId: "ev_monday",
      slot: {
        serviceId: "svc_1",
        sessionId: "ev_monday",
        startDate: inHours(48),
        endDate: inHours(49),
      },
    }]);

    const moved = JSON.parse(
      await executeTool(asClient(client), "reschedule_booking", {
        booking_id: booking.id,
        event_id: "ev_monday",
      }),
    );
    const cancelled = JSON.parse(
      await executeTool(asClient(client), "cancel_booking", {
        booking_id: booking.id,
      }),
    );

    expect(moved.error).toBe("key_benefit_non_changeable");
    expect(cancelled.error).toBe("key_benefit_non_cancellable");
    expect(mock.calls.some((call) => call.url.endsWith("/reschedule") || call.url.endsWith("/cancel"))).toBe(false);
    expect(
      (await pool.query(`select status from pending_bookings where id=$1`, [booking.id])).rows[0].status,
    ).toBe("BOOKED");
  });
});

describe("cancel_booking no-refund policy", () => {
  it("does not turn an already-started class into a 0-hour cancellation-policy refusal", async () => {
    const client = await seedClient();
    const booking = await seedBooking(client.id, {
      status: "BOOKED", wix_booking_id: "wb_cancel_started", slot_start: inHours(-1), slot_end: inHours(0),
    });
    const out = JSON.parse(await executeTool(asClient(client), "cancel_booking", { booking_id: booking.id }));
    expect(out.error).toBe("class_already_started");
    expect(mock.calls.some((call) => call.url.endsWith("/cancel"))).toBe(false);
  });

  it("uses Wix native refund for a membership cancellation and does not double-credit", async () => {
    const client = await seedClient();
    const booking = await seedBooking(client.id, {
      status: "BOOKED",
      wix_booking_id: "wb_membership",
      payment_method: "membership",
      benefit_transaction_id: "benefit_original",
      slot_start: inHours(30),
      slot_end: inHours(31),
    });

    const out = JSON.parse(
      await executeTool(asClient(client), "cancel_booking", { booking_id: booking.id }),
    );

    expect(out).toMatchObject({
      cancelled: true,
      session_recredited: true,
      sessions_recredited: 1,
      recredit_source: "native",
      wix_payment_status_synced: true,
    });
    const cancel = mock.calls.find((call) => call.url.endsWith("/cancel"));
    expect(cancel?.body.flowControlSettings).toMatchObject({
      ignoreCancellationPolicy: true,
      withRefund: true,
      waiveCancellationFee: true,
    });
    expect(
      mock.calls.some((call) => call.url.includes("/balances/changes/benefit_original/revert")),
    ).toBe(false);
    const paymentMarker = mock.calls.find(
      (call) =>
        call.method === "PATCH" &&
        call.url.endsWith("/bookings/v2/bookings/wb_membership"),
    );
    expect(paymentMarker?.body.booking).toMatchObject({
      revision: "2",
      paymentStatus: "REFUNDED",
    });
    expect(
      (await pool.query(`select status from pending_bookings where id=$1`, [booking.id]))
        .rows[0].status,
    ).toBe("CANCELLED");
  });

  it("falls back to an idempotent Benefit Programs reversal when Wix records no native refund", async () => {
    mock.wix.nativeRefundRecreditsBenefit = false;
    const client = await seedClient();
    const booking = await seedBooking(client.id, {
      status: "BOOKED",
      wix_booking_id: "wb_membership_legacy",
      payment_method: "membership",
      benefit_transaction_id: "benefit_legacy",
      slot_start: inHours(30),
      slot_end: inHours(31),
    });

    const out = JSON.parse(
      await executeTool(asClient(client), "cancel_booking", { booking_id: booking.id }),
    );

    expect(out).toMatchObject({
      cancelled: true,
      session_recredited: true,
      recredit_source: "fallback",
      wix_payment_status_synced: true,
    });
    expect(mock.wix.revertedBenefitTransactionIds).toEqual(["benefit_legacy"]);
    expect(
      mock.calls.filter((call) => call.url.includes("/balances/changes/benefit_legacy/revert")),
    ).toHaveLength(1);
  });

  it("keeps a direct-paid booking intact until the client explicitly accepts no refund", async () => {
    const client = await seedClient();
    const booking = await seedBooking(client.id, {
      status: "BOOKED",
      wix_booking_id: "wb_non_refundable",
      payment_method: "wave",
      wave_session_id: "cos_paid",
      slot_start: inHours(30),
      slot_end: inHours(31),
    });

    const out = JSON.parse(
      await executeTool(asClient(client), "cancel_booking", { booking_id: booking.id }),
    );

    expect(out.error).toBe("no_refund_confirmation_required");
    expect(out.message).toMatch(/reschedule|transfer/i);
    expect(mock.calls.some((call) => call.url.endsWith("/cancel"))).toBe(false);
    const after = (
      await pool.query(`select status, forfeited_at from pending_bookings where id=$1`, [booking.id])
    ).rows[0];
    expect(after.status).toBe("BOOKED");
    expect(after.forfeited_at).toBeNull();
  });

  it("releases a direct-paid seat without creating a refund after explicit acceptance", async () => {
    const client = await seedClient();
    const booking = await seedBooking(client.id, {
      status: "BOOKED",
      wix_booking_id: "wb_non_refundable",
      payment_method: "orange_money",
      wave_session_id: "om_paid",
      slot_start: inHours(30),
      slot_end: inHours(31),
    });

    const out = JSON.parse(
      await executeTool(asClient(client), "cancel_booking", {
        booking_id: booking.id,
        acknowledge_no_refund: true,
      }),
    );

    expect(out).toMatchObject({ cancelled: true, non_refundable: true });
    expect(out).not.toHaveProperty("refund");
    expect(out).not.toHaveProperty("refund_within_hours");
    expect(mock.calls.some((call) => call.url.endsWith("/cancel"))).toBe(true);
    const cancel = mock.calls.find((call) => call.url.endsWith("/cancel"));
    expect(cancel?.body.flowControlSettings).toEqual({
      ignoreCancellationPolicy: true,
    });
    expect(
      mock.calls.some(
        (call) =>
          call.method === "PATCH" &&
          call.url.endsWith("/bookings/v2/bookings/wb_non_refundable"),
      ),
    ).toBe(false);
    const after = (
      await pool.query(`select status, forfeited_at from pending_bookings where id=$1`, [booking.id])
    ).rows[0];
    expect(after.status).toBe("CANCELLED");
    expect(after.forfeited_at).toBeInstanceOf(Date);
  });
});
