import { describe, expect, it } from "vitest";
import { fichesBanner, renderFichesPage, type FichesPageData } from "../src/admin/fichesPage.js";
import type { JobFiche } from "../src/domain/ficheRepo.js";
import type { StaffContact } from "../src/domain/notificationRepo.js";

const fiche = (o: Partial<JobFiche> = {}): JobFiche => ({
  id: "11111111-1111-4111-8111-111111111111",
  role_label: "Accueil",
  role_keys: "accueil",
  body: "- Ouvrir le studio",
  published_role_label: "Accueil",
  published_role_keys: "accueil",
  published_body: "- Ouvrir le studio",
  published_at: new Date("2026-08-12T10:00:00Z"),
  public_token: "0123456789abcdef0123456789abcdef",
  token_rotated_at: null,
  last_sent_at: null,
  last_sent_count: 0,
  updated_at: new Date("2026-08-12T10:00:00Z"),
  updated_by: "babakar",
  created_at: new Date("2026-08-01T10:00:00Z"),
  ...o,
});

const contact = (name: string, extra: Partial<StaffContact> = {}): StaffContact => ({
  id: name.toLowerCase(),
  name,
  phone: "+221771234567",
  role: "accueil",
  muted: false,
  ...extra,
});

const page = (o: Partial<FichesPageData> = {}): string =>
  renderFichesPage({
    cards: [],
    knownRoles: ["accueil", "bar"],
    rolesWithoutFiche: [],
    templateConfigured: true,
    banner: "",
    ...o,
  });

const card = (f: JobFiche, targets: StaffContact[] = [], extra = {}) => ({
  fiche: f,
  recipients: { targets, noPhone: [], muted: [], ...extra },
  lastSends: new Map(),
  url: "https://x.tld/fiche/0123456789abcdef0123456789abcdef",
});

describe("renderFichesPage", () => {
  it("affiche un état vide explicite", () => {
    expect(page()).toContain("Aucune fiche de poste");
  });

  it("montre le lien de l'équipe en entier pour qu'une BASE_URL fausse saute aux yeux", () => {
    const html = page({ cards: [card(fiche(), [contact("Fatou")])] });
    expect(html).toContain("https://x.tld/fiche/0123456789abcdef0123456789abcdef");
  });

  it("liste les destinataires et le bouton d'envoi actif", () => {
    const html = page({ cards: [card(fiche(), [contact("Fatou"), contact("Awa")])] });
    expect(html).toContain("Fatou");
    expect(html).toContain("Envoyer à tous (2)");
    expect(html).not.toContain('type="submit" disabled');
  });

  it("désactive l'envoi et alerte quand personne n'est joignable", () => {
    const html = page({ cards: [card(fiche(), [])] });
    expect(html).toContain("Aucun membre joignable pour ce rôle");
    expect(html).toContain("Envoyer à tous (0)");
    expect(html).toContain("disabled");
  });

  it("badge brouillon quand rien n'est publié, et prévient que le lien est mort", () => {
    const html = page({
      cards: [
        card(
          fiche({
            published_body: null,
            published_role_label: null,
            published_role_keys: null,
            published_at: null,
          }),
        ),
      ],
    });
    expect(html).toContain("brouillon");
    expect(html).toContain("le lien répond « introuvable »");
  });

  it("signale des modifications non publiées", () => {
    const html = page({ cards: [card(fiche({ body: "autre texte" }), [contact("Fatou")])] });
    expect(html).toContain("modifications non publiées");
    expect(html).toContain("L’équipe lit toujours l’ancienne");
  });

  it("signale une fiche modifiée depuis le dernier envoi", () => {
    const html = page({
      cards: [
        card(
          fiche({
            last_sent_at: new Date("2026-08-10T10:00:00Z"),
            published_at: new Date("2026-08-12T10:00:00Z"),
          }),
          [contact("Fatou")],
        ),
      ],
    });
    expect(html).toContain("modifiée depuis le dernier envoi");
  });

  it("propose « Dépublier » plutôt que « Supprimer » pour une fiche déjà envoyée", () => {
    const html = page({
      cards: [card(fiche({ last_sent_at: new Date("2026-08-12T10:00:00Z") }), [contact("Fatou")])],
    });
    expect(html).toContain("dépublie plutôt que supprimer");
    expect(html).not.toContain("act--danger");
  });

  it("affiche les chips des rôles sans fiche", () => {
    const html = page({ rolesWithoutFiche: ["gardien", "coach"] });
    expect(html).toContain("aucune fiche ne les couvre");
    expect(html).toContain("+ gardien");
    expect(html).toContain("+ coach");
  });

  it("avertit quand aucun template WhatsApp n'est configuré", () => {
    expect(page({ templateConfigured: false })).toContain("Aucun template WhatsApp configuré");
    expect(page({ templateConfigured: true })).not.toContain("Aucun template WhatsApp configuré");
  });

  it("remplit le datalist avec les rôles du répertoire", () => {
    const html = page({ knownRoles: ["gardien"] });
    expect(html).toContain('<datalist id="fiche-roles">');
    expect(html).toContain('<option value="gardien">');
  });

  // Le webhook Meta ne traite que `failed` : delivered/read sont jetés. Affirmer
  // « reçue » serait faux, et une fiche de poste est un document quasi-RH.
  it("ne prétend JAMAIS qu'une fiche a été reçue ou lue", () => {
    const html = page({
      cards: [
        {
          ...card(fiche(), [contact("Fatou")]),
          lastSends: new Map([
            [
              "221771234567",
              {
                recipient_phone: "+221771234567",
                status: "sent_template",
                error: null,
                created_at: new Date("2026-08-12T11:00:00Z"),
              },
            ],
          ]),
        },
      ],
    });
    expect(html).toContain("Dernier envoi WhatsApp");
    expect(html).toContain("accepté par Meta");
    expect(html).not.toMatch(/\breçue\b/);
    expect(html).not.toMatch(/\blue par\b/);
  });

  it("montre QUEL envoi a échoué, pas seulement un compteur", () => {
    const html = page({
      cards: [
        {
          ...card(fiche(), [contact("Fatou")]),
          lastSends: new Map([
            [
              "221771234567",
              {
                recipient_phone: "+221771234567",
                status: "failed",
                error: "131047 window closed",
                created_at: new Date("2026-08-12T11:00:00Z"),
              },
            ],
          ]),
        },
      ],
    });
    expect(html).toContain("échec signalé");
    expect(html).toContain("131047");
  });

  it("échappe le libellé de rôle et les noms d'employées", () => {
    const html = page({
      cards: [card(fiche({ role_label: '<img src=x onerror=1>' }), [contact('<b>Fatou</b>')])],
    });
    expect(html).not.toContain("<img src=x");
    expect(html).not.toContain("<b>Fatou</b>");
    expect(html).toContain("&lt;img");
  });
});

describe("fichesBanner", () => {
  it("rend chaque état simple", () => {
    expect(fichesBanner("created")).toContain("Fiche créée");
    expect(fichesBanner("saved")).toContain("Brouillon enregistré");
    expect(fichesBanner("published")).toContain("le lien est actif");
    expect(fichesBanner("unpublished")).toContain("introuvable");
    expect(fichesBanner("link-rotated")).toContain("l’ancien ne fonctionne plus");
    expect(fichesBanner("deleted")).toContain("Fiche supprimée");
  });

  it("rend l'envoi individuel sans affirmer la réception", () => {
    const b = fichesBanner("sent:Fatou");
    expect(b).toContain("Fatou");
    expect(b).toContain("acceptée par Meta");
  });

  it("détaille un lot et le marque en avertissement s'il y a des échecs", () => {
    const ok = fichesBanner("sent-all:3:1:1:0");
    expect(ok).toContain("3 envoi(s) accepté(s)");
    expect(ok).toContain("1 sans numéro");
    expect(ok).toContain("1 en sourdine");
    expect(ok).toContain("card success");

    const bad = fichesBanner("sent-all:2:0:0:1");
    expect(bad).toContain("1 en échec");
    expect(bad).toContain("card warn");
  });

  it("affiche une erreur échappée", () => {
    expect(fichesBanner(undefined, "<x>")).toContain("&lt;x&gt;");
  });

  it("ne rend rien sans drapeau", () => {
    expect(fichesBanner()).toBe("");
  });
});
