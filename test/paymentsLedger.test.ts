import { describe, expect, it } from "vitest";
import { csvCell, renderPaymentsPage } from "../src/admin/paiementsPage.js";
import { dakarDay } from "../src/domain/paymentsLedger.js";
import { extractBookingIds, normalizeWixProviderMethod, wixOrderBuyer } from "../src/domain/wixPaymentSync.js";
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

  it("extracts booking ids from an order's Bookings-app line items only", () => {
    const bookingsApp = "13d21c63-b5ec-5912-8397-c3a5ddb27a97";
    const order = {
      lineItems: [
        { productName: { original: "Sculpt" }, catalogReference: { appId: bookingsApp, catalogItemId: "bk-1" } },
        { productName: { original: "Café" }, catalogReference: { appId: "some-store-app", catalogItemId: "prod-9" } },
        { catalogReference: { appId: bookingsApp, catalogItemId: "bk-2" } },
        { catalogReference: { appId: bookingsApp, catalogItemId: "bk-1" } }, // dup
      ],
    };
    expect(extractBookingIds(order)).toEqual(["bk-1", "bk-2"]);
    expect(extractBookingIds({})).toEqual([]);
    expect(extractBookingIds({ lineItems: [{ catalogReference: { appId: bookingsApp } }] })).toEqual([]);
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

describe("paiements search + requalify bridge", () => {
  const sync = {
    lastStartedAt: null, lastSucceededAt: null, lastUpdatedDateSeen: null,
    lastFullReconciledAt: null, lastError: null, recordCount: 0,
  };
  const paymentsBase = {
    from: "2026-08-11", to: "2026-08-11", today: "2026-08-11", startDate: "2026-07-01",
    rows: [], bookings: [], daily: [], currentMonth: [], previousMonth: [], untagged: [],
    excludedCounts: {}, refundNeeded: [], owner: false, sync,
  } as const;

  const mkBooking = (o: Partial<any> = {}) => ({
    bookingId: "b1", clientId: null, clientName: "Awa Ba", clientPhone: "221778299595",
    serviceName: "Sculpt", slotStart: new Date("2026-08-11T09:00:00Z"), participants: 1,
    amountXof: 12000, paymentMethod: "", paidAt: null, source: "wix" as const,
    planName: null, groupKey: "wix:c1", movementId: null, paymentExcluded: false, ...o,
  });

  it("echoes an escaped search value and threads q into chips, CSV and view switch", () => {
    const html = renderPaymentsPage({ ...paymentsBase, view: "payments", q: 'Awa "Ba"' } as any);
    expect(html).toContain('name="q" value="Awa &quot;Ba&quot;"');
    expect(html).not.toContain('value="Awa "Ba""'); // properly escaped, no raw quotes break out
    expect(html).toContain("q=Awa"); // chip / link hrefs carry q
    expect(html).toContain("export.csv?"); // export link present
    expect(html).toContain("résultat"); // "N résultats affichés pour ..."
  });

  it("never emits a raw script tag from a hostile q", () => {
    const html = renderPaymentsPage({ ...paymentsBase, view: "bookings", q: '"><script>alert(1)</script>' } as any);
    expect(html).not.toContain("<script>alert");
  });

  it("renders an inline requalify form on a Wix booking row with a movement id", () => {
    const html = renderPaymentsPage({
      ...paymentsBase, view: "bookings",
      bookings: [mkBooking({ movementId: "mv-1", paymentMethod: "wix_unreconciled", amountXof: 12000 })],
    } as any);
    expect(html).toContain('action="/admin/paiements/tag"');
    expect(html).toContain('name="target_id" value="mv-1"');
    expect(html).toContain('name="return_to"');
    expect(html).toMatch(/return_to" value="[^"]*view=bookings/);
  });

  it("links an unmatched Wix booking to the accounting queue pre-filtered by client", () => {
    const html = renderPaymentsPage({
      ...paymentsBase, view: "bookings",
      bookings: [mkBooking({ movementId: null, paymentMethod: "wix_unreconciled" })],
    } as any);
    expect(html).toContain("Voir côté comptable");
    expect(html).toMatch(/view=payments[^"]*q=Awa[^"]*#pay-qualifier/);
  });

  it("shows an excluded Wix payment as 'Exclu', never a provider method or 'À qualifier'", () => {
    const html = renderPaymentsPage({
      ...paymentsBase, view: "bookings",
      bookings: [mkBooking({ movementId: "mv-2", paymentMethod: "wix_unreconciled", paymentExcluded: true })],
    } as any);
    expect(html).toContain("Exclu");
    expect(html).toContain("écarté des totaux");
    expect(html).not.toContain("À qualifier");
  });

  const mkMovement = (o: Partial<any> = {}) => ({
    origin: "wix", movementType: "payment", sourceKind: "wix_ecom", sourceId: "o1",
    providerTxId: null, clientName: "Awa Ba", clientPhone: "221778299595", label: "Sculpt",
    amountXof: 12000, method: null, methodOrigin: "provider", occurredAt: new Date("2026-08-11T12:00:00Z"),
    dateEstimated: false, targetId: "mv-1", excludedReason: null, ...o,
  });

  it("puts the qualifier queue above the movements table (no search)", () => {
    const html = renderPaymentsPage({ ...paymentsBase, view: "payments", untagged: [mkMovement()] } as any);
    expect(html.indexOf('id="pay-qualifier"')).toBeGreaterThan(-1);
    expect(html.indexOf('id="pay-qualifier"')).toBeLessThan(html.indexOf('id="pay-mouvements"'));
    // Healthy sync card is a footer: after the daily totals section.
    expect(html.indexOf("Synchronisation Wix")).toBeGreaterThan(html.indexOf('id="pay-journaliers"'));
  });

  it("surfaces a broken sync card at the top", () => {
    const html = renderPaymentsPage({
      ...paymentsBase, view: "payments",
      sync: { ...sync, lastError: "boom" },
    } as any);
    expect(html.indexOf("Synchronisation Wix")).toBeLessThan(html.indexOf('id="pay-mouvements"'));
  });

  it("shows results before the qualifier queue when searching", () => {
    const html = renderPaymentsPage({ ...paymentsBase, view: "payments", q: "awa", untagged: [mkMovement()] } as any);
    expect(html.indexOf('id="pay-mouvements"')).toBeLessThan(html.indexOf('id="pay-qualifier"'));
  });

  it("labels the source filter in plain French while keeping raw values", () => {
    const html = renderPaymentsPage({ ...paymentsBase, view: "payments" } as any);
    expect(html).toContain('value="wix_ecom"');
    expect(html).toContain("Wix boutique");
  });

  it("gives the payments view a single date control (no inline date picker)", () => {
    const html = renderPaymentsPage({ ...paymentsBase, view: "payments" } as any);
    // The only type=date inputs live in the Filtrer card; the movements range
    // bar is chips + an "Autre période" link.
    const beforeFiltres = html.slice(0, html.indexOf('id="pay-filtres"'));
    expect(beforeFiltres).not.toContain('type="date"');
    expect(html).toContain("Autre période");
  });
});
