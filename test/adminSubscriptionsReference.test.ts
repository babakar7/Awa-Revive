import { describe, expect, it } from "vitest";
import Fastify from "fastify";
import { config } from "../src/config.js";
import { renderSubscriptionsReference } from "../src/admin/subscriptionsReferencePage.js";
import { layout } from "../src/admin/layout.js";
import { emptyNavBadges } from "../src/admin/navBadges.js";
import { registerAdmin } from "../src/admin/routes.js";

describe("Abonnements — référence réception", () => {
  it("renders every operational rule and the non-duplication guard", () => {
    const html = renderSubscriptionsReference();

    expect(html).toContain("Vente d’une Clé");
    expect(html).toContain("uniquement la Clé payante");
    expect(html).toContain("Aquabike, Yoga, Mat ou Step");
    expect(html).toContain("1 pour L’Invitée et L’Habituée · 2 pour La Résidente");
    expect(html).toContain("Toute invitation passe par Awa/Resabot");
    expect(html).toContain("Amie n’ayant jamais fait de Reformer chez Revive — ses autres venues ne bloquent pas");
    expect(html).toContain("Reformer sur un créneau calme — 8h15, 9h15 ou 12h30 — du lundi au vendredi");
    expect(html).toContain("le 7h15 n’est pas ouvert aux invitations");
    expect(html).toContain("1 invitation Reformer (8h15, 9h15 ou 12h30, lun–ven)");
    expect(html).toContain("Prolongation de 7 jours");
    expect(html).toContain("Membres Fondatrices");
    expect(html).toContain("Carnet de 10 Bébé nageur et Natation — 70 000 F");
    // Tailor-made plans, each with its own pool perk wording.
    expect(html).toContain("1x Reformer · 1x Mat · 1x Step");
    expect(html).toContain("2x Reformer · 1x Yoga · 1x Step");
    expect(html).toContain("2x Reformer · 1x Step");
    expect(html).toContain("148 000 F · 16 séances · 30 j");
    expect(html).toContain("120 000 F · 12 séances · 30 j");
    expect(html).toContain("Accès piscine pendant toute la durée de la formule");
    expect(html).not.toContain("Carnet de 10 Reformer");
    expect(html).not.toContain("Carnet de 10 Aquabike");
    expect(html).toContain("ne rien créer en double dans Wix");
  });

  it("keeps the reference read-only and offers register and print actions", () => {
    const html = renderSubscriptionsReference();

    expect(html).toContain('href="/admin/abonnements"');
    expect(html).toContain('onclick="window.print()"');
    expect(html).not.toContain("<form");
    expect(html).not.toContain('method="post"');
  });

  it("is reachable from the Abonnements navigation and marks that section active", async () => {
    const html = await layout(
      "Abonnements",
      "/admin/abonnements",
      renderSubscriptionsReference(),
      { badges: emptyNavBadges },
    );

    expect(html).toContain('href="/admin/abonnements" class="nav-link active"');
    expect(html).toContain("Abonnements");
    expect(html).toContain("@media print");
  });

  it("serves the reference route and redirects the old /admin/cles URLs", async () => {
    const previousUsers = config.ADMIN_USERS;
    config.ADMIN_USERS = "reception:memo-secret";
    const app = Fastify({ logger: false });
    registerAdmin(app);
    try {
      await app.ready();
      const authorization = `Basic ${Buffer.from("reception:memo-secret").toString("base64")}`;

      const memo = await app.inject({
        method: "GET",
        url: "/admin/abonnements/memo",
        headers: { authorization },
      });
      expect(memo.statusCode).toBe(200);
      expect(memo.headers["content-type"]).toContain("text/html");
      expect(memo.body).toContain("Référence réception");
      expect(memo.body).toContain("ne rien créer en double dans Wix");

      // Old URLs 301-redirect to the renamed section.
      const oldMemo = await app.inject({
        method: "GET",
        url: "/admin/cles/memo",
        headers: { authorization },
      });
      expect(oldMemo.statusCode).toBe(301);
      expect(oldMemo.headers.location).toBe("/admin/abonnements/memo");

      const oldRegistry = await app.inject({
        method: "GET",
        url: "/admin/cles",
        headers: { authorization },
      });
      expect(oldRegistry.statusCode).toBe(301);
      expect(oldRegistry.headers.location).toBe("/admin/abonnements");
    } finally {
      config.ADMIN_USERS = previousUsers;
      await app.close();
    }
  });
});
