import { describe, expect, it } from "vitest";
import { renderLivraisonForm } from "../src/admin/livraisonsPage.js";
import type { CafeMenuItem } from "../src/lib/cafeMenu.js";
import type { RecentDeliveryClient } from "../src/domain/deliveryRepo.js";

function menu(): Map<string, CafeMenuItem> {
  const m = new Map<string, CafeMenuItem>();
  m.set("ESPRESSO", { id: "ESPRESSO", name: "Espresso", priceXof: 2000, category: "Cafés" });
  m.set("MATCHA", {
    id: "MATCHA",
    name: "Iced Matcha",
    priceXof: 3500,
    category: "Matcha",
    optionLabel: "Lait",
    optionChoices: ["Entier", "Avoine"],
  });
  return m;
}

describe("renderLivraisonForm — stepper & UX", () => {
  it("uses tappable steppers with a hidden numeric field, not a number input", () => {
    const html = renderLivraisonForm(menu(), "");
    expect(html).toContain(`class="act act--ghost act--sm liv-inc" data-id="ESPRESSO"`);
    expect(html).toContain(`class="act act--ghost act--sm liv-dec" data-id="ESPRESSO"`);
    expect(html).toContain(`<input type="hidden" name="qty_ESPRESSO" value="0"`);
    expect(html).not.toContain(`type="number" name="qty_`);
  });

  it("hides an item's option select until its quantity is > 0", () => {
    const html = renderLivraisonForm(menu(), "");
    // MATCHA at qty 0 → select hidden.
    expect(html).toMatch(/name="choice_MATCHA"[^>]*display:none/);
  });

  it("reveals the option select and opens the category when prefilled with a qty", () => {
    const html = renderLivraisonForm(menu(), "", [], { qty: { MATCHA: 2 }, choice: { MATCHA: "Avoine" } });
    expect(html).toContain(`<input type="hidden" name="qty_MATCHA" value="2"`);
    expect(html).toContain(`<option value="Avoine" selected>`);
    expect(html).not.toMatch(/name="choice_MATCHA"[^>]*display:none/);
    expect(html).toContain(`<details class="card liv-cat" open>`);
  });

  it("uses tel input and a live article search", () => {
    const html = renderLivraisonForm(menu(), "");
    expect(html).toContain(`name="client_phone" type="tel" inputmode="tel"`);
    expect(html).toContain(`id="liv-search"`);
    expect(html).toContain(`data-search="iced matcha matcha matcha"`);
  });

  it("searches Wix clients while keeping manual entry available", () => {
    const html = renderLivraisonForm(menu(), "");
    expect(html).toContain(`id="liv-wix-search"`);
    expect(html).toContain(`/admin/livraisons/clients?q=`);
    expect(html).toContain(`name="wix_contact_id" type="hidden" value=""`);
    expect(html).toContain("La saisie manuelle reste disponible.");
  });

  it("offers a test mode and preserves it after a validation error", () => {
    const normal = renderLivraisonForm(menu(), "");
    expect(normal).toContain(`name="is_test" type="checkbox" value="1"`);
    expect(normal).not.toContain(`name="is_test" type="checkbox" value="1" checked`);

    const test = renderLivraisonForm(menu(), "", [], { is_test: "1" });
    expect(test).toContain(`name="is_test" type="checkbox" value="1" checked`);
    expect(test).toContain("exclue des statistiques");
  });

  it("offers immediate or scheduled arrival in Dakar with a 60-minute default", () => {
    const html = renderLivraisonForm(menu(), "");
    expect(html).toContain(`name="delivery_mode" type="radio" value="now" checked`);
    expect(html).toContain(`name="delivery_mode" type="radio" value="scheduled"`);
    expect(html).toContain(`name="scheduled_for" type="datetime-local"`);
    expect(html).toContain("Arrivée promise au client (heure de Dakar)");
    expect(html).toContain(`<option value="60" selected>60 minutes avant`);
    expect(html).toContain(`<option value="30">30 minutes avant`);
    expect(html).toContain(`<option value="90">90 minutes avant`);
  });

  it("preserves scheduled fields after a validation error", () => {
    const html = renderLivraisonForm(menu(), "", [], {
      delivery_mode: "scheduled",
      scheduled_for: "2026-08-04T14:30",
      kitchen_lead_minutes: "90",
    });
    expect(html).toContain(`value="scheduled" checked`);
    expect(html).toContain(`value="2026-08-04T14:30" required`);
    expect(html).toContain(`<option value="90" selected>`);
  });

  it("prefills client fields on error re-render, escaping HTML", () => {
    const html = renderLivraisonForm(menu(), "", [], {
      client_name: `A<script>x</script>`,
      client_phone: "+221771112233",
      wix_contact_id: `wix"><script>x</script>`,
      address: "Almadies",
    });
    expect(html).toContain(`value="A&lt;script&gt;x&lt;/script&gt;"`);
    expect(html).toContain(`value="+221771112233"`);
    expect(html).toContain(`value="Almadies"`);
    expect(html).toContain(`name="wix_contact_id" type="hidden" value="wix&quot;&gt;&lt;script&gt;x&lt;/script&gt;"`);
    expect(html).not.toContain("<script>x</script>");
  });

  it("renders a recent-clients quick-fill select with escaped data attributes", () => {
    const recents: RecentDeliveryClient[] = [
      { client_name: `Awa "B"`, client_phone: "221770000000", address: "Ngor" },
    ];
    const html = renderLivraisonForm(menu(), "", recents);
    expect(html).toContain(`id="liv-recent"`);
    expect(html).toContain(`data-name="Awa &quot;B&quot;"`);
    expect(html).toContain(`data-address="Ngor"`);
  });
});
