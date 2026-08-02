import { describe, expect, it } from "vitest";
import { renderCoachPaymentSettings } from "../src/admin/coachPaymentsPage.js";
import type { CoachPaymentProfile } from "../src/domain/coachPaymentRepo.js";

function profile(overrides: Partial<CoachPaymentProfile> = {}): CoachPaymentProfile {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    slug: "yass",
    display_name: "Yass",
    wix_resource_id: "coach-yass",
    email: "yass@revive.sn",
    formula_type: "per_session",
    base_amount_xof: null,
    base_session_count: null,
    per_session_xof: 9_500,
    enabled: true,
    created_at: new Date("2026-01-01T00:00:00Z"),
    updated_at: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  };
}

describe("coach payment settings page", () => {
  it("offers only Wix coaches that do not already have a payment profile", () => {
    const html = renderCoachPaymentSettings({
      profiles: [profile()],
      resources: [
        { id: "coach-yass", name: "Yass", phone: null, email: "yass@revive.sn" },
        { id: "coach-awa", name: "Awa Ndiaye", phone: null, email: "awa@revive.sn" },
      ],
      banner: "",
    });

    const addForm = html.match(/<form class="card" id="ajouter-coach" method="post" action="\/admin\/paiements-coachs\/reglages" data-new-coach>[\s\S]*?<\/form>/)?.[0];
    expect(addForm).toBeTruthy();
    expect(addForm).toContain("Awa Ndiaye");
    expect(addForm).toContain("awa@revive.sn");
    expect(addForm).not.toContain("coach-yass");
    expect(html).toContain("Ajouter la coach");
  });

  it("explains when every Wix coach is already configured", () => {
    const html = renderCoachPaymentSettings({
      profiles: [profile()],
      resources: [
        { id: "coach-yass", name: "Yass", phone: null, email: "yass@revive.sn" },
      ],
      banner: "",
    });

    expect(html).toContain("Toutes les ressources coach Wix ont déjà une fiche de paiement.");
  });
});
