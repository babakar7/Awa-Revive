import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../../src/server.js";
import { migrate, pool } from "../../src/db/index.js";
import { PACK_DISCOVERY_CAMPAIGN } from "../../src/domain/packDiscoveryCampaign.js";
import { makeFetchMock, seedClient, truncateAll, type FetchMock } from "./helpers.js";

const AUTH = `Basic ${Buffer.from("revive:revive@5000").toString("base64")}`;
let app: FastifyInstance;
let mock: FetchMock;

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
  mock.reset();
});

async function seedSilentLead(phone: string, name: string) {
  const client = await seedClient({ wa_phone: phone, name, language: "fr" });
  const wamid = `trigger-${phone}`;
  await pool.query(
    `insert into campaign_leads (client_id, campaign_key, trigger_message_id, matched_by)
     values ($1, $2, $3, 'meta_referral')`,
    [client.id, PACK_DISCOVERY_CAMPAIGN, wamid],
  );
  await pool.query(
    `insert into conversations (client_id, role, content, wa_message_id, created_at)
     values ($1, 'user', 'Bonjour, je veux réserver la clé invité', $2, now() - interval '4 hours')`,
    [client.id, wamid],
  );
  await pool.query(
    `insert into conversations (client_id, role, content, created_at)
     values ($1, 'assistant', 'pitch', now() - interval '210 minutes')`,
    [client.id],
  );
  return client;
}

describe("/admin/relances route (manual nudge)", () => {
  it("lists a candidate, sends on POST, and the lead drops off with history", async () => {
    const c = await seedSilentLead("221770005001", "Fatou");

    const list = await app.inject({
      method: "GET",
      url: "/admin/relances",
      headers: { authorization: AUTH, accept: "text/html" },
    });
    expect(list.statusCode).toBe(200);
    expect(list.body).toContain("Fatou");
    expect(list.body).toContain(`/admin/relances/${c.id}/send`);

    const send = await app.inject({
      method: "POST",
      url: `/admin/relances/${c.id}/send`,
      headers: { authorization: AUTH },
    });
    expect(send.statusCode).toBe(303);
    expect(send.headers.location).toBe("/admin/relances?sent=1");
    expect(mock.waTextsTo("221770005001")).toHaveLength(1);

    const after = await app.inject({
      method: "GET",
      url: "/admin/relances",
      headers: { authorization: AUTH, accept: "text/html" },
    });
    expect(after.body).not.toContain(`/admin/relances/${c.id}/send`);
    expect(after.body).toContain("Relance envoyée"); // history panel
  });

  it("skips a lead on POST without sending anything", async () => {
    const c = await seedSilentLead("221770005002", "Awa");
    const skip = await app.inject({
      method: "POST",
      url: `/admin/relances/${c.id}/skip`,
      headers: { authorization: AUTH },
    });
    expect(skip.statusCode).toBe(303);
    expect(skip.headers.location).toBe("/admin/relances?skip=1");
    expect(mock.waTextsTo("221770005002")).toHaveLength(0);

    const row = await pool.query(`select outcome from outbound_nudges where client_id = $1`, [c.id]);
    expect(row.rows[0].outcome).toBe("SUPPRESSED");
  });
});
