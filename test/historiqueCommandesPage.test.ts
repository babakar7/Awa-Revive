import { describe, expect, it } from "vitest";
import {
  renderHistoriqueCommandes,
  type HistoriqueCommandesData,
} from "../src/admin/historiqueCommandesPage.js";
import type {
  OrderHistoryFilters,
  OrderHistoryRow,
  PageResult,
} from "../src/admin/queries.js";

function row(overrides: Partial<OrderHistoryRow> = {}): OrderHistoryRow {
  return {
    id: "kt:1",
    created_at: new Date("2026-08-06T10:00:00Z"),
    channel: "SUR_PLACE",
    status: "COMPLETED",
    amount_xof: 5000,
    heading: "Awa D.",
    detail: "C-24",
    items_json: [
      { id: "cafe", name: "Café", qty: 2, unitPriceXof: 1000, lineTotalXof: 2000 },
      { id: "jus", name: "Jus bissap", qty: 1, unitPriceXof: 1500, lineTotalXof: 1500 },
    ],
    client_id: "client-1",
    ...overrides,
  };
}

function data(overrides: Partial<HistoriqueCommandesData> = {}): HistoriqueCommandesData {
  const rows = overrides.result?.rows ?? [row()];
  const result: PageResult<OrderHistoryRow> = overrides.result ?? {
    rows,
    page: 1,
    pageSize: 50,
    total: rows.length,
    pages: 1,
  };
  const filters: OrderHistoryFilters = overrides.filters ?? {
    period: "7",
    channel: "all",
    status: "all",
    page: 1,
  };
  return {
    result,
    filters,
    stats: {
      completed: 12,
      cancelled: 1,
      open: 2,
      revenueXof: 60000,
      avgTicketXof: 5000,
      previousCompleted: 10,
      previousRevenueXof: 50000,
      firstOrderAt: new Date("2026-07-28T09:00:00Z"),
      ...overrides.stats,
    },
    byChannel: overrides.byChannel ?? [
      { channel: "SUR_PLACE", orders: 5, revenueXof: 25000 },
      { channel: "A_EMPORTER", orders: 3, revenueXof: 15000 },
      { channel: "RETRAIT", orders: 1, revenueXof: 5000 },
      { channel: "LIVRAISON", orders: 3, revenueXof: 15000 },
    ],
    daily: overrides.daily ?? [
      { day: "2026-08-05", orders: 2, revenueXof: 10000 },
      { day: "2026-08-06", orders: 4, revenueXof: 20000 },
    ],
  };
}

describe("renderHistoriqueCommandes", () => {
  it("renders channels, KPIs and a linked client row", () => {
    const html = renderHistoriqueCommandes(data());
    expect(html).toContain("Historique des commandes");
    expect(html).toContain("Sur place");
    expect(html).toContain("Livraison");
    expect(html).toContain("2× Café");
    expect(html).toContain('href="/admin/conversations/client-1"');
    // trend vs previous window
    expect(html).toContain("vs période précédente");
    // honesty footnote
    expect(html).toContain("le POS reste la seule source comptable");
  });

  it("escapes DB-sourced item and client names", () => {
    const html = renderHistoriqueCommandes(
      data({
        result: {
          rows: [
            row({
              heading: "<b>x</b>",
              client_id: null,
              items_json: [
                { id: "x", name: "<script>", qty: 1, unitPriceXof: 1, lineTotalXof: 1 },
              ],
            }),
          ],
          page: 1,
          pageSize: 50,
          total: 1,
          pages: 1,
        },
      }),
    );
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;b&gt;x&lt;/b&gt;");
  });

  it("shows an empty state when there are no orders", () => {
    const html = renderHistoriqueCommandes(
      data({ result: { rows: [], page: 1, pageSize: 50, total: 0, pages: 1 } }),
    );
    expect(html).toContain("Aucune commande");
  });

  it("scales trend bar heights to the max daily revenue", () => {
    const html = renderHistoriqueCommandes(data());
    // max revenue day (20000) → 100%, the other (10000) → 50%
    expect(html).toContain("height:100%");
    expect(html).toContain("height:50%");
  });

  it("builds pagination links that preserve the active filters", () => {
    const html = renderHistoriqueCommandes(
      data({
        filters: { period: "30", channel: "LIVRAISON", status: "COMPLETED", page: 1 },
        result: { rows: [row()], page: 1, pageSize: 50, total: 120, pages: 3 },
      }),
    );
    expect(html).toContain("Suivant");
    expect(html).toContain("period=30");
    expect(html).toContain("channel=LIVRAISON");
    expect(html).toContain("status=COMPLETED");
    expect(html).toContain("page=2");
  });

  it("marks the active filter tabs", () => {
    const html = renderHistoriqueCommandes(
      data({ filters: { period: "30", channel: "all", status: "all", page: 1 } }),
    );
    expect(html).toContain('aria-current="page"');
  });
});
