import { describe, expect, it } from "vitest";
import {
  buildFicheMessage,
  contactMatchesFiche,
  ficheUrl,
  hasUnpublishedChanges,
  matchFicheRecipients,
  normalizeRoleKeys,
  parseFicheForm,
  renderFicheBodyHtml,
  roleKeysOverlap,
  rolesWithoutFiche,
} from "../src/domain/ficheRules.js";
import { toTemplateParam } from "../src/lib/notify.js";
import type { StaffContact } from "../src/domain/notificationRepo.js";

const contact = (o: Partial<StaffContact> & { name: string }): StaffContact => ({
  id: o.id ?? o.name.toLowerCase(),
  name: o.name,
  phone: o.phone ?? "+221771234567",
  role: o.role ?? "accueil",
  muted: o.muted ?? false,
});

describe("normalizeRoleKeys", () => {
  it("normalise accents et casse", () => {
    expect(normalizeRoleKeys("Entretien")).toEqual(["entretien"]);
    expect(normalizeRoleKeys("ACCUEIL")).toEqual(["accueil"]);
    expect(normalizeRoleKeys("Sécurité")).toEqual(["securite"]);
  });

  it("éclate les libellés multiples et trie — « Cuisine / Bar » == « Bar / Cuisine »", () => {
    expect(normalizeRoleKeys("Cuisine / Bar")).toEqual(["bar", "cuisine"]);
    expect(normalizeRoleKeys("Bar / Cuisine")).toEqual(["bar", "cuisine"]);
  });

  it("dédoublonne", () => {
    expect(normalizeRoleKeys("Bar / bar / BAR")).toEqual(["bar"]);
  });

  it("ne renvoie rien pour un libellé vide", () => {
    expect(normalizeRoleKeys("   ")).toEqual([]);
    expect(normalizeRoleKeys("//")).toEqual([]);
  });
});

describe("roleKeysOverlap", () => {
  it("détecte le rôle disputé, même partiellement", () => {
    expect(roleKeysOverlap(["bar", "cuisine"], ["bar"])).toEqual(["bar"]);
    expect(roleKeysOverlap(["accueil"], ["bar", "cuisine"])).toEqual([]);
  });
});

describe("matchFicheRecipients", () => {
  const contacts = [
    contact({ name: "Fatou", role: "accueil", phone: "+221771234567" }),
    contact({ name: "Awa", role: "Accueil", phone: "221 78 111 22 33" }),
    contact({ name: "Bineta", role: "accueil", phone: "" }),
    contact({ name: "Sokhna", role: "accueil", phone: "+221770000001", muted: true }),
    contact({ name: "Moussa", role: "gardien", phone: "+221770000002" }),
  ];

  it("cible le bon rôle et range les cas particuliers", () => {
    const r = matchFicheRecipients(contacts, "accueil");
    expect(r.targets.map((c) => c.name)).toEqual(["Fatou", "Awa"]);
    expect(r.noPhone.map((c) => c.name)).toEqual(["Bineta"]);
    expect(r.muted.map((c) => c.name)).toEqual(["Sokhna"]);
  });

  it("exclut la sourdine du lot mais ne la perd jamais", () => {
    const r = matchFicheRecipients(contacts, "accueil");
    expect(r.targets.some((c) => c.name === "Sokhna")).toBe(false);
    expect(r.muted).toHaveLength(1);
  });

  it("dédoublonne par chiffres du numéro", () => {
    const dup = [
      contact({ name: "A", phone: "+221 77 123 45 67" }),
      contact({ name: "B", phone: "221771234567" }),
    ];
    expect(matchFicheRecipients(dup, "accueil").targets).toHaveLength(1);
  });

  it("couvre plusieurs rôles avec une seule fiche", () => {
    const mixed = [
      contact({ name: "Cuisto", role: "cuisine", phone: "+221770000011" }),
      contact({ name: "Barman", role: "bar", phone: "+221770000012" }),
      contact({ name: "Hôtesse", role: "accueil", phone: "+221770000013" }),
    ];
    const r = matchFicheRecipients(mixed, "bar,cuisine");
    expect(r.targets.map((c) => c.name)).toEqual(["Cuisto", "Barman"]);
  });

  it("ne cible personne quand les clés publiées sont absentes (fiche non publiée)", () => {
    const r = matchFicheRecipients(contacts, null);
    expect(r.targets).toHaveLength(0);
    expect(r.noPhone).toHaveLength(0);
    expect(r.muted).toHaveLength(0);
  });
});

describe("contactMatchesFiche", () => {
  it("refuse un rôle qui ne relève plus de la fiche, ou un numéro invalide", () => {
    expect(contactMatchesFiche(contact({ name: "F", role: "accueil" }), "accueil")).toBe(true);
    expect(contactMatchesFiche(contact({ name: "F", role: "bar" }), "accueil")).toBe(false);
    expect(contactMatchesFiche(contact({ name: "F", phone: "12" }), "accueil")).toBe(false);
  });
});

describe("rolesWithoutFiche", () => {
  it("remonte les rôles du répertoire que rien ne couvre", () => {
    const contacts = [
      contact({ name: "F", role: "accueil" }),
      contact({ name: "M", role: "gardien" }),
      contact({ name: "C", role: "coach" }),
      contact({ name: "X", role: "staff" }),
    ];
    expect(rolesWithoutFiche(contacts, [{ role_keys: "accueil" }])).toEqual([
      "coach",
      "gardien",
      "staff",
    ]);
  });

  it("considère une fiche multi-rôles comme couvrant chacun d'eux", () => {
    const contacts = [contact({ name: "A", role: "bar" }), contact({ name: "B", role: "cuisine" })];
    expect(rolesWithoutFiche(contacts, [{ role_keys: "bar,cuisine" }])).toEqual([]);
  });
});

describe("hasUnpublishedChanges", () => {
  const base = {
    id: "1",
    role_label: "Accueil",
    role_keys: "accueil",
    body: "texte",
    published_role_label: "Accueil",
    published_role_keys: "accueil",
    published_body: "texte",
    published_at: new Date("2026-08-12T10:00:00Z"),
  };

  it("faux quand tout est aligné", () => {
    expect(hasUnpublishedChanges(base)).toBe(false);
  });

  it("faux quand la fiche n'a jamais été publiée", () => {
    expect(
      hasUnpublishedChanges({
        ...base,
        published_body: null,
        published_role_label: null,
        published_role_keys: null,
        published_at: null,
      }),
    ).toBe(false);
  });

  it("vrai sur un changement de corps", () => {
    expect(hasUnpublishedChanges({ ...base, body: "autre" })).toBe(true);
  });

  it("vrai sur un changement de libellé", () => {
    expect(hasUnpublishedChanges({ ...base, role_label: "Gardien" })).toBe(true);
  });

  it("vrai sur un changement de CLÉS — le cas qui enverrait au mauvais rôle", () => {
    expect(hasUnpublishedChanges({ ...base, role_keys: "gardien" })).toBe(true);
  });
});

describe("buildFicheMessage", () => {
  const url = "https://resabot-production.up.railway.app/fiche/0123456789abcdef0123456789abcdef";

  it("tient dans un template Meta SANS perdre le lien", () => {
    const { subject, body } = buildFicheMessage({
      staffName: "Fatou Ndiaye",
      roleLabel: "Cuisine / Bar",
      publishedAt: new Date("2026-08-12T10:00:00Z"),
      url,
    });
    expect(subject.length).toBeLessThanOrEqual(120);
    const flat = toTemplateParam(body);
    expect(flat.length).toBeLessThanOrEqual(550);
    expect(flat).toContain(url);
  });

  it("utilise le prénom seul", () => {
    const { body } = buildFicheMessage({
      staffName: "Fatou Ndiaye",
      roleLabel: "Accueil",
      publishedAt: null,
      url,
    });
    expect(body).toContain("Bonjour Fatou,");
    expect(body).not.toContain("Ndiaye");
  });

  it("ne demande PAS d'accusé de lecture (le template interdit de répondre)", () => {
    const { body } = buildFicheMessage({
      staffName: "Fatou",
      roleLabel: "Accueil",
      publishedAt: null,
      url,
    });
    expect(body.toLowerCase()).not.toContain("confirmer");
    expect(body.toLowerCase()).not.toContain("réponds");
  });

  it("tronque le sujet d'un libellé maximal", () => {
    const { subject } = buildFicheMessage({
      staffName: "F",
      roleLabel: "R".repeat(60),
      publishedAt: null,
      url,
    });
    expect(subject.length).toBeLessThanOrEqual(120);
  });
});

describe("ficheUrl", () => {
  it("ne double jamais le slash", () => {
    expect(ficheUrl("https://x.tld/", "abc")).toBe("https://x.tld/fiche/abc");
    expect(ficheUrl("https://x.tld", "abc")).toBe("https://x.tld/fiche/abc");
  });
});

describe("renderFicheBodyHtml", () => {
  it("échappe le HTML AVANT toute conversion", () => {
    const html = renderFicheBodyHtml("<script>alert(1)</script>");
    expect(html).not.toContain("<script");
    expect(html).toContain("&lt;script&gt;");
  });

  it("convertit les puces en liste", () => {
    const html = renderFicheBodyHtml("- Ouvrir\n- Nettoyer");
    expect(html).toContain("<ul>");
    expect(html).toContain("<li>Ouvrir</li>");
    expect(html).toContain("<li>Nettoyer</li>");
  });

  it("convertit les listes numérotées", () => {
    const html = renderFicheBodyHtml("1. Premier\n2. Second");
    expect(html).toContain("<ol>");
    expect(html).toContain("<li>Premier</li>");
  });

  it("sépare les paragraphes sur une ligne vide", () => {
    expect(renderFicheBodyHtml("Un\n\nDeux")).toBe("<p>Un</p>\n<p>Deux</p>");
  });

  it("n'émet ni gras ni lien (liste blanche)", () => {
    const html = renderFicheBodyHtml("**gras** et [lien](http://x.tld)");
    expect(html).not.toContain("<b>");
    expect(html).not.toContain("<a ");
    expect(html).toContain("**gras**");
  });

  it("gère un corps vide", () => {
    expect(renderFicheBodyHtml("")).toBe("");
  });
});

describe("parseFicheForm", () => {
  it("refuse un rôle vide", () => {
    expect(parseFicheForm({ role_label: "  ", body: "x" })).toEqual({
      error: "le rôle est obligatoire",
    });
  });

  it("refuse un rôle trop long", () => {
    const r = parseFicheForm({ role_label: "R".repeat(61), body: "" });
    expect("error" in r && r.error).toContain("60");
  });

  it("refuse un corps trop long", () => {
    const r = parseFicheForm({ role_label: "Accueil", body: "x".repeat(8001) });
    expect("error" in r && r.error).toContain("8000");
  });

  it("calcule les clés canoniques", () => {
    const r = parseFicheForm({ role_label: "Cuisine / Bar", body: "- a" });
    expect("error" in r).toBe(false);
    if (!("error" in r)) {
      expect(r.roleKeys).toBe("bar,cuisine");
      expect(r.roleLabel).toBe("Cuisine / Bar");
    }
  });

  it("accepte un corps vide (on publie plus tard)", () => {
    const r = parseFicheForm({ role_label: "Accueil" });
    expect("error" in r).toBe(false);
  });
});
