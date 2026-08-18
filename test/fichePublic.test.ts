import { describe, expect, it } from "vitest";
import { renderFicheNotFound, renderFichePublic } from "../src/fichePublic.js";
import type { JobFiche } from "../src/domain/ficheRepo.js";

const fiche = (o: Partial<JobFiche> = {}): JobFiche => ({
  id: "11111111-1111-4111-8111-111111111111",
  role_label: "Accueil brouillon",
  role_keys: "accueil",
  body: "- Texte de BROUILLON",
  published_role_label: "Accueil",
  published_role_keys: "accueil",
  published_body: "- Ouvrir le studio à 6h45\n- Accueillir chaque cliente par son prénom",
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

describe("renderFichePublic", () => {
  it("sert l'INSTANTANÉ publié, jamais le brouillon", () => {
    const html = renderFichePublic(fiche());
    expect(html).toContain("Ouvrir le studio à 6h45");
    expect(html).not.toContain("BROUILLON");
    expect(html).toContain("<h1>Accueil</h1>");
    expect(html).not.toContain("Accueil brouillon");
  });

  it("affiche la date de mise à jour", () => {
    expect(renderFichePublic(fiche())).toContain("Mise à jour le 12 août 2026");
  });

  it("rend les puces en liste", () => {
    const html = renderFichePublic(fiche());
    expect(html).toContain("<ul>");
    expect(html).toContain("<li>Ouvrir le studio à 6h45</li>");
  });

  it("n'embarque AUCUN script — la CSP publique n'autorise pas script-src", () => {
    expect(renderFichePublic(fiche())).not.toContain("<script");
  });

  it("porte le noindex", () => {
    expect(renderFichePublic(fiche())).toContain('name="robots" content="noindex,nofollow"');
  });

  it("échappe une injection dans le corps publié", () => {
    const html = renderFichePublic(
      fiche({ published_body: "<script>alert(1)</script>", published_role_label: "<b>x</b>" }),
    );
    expect(html).not.toContain("<script>alert");
    expect(html).not.toContain("<b>x</b>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("ne divulgue aucun nom d'employée ni numéro personnel", () => {
    const html = renderFichePublic(fiche());
    expect(html).not.toContain("babakar");
  });

  it("garde une impression possible sans bouton (CSS uniquement)", () => {
    expect(renderFichePublic(fiche())).toContain("@media print");
    expect(renderFichePublic(fiche())).not.toContain("window.print");
  });
});

describe("renderFicheNotFound", () => {
  it("ne révèle jamais qu'une fiche existe", () => {
    const html = renderFicheNotFound();
    expect(html).toContain("Fiche introuvable");
    expect(html).not.toContain("dépubli");
    expect(html).not.toContain("brouillon");
  });

  it("porte le noindex et aucun script", () => {
    const html = renderFicheNotFound();
    expect(html).toContain('content="noindex,nofollow"');
    expect(html).not.toContain("<script");
  });

  it("oriente vers la réception", () => {
    expect(renderFicheNotFound()).toContain("réception");
  });
});
