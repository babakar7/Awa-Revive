import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { migrate, pool } from "../../src/db/index.js";
import * as links from "../../src/domain/linkRequests.js";
import {
  AUTO_LINKED_BY,
  completeStaleCreateAccountRequests,
  type UnverifiedAccountDeps,
} from "../../src/domain/unverifiedAccounts.js";
import { recordHandoff } from "../../src/domain/repo.js";
import { seedClient, truncateAll } from "./helpers.js";

/**
 * Repli « compte créé sans vérification » (Babakar 08/08, cas Marouche) : une
 * demande de CRÉATION silencieuse depuis 30 min devient un vrai compte, la
 * cliente est prévenue qu'elle peut finir sa réservation, et l'achat de plan
 * suivant ne redemande pas de vérification. La voie LIAISON d'un compte
 * existant, elle, reste escaladée à la réception (anti-usurpation).
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

function makeDeps(overrides: Partial<UnverifiedAccountDeps> = {}) {
  const calls: { contacts: any[]; sends: { to: string; body: string }[] } = {
    contacts: [],
    sends: [],
  };
  const deps: UnverifiedAccountDeps = {
    createContact: async (args) => {
      calls.contacts.push(args);
      return "wix-contact-new";
    },
    send: async (to, body) => {
      calls.sends.push({ to, body });
      return "wamid.test";
    },
    ...overrides,
  };
  return { deps, calls };
}

async function seedStaleRequest(args: {
  phone: string;
  wixContactId?: string | null;
  claimedName?: string | null;
  staleMinutes?: number;
}) {
  const client = await seedClient({ wa_phone: args.phone });
  const request = await links.getOrOpen(client.id);
  await links.setAwaitingCode(
    request.id,
    "marouche@example.com",
    args.wixContactId ?? null,
    links.hashCode("123456", request.id),
    args.claimedName === undefined ? "Marouche Diop" : args.claimedName,
  );
  await pool.query(
    `update link_requests set updated_at = now() - ($2 || ' minutes')::interval where id = $1`,
    [request.id, String(args.staleMinutes ?? links.STALE_AFTER_MINUTES + 5)],
  );
  return { client, request };
}

describe("completeStaleCreateAccountRequests", () => {
  it("crée le compte, marque LINKED (auto-sans-verification) et prévient la cliente", async () => {
    const { client, request } = await seedStaleRequest({ phone: "221770000201" });
    const { deps, calls } = makeDeps();

    const created = await completeStaleCreateAccountRequests(deps);

    expect(created).toBe(1);
    expect(calls.contacts).toEqual([
      { name: "Marouche Diop", phone: "+221770000201", email: "marouche@example.com" },
    ]);
    const { rows } = await pool.query(`select * from link_requests where id = $1`, [request.id]);
    expect(rows[0]).toMatchObject({
      status: "LINKED",
      linked_contact_id: "wix-contact-new",
      linked_by: AUTO_LINKED_BY,
    });
    expect(calls.sends).toHaveLength(1);
    expect(calls.sends[0].to).toBe("221770000201");
    expect(calls.sends[0].body).toContain("marouche@example.com");
    expect(calls.sends[0].body).toContain("pas besoin de");
    const turns = await pool.query(
      `select role, content from conversations where client_id = $1`,
      [client.id],
    );
    expect(turns.rows).toHaveLength(1);
    expect(turns.rows[0].role).toBe("assistant");
    // La preuve durable est visible du flux d'achat de plan.
    expect(await links.latestProvenLinkRequest(client.id)).not.toBeNull();
  });

  it("ferme le handoff « Compte non relié » ouvert par une escalade précédente", async () => {
    const { client } = await seedStaleRequest({ phone: "221770000202" });
    await recordHandoff(
      client.id,
      "Compte non relié — liaison/création à finaliser (client silencieux — vérification email jamais terminée)",
    );
    const { deps } = makeDeps();

    await completeStaleCreateAccountRequests(deps);

    const { rows } = await pool.query(
      `select status, done_by from handoffs where client_id = $1`,
      [client.id],
    );
    expect(rows[0]).toMatchObject({ status: "DONE", done_by: AUTO_LINKED_BY });
  });

  it("ne touche JAMAIS la liaison d'un compte EXISTANT (anti-usurpation)", async () => {
    const { request } = await seedStaleRequest({
      phone: "221770000203",
      wixContactId: "existing-fiche",
    });
    const { deps, calls } = makeDeps();

    const created = await completeStaleCreateAccountRequests(deps);

    expect(created).toBe(0);
    expect(calls.contacts).toHaveLength(0);
    const { rows } = await pool.query(`select status from link_requests where id = $1`, [request.id]);
    expect(rows[0].status).toBe("AWAITING_CODE"); // escalateStaleLinkRequests s'en chargera
  });

  it("ignore les demandes encore fraîches", async () => {
    await seedStaleRequest({ phone: "221770000204", staleMinutes: 5 });
    const { deps, calls } = makeDeps();

    expect(await completeStaleCreateAccountRequests(deps)).toBe(0);
    expect(calls.contacts).toHaveLength(0);
  });

  it("échec Wix → retour au repli réception, sans message client", async () => {
    const { request } = await seedStaleRequest({ phone: "221770000205" });
    const { deps, calls } = makeDeps({
      createContact: async () => {
        throw new Error("wix down");
      },
    });

    const created = await completeStaleCreateAccountRequests(deps);

    expect(created).toBe(0);
    expect(calls.sends).toHaveLength(0);
    const { rows } = await pool.query(`select status, detail from link_requests where id = $1`, [request.id]);
    expect(rows[0].status).toBe("NEEDS_RECEPTION");
    expect(rows[0].detail).toContain("création sans vérification en échec");
  });

  it("le compte est créé une seule fois même si la passe se répète", async () => {
    await seedStaleRequest({ phone: "221770000206" });
    const { deps, calls } = makeDeps();

    expect(await completeStaleCreateAccountRequests(deps)).toBe(1);
    expect(await completeStaleCreateAccountRequests(deps)).toBe(0);
    expect(calls.contacts).toHaveLength(1);
    expect(calls.sends).toHaveLength(1);
  });
});
