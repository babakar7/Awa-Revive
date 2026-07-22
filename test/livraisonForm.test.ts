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


  it("offers a test mode and preserves it after a validation error", () => {
    const normal = renderLivraisonForm(menu(), "");
    expect(normal).toContain(`name="is_test" type="checkbox" value="1"`);
    expect(normal).not.toContain(`name="is_test" type="checkbox" value="1" checked`);

    const test = renderLivraisonForm(menu(), "", [], { is_test: "1" });
    expect(test).toContain(`name="is_test" type="checkbox" value="1" checked`);
    expect(test).toContain("exclue des statistiques");
  });

  it("prefills client fields on error re-render, escaping HTML", () => {
    const html = renderLivraisonForm(menu(), "", [], {
      client_name: `A<script>x</script>`,
      client_phone: "+221771112233",
      address: "Almadies",
    });
    expect(html).toContain(`value="A&lt;script&gt;x&lt;/script&gt;"`);
    expect(html).toContain(`value="+221771112233"`);
    expect(html).toContain(`value="Almadies"`);
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
