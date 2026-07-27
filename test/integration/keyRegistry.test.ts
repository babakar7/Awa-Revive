import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { migrate, pool } from "../../src/db/index.js";
import * as keys from "../../src/domain/keyRepo.js";
import * as repo from "../../src/domain/repo.js";
import type { KeyPlanMapping } from "../../src/domain/keyRules.js";
import { inHours, seedClient, truncateAll } from "./helpers.js";

const mapping: KeyPlanMapping = {
  type: "RESIDENTE",
  planId: "resident-plan",
  bonusPlanId: "resident-bonus",
  durationDays: 60,
};

beforeAll(async () => {
  await migrate();
});

afterAll(async () => {
  await pool.end();
});

beforeEach(async () => {
  await truncateAll();
});

describe("Clés registry", () => {
  it("stores pairings and invitation rights without local session balances", async () => {
    const client = await seedClient();
    const start = new Date(inHours(-1));
    const end = new Date(inHours(60 * 24));
    const key = await keys.upsertKey({
      paidOrderId: "paid-order-1",
      clientId: client.id,
      wixContactId: "contact-1",
      wixMemberId: "member-1",
      mapping,
      startsAt: start,
      endsAt: end,
      status: "ACTIVE",
    });
    await keys.createInvitationRights(key.id, 2);
    await keys.createInvitationRights(key.id, 2);

    const columns = await pool.query(
      `select column_name from information_schema.columns where table_name='key_registry'`,
    );
    expect(columns.rows.map((row) => row.column_name)).not.toContain("remaining_sessions");
    expect(
      Number(
        (
          await pool.query(
            `select count(*) as count from key_invitations where key_id=$1`,
            [key.id],
          )
        ).rows[0].count,
      ),
    ).toBe(2);
  });

  it("persists the same verified continuity facts on the payment and Key registry", async () => {
    const client = await seedClient();
    const paidAt = new Date("2026-07-27T10:00:00Z");
    const legacyEnd = new Date("2026-08-05T10:00:00Z");
    const draft = await repo.createDraftPlanOrder({
      clientId: client.id,
      planId: mapping.planId,
      planName: "La Résidente — Clé 12 séances",
      amountXof: 144000,
      memberId: "member-continuity",
      isKey: true,
      startsAt: legacyEnd,
      continuitySourceKind: "LEGACY_REFORMER",
      continuitySourceOrderId: "legacy-order",
      continuitySourcePlanId: "legacy-plan",
      continuityExpiresAt: legacyEnd,
      continuityRemaining: 4,
    });
    const paid = await repo.markPlanOrderPaid(draft.id, paidAt);
    expect(new Date(paid!.paid_at!).toISOString()).toBe(paidAt.toISOString());
    await repo.finalizePaidKeyContinuity({
      id: draft.id,
      startsAt: legacyEnd,
      invitationCount: 2,
      sourceKind: "LEGACY_REFORMER",
      sourceOrderId: "legacy-order",
      sourcePlanId: "legacy-plan",
      sourceExpiresAt: legacyEnd,
      sourceRemaining: 4,
    });
    const key = await keys.upsertKey({
      paidOrderId: "new-key-order",
      clientId: client.id,
      wixMemberId: "member-continuity",
      mapping,
      startsAt: legacyEnd,
      endsAt: new Date(legacyEnd.getTime() + 60 * 86_400_000),
      status: "SCHEDULED",
      purchasedAt: paidAt,
      continuitySourceKind: "LEGACY_REFORMER",
      continuitySourceOrderId: "legacy-order",
      continuitySourcePlanId: "legacy-plan",
      continuityExpiresAt: legacyEnd,
      invitationsGranted: 2,
    });
    expect(key).toMatchObject({
      continuity_source_kind: "LEGACY_REFORMER",
      continuity_source_order_id: "legacy-order",
      continuity_source_plan_id: "legacy-plan",
      invitations_granted: 2,
    });
    expect(new Date(key.purchased_at!).toISOString()).toBe(paidAt.toISOString());
  });

  it("enforces at most one scheduled Key per client", async () => {
    const client = await seedClient();
    const first = new Date(inHours(24));
    await keys.upsertKey({
      paidOrderId: "scheduled-1",
      clientId: client.id,
      wixMemberId: "member-1",
      mapping,
      startsAt: first,
      endsAt: new Date(first.getTime() + 60 * 86_400_000),
      status: "SCHEDULED",
    });
    await expect(
      keys.upsertKey({
        paidOrderId: "scheduled-2",
        clientId: client.id,
        wixMemberId: "member-1",
        mapping,
        startsAt: new Date(first.getTime() + 1000),
        endsAt: new Date(first.getTime() + 60 * 86_400_000),
        status: "SCHEDULED",
      }),
    ).rejects.toMatchObject({ code: "23505" });
  });

  it("keeps benefit bookings final and excludes cancelled Reformer bookings from guarantee facts", async () => {
    const client = await seedClient();
    const key = await keys.upsertKey({
      paidOrderId: "invitee-paid",
      clientId: client.id,
      wixContactId: "contact-1",
      wixMemberId: "member-1",
      mapping: { ...mapping, type: "INVITEE" },
      startsAt: new Date(inHours(-24)),
      endsAt: new Date(inHours(20 * 24)),
      status: "ACTIVE",
    });
    const booked = await pool.query(
      `insert into pending_bookings
         (client_id, service_id, service_name, event_id, slot_start, amount_xof,
          status, wix_booking_id, payment_method)
       values ($1,'reformer','Reformer','event-1',$2,0,'BOOKED','wix-reformer-1','membership')
       returning id`,
      [client.id, inHours(-2)],
    );
    const cancelled = await pool.query(
      `insert into pending_bookings
         (client_id, service_id, service_name, event_id, slot_start, amount_xof,
          status, wix_booking_id, payment_method)
       values ($1,'reformer','Reformer','event-2',$2,0,'CANCELLED','wix-reformer-2','membership')
       returning id`,
      [client.id, inHours(24)],
    );
    await keys.recordKeyReformerBooking({
      wixBookingId: "wix-reformer-1",
      localBookingId: booked.rows[0].id,
      keyId: key.id,
      slotStart: inHours(-2),
    });
    await keys.recordKeyReformerBooking({
      wixBookingId: "wix-reformer-2",
      localBookingId: cancelled.rows[0].id,
      keyId: key.id,
      slotStart: inHours(24),
    });
    await pool.query(
      `insert into key_benefit_bookings
         (wix_booking_id, local_booking_id, key_id, kind)
       values ('wix-bonus-1',$1,$2,'BONUS')`,
      [booked.rows[0].id, key.id],
    );

    const facts = await keys.inviteeGuaranteeFacts(key.id);
    expect(facts.reformerBookings.map((row) => row.wix_booking_id)).toEqual([
      "wix-reformer-1",
    ]);
    expect(facts.bonusBookings).toBe(1);
    await expect(keys.protectedBenefitForBooking(booked.rows[0].id)).resolves.toEqual({
      kind: "BONUS",
    });
    await expect(keys.protectedBenefitForWixBooking("wix-bonus-1")).resolves.toEqual({
      kind: "BONUS",
    });
  });

  it("claims each commercial nudge exactly once and keeps failures durable", async () => {
    const client = await seedClient();
    const key = await keys.upsertKey({
      paidOrderId: "paid-nudge",
      clientId: client.id,
      mapping,
      startsAt: new Date(inHours(-1)),
      endsAt: new Date(inHours(60 * 24)),
      status: "ACTIVE",
    });
    const claim = {
      dedupKey: `MEMBER_J5:${key.id}`,
      keyId: key.id,
      clientId: client.id,
    };
    await expect(keys.claimKeyNudge(claim)).resolves.toBe(true);
    await expect(keys.claimKeyNudge(claim)).resolves.toBe(false);
    await keys.completeKeyNudge(claim.dedupKey, "FAILED", "Meta unavailable");
    const row = await pool.query(`select outcome, detail from key_nudges where dedup_key=$1`, [
      claim.dedupKey,
    ]);
    expect(row.rows[0]).toMatchObject({
      outcome: "FAILED",
      detail: "Meta unavailable",
    });
  });

  it("releases a paid next Key only after L'Invitée's third session has started", async () => {
    const client = await seedClient();
    const invitee = await keys.upsertKey({
      paidOrderId: "invitee-completion",
      clientId: client.id,
      wixContactId: "contact-completion",
      wixMemberId: "member-completion",
      mapping: { ...mapping, type: "INVITEE" },
      startsAt: new Date(inHours(-10 * 24)),
      endsAt: new Date(inHours(10 * 24)),
      status: "ACTIVE",
    });
    const scheduled = await pool.query(
      `insert into pending_plan_orders
         (client_id, plan_id, plan_name, amount_xof, member_id, starts_at,
          is_key, status)
       values ($1,'next-key','L''Habituée — Clé 6 séances',72000,
               'member-completion',$2,true,'SCHEDULED')
       returning id`,
      [client.id, inHours(10 * 24)],
    );
    for (const [index, hours] of [-72, -48, 1].entries()) {
      const booking = await pool.query(
        `insert into pending_bookings
           (client_id, service_id, service_name, event_id, slot_start, amount_xof,
            status, wix_booking_id, payment_method)
         values ($1,'reformer','Reformer',$2,$3,0,'BOOKED',$4,'membership')
         returning id`,
        [client.id, `event-completion-${index}`, inHours(hours), `wix-completion-${index}`],
      );
      await keys.recordKeyReformerBooking({
        wixBookingId: `wix-completion-${index}`,
        localBookingId: booking.rows[0].id,
        keyId: invitee.id,
        slotStart: inHours(hours),
      });
    }

    await expect(keys.releaseScheduledKeysAfterInviteeCompletion()).resolves.toEqual([]);
    await pool.query(
      `update key_reformer_bookings set slot_start=now() - interval '1 minute'
        where wix_booking_id='wix-completion-2'`,
    );
    await expect(keys.releaseScheduledKeysAfterInviteeCompletion()).resolves.toEqual([
      scheduled.rows[0].id,
    ]);
    const row = await pool.query(
      `select starts_at from pending_plan_orders where id=$1`,
      [scheduled.rows[0].id],
    );
    expect(new Date(row.rows[0].starts_at).getTime()).toBeLessThanOrEqual(Date.now());
  });
});
