import { describe, expect, it } from "vitest";
import { csvCell, renderPaymentsPage } from "../src/admin/paiementsPage.js";
import { dakarDay } from "../src/domain/paymentsLedger.js";
import { normalizeWixProviderMethod, wixOrderBuyer } from "../src/domain/wixPaymentSync.js";
import { bookingPaymentLabel } from "../src/lib/paymentMethod.js";

describe("payments ledger pure rules", () => {
  it("uses the exact plan name as the payment label for membership bookings", () => {
    expect(bookingPaymentLabel("membership", "La Résidente")).toBe("La Résidente");
    expect(bookingPaymentLabel("membership", null)).toBe("Abonnement");
    expect(bookingPaymentLabel("orange_money", "La Résidente")).toBe("Orange Money");
  });

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

  it("keeps the contact id when a Wix WEB order has blank billing names", () => {
    expect(wixOrderBuyer({
      buyerInfo: { contactId: "contact-1", email: "cliente@example.com" },
      billingInfo: { contactDetails: { firstName: "", lastName: "" } },
    })).toEqual({ name: null, phone: null, contactId: "contact-1" });
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
      from: "2026-08-01", to: "2026-08-10", today: "2026-08-10", startDate: "2026-07-01",
      rows: [movement], bookings: [], daily: [], currentMonth: [], previousMonth: [],
      untagged: [movement], excludedCounts: {}, refundNeeded: [], owner: true,
      sync: { lastStartedAt: null, lastSucceededAt: null, lastUpdatedDateSeen: null,
        lastFullReconciledAt: null, lastError: null, recordCount: 0 },
    });
    expect(html).toContain("À qualifier");
    expect(html).toContain("Ajouter un mouvement manuel");
    expect(html).not.toContain("<Cliente>");
    expect(html).toContain('href="#pay-mouvements"');
    expect(html).toContain('id="pay-qualifier"');
  });

  it("folds untagged movements past the visible cap into a <details>", () => {
    const make = (i: number) => ({
      origin: "wix" as const, movementType: "payment" as const, sourceKind: "wix_ecom",
      sourceId: `order-${i}`, providerTxId: `tx-${i}`, clientName: `Client ${i}`, clientPhone: null,
      label: "Cours", amountXof: 24000, method: null, methodOrigin: "provider" as const,
      occurredAt: new Date("2026-08-10T12:00:00Z"), dateEstimated: false,
      targetId: `1111111${i.toString().padStart(2, "0")}-1111-1111-1111-111111111111`, excludedReason: null,
    });
    const untagged = Array.from({ length: 12 }, (_, i) => make(i));
    const html = renderPaymentsPage({
      from: "2026-08-01", to: "2026-08-10", today: "2026-08-10", startDate: "2026-07-01",
      rows: untagged, bookings: [], daily: [], currentMonth: [], previousMonth: [],
      untagged, excludedCounts: {}, refundNeeded: [], owner: false,
      sync: { lastStartedAt: null, lastSucceededAt: null, lastUpdatedDateSeen: null,
        lastFullReconciledAt: null, lastError: null, recordCount: 0 },
    });
    expect(html).toContain("Afficher les 2 suivants");
  });

  it("groups movements by Dakar day and links each daily total to its day", () => {
    const mv = (day: string, hh: string, name: string, amountXof: number, method: "wave" | "cash", excludedReason: string | null = null) => ({
      origin: "awa" as const, movementType: (amountXof < 0 ? "refund" : "payment") as "payment" | "refund",
      sourceKind: "booking", sourceId: `${day}-${hh}-${name}`, providerTxId: null,
      clientName: name, clientPhone: null, label: "Cours", amountXof, method, methodOrigin: "local" as const,
      occurredAt: new Date(`${day}T${hh}:00:00Z`), dateEstimated: false, targetId: null, excludedReason,
    });
    // newest first, mirroring the `occurred_at desc` query order
    const rows = [
      mv("2026-08-11", "14", "Awa", 24000, "wave"),
      mv("2026-08-11", "10", "Remb", -24000, "wave"),
      mv("2026-08-10", "16", "Moussa", 30000, "cash"),
      mv("2026-08-10", "11", "Exclu", 99999, "cash", "tag_exclu"),
    ];
    const daily = [{ day: "2026-08-11", method: "wave", grossXof: 24000, refundsXof: 24000, netXof: 0, movementCount: 2 }];
    const html = renderPaymentsPage({
      from: "2026-08-10", to: "2026-08-11", today: "2026-08-11", startDate: "2026-07-01",
      rows, bookings: [], daily, currentMonth: [], previousMonth: [], untagged: [], excludedCounts: {}, refundNeeded: [], owner: false,
      sync: { lastStartedAt: null, lastSucceededAt: null, lastUpdatedDateSeen: null,
        lastFullReconciledAt: null, lastError: null, recordCount: 0 },
    });
    // one day-header band per Dakar day, newest first, header above its rows
    const movements = html.slice(html.indexOf('id="pay-mouvements"'));
    expect(movements).toContain('class="day-head"');
    expect(movements.indexOf("2026-08-11")).toBeLessThan(movements.indexOf("2026-08-10"));
    expect(movements.indexOf("day-head")).toBeLessThan(movements.indexOf("Awa"));
    // per-day net honours the refund (24000 − 24000 = 0) and excludes tag_exclu (30000, not 129999)
    expect(movements).toMatch(/2026-08-11<\/b>[^<]*· 2 transactions · net 0/);
    expect(movements).toMatch(/2026-08-10<\/b>[^<]*· 2 transactions · net 30/);
    expect(movements).not.toContain("129 999");
    // daily total drills into that single day's itemised list
    expect(html).toContain("from=2026-08-11&amp;to=2026-08-11&amp;view=payments#pay-mouvements");
  });

  it("scopes movements to the day with Today/Yesterday/7-day chips", () => {
    const base = {
      rows: [], bookings: [], daily: [], currentMonth: [], previousMonth: [], untagged: [], excludedCounts: {},
      refundNeeded: [], owner: false, startDate: "2026-07-01",
      sync: { lastStartedAt: null, lastSucceededAt: null, lastUpdatedDateSeen: null,
        lastFullReconciledAt: null, lastError: null, recordCount: 0 },
    } as const;
    // default view = current day only, and the "Aujourd'hui" chip is active
    const todayView = renderPaymentsPage({ ...base, from: "2026-08-11", to: "2026-08-11", today: "2026-08-11" });
    expect(todayView).toContain("Aujourd’hui");
    expect(todayView).toContain("Transactions du 2026-08-11 ·");
    expect(todayView).toMatch(/<a class="active" href="[^"]*from=2026-08-11&amp;to=2026-08-11[^"]*">Aujourd’hui<\/a>/);
    // yesterday and last-7-days chips point at the right ranges
    expect(todayView).toContain("from=2026-08-10&amp;to=2026-08-10"); // Hier
    expect(todayView).toContain("from=2026-08-05&amp;to=2026-08-11"); // 7 derniers jours
    // when viewing last 7 days that chip is the active one, not "Aujourd'hui"
    const weekView = renderPaymentsPage({ ...base, from: "2026-08-05", to: "2026-08-11", today: "2026-08-11" });
    expect(weekView).toMatch(/<a class="active" href="[^"]*from=2026-08-05&amp;to=2026-08-11[^"]*">7 derniers jours<\/a>/);
    expect(weekView).toMatch(/<a class="" href="[^"]*">Aujourd’hui<\/a>/);
  });

  it("groups confirmed bookings by client and scopes them by class date", () => {
    const booking = (overrides: Partial<{
      bookingId: string; clientId: string; clientName: string; clientPhone: string;
      serviceName: string; slotStart: Date; participants: number; amountXof: number;
      paymentMethod: string; paidAt: Date | null; source: "awa" | "wix";
      planName: string | null; groupKey: string;
    }> = {}) => {
      const base = {
        bookingId: "booking-1", clientId: "11111111-1111-4111-8111-111111111111",
        clientName: "Awa Ndiaye", clientPhone: "221770000001", serviceName: "Reformer",
        slotStart: new Date("2026-08-11T09:00:00Z"), participants: 1, amountXof: 12000,
        paymentMethod: "wave", paidAt: new Date("2026-08-03T12:00:00Z"),
        source: "awa" as const, planName: null,
      };
      const merged = { ...base, ...overrides };
      return { ...merged, groupKey: overrides.groupKey ?? merged.clientId };
    };
    const html = renderPaymentsPage({
      from: "2026-08-11", to: "2026-08-11", today: "2026-08-11", startDate: "2026-07-01",
      view: "bookings", rows: [], bookings: [
        booking(),
        booking({ bookingId: "booking-2", serviceName: "Pilates Mat", participants: 2,
          slotStart: new Date("2026-08-11T11:00:00Z"), paymentMethod: "membership", amountXof: 0, paidAt: null }),
        booking({ bookingId: "booking-3", clientId: "22222222-2222-4222-8222-222222222222",
          clientName: "Binta Fall", clientPhone: "221770000002" }),
      ],
      daily: [], currentMonth: [], previousMonth: [], untagged: [], excludedCounts: {},
      refundNeeded: [], owner: false,
      sync: { lastStartedAt: null, lastSucceededAt: null, lastUpdatedDateSeen: null,
        lastFullReconciledAt: null, lastError: null, recordCount: 0 },
    });
    expect(html).toContain("Par date de réservation");
    expect(html).toContain("Clients ayant une réservation du 2026-08-11");
    expect(html).toContain("Awa Ndiaye");
    expect(html.match(/Awa Ndiaye/g)).toHaveLength(1);
    expect(html).toContain("3 places");
    expect(html).toContain("Réglé le 03/08");
    expect(html).toContain("Séance décomptée");
    expect(html).toContain("from=2026-08-12&amp;to=2026-08-12&amp;view=bookings");
    expect(html).not.toContain("Mois en cours");
  });
});
