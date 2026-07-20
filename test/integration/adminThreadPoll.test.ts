import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../../src/server.js";
import { migrate, pool } from "../../src/db/index.js";
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
});

describe("GET /admin/conversations/:clientId/thread — live polling fragment", () => {
  it("requires auth (the JSON poller gets 401, not a login redirect)", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/admin/conversations/x/thread",
      headers: { accept: "application/json" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("404 on unknown client", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/admin/conversations/00000000-0000-4000-8000-000000000000/thread",
      headers: { authorization: AUTH },
    });
    expect(res.statusCode).toBe(404);
  });

  it("returns html on first call, null when sig unchanged, fresh html after a new message", async () => {
    const client = await seedClient({ wa_phone: "221771230001", name: "Maya" });
    await pool.query(`insert into conversations (client_id, role, content) values ($1,'user','Bonjour Awa')`, [client.id]);

    const first = await app.inject({
      method: "GET",
      url: `/admin/conversations/${client.id}/thread`,
      headers: { authorization: AUTH },
    });
    expect(first.statusCode).toBe(200);
    const body1 = first.json() as { sig: string; html: string | null };
    expect(body1.sig).toBeTruthy();
    expect(body1.html).toContain("Bonjour Awa");

    const unchanged = await app.inject({
      method: "GET",
      url: `/admin/conversations/${client.id}/thread?sig=${body1.sig}`,
      headers: { authorization: AUTH },
    });
    expect(unchanged.json()).toEqual({ sig: body1.sig, html: null });

    await pool.query(
      `insert into conversations (client_id, role, content, created_at) values ($1,'assistant','Bienvenue chez Revive', now() + interval '1 second')`,
      [client.id],
    );
    const updated = await app.inject({
      method: "GET",
      url: `/admin/conversations/${client.id}/thread?sig=${body1.sig}`,
      headers: { authorization: AUTH },
    });
    const body2 = updated.json() as { sig: string; html: string | null };
    expect(body2.sig).not.toBe(body1.sig);
    expect(body2.html).toContain("Bienvenue chez Revive");
  });

  it("sig changes when an admin outbound flips from pending to sent", async () => {
    const client = await seedClient({ wa_phone: "221771230002", name: "Awa Test" });
    const outbound = await pool.query(
      `insert into admin_outbound_messages (request_key, client_id, body, sent_by) values ('11111111-1111-4111-8111-111111111111',$1,'Réponse équipe','revive') returning id`,
      [client.id],
    );

    const pending = await app.inject({
      method: "GET",
      url: `/admin/conversations/${client.id}/thread`,
      headers: { authorization: AUTH },
    });
    const bodyPending = pending.json() as { sig: string; html: string | null };
    expect(bodyPending.html).toContain("Envoi…");

    await pool.query(`update admin_outbound_messages set status='sent', sent_at=now() where id=$1`, [outbound.rows[0].id]);
    const sent = await app.inject({
      method: "GET",
      url: `/admin/conversations/${client.id}/thread?sig=${bodyPending.sig}`,
      headers: { authorization: AUTH },
    });
    const bodySent = sent.json() as { sig: string; html: string | null };
    expect(bodySent.sig).not.toBe(bodyPending.sig);
    expect(bodySent.html).not.toContain("Envoi…");
  });

  it("the conversation page embeds the polling script and the thread anchor", async () => {
    const client = await seedClient({ wa_phone: "221771230003" });
    const page = await app.inject({
      method: "GET",
      url: `/admin/conversations/${client.id}`,
      headers: { authorization: AUTH },
    });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('id="thread"');
    expect(page.body).toContain(`/admin/conversations/${client.id}/thread`);
  });
});
