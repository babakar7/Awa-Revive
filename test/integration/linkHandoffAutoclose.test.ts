import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { pool } from "../../src/db/index.js";
import * as links from "../../src/domain/linkRequests.js";
import { recordHandoff } from "../../src/domain/repo.js";
import { seedClient, truncateAll } from "./helpers.js";

/**
 * La résolution d'une demande de liaison (code accepté, liaison admin, ou
 * « Ignorer » dans /admin/crm) doit fermer le handoff « Compte non relié »
 * qu'avait ouvert le sweep 30 min — sinon la pastille « intervention
 * humaine » survit pour toujours à une situation réglée (Aida Fall &
 * Charles Gomis, 07/08).
 */

const LINK_REASON =
  "Compte non relié — liaison/création à finaliser (client silencieux — vérification email jamais terminée)";
const OTHER_REASON = "Demande de remboursement — à traiter par la réception";


afterAll(async () => {
  await pool.end();
});

beforeEach(async () => {
  await truncateAll();
});

async function seedRequestWithHandoffs(phone: string) {
  const client = await seedClient({ wa_phone: phone });
  const request = await links.getOrOpen(client.id);
  await links.setAwaitingCode(
    request.id,
    "client@example.com",
    null,
    links.hashCode("123456", request.id),
    "Test Client",
  );
  await recordHandoff(client.id, LINK_REASON);
  await recordHandoff(client.id, OTHER_REASON);
  return { client, request };
}

async function handoffRows(clientId: string) {
  const res = await pool.query(
    `select reason, status, done_by from handoffs where client_id = $1 order by created_at`,
    [clientId],
  );
  return res.rows as { reason: string; status: string; done_by: string | null }[];
}

describe("auto-fermeture des handoffs « Compte non relié »", () => {
  it("markVerified ferme le handoff de liaison (done_by auto) sans toucher aux autres", async () => {
    const { client, request } = await seedRequestWithHandoffs("221770000101");
    await links.markVerified(request.id, "wix-contact-1");

    const rows = await handoffRows(client.id);
    expect(rows.find((r) => r.reason === LINK_REASON)).toMatchObject({
      status: "DONE",
      done_by: "auto",
    });
    expect(rows.find((r) => r.reason === OTHER_REASON)).toMatchObject({
      status: "OPEN",
      done_by: null,
    });
  });

  it("markLinked (liaison admin depuis /admin/crm) ferme aussi le handoff", async () => {
    const { client, request } = await seedRequestWithHandoffs("221770000102");
    await links.markLinked(request.id, "wix-contact-2", "reception");

    const rows = await handoffRows(client.id);
    expect(rows.find((r) => r.reason === LINK_REASON)).toMatchObject({
      status: "DONE",
      done_by: "reception",
    });
  });

  it("dismiss (« Ignorer » dans /admin/crm) ferme aussi le handoff — cas Charles Gomis", async () => {
    const { client, request } = await seedRequestWithHandoffs("221770000103");
    await links.dismiss(request.id, "owner");

    const rows = await handoffRows(client.id);
    expect(rows.find((r) => r.reason === LINK_REASON)).toMatchObject({
      status: "DONE",
      done_by: "owner",
    });
    expect(rows.find((r) => r.reason === OTHER_REASON)?.status).toBe("OPEN");
  });

  it("ne touche jamais un handoff de liaison déjà traité à la main", async () => {
    const { client, request } = await seedRequestWithHandoffs("221770000104");
    await pool.query(
      `update handoffs set status = 'DONE', done_by = 'meryl', done_at = now()
        where client_id = $1 and reason = $2`,
      [client.id, LINK_REASON],
    );
    await links.markVerified(request.id, "wix-contact-3");

    const rows = await handoffRows(client.id);
    expect(rows.find((r) => r.reason === LINK_REASON)?.done_by).toBe("meryl");
  });
});
