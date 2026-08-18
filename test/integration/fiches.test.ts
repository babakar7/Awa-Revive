import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../../src/server.js";
import { pool } from "../../src/db/index.js";
import {
  createFiche,
  deleteFiche,
  findRoleConflict,
  getFiche,
  getPublishedFicheByToken,
  lastFicheSendByPhone,
  markSent,
  publishFiche,
  regenerateToken,
  saveDraft,
  unpublishFiche,
} from "../../src/domain/ficheRepo.js";
import { recordFicheLog } from "../../src/domain/notificationRepo.js";

/**
 * Fiches de poste contre un vrai Postgres. Couvre exactement ce que les tests
 * purs ne peuvent PAS prouver : l'instantané publié, le refus d'envoyer un
 * brouillon au niveau de la route, le rattachement des logs à LA bonne fiche,
 * l'invalidation réelle d'un token, et l'uniformité des deux 404.
 */

const AUTH = `Basic ${Buffer.from("revive:revive@5000").toString("base64")}`;
let app: FastifyInstance;

beforeAll(async () => {
  app = buildServer();
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await pool.end();
});

beforeEach(async () => {
  await pool.query("delete from notification_log where source='fiche_poste'");
  await pool.query("delete from job_fiches");
  await pool.query("delete from staff_contacts");
});

const mk = (roleLabel = "Accueil", roleKeys = "accueil", body = "- Ouvrir le studio") =>
  createFiche({ roleLabel, roleKeys, body, by: "test" });

describe("instantané publié", () => {
  it("le lien public ne sert rien avant publication", async () => {
    const f = await mk();
    expect(await getPublishedFicheByToken(f.public_token)).toBeNull();

    const res = await app.inject({ method: "GET", url: `/fiche/${f.public_token}` });
    expect(res.statusCode).toBe(404);
  });

  it("publier fige les TROIS champs, et éditer le brouillon ne change pas la page publique", async () => {
    const f = await mk();
    expect(await publishFiche(f.id, "test")).toBe(true);

    await saveDraft(f.id, {
      roleLabel: "Gardien",
      roleKeys: "gardien",
      body: "- Texte tout neuf",
      by: "test",
    });

    const after = await getFiche(f.id);
    expect(after!.role_label).toBe("Gardien");
    expect(after!.role_keys).toBe("gardien");
    expect(after!.published_role_label).toBe("Accueil");
    expect(after!.published_role_keys).toBe("accueil");
    expect(after!.published_body).toBe("- Ouvrir le studio");

    const res = await app.inject({ method: "GET", url: `/fiche/${f.public_token}` });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("Ouvrir le studio");
    expect(res.body).not.toContain("Texte tout neuf");
    expect(res.body).toContain("<h1>Accueil</h1>");
  });

  it("refuse de publier un corps vide", async () => {
    const f = await mk("Accueil", "accueil", "   ");
    expect(await publishFiche(f.id, "test")).toBe(false);
    expect((await getFiche(f.id))!.published_body).toBeNull();
  });

  it("dépublier rend le MÊME 404 qu'un token inconnu", async () => {
    const f = await mk();
    await publishFiche(f.id, "test");
    await unpublishFiche(f.id, "test");

    const dep = await app.inject({ method: "GET", url: `/fiche/${f.public_token}` });
    const inconnu = await app.inject({
      method: "GET",
      url: "/fiche/ffffffffffffffffffffffffffffffff",
    });
    expect(dep.statusCode).toBe(404);
    expect(inconnu.statusCode).toBe(404);
    expect(dep.body).toBe(inconnu.body);
  });

  it("la page publique porte les en-têtes durcis, dont nosniff", async () => {
    const f = await mk();
    await publishFiche(f.id, "test");
    const res = await app.inject({ method: "GET", url: `/fiche/${f.public_token}` });
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["x-robots-tag"]).toContain("noindex");
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(String(res.headers["content-security-policy"])).toContain("form-action 'none'");
  });
});

describe("routes d'envoi", () => {
  it("refusent une fiche non publiée — le lien serait mort", async () => {
    const f = await mk();
    await pool.query(
      `insert into staff_contacts (name, phone, role, muted) values ('Fatou','+221771234567','accueil',false)`,
    );
    const res = await app.inject({
      method: "POST",
      url: `/admin/fiches/${f.id}/send`,
      headers: { authorization: AUTH, "content-type": "application/x-www-form-urlencoded" },
      payload: "",
    });
    expect(res.statusCode).toBe(303);
    expect(decodeURIComponent(String(res.headers.location))).toContain("publie la fiche");
    // aucun envoi journalisé
    const log = await pool.query(`select count(*) from notification_log where source='fiche_poste'`);
    expect(Number(log.rows[0].count)).toBe(0);
  });

  it("refusent quand aucun membre du rôle n'est joignable", async () => {
    const f = await mk();
    await publishFiche(f.id, "test");
    const res = await app.inject({
      method: "POST",
      url: `/admin/fiches/${f.id}/send`,
      headers: { authorization: AUTH, "content-type": "application/x-www-form-urlencoded" },
      payload: "",
    });
    expect(res.statusCode).toBe(303);
    expect(decodeURIComponent(String(res.headers.location))).toContain("aucun membre joignable");
  });

  it("ciblent les clés PUBLIÉES, pas le brouillon", async () => {
    const f = await mk("Accueil", "accueil");
    await publishFiche(f.id, "test");
    // clés basculées vers gardien SANS publier
    await saveDraft(f.id, {
      roleLabel: "Gardien",
      roleKeys: "gardien",
      body: "- Ouvrir le studio",
      by: "test",
    });
    await pool.query(
      `insert into staff_contacts (name, phone, role, muted)
       values ('Moussa','+221770000002','gardien',false)`,
    );
    const res = await app.inject({
      method: "POST",
      url: `/admin/fiches/${f.id}/send`,
      headers: { authorization: AUTH, "content-type": "application/x-www-form-urlencoded" },
      payload: "",
    });
    // Moussa est gardien : il ne relève PAS des clés publiées (accueil)
    expect(decodeURIComponent(String(res.headers.location))).toContain("aucun membre joignable");
  });
});

describe("journal rattaché à la bonne fiche", () => {
  it("lastFicheSendByPhone ne mélange jamais deux fiches", async () => {
    const a = await mk("Accueil", "accueil");
    const b = await mk("Bar", "bar");
    await recordFicheLog(a.id, "+221770000001", "[fiche Accueil] Fatou", "sent_template", null, "wamid.A");
    await recordFicheLog(b.id, "+221770000002", "[fiche Bar] Barman", "sent_template", null, "wamid.B");

    const forA = await lastFicheSendByPhone(a.id);
    expect([...forA.keys()]).toEqual(["221770000001"]);
    const forB = await lastFicheSendByPhone(b.id);
    expect([...forB.keys()]).toEqual(["221770000002"]);
  });

  it("garde le wa_message_id pour que le webhook puisse requalifier un échec", async () => {
    const f = await mk();
    await recordFicheLog(f.id, "+221770000001", "tag", "sent_template", null, "wamid.XYZ");
    const row = await pool.query(
      `select wa_message_id, job_fiche_id from notification_log where source='fiche_poste'`,
    );
    expect(row.rows[0].wa_message_id).toBe("wamid.XYZ");
    expect(row.rows[0].job_fiche_id).toBe(f.id);
  });

  it("retient le DERNIER envoi par personne", async () => {
    const f = await mk();
    await recordFicheLog(f.id, "+221770000001", "t1", "failed", "131047", "wamid.1");
    await recordFicheLog(f.id, "+221770000001", "t2", "sent_template", null, "wamid.2");
    const last = await lastFicheSendByPhone(f.id);
    expect(last.get("221770000001")!.status).toBe("sent_template");
  });
});

describe("rotation de lien", () => {
  it("invalide réellement l'ancien token", async () => {
    const f = await mk();
    await publishFiche(f.id, "test");
    const before = await app.inject({ method: "GET", url: `/fiche/${f.public_token}` });
    expect(before.statusCode).toBe(200);

    const fresh = await regenerateToken(f.id, "test");
    expect(fresh).toBeTruthy();
    expect(fresh).not.toBe(f.public_token);

    const old = await app.inject({ method: "GET", url: `/fiche/${f.public_token}` });
    expect(old.statusCode).toBe(404);
    const now = await app.inject({ method: "GET", url: `/fiche/${fresh}` });
    expect(now.statusCode).toBe(200);
  });
});

describe("garde-fous", () => {
  it("refuse deux fiches se disputant un rôle, même partiellement", async () => {
    await mk("Cuisine / Bar", "bar,cuisine");
    expect(await findRoleConflict("bar")).toMatchObject({ role_label: "Cuisine / Bar" });
    expect(await findRoleConflict("accueil")).toBeNull();
  });

  it("refuse de supprimer une fiche déjà envoyée", async () => {
    const f = await mk();
    await markSent(f.id, 3);
    expect(await deleteFiche(f.id)).toBe(false);
    expect(await getFiche(f.id)).not.toBeNull();
  });

  it("supprime une fiche jamais envoyée", async () => {
    const f = await mk();
    expect(await deleteFiche(f.id)).toBe(true);
    expect(await getFiche(f.id)).toBeNull();
  });

  it("ignore un uuid ou un token malformé sans exploser", async () => {
    expect(await getFiche("pas-un-uuid")).toBeNull();
    expect(await getPublishedFicheByToken("zz")).toBeNull();
    const res = await app.inject({ method: "GET", url: "/fiche/pas-un-token" });
    expect(res.statusCode).toBe(404);
  });
});
