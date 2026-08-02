import { describe, expect, it } from "vitest";
import { looksLikeOmTransactionId } from "../src/admin/omReconcilePage.js";

// Reconciliation admin (panne callbacks 31/07): l'ID vient d'un copier-coller du
// portail marchand — accepter le format Sonatel observé sans être trop strict,
// mais rejeter ce qui est manifestement autre chose (URL, phrase, vide).
describe("looksLikeOmTransactionId", () => {
  it("accepts the observed Sonatel formats", () => {
    expect(looksLikeOmTransactionId("MP260801.2046.A59064")).toBe(true);
    expect(looksLikeOmTransactionId("  MP260731.1236.A50831  ")).toBe(true);
    expect(looksLikeOmTransactionId("CI250101.0001.B12345")).toBe(true);
  });

  it("rejects garbage, URLs and empty input", () => {
    expect(looksLikeOmTransactionId("")).toBe(false);
    expect(looksLikeOmTransactionId("   ")).toBe(false);
    expect(looksLikeOmTransactionId("https://sugu.orange-sonatel.com/mp/xyz")).toBe(false);
    expect(looksLikeOmTransactionId("j'ai payé hier")).toBe(false);
    expect(looksLikeOmTransactionId("MP 260801")).toBe(false);
    expect(looksLikeOmTransactionId("ab")).toBe(false);
  });
});
