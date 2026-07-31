import crypto from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../../src/server.js";
import { migrate, pool } from "../../src/db/index.js";
import { listClientsPage } from "../../src/admin/queries.js";
import { makeFetchMock, seedClient, truncateAll, type FetchMock } from "./helpers.js";

const AUTH = `Basic ${Buffer.from("revive:revive@5000").toString("base64")}`;
let app: FastifyInstance;
let mock: FetchMock;

async function message(clientId: string, role: "user" | "assistant", content: string, age = "0 days") {
  await pool.query(
    `insert into conversations (client_id, role, content, created_at)
     values ($1, $2, $3, now() - $4::interval)`,
    [clientId, role, content, age],
  );
}

async function teamMessage(clientId: string, body: string, status: "pending" | "sent" | "failed" = "pending", age = "0 days") {
  await pool.query(
    `insert into admin_outbound_messages (request_key, client_id, body, sent_by, status, created_at)
     values ($1, $2, $3, 'reception', $4, now() - $5::interval)`,
    [crypto.randomUUID(), clientId, body, status, age],
  );
}

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

describe("admin conversation keyword search", () => {
  it("uses the latest visible team reply for the list preview, count and ordering", async () => {
    const teamLatest = await seedClient({ name: "Réponse équipe récente" });
    const clientLatest = await seedClient({ wa_phone: "221770000002", name: "Message client récent" });
    await message(teamLatest.id, "user", "Ancien message du client", "3 hours");
    await teamMessage(teamLatest.id, "Tout dernier message manuel", "pending", "1 hour");
    await message(clientLatest.id, "user", "Message client intermédiaire", "2 hours");

    const result = await listClientsPage({});
    expect(result.rows[0]).toMatchObject({
      id: teamLatest.id,
      last_message: "Tout dernier message manuel",
      message_count: 2,
    });

    const response = await app.inject({ method: "GET", url: "/admin/conversations", headers: { authorization: AUTH } });
    expect(response.body).toContain("Tout dernier message manuel");
  });

  it("finds client, Awa and manual team messages, including pending and failed sends", async () => {
    const client = await seedClient({ name: "Contenu client" });
    const awa = await seedClient({ wa_phone: "221770000002", name: "Contenu Awa" });
    const pending = await seedClient({ wa_phone: "221770000003", name: "Équipe pending" });
    const failed = await seedClient({ wa_phone: "221770000004", name: "Équipe failed" });
    await message(client.id, "user", "Je souhaite un remboursement client");
    await message(awa.id, "assistant", "Votre tapis est disponible");
    await message(pending.id, "user", "Bonjour");
    await teamMessage(pending.id, "Réponse manuelle spéciale", "pending");
    await message(failed.id, "user", "Bonsoir");
    await teamMessage(failed.id, "Relance équipe introuvable", "failed");

    expect((await listClientsPage({ search: "remboursement" })).rows[0]).toMatchObject({ id: client.id, matched_source: "client" });
    expect((await listClientsPage({ search: "tapis" })).rows[0]).toMatchObject({ id: awa.id, matched_source: "awa" });
    expect((await listClientsPage({ search: "manuelle" })).rows[0]).toMatchObject({ id: pending.id, matched_source: "team" });
    expect((await listClientsPage({ search: "introuvable" })).rows[0]).toMatchObject({ id: failed.id, matched_source: "team" });
  });

  it("requires every term but allows them to occur in different messages", async () => {
    const complete = await seedClient({ name: "Complet" });
    const partial = await seedClient({ wa_phone: "221770000002", name: "Partiel" });
    await message(complete.id, "user", "Je cherche du pilates");
    await message(complete.id, "assistant", "Le créneau du matin est libre");
    await message(partial.id, "user", "Je cherche du pilates");

    const result = await listClientsPage({ search: "pilates matin" });
    expect(result.rows.map((row) => row.id)).toEqual([complete.id]);
  });

  it("is case/accent insensitive and never treats SQL wildcard characters as wildcards", async () => {
    const client = await seedClient({ name: "Élodie Ndiaye" });
    await message(client.id, "user", "CAFÉ réservé à 10h");

    expect((await listClientsPage({ search: "elodie" })).rows.map((row) => row.id)).toContain(client.id);
    expect((await listClientsPage({ search: "cafe RESERVE" })).rows.map((row) => row.id)).toContain(client.id);
    expect((await listClientsPage({ search: "%_?!" })).total).toBe(0);
  });

  it("applies the period to content matches and identity results", async () => {
    const oldContent = await seedClient({ name: "Ancien contenu" });
    const oldIdentity = await seedClient({ wa_phone: "221770000002", name: "Fatou ancienne" });
    const recent = await seedClient({ wa_phone: "221770000003", name: "Fatou récente" });
    await message(oldContent.id, "user", "mot historique", "40 days");
    await message(oldIdentity.id, "user", "Bonjour", "40 days");
    await message(recent.id, "user", "mot récent", "2 days");

    expect((await listClientsPage({ search: "historique", periodDays: 30 })).total).toBe(0);
    expect((await listClientsPage({ search: "fatou", periodDays: 30 })).rows.map((row) => row.id)).toEqual([recent.id]);
    expect((await listClientsPage({ search: "recent", periodDays: 7 })).rows.map((row) => row.id)).toEqual([recent.id]);
  });

  it("chooses the message with most terms, then the newest one", async () => {
    const client = await seedClient({ name: "Pertinence" });
    await message(client.id, "user", "pilates seulement", "1 hour");
    await message(client.id, "assistant", "pilates matin ensemble", "3 hours");
    await teamMessage(client.id, "pilates matin plus récent", "sent", "2 hours");

    const row = (await listClientsPage({ search: "pilates matin" })).rows[0];
    expect(row.matched_message).toBe("pilates matin plus récent");
    expect(row.matched_source).toBe("team");
  });

  it("renders a safe highlighted excerpt and preserves filters in links", async () => {
    await pool.query(
      `with inserted as (
         insert into clients (wa_phone, name)
         select '22178' || lpad(i::text, 7, '0'), 'Client ' || i
           from generate_series(0, 30) i
         returning id, name
       )
       insert into conversations (client_id, role, content)
       select id, 'user', '<img src=x onerror="bad"> RÉSERVATION ' || name from inserted`,
    );

    const response = await app.inject({
      method: "GET",
      url: "/admin/conversations?q=r%C3%A9servation&period=7&page=2",
      headers: { authorization: AUTH },
    });
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("<mark>RÉSERVATION</mark>");
    expect(response.body).toContain("&lt;img src=x onerror=&quot;bad&quot;&gt;");
    expect(response.body).not.toContain("<img src=x");
    expect(response.body).toContain("Client</span>");
    expect(response.body).toContain("q=r%C3%A9servation&period=7&page=1");
    expect(response.body).toContain('href="/admin/conversations?period=7">Effacer la recherche</a>');
  });

  it("keeps existing name and phone searches and returns an empty state", async () => {
    const client = await seedClient({ wa_phone: "221771234567", name: "Aminata Fall" });
    await message(client.id, "user", "Bonjour");

    expect((await listClientsPage({ search: "aminata" })).rows.map((row) => row.id)).toEqual([client.id]);
    expect((await listClientsPage({ search: "77 123" })).rows.map((row) => row.id)).toEqual([client.id]);
    const empty = await app.inject({ method: "GET", url: "/admin/conversations?q=absent", headers: { authorization: AUTH } });
    expect(empty.body).toContain("Aucun client trouvé");
  });
});
