import { describe, expect, it } from "vitest";
import { stripStaffFooter, toTemplateParam } from "../src/lib/notify.js";
import { STAFF_FOOTER } from "../src/domain/notificationRules.js";

describe("stripStaffFooter", () => {
  it("drops the staff footer so the template's own signature isn't doubled", () => {
    const body = `Aquabike à 10:00 : 8 inscrit(s) — vélos à l'eau 🚴\n\n${STAFF_FOOTER}`;
    expect(stripStaffFooter(body)).toBe("Aquabike à 10:00 : 8 inscrit(s) — vélos à l'eau 🚴");
  });

  it("leaves a body without footer untouched, and never returns empty", () => {
    expect(stripStaffFooter("Juste un message")).toBe("Juste un message");
    expect(stripStaffFooter(STAFF_FOOTER)).toBe(STAFF_FOOTER); // footer-only stays
  });
});

describe("toTemplateParam", () => {
  it("flattens newlines into ' | ' separators", () => {
    expect(toTemplateParam("Client : Fatou\nService : Massage 60 min\n\nMontant : 25 000 FCFA")).toBe(
      "Client : Fatou | Service : Massage 60 min | Montant : 25 000 FCFA",
    );
  });

  it("collapses runs of whitespace (Meta rejects 4+ consecutive spaces and tabs)", () => {
    expect(toTemplateParam("a    b\t\tc")).toBe("a b c");
  });

  it("truncates long text with an ellipsis at maxLength", () => {
    const out = toTemplateParam("x".repeat(600), 550);
    expect(out).toHaveLength(550);
    expect(out.endsWith("…")).toBe(true);
  });

  it("leaves short single-line text untouched", () => {
    expect(toTemplateParam("Remboursement à traiter")).toBe("Remboursement à traiter");
  });
});
