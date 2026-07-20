import crypto from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../../src/server.js";
import { migrate, pool } from "../../src/db/index.js";
import { config } from "../../src/config.js";
import { handleInboundText } from "../../src/agent/index.js";
import { makeFetchMock, seedClient, settle, truncateAll, type FetchMock } from "./helpers.js";

const AUTH = `Basic ${Buffer.from("revive:revive@5000").toString("base64")}`;
const FORM = "application/x-www-form-urlencoded";
let app: FastifyInstance;
let mock: FetchMock;
const previousReplyFlag = config.ADMIN_HUMAN_REPLY_ENABLED;

beforeAll(async () => {
  await migrate();
  mock = makeFetchMock();
  mock.install();
  app = buildServer();
  await app.ready();
});

afterAll(async () => {
  config.ADMIN_HUMAN_REPLY_ENABLED = previousReplyFlag;
  mock.restore();
  await app.close();
  await pool.end();
});

beforeEach(async () => {
  await truncateAll();
  mock.reset();
  config.ADMIN_HUMAN_REPLY_ENABLED = true;
});

const post = (url: string, fields: Record<string, string>) => app.inject({
  method: "POST",
  url,
  headers: { authorization: AUTH, "content-type": FORM },
  payload: new URLSearchParams(fields).toString(),
});

describe("shared follow-up and human takeover", () => {
  it("resolves with an outcome, pauses Awa, sends idempotently, then resumes", async () => {
    const client = await seedClient({ wa_phone: "221771234567", name: "Maya" });
    await pool.query(
      `insert into conversations (client_id, role, content) values ($1,'user','Bonjour')`,
      [client.id],
    );
    const handoff = (await pool.query(
      `insert into handoffs (client_id, reason) values ($1,'Changer mon rendez-vous') returning id`,
      [client.id],
    )).rows[0];

    const followUp = await app.inject({ method: "GET", url: "/admin/suivi", headers: { authorization: AUTH } });
    expect(followUp.statusCode).toBe(200);
    expect(followUp.body).toContain("Changer mon rendez-vous");
    expect(followUp.body).toContain("Clore le suivi");

    const legacyClose = await post(`/admin/handoffs/${handoff.id}/done`, {});
    expect(legacyClose.statusCode).toBe(303);
    expect(legacyClose.headers.location).toContain("/admin/suivi?source=handoff&err=");
    expect((await pool.query(`select status from handoffs where id=$1`, [handoff.id])).rows[0].status).toBe("OPEN");

    const resolved = await post(`/admin/suivi/handoff/${handoff.id}/resolve`, {
      outcome: "contacted",
      note: "Appel effectué",
      next: `/admin/conversations/${client.id}`,
    });
    expect(resolved.statusCode).toBe(303);
    const closed = (await pool.query(`select * from handoffs where id=$1`, [handoff.id])).rows[0];
    expect(closed.resolution_outcome).toBe("contacted");
    expect(closed.resolution_note).toBe("Appel effectué");

    const takeover = await post(`/admin/conversations/${client.id}/takeover`, {});
    expect(takeover.statusCode).toBe(303);
    const takeoverRow = (await pool.query(`select * from clients where id=$1`, [client.id])).rows[0];
    expect(new Date(takeoverRow.human_takeover_until).getTime()).toBeGreaterThan(Date.now());

    await handleInboundText({
      waPhone: client.wa_phone,
      text: "Je suis disponible maintenant",
      waMessageId: "wamid.human-takeover",
    });
    await settle();
    expect(mock.waTextsTo(client.wa_phone)).toEqual([]);
    expect(Number((await pool.query(`select count(*) from conversations where client_id=$1 and role='user'`, [client.id])).rows[0].count)).toBe(2);

    const requestKey = crypto.randomUUID();
    const first = await post(`/admin/conversations/${client.id}/reply`, {
      request_key: requestKey,
      mode: "text",
      body: "Bonjour Maya, la réception prend le relais.",
    });
    const duplicate = await post(`/admin/conversations/${client.id}/reply`, {
      request_key: requestKey,
      mode: "text",
      body: "Bonjour Maya, la réception prend le relais.",
    });
    expect(first.statusCode).toBe(303);
    expect(duplicate.statusCode).toBe(303);
    expect(mock.waTextsTo(client.wa_phone)).toEqual(["Bonjour Maya, la réception prend le relais."]);
    expect(Number((await pool.query(`select count(*) from admin_outbound_messages where client_id=$1 and status='sent'`, [client.id])).rows[0].count)).toBe(1);

    const workspace = await app.inject({ method: "GET", url: `/admin/conversations/${client.id}`, headers: { authorization: AUTH } });
    expect(workspace.statusCode).toBe(200);
    expect(workspace.body).toContain("Espace client");
    expect(workspace.body).toContain("Relais humain actif");
    expect(workspace.body).toContain("la réception prend le relais");

    const report = await app.inject({ method: "GET", url: "/admin/rapport?period=7", headers: { authorization: AUTH } });
    expect(report.statusCode).toBe(200);
    expect(report.body).toContain("Rapport du studio");
    expect(report.body).toContain("Encaissements enregistrés");

    await post(`/admin/conversations/${client.id}/resume`, {});
    const resumed = (await pool.query(`select human_takeover_until from clients where id=$1`, [client.id])).rows[0];
    expect(resumed.human_takeover_until).toBeNull();
    expect(Number((await pool.query(`select count(*) from admin_audit_log`)).rows[0].count)).toBeGreaterThan(0);
  });
});
