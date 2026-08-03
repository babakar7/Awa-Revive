import { describe, expect, it } from "vitest";
import { renderRelancesPage } from "../src/admin/relancesPage.js";

const candidate = {
  client_id: "11111111-1111-1111-1111-111111111111",
  campaign_key: "pack_decouverte_ctwa",
  wa_phone: "221770000001",
  name: "Fatou",
  language: "fr",
  trigger_at: new Date(Date.now() - 6 * 3_600_000),
  last_user_at: new Date(Date.now() - 4 * 3_600_000),
  replies_after_trigger: 3,
};

describe("renderRelancesPage", () => {
  it("renders a candidate card with send/skip actions and a message preview", () => {
    const html = renderRelancesPage({ candidates: [candidate], recent: [], maxAgeHours: 22, banner: "" });
    expect(html).toContain("/admin/relances/11111111-1111-1111-1111-111111111111/send");
    expect(html).toContain("/admin/relances/11111111-1111-1111-1111-111111111111/skip");
    expect(html).toContain("Fatou");
    expect(html).toContain("L'Invitée"); // message preview present
    expect(html).toContain("ferme dans"); // 24h window countdown
    expect(html).toContain("3 réponses, puis silence"); // engagement shown
  });

  it("shows an empty state when there is nothing to nudge", () => {
    const html = renderRelancesPage({ candidates: [], recent: [], maxAgeHours: 22, banner: "" });
    expect(html).toContain("Aucun lead à relancer");
  });

  it("lists recently actioned leads with their outcome", () => {
    const html = renderRelancesPage({
      candidates: [],
      recent: [
        { client_id: candidate.client_id, wa_phone: "221770000002", name: "Awa",
          outcome: "SENT", detail: "manual:reception", assigned_at: new Date(), sent_at: new Date() },
      ],
      maxAgeHours: 22,
      banner: "",
    });
    expect(html).toContain("Relance envoyée");
    expect(html).toContain("Historique des relances");
  });
});
