import { describe, expect, it } from "vitest";
import { toTemplateParam } from "../src/lib/notify.js";

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
