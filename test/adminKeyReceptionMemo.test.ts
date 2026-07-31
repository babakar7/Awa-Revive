import { describe, expect, it } from "vitest";
import Fastify from "fastify";
import { config } from "../src/config.js";
import { renderKeyReceptionMemo } from "../src/admin/keyReceptionMemoPage.js";
import { layout } from "../src/admin/layout.js";
import { emptyNavBadges } from "../src/admin/navBadges.js";
import { registerAdmin } from "../src/admin/routes.js";

describe("Clés de la Maison — mémo réception", () => {
  it("renders every operational rule and the non-duplication guard", () => {
    const html = renderKeyReceptionMemo();

    expect(html).toContain("Vente d’une Clé");
    expect(html).toContain("uniquement la Clé payante");
    expect(html).toContain("Aquabike, Yoga, Mat ou Step");
    expect(html).toContain("1 pour L’Invitée et L’Habituée · 2 pour La Résidente");
    expect(html).toContain("Toute invitation passe par Awa/Resabot");
    expect(html).toContain("Amie n’ayant jamais fait de Reformer chez Revive — ses autres venues ne bloquent pas");
    expect(html).not.toContain("Amie jamais venue chez Revive");
    expect(html).toContain("Reformer à 12h30, du lundi au vendredi");
    expect(html).toContain("Prolongation de 7 jours");
    expect(html).toContain("avant la fin de la journée de la première séance");
    expect(html).toContain("Membres Fondatrices");
    expect(html).toContain("programmes gratuits Ambassadrice et Invitation");
    expect(html).toContain("ne rien créer en double dans Wix");
  });

  it("keeps the memo read-only and offers register and print actions", () => {
    const html = renderKeyReceptionMemo();

    expect(html).toContain('href="/admin/cles"');
    expect(html).toContain('onclick="window.print()"');
    expect(html).not.toContain("<form");
    expect(html).not.toContain('method="post"');
  });

  it("is reachable from the Clés navigation and marks that section active", async () => {
    const html = await layout(
      "Clés de la Maison",
      "/admin/cles",
      renderKeyReceptionMemo(),
      { badges: emptyNavBadges },
    );

    expect(html).toContain('href="/admin/cles" class="nav-link active"');
    expect(html).toContain("Clés de la Maison");
    expect(html).toContain("@media print");
  });

  it("serves the memo route to a reception team account without querying the registry", async () => {
    const previousUsers = config.ADMIN_USERS;
    config.ADMIN_USERS = "reception:memo-secret";
    const app = Fastify({ logger: false });
    registerAdmin(app);
    try {
      await app.ready();
      const authorization = `Basic ${Buffer.from("reception:memo-secret").toString("base64")}`;
      const response = await app.inject({
        method: "GET",
        url: "/admin/cles/memo",
        headers: { authorization },
      });

      expect(response.statusCode).toBe(200);
      expect(response.headers["content-type"]).toContain("text/html");
      expect(response.body).toContain("Mémo réception");
      expect(response.body).toContain("ne rien créer en double dans Wix");
    } finally {
      config.ADMIN_USERS = previousUsers;
      await app.close();
    }
  });
});
