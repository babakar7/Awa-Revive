import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { pool } from "../../src/db/index.js";
import * as keys from "../../src/domain/keyRepo.js";
import * as repo from "../../src/domain/repo.js";
import type { KeyPlanMapping, KeyType } from "../../src/domain/keyRules.js";
import { inHours, seedClient, truncateAll } from "./helpers.js";

function makeMapping(type: KeyType, over: Partial<KeyPlanMapping> = {}): KeyPlanMapping {
  const base: KeyPlanMapping = {
    type,
    planId: `${type.toLowerCase()}-plan`,
    family: "REFORMER",
    durationDays: 60,
    baseInvitations: type === "RESIDENTE" ? 1 : 0,
    continuityInvitation: true,
    invitation: {
      planId: "invitation-plan",
      serviceIds: ["svc-reformer"],
      slotRule: "CALM_SLOT_1230",
      friendRule: "NEVER_REFORMER",
    },
    bonus: { planId: `${type.toLowerCase()}-bonus`, serviceIds: ["svc-mat"], slotRule: "ANY_WEEKDAY_HOUR" },
  };
  return { ...base, ...over };
}

const mapping = makeMapping("RESIDENTE", { planId: "resident-plan", bonus: { planId: "resident-bonus", serviceIds: ["svc-mat"], slotRule: "ANY_WEEKDAY_HOUR" } });

const aquabikeMapping = makeMapping("AQUABIKE", {
  planId: "aquabike-plan",
  family: "AQUABIKE",
  baseInvitations: 1,
  continuityInvitation: false,
  invitation: {
    planId: "aquabike-invitation-plan",
    serviceIds: ["svc-aquabike"],
    slotRule: "ANY_WEEKDAY_HOUR",
    friendRule: "NEVER_AQUABIKE",
  },
  bonus: { planId: "aquabike-bonus", serviceIds: ["svc-reformer"], slotRule: "CALM_SLOT_1230" },
});

const surMesureMapping = makeMapping("SUR_MESURE", {
  planId: "sur-mesure-plan",
  baseInvitations: 1,
  continuityInvitation: false,
  bonus: null,
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

  it("counts available invitations for lifecycle reminders", async () => {
    const client = await seedClient();
    const key = await keys.upsertKey({
      paidOrderId: "paid-reminder-count",
      clientId: client.id,
      wixContactId: "contact-reminder-count",
      wixMemberId: "member-reminder-count",
      mapping,
      startsAt: new Date(inHours(-10 * 24)),
      endsAt: new Date(inHours(50 * 24)),
      status: "ACTIVE",
    });
    await keys.createInvitationRights(key.id, 5);
    await pool.query(
      `update key_invitations
          set status=case ordinal
            when 1 then 'GRANTED'
            when 2 then 'ASSIGNED'
            when 3 then 'GRANTED'
            when 4 then 'USED'
            else 'VOID'
          end,
          friend_first_name=case when ordinal=2 then 'Sokhna' else null end
        where key_id=$1`,
      [key.id],
    );

    const rows = await keys.listActiveKeysForNudges();

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: key.id,
      available_invitations: 3,
    });
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

  it("enforces at most one scheduled Key per client PER FAMILY", async () => {
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
    // Same family (REFORMER) → rejected.
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
    // A different family (AQUABIKE) may be scheduled at the same time.
    const aqua = await keys.upsertKey({
      paidOrderId: "scheduled-aqua",
      clientId: client.id,
      wixMemberId: "member-1",
      mapping: aquabikeMapping,
      startsAt: new Date(first.getTime() + 2000),
      endsAt: new Date(first.getTime() + 30 * 86_400_000),
      status: "SCHEDULED",
    });
    expect(aqua.family).toBe("AQUABIKE");
  });

  it("registers AQUABIKE and SUR_MESURE rows; a bonus-less key is born ACTIVE and ignored by repairs", async () => {
    const client = await seedClient();
    const aqua = await keys.upsertKey({
      paidOrderId: "aqua-paid",
      clientId: client.id,
      wixMemberId: "member-aqua",
      mapping: aquabikeMapping,
      startsAt: new Date(inHours(-1)),
      endsAt: new Date(inHours(30 * 24)),
      status: "ACTIVE",
    });
    expect(aqua).toMatchObject({ key_type: "AQUABIKE", family: "AQUABIKE" });
    expect(aqua.bonus_plan_id).toBe("aquabike-bonus");

    const sur = await keys.upsertKey({
      paidOrderId: "sur-paid",
      clientId: client.id,
      wixMemberId: "member-sur",
      mapping: surMesureMapping,
      startsAt: new Date(inHours(-1)),
      endsAt: new Date(inHours(30 * 24)),
      status: "ACTIVE",
    });
    expect(sur).toMatchObject({ key_type: "SUR_MESURE", family: "REFORMER" });
    expect(sur.bonus_plan_id).toBeNull();
    expect(sur.bonus_status).toBe("ACTIVE"); // no bonus to provision

    // The bonus-less key must not appear in the repair sweep.
    const due = await keys.dueBonusRepairs();
    expect(due.map((r) => r.paid_order_id)).not.toContain("sur-paid");
  });

  it("resolves continuity/guarantee lookups by family and type, never masking across families", async () => {
    const client = await seedClient();
    // An Invitée started 10 days ago; an Aquabike started more recently.
    const invitee = await keys.upsertKey({
      paidOrderId: "coexist-invitee",
      clientId: client.id,
      wixMemberId: "member-x",
      mapping: makeMapping("INVITEE", { planId: "invitee-plan", durationDays: 21 }),
      startsAt: new Date(inHours(-10 * 24)),
      endsAt: new Date(inHours(11 * 24)),
      status: "ACTIVE",
    });
    await keys.upsertKey({
      paidOrderId: "coexist-aqua",
      clientId: client.id,
      wixMemberId: "member-x",
      mapping: aquabikeMapping,
      startsAt: new Date(inHours(-1)),
      endsAt: new Date(inHours(29 * 24)),
      status: "ACTIVE",
    });

    // activeKeyOfType finds the Invitée despite the more recent Aquabike.
    const foundInvitee = await keys.activeKeyOfType({
      clientId: client.id,
      wixMemberId: "member-x",
      type: "INVITEE",
    });
    expect(foundInvitee?.id).toBe(invitee.id);

    // keyCoveringAt scoped to AQUABIKE returns the Aquabike, not the Invitée.
    const aquaCover = await keys.keyCoveringAt({
      clientId: client.id,
      wixMemberId: "member-x",
      at: new Date(),
      family: "AQUABIKE",
    });
    expect(aquaCover?.paid_order_id).toBe("coexist-aqua");

    // keyCoveringAt scoped to REFORMER returns the Invitée.
    const reformerCover = await keys.keyCoveringAt({
      clientId: client.id,
      wixMemberId: "member-x",
      at: new Date(),
      family: "REFORMER",
    });
    expect(reformerCover?.paid_order_id).toBe("coexist-invitee");
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

  it("allows only one L'Invitée conversion message across J-5 and pre-third-session", async () => {
    const client = await seedClient();
    const key = await keys.upsertKey({
      paidOrderId: "invitee-conversion-nudge",
      clientId: client.id,
      mapping: { ...mapping, type: "INVITEE" },
      startsAt: new Date(inHours(-1)),
      endsAt: new Date(inHours(21 * 24)),
      status: "ACTIVE",
    });
    const sharedClaim = {
      dedupKey: `INVITEE_CONVERSION:${key.id}`,
      keyId: key.id,
      clientId: client.id,
    };

    // Whichever branch arrives first owns the one lifetime conversion send.
    await expect(keys.claimKeyNudge(sharedClaim)).resolves.toBe(true);
    await expect(keys.claimKeyNudge(sharedClaim)).resolves.toBe(false);

    const row = await pool.query(
      `select kind, outcome, detail from key_nudges where dedup_key=$1`,
      [sharedClaim.dedupKey],
    );
    expect(row.rows).toEqual([
      {
        kind: "INVITEE_CONVERSION",
        outcome: "FAILED",
        detail: "claimed",
      },
    ]);
  });

  it("detects a chosen or purchased next Reformer Key without treating an expired link as a commitment", async () => {
    const client = await seedClient();
    const current = await keys.upsertKey({
      paidOrderId: "current-key-order",
      clientId: client.id,
      mapping,
      startsAt: new Date(inHours(-10 * 24)),
      endsAt: new Date(inHours(10 * 24)),
      status: "ACTIVE",
    });
    const commitment = {
      keyId: current.id,
      clientId: client.id,
      paidOrderId: current.paid_order_id,
      family: current.family,
    };

    await expect(keys.hasNextKeyCommitment(commitment)).resolves.toBe(false);

    const pending = await pool.query(
      `insert into pending_plan_orders
         (client_id, plan_id, plan_name, amount_xof, starts_at, is_key,
          key_family, continuity_source_order_id, status, link_expires_at)
       values ($1,'next-habituee','L''Habituée — Clé 6 séances',72000,$2,true,
               'REFORMER',$3,'AWAITING_PAYMENT',$4)
       returning id`,
      [client.id, inHours(10 * 24), current.paid_order_id, inHours(1)],
    );
    await expect(keys.hasNextKeyCommitment(commitment)).resolves.toBe(true);

    await pool.query(
      `update pending_plan_orders set link_expires_at=now() - interval '1 minute'
        where id=$1`,
      [pending.rows[0].id],
    );
    await expect(keys.hasNextKeyCommitment(commitment)).resolves.toBe(false);

    await keys.upsertKey({
      paidOrderId: "purchased-next-key-order",
      clientId: client.id,
      mapping: { ...mapping, type: "HABITUEE" },
      startsAt: new Date(inHours(10 * 24)),
      endsAt: new Date(inHours(40 * 24)),
      status: "SCHEDULED",
      previousKeyId: current.id,
    });
    await expect(keys.hasNextKeyCommitment(commitment)).resolves.toBe(true);
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
      `select starts_at, starts_at <= now() as started
         from pending_plan_orders where id=$1`,
      [scheduled.rows[0].id],
    );
    expect(row.rows[0].started).toBe(true);
  });
});
