import crypto from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../../src/server.js";
import { migrate, pool } from "../../src/db/index.js";
import { config } from "../../src/config.js";
import { handleInboundText } from "../../src/agent/index.js";
import { recordNoIntentTurn } from "../../src/domain/repo.js";
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
  it("closes on the third no-intent turn without calling the model, then stays silent", async () => {
    const client = await seedClient({ wa_phone: "221771234570", name: "Atueydjk" });
    await recordNoIntentTurn(client.id);
    await recordNoIntentTurn(client.id);

    await handleInboundText({
      waPhone: client.wa_phone,
      text: "[note vocale] ana petrol bi?",
      waMessageId: "wamid.no-intent-3",
    });
    await settle();

    const sent = mock.waTextsTo(client.wa_phone);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("assistante automatisée de Revive");
    const paused = (await pool.query(`select * from clients where id=$1`, [client.id])).rows[0];
    expect(paused.awa_no_intent_streak).toBe(3);
    expect(paused.awa_disengaged_kind).toBe("no_intent");

    await handleInboundText({
      waPhone: client.wa_phone,
      text: "What's up?",
      waMessageId: "wamid.no-intent-4",
    });
    await settle();
    expect(mock.waTextsTo(client.wa_phone)).toEqual(sent);
  });

  it("never trips the no-intent breaker mid-vente (activité de réservation récente)", async () => {
    const client = await seedClient({ wa_phone: "221771234571", name: "Maryeme" });
    // Une vente est en cours : un tool de réservation/vente dans l'heure.
    await pool.query(
      `insert into conversations (client_id, role, content) values ($1, 'tool', $2)`,
      [client.id, 'list_plans({}) -> [{"plan_id":"p1"}]'],
    );

    for (let i = 0; i < 4; i++) {
      const guard = await recordNoIntentTurn(client.id);
      expect(guard.disengaged).toBe(false);
    }
    const row = (await pool.query(`select awa_no_intent_streak, awa_disengaged_kind from clients where id=$1`, [client.id])).rows[0];
    expect(row.awa_no_intent_streak).toBe(0);
    expect(row.awa_disengaged_kind).toBeNull();
  });

  it("stores a WhatsApp profile name for the admin conversation without replacing an existing name", async () => {
    const unnamed = (await pool.query(
      `insert into clients (wa_phone, name, human_takeover_until)
       values ($1, null, now() + interval '1 hour') returning id, wa_phone`,
      ["221771234568"],
    )).rows[0];

    await handleInboundText({
      waPhone: unnamed.wa_phone,
      text: "Bonjour",
      waMessageId: "wamid.profile-name",
      profileName: "  Fatou Ndiaye  ",
    });

    expect((await pool.query(`select name from clients where id=$1`, [unnamed.id])).rows[0].name).toBe("Fatou Ndiaye");
    const conversations = await app.inject({ method: "GET", url: "/admin/conversations", headers: { authorization: AUTH } });
    expect(conversations.body).toContain("Fatou Ndiaye");

    const named = await seedClient({ wa_phone: "221771234569", name: "Fiche Wix" });
    await pool.query(`update clients set human_takeover_until = now() + interval '1 hour' where id=$1`, [named.id]);
    await handleInboundText({
      waPhone: named.wa_phone,
      text: "Bonjour",
      waMessageId: "wamid.profile-name-existing",
      profileName: "Nom WhatsApp",
    });
    expect((await pool.query(`select name from clients where id=$1`, [named.id])).rows[0].name).toBe("Fiche Wix");
  });

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
    const ownerPhone = config.OWNER_PHONE.replace(/\D/g, "");
    expect(
      mock.waCalls().some(
        (call) =>
          call.body?.to === ownerPhone &&
          JSON.stringify(call.body).includes("Nouveau message pendant un relais humain"),
      ),
    ).toBe(true);

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

describe("auto-close open interventions when a human takes over", () => {
  async function openHandoff(clientId: string, reason: string): Promise<string> {
    return (await pool.query(
      `insert into handoffs (client_id, reason) values ($1,$2) returning id`,
      [clientId, reason],
    )).rows[0].id;
  }
  async function openReview(clientId: string, summary: string): Promise<string> {
    return (await pool.query(
      `insert into conversation_reviews
         (client_id, last_message_at, outcome, need_category, severity, summary, status)
       values ($1, now(), 'unresolved_request', 'booking', 'normal', $2, 'OPEN') returning id`,
      [clientId, summary],
    )).rows[0].id;
  }
  const statusOf = async (table: string, id: string) =>
    (await pool.query(`select status, resolution_outcome, resolution_note, done_by from ${table} where id=$1`, [id])).rows[0];

  it("takeover closes the client's open handoff AND review as resolved", async () => {
    const client = await seedClient({ wa_phone: "221770000001", name: "Awa" });
    const h = await openHandoff(client.id, "Problème paiement OM");
    const r = await openReview(client.id, "Cliente sans réponse");

    const res = await post(`/admin/conversations/${client.id}/takeover`, {});
    expect(res.statusCode).toBe(303);

    const hs = await statusOf("handoffs", h);
    const rs = await statusOf("conversation_reviews", r);
    expect(hs.status).toBe("DONE");
    expect(hs.resolution_outcome).toBe("resolved");
    expect(hs.resolution_note).toContain("prise de relais");
    expect(rs.status).toBe("DONE");
    expect(rs.resolution_outcome).toBe("resolved");

    const audit = await pool.query(
      `select target_type from admin_audit_log where action='follow_up.auto_resolved' order by target_type`,
    );
    expect(audit.rows.map((x) => x.target_type)).toEqual(["conversation_reviews", "handoffs"]);
  });

  it("does not touch another client's open items", async () => {
    const a = await seedClient({ wa_phone: "221770000002", name: "A" });
    const b = await seedClient({ wa_phone: "221770000003", name: "B" });
    const hb = await openHandoff(b.id, "autre client");
    await post(`/admin/conversations/${a.id}/takeover`, {});
    expect((await statusOf("handoffs", hb)).status).toBe("OPEN");
  });

  it("a reply during a technical takeover (no manual takeover click) closes the handoff as contacted", async () => {
    const client = (await pool.query(
      `insert into clients (wa_phone, name, human_takeover_until, human_takeover_by, human_takeover_at)
       values ($1,$2, now() + interval '12 hours', 'awa-technical-failure', now()) returning id, wa_phone`,
      ["221770000004", "Tout"],
    )).rows[0];
    await pool.query(`insert into conversations (client_id, role, content) values ($1,'user','Bonjour')`, [client.id]);
    const h = await openHandoff(client.id, "Relais technique Awa");

    const res = await post(`/admin/conversations/${client.id}/reply`, {
      request_key: crypto.randomUUID(),
      mode: "text",
      body: "Bonjour, l'équipe Revive reprend votre demande.",
    });
    expect(res.statusCode).toBe(303);
    const hs = await statusOf("handoffs", h);
    expect(hs.status).toBe("DONE");
    expect(hs.resolution_outcome).toBe("contacted");
  });

  it("disengage closes open items as not_applicable", async () => {
    const client = await seedClient({ wa_phone: "221770000005", name: "Spam" });
    const h = await openHandoff(client.id, "contact douteux");
    await post(`/admin/conversations/${client.id}/disengage`, {});
    const hs = await statusOf("handoffs", h);
    expect(hs.status).toBe("DONE");
    expect(hs.resolution_outcome).toBe("not_applicable");
  });

  it("never rewrites an already-closed item", async () => {
    const client = await seedClient({ wa_phone: "221770000006", name: "Déjà" });
    const h = await openHandoff(client.id, "déjà traité");
    await post(`/admin/suivi/handoff/${h}/resolve`, { outcome: "contacted", note: "Manuel", next: "/admin/suivi" });
    const before = await statusOf("handoffs", h);

    await post(`/admin/conversations/${client.id}/takeover`, {});
    const after = await statusOf("handoffs", h);
    expect(after.resolution_outcome).toBe("contacted");
    expect(after.resolution_note).toBe("Manuel");
    expect(after.done_by).toBe(before.done_by);
  });
});
