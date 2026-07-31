import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { migrate, pool } from "../../src/db/index.js";
import * as keys from "../../src/domain/keyRepo.js";
import type { KeyPlanMapping } from "../../src/domain/keyRules.js";
import { inHours, seedClient, truncateAll } from "./helpers.js";

const mapping: KeyPlanMapping = {
  type: "HABITUEE",
  planId: "habituee-plan",
  bonusPlanId: "habituee-bonus",
  durationDays: 30,
};

async function seedActiveKey(clientId: string, paidOrderId: string) {
  return keys.upsertKey({
    paidOrderId,
    clientId,
    wixContactId: "contact-1",
    wixMemberId: "member-1",
    mapping,
    startsAt: new Date(inHours(-1)),
    endsAt: new Date(inHours(30 * 24)),
    status: "ACTIVE",
  });
}

beforeAll(async () => {
  await migrate();
});

afterAll(async () => {
  await pool.end();
});

beforeEach(async () => {
  await truncateAll();
});

describe("Google review gate", () => {
  it("is a once-per-lifetime gate keyed by client", async () => {
    const client = await seedClient();
    await expect(keys.insertReviewGate(client.id, "order-a")).resolves.toBe(true);
    // A later early renewal must never create a second gate.
    await expect(keys.insertReviewGate(client.id, "order-b")).resolves.toBe(false);
    const gate = await keys.reviewGateForClient(client.id);
    expect(gate).toMatchObject({ plan_order_id: "order-a", activated_at: null });
  });

  it("hides review-locked invitations from redemption until activation", async () => {
    const client = await seedClient();
    const key = await seedActiveKey(client.id, "paid-locked");
    await keys.insertReviewGate(client.id, "paid-locked");
    await keys.createInvitationRights(key.id, 1, "PENDING_REVIEW");
    await keys.linkReviewGateKey(client.id, key.id);

    expect(await keys.availableInvitationForKey(key.id)).toBeNull();
    expect(await keys.hasPendingReviewInvitation([key.id])).toBe(true);

    const activated = await keys.activateReviewGate(client.id);
    expect(activated?.activated_at).toBeTruthy();
    expect(activated?.key_id).toBe(key.id);
    // A second screenshot is a no-op (atomic single winner).
    expect(await keys.activateReviewGate(client.id)).toBeNull();

    const unlocked = await keys.activatePendingInvitations(key.id);
    expect(unlocked).toBe(1);
    expect(await keys.hasPendingReviewInvitation([key.id])).toBe(false);
    expect(await keys.availableInvitationForKey(key.id)).not.toBeNull();
  });

  it("claims the post-payment review ask exactly once", async () => {
    const client = await seedClient();
    await keys.insertReviewGate(client.id, "paid-ask");
    const first = await keys.claimReviewAskSend("paid-ask");
    expect(first?.plan_order_id).toBe("paid-ask");
    // A duplicated webhook must not re-send the ask.
    expect(await keys.claimReviewAskSend("paid-ask")).toBeNull();
  });

  it("grants invitations immediately when the review landed before provisioning", async () => {
    const client = await seedClient();
    // Screenshot arrives while the renewal is still SCHEDULED (no key row yet).
    await keys.insertReviewGate(client.id, "paid-scheduled");
    const activated = await keys.activateReviewGate(client.id);
    expect(activated?.key_id).toBeNull();

    // Provisioning later sees an activated gate → invitations are born GRANTED.
    const key = await seedActiveKey(client.id, "paid-scheduled");
    await keys.createInvitationRights(key.id, 1, "GRANTED");
    await keys.linkReviewGateKey(client.id, key.id);

    expect(await keys.hasPendingReviewInvitation([key.id])).toBe(false);
    expect(await keys.availableInvitationForKey(key.id)).not.toBeNull();
  });

  it("locks every invitation of a Résidente early renewal together", async () => {
    const client = await seedClient();
    const key = await keys.upsertKey({
      paidOrderId: "paid-residente",
      clientId: client.id,
      wixMemberId: "member-1",
      mapping: { ...mapping, type: "RESIDENTE", durationDays: 60 },
      startsAt: new Date(inHours(-1)),
      endsAt: new Date(inHours(60 * 24)),
      status: "ACTIVE",
    });
    await keys.insertReviewGate(client.id, "paid-residente");
    await keys.createInvitationRights(key.id, 2, "PENDING_REVIEW");

    expect(await keys.availableInvitationForKey(key.id)).toBeNull();
    expect(await keys.activatePendingInvitations(key.id)).toBe(2);
  });
});
