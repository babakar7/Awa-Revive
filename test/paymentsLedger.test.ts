import { describe, expect, it } from "vitest";
import { csvCell, renderPaymentsPage } from "../src/admin/paiementsPage.js";
import { dakarDay } from "../src/domain/paymentsLedger.js";
import { normalizeWixProviderMethod } from "../src/domain/wixPaymentSync.js";

describe("payments ledger pure rules", () => {
  it("uses the Dakar calendar day", () => {
    expect(dakarDay(new Date("2026-08-10T23:45:00Z"))).toBe("2026-08-10");
  });

  it("normalizes known providers and leaves generic offline payments untagged", () => {
    expect(normalizeWixProviderMethod({ regularPaymentDetails: {
      paymentMethod: "Orange Money", status: "APPROVED", offlinePayment: false,
    }})).toMatchObject({ method: "orange_money", providerStatus: "APPROVED" });
    expect(normalizeWixProviderMethod({ regularPaymentDetails: {
      paymentMethod: "Paid in person", status: "APPROVED", offlinePayment: true,
    }})).toMatchObject({ method: null, offline: true });
    expect(normalizeWixProviderMethod({ regularPaymentDetails: {
      paymentMethod: "Payer en personne", status: "APPROVED", offlinePayment: true,
      paymentMethodName: { userDefinedName: { custom: "OM" } },
    }})).toMatchObject({ method: "orange_money", offline: true });
  });

  it("neutralizes spreadsheet formulas in every CSV cell", () => {
    expect(csvCell("=2+2")).toBe("\"'=2+2\"");
    expect(csvCell("-cmd")).toBe("\"'-cmd\"");
    expect(csvCell("normal")).toBe("\"normal\"");
  });

  it("renders the qualifier and owner-only manual form", () => {
    const movement = {
      origin: "wix" as const, movementType: "payment" as const, sourceKind: "wix_ecom",
      sourceId: "order-1", providerTxId: "tx-1", clientName: "<Cliente>", clientPhone: null,
      label: "Cours", amountXof: 24000, method: null, methodOrigin: "provider" as const,
      occurredAt: new Date("2026-08-10T12:00:00Z"), dateEstimated: false,
      targetId: "11111111-1111-1111-1111-111111111111", excludedReason: null,
    };
    const html = renderPaymentsPage({
      from: "2026-08-01", to: "2026-08-10", startDate: "2026-07-01",
      rows: [movement], daily: [], currentMonth: [], previousMonth: [],
      untagged: [movement], excludedCounts: {}, refundNeeded: [], owner: true,
      sync: { lastStartedAt: null, lastSucceededAt: null, lastUpdatedDateSeen: null,
        lastFullReconciledAt: null, lastError: null, recordCount: 0 },
    });
    expect(html).toContain("À qualifier");
    expect(html).toContain("Ajouter un mouvement manuel");
    expect(html).not.toContain("<Cliente>");
  });
});
