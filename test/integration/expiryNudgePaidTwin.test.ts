import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { migrate, pool } from "../../src/db/index.js";
import { expiredLinksToNudge, expiredPlanOrdersToNudge } from "../../src/domain/repo.js";
import { seedClient, truncateAll } from "./helpers.js";

/**
 * Paid-twin guard on the expiry nudges (Khadija 14/08): a client who taps two
 * payment buttons gets twin pending orders; if she pays the OLDER twin, the
 * newer one expires and used to nudge "payment not received" minutes after her
 * ✅ confirmation — scaring her into a needless reception handoff. Any sibling
 * paid after the expired link was created must keep the sweep silent.
 */

beforeAll(async () => {
  await migrate();
});

afterAll(async () => {
  await pool.end();
});

beforeEach(async () => {
  await truncateAll();
});

const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000);
const inMinutes = (m: number) => new Date(Date.now() + m * 60_000);

async function insertPlanOrder(
  clientId: string,
  opts: Partial<{
    status: string;
    paidAt: Date | null;
    createdAt: Date;
    linkExpiresAt: Date;
  }> = {},
): Promise<string> {
  const res = await pool.query(
    `insert into pending_plan_orders
       (client_id, plan_id, plan_name, amount_xof, status, is_key,
        payment_link, link_expires_at, paid_at, created_at, updated_at)
     values ($1, 'plan-invitee', 'L''Invitée — Clé 3 séances', 30000, $2, true,
             'https://pay.example/x', $3, $4, $5, now())
     returning id`,
    [
      clientId,
      opts.status ?? "EXPIRED",
      opts.linkExpiresAt ?? minutesAgo(5),
      opts.paidAt ?? null,
      opts.createdAt ?? minutesAgo(25),
    ],
  );
  return res.rows[0].id;
}

async function insertBooking(
  clientId: string,
  opts: Partial<{ status: string; createdAt: Date; linkExpiresAt: Date; slotStart: Date }> = {},
): Promise<string> {
  const res = await pool.query(
    `insert into pending_bookings
       (client_id, service_id, service_name, event_id, slot_start, amount_xof,
        status, payment_link, link_expires_at, created_at, updated_at)
     values ($1, 'svc-1', 'Pilates Reformer (Foundation)', 'evt-1', $2, 12000,
             $3, 'https://pay.example/b', $4, $5, now())
     returning id`,
    [
      clientId,
      opts.slotStart ?? inMinutes(48 * 60),
      opts.status ?? "EXPIRED",
      opts.linkExpiresAt ?? minutesAgo(5),
      opts.createdAt ?? minutesAgo(25),
    ],
  );
  return res.rows[0].id;
}

describe("expiredPlanOrdersToNudge — paid-twin guard", () => {
  it("still nudges a genuinely abandoned expired plan link", async () => {
    const client = await seedClient();
    const id = await insertPlanOrder(client.id);
    expect((await expiredPlanOrdersToNudge()).map((o) => o.id)).toEqual([id]);
  });

  it("stays silent when an OLDER twin order was paid after this link was created (Khadija)", async () => {
    const client = await seedClient();
    // Wave twin: created FIRST, paid 3 minutes after the OM twin was created.
    await insertPlanOrder(client.id, {
      status: "ACTIVATED",
      createdAt: minutesAgo(27),
      paidAt: minutesAgo(23),
      linkExpiresAt: inMinutes(60),
    });
    // OM twin: created second, never paid, just expired → used to fire the nudge.
    await insertPlanOrder(client.id, { createdAt: minutesAgo(26) });
    expect(await expiredPlanOrdersToNudge()).toEqual([]);
  });

  it("stays silent when the client paid a class booking after the plan link was created", async () => {
    const client = await seedClient();
    await insertBooking(client.id, { status: "BOOKED", createdAt: minutesAgo(40) });
    await insertPlanOrder(client.id, { createdAt: minutesAgo(25) });
    expect(await expiredPlanOrdersToNudge()).toEqual([]);
  });

  it("still nudges when the only paid order predates this link (old purchase, new abandoned link)", async () => {
    const client = await seedClient();
    // A plan paid last week must not silence a genuinely abandoned new link.
    await insertPlanOrder(client.id, {
      status: "ACTIVATED",
      createdAt: minutesAgo(7 * 24 * 60),
      paidAt: minutesAgo(7 * 24 * 60 - 5),
      linkExpiresAt: minutesAgo(7 * 24 * 60 - 20),
    });
    const id = await insertPlanOrder(client.id, { createdAt: minutesAgo(25) });
    expect((await expiredPlanOrdersToNudge()).map((o) => o.id)).toEqual([id]);
  });
});

describe("expiredLinksToNudge — paid-twin guard", () => {
  it("still nudges a genuinely abandoned expired booking link", async () => {
    const client = await seedClient();
    const id = await insertBooking(client.id);
    expect((await expiredLinksToNudge()).map((b) => b.id)).toEqual([id]);
  });

  it("stays silent when an older sibling booking got paid after this link was created", async () => {
    const client = await seedClient();
    await insertBooking(client.id, { status: "BOOKED", createdAt: minutesAgo(30) });
    await insertBooking(client.id, { createdAt: minutesAgo(25) });
    expect(await expiredLinksToNudge()).toEqual([]);
  });

  it("stays silent when a plan order got paid after this booking link was created", async () => {
    const client = await seedClient();
    await insertPlanOrder(client.id, {
      status: "ACTIVATED",
      createdAt: minutesAgo(30),
      paidAt: minutesAgo(20),
      linkExpiresAt: inMinutes(60),
    });
    await insertBooking(client.id, { createdAt: minutesAgo(25) });
    expect(await expiredLinksToNudge()).toEqual([]);
  });
});
