import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../../src/server.js";
import { pool, migrate } from "../../src/db/index.js";
import { initCafeMenu } from "../../src/domain/cafeMenuRepo.js";
import { executeTool } from "../../src/agent/tools.js";
import * as repo from "../../src/domain/repo.js";
import * as commitments from "../../src/domain/commitments.js";
import {
  makeFetchMock,
  type FetchMock,
  deliverWaveWebhook,
  seedClient,
  waitForStatus,
  waitFor,
  settle,
  truncateAll,
  inHours,
} from "./helpers.js";

/**
 * End-to-end: create_payment_link commitment gating, then a verified Wave
 * webhook → BOOKED → the server's "session X/N — continue?" progress message
 * (replacing the café offer, with the account-linking button for an unlinked
 * client). This is the plan's headline verification.
 */

let app: FastifyInstance;
let mock: FetchMock;

beforeAll(async () => {
  await migrate();
  await initCafeMenu();
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

afterEach(async () => {
  await settle(500); // let the webhook's background fulfillment release locks
});

async function insertCommitment(clientId: string, count: number): Promise<string> {
  const res = await pool.query(
    `insert into multi_session_commitments (client_id, service_id, service_name, requested_count, status, expires_at)
     values ($1, 'svc_1', 'Pilates Reformer', $2, 'ACTIVE', $3) returning id`,
    [clientId, count, inHours(24 * 7)],
  );
  return res.rows[0].id;
}
async function insertItem(commitmentId: string, position: number): Promise<string> {
  const res = await pool.query(
    `insert into multi_session_commitment_items (commitment_id, position, event_id, slot_start, intent_status)
     values ($1, $2, 'ev_1', $3, 'PLANNED') returning id`,
    [commitmentId, position, inHours(24)],
  );
  return res.rows[0].id;
}

describe("create_payment_link commitment gating", () => {
  it("requires commitment_item_id for the plan's class, then links the attempt to the item", async () => {
    const client = await repo.upsertClient("221770000001");
    const commitmentId = await insertCommitment(client.id, 2);
    const item1 = await insertItem(commitmentId, 1);
    await insertItem(commitmentId, 2);

    // Cache the slot the model will reference (prompt-injection stance).
    await repo.cacheSlots(client.id, "svc_1", [
      { eventId: "ev_1", slot: { sessionId: "ev_1", serviceId: "svc_1", startDate: inHours(24), endDate: inHours(25) } },
    ]);

    // Without commitment_item_id → refused, and told which session to pay.
    const refused = JSON.parse(
      await executeTool(client, "create_payment_link", {
        service_id: "svc_1",
        event_id: "ev_1",
        slot_start: inHours(24),
        client_name: "Awa",
        payment_method: "wave",
      }),
    );
    expect(refused.error).toBe("commitment_item_required");
    expect(refused.commitment_item_id).toBe(item1);

    // With it → link created and the draft carries the commitment item.
    const ok = JSON.parse(
      await executeTool(client, "create_payment_link", {
        service_id: "svc_1",
        event_id: "ev_1",
        slot_start: inHours(24),
        client_name: "Awa",
        payment_method: "wave",
        commitment_item_id: item1,
      }),
    );
    expect(ok.payment_link).toBeTruthy();
    const draft = await pool.query(
      `select commitment_item_id from pending_bookings where client_id=$1 and status='AWAITING_PAYMENT'`,
      [client.id],
    );
    expect(draft.rows[0].commitment_item_id).toBe(item1);
  });
});

describe("Wave webhook → commitment progression", () => {
  it("books the session, sends 'X/N — continue?' with buttons, defers the café offer", async () => {
    const client = await repo.upsertClient("221770000001");
    const commitmentId = await insertCommitment(client.id, 3);
    const item1 = await insertItem(commitmentId, 1);
    await insertItem(commitmentId, 2);
    await insertItem(commitmentId, 3);

    // Seed a paid-pending booking tied to session 1 (as create_payment_link would).
    const bk = await pool.query(
      `insert into pending_bookings
         (client_id, service_id, service_name, event_id, slot_json, slot_start, slot_end,
          amount_xof, participants, status, wave_session_id, payment_link, link_expires_at, commitment_item_id)
       values ($1,'svc_1','Pilates Reformer','ev_1',$2,$3,$4,15000,1,'AWAITING_PAYMENT','cos-1','https://pay.wave.com/x',$5,$6)
       returning id`,
      [
        client.id,
        JSON.stringify({ sessionId: "ev_1", serviceId: "svc_1", startDate: inHours(24), endDate: inHours(25) }),
        inHours(24),
        inHours(25),
        inHours(1),
        item1,
      ],
    );
    const bookingId = bk.rows[0].id;

    const res = await deliverWaveWebhook(app, bookingId);
    expect(res.statusCode).toBe(200);
    await waitForStatus(bookingId, "BOOKED");

    // The "séance 1/3" progress message went out as an interactive button message.
    const progress = await waitFor(
      async () =>
        mock
          .waCalls()
          .find(
            (c) =>
              c.body?.type === "interactive" &&
              c.body?.interactive?.type === "button" &&
              String(c.body?.interactive?.body?.text ?? "").includes("1/3"),
          ) ?? null,
      "commitment progress message",
    );
    const buttonIds = progress.body.interactive.action.buttons.map((b: any) => b.reply.id);
    expect(buttonIds.some((id: string) => id.startsWith("ms_continue:"))).toBe(true);
    expect(buttonIds.some((id: string) => id.startsWith("ms_later:"))).toBe(true);
    // Unlinked client → the account-linking button rides along.
    expect(buttonIds.some((id: string) => id.startsWith("ms_link:"))).toBe(true);

    // Progress is server-owned: session 1 booked, plan still active.
    const snap = (await commitments.commitmentSnapshot(commitmentId))!;
    expect(snap.booked_count).toBe(1);
    expect(snap.commitment.status).toBe("ACTIVE");

    // The café offer is deferred while the plan is incomplete, and the linking
    // TEXT invite is NOT sent (it rode the button instead).
    const bodies = mock.waCalls().map((c) => JSON.stringify(c.body));
    expect(bodies.some((b) => b.includes("incontournables") || b.includes("accompagner"))).toBe(false);
    const texts = mock.waTextsTo("221770000001");
    expect(texts.some((t) => t.toLowerCase().includes("relie") || t.includes("compte"))).toBe(false);
  });
});
