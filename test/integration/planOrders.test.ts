import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { migrate, pool } from "../../src/db/index.js";
import { PACK_DISCOVERY_CAMPAIGN } from "../../src/domain/packDiscoveryCampaign.js";
import { createDraftPlanOrder } from "../../src/domain/repo.js";
import { inHours, seedClient, truncateAll } from "./helpers.js";

beforeAll(async () => {
  await migrate();
});

afterAll(async () => {
  await pool.end();
});

beforeEach(async () => {
  await truncateAll();
});

describe("createDraftPlanOrder", () => {
  it("creates a regular draft without a discovery booking status", async () => {
    const client = await seedClient();

    const order = await createDraftPlanOrder({
      clientId: client.id,
      planId: "plan_regular",
      planName: "Abonnement Mensuel",
      amountXof: 75_000,
      memberId: "member_regular",
    });

    expect(order).toMatchObject({
      client_id: client.id,
      plan_id: "plan_regular",
      status: "DRAFT",
      campaign_code: null,
      discovery_booking_status: null,
    });
  });

  it("keeps at most one future Key scheduled per client in Postgres", async () => {
    const client = await seedClient();
    const startsAt = new Date(inHours(24));
    const first = await createDraftPlanOrder({
      clientId: client.id,
      planId: "key_habituee",
      planName: "L'Habituée — Clé 6 séances",
      amountXof: 72_000,
      memberId: "member_key",
      startsAt,
      isKey: true,
      keyInvitationCount: 2,
    });
    expect(first.key_invitation_count).toBe(2);
    await pool.query(`update pending_plan_orders set status='SCHEDULED' where id=$1`, [first.id]);
    const second = await createDraftPlanOrder({
      clientId: client.id,
      planId: "key_residente",
      planName: "La Résidente — Clé 12 séances",
      amountXof: 144_000,
      memberId: "member_key",
      startsAt,
      isKey: true,
    });
    await expect(
      pool.query(`update pending_plan_orders set status='SCHEDULED' where id=$1`, [second.id]),
    ).rejects.toMatchObject({ code: "23505" });
  });

  it("creates a Pack campaign draft with its slot pending discovery booking", async () => {
    const client = await seedClient();
    const slotStart = inHours(24);
    const slotEnd = inHours(25);
    const slotJson = {
      sessionId: "session_pack",
      serviceId: "service_reformer",
      startDate: slotStart,
      endDate: slotEnd,
    };

    const order = await createDraftPlanOrder({
      clientId: client.id,
      planId: "plan_pack_step_1",
      planName: "Pack Découverte - Etape 1",
      amountXof: 10_000,
      memberId: "member_pack",
      campaignCode: PACK_DISCOVERY_CAMPAIGN,
      serviceId: "service_reformer",
      serviceName: "Pilates Reformer",
      eventId: "event_reformer",
      slotJson,
      slotStart,
      slotEnd,
    });

    expect(order).toMatchObject({
      client_id: client.id,
      plan_id: "plan_pack_step_1",
      status: "DRAFT",
      campaign_code: PACK_DISCOVERY_CAMPAIGN,
      service_id: "service_reformer",
      service_name: "Pilates Reformer",
      event_id: "event_reformer",
      slot_json: slotJson,
      discovery_booking_status: "PENDING",
    });
    expect(order.slot_start?.toISOString()).toBe(slotStart);
    expect(order.slot_end?.toISOString()).toBe(slotEnd);
  });
});
