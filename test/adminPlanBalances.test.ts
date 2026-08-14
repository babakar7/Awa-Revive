import { describe, expect, it } from "vitest";
import {
  assemblePlanBalanceRows,
  renderPlanBalances,
} from "../src/admin/planBalancesPage.js";
import type { PoolBalance } from "../src/lib/wix.js";

const order = (id: string, contactId: string, planName: string, endDate: string | null) => ({
  id,
  planName,
  endDate,
  buyer: { contactId, memberId: contactId },
});

const pool = (orderId: string, available: string, total: string, reserved = "0"): PoolBalance => ({
  orderId,
  planId: "plan-1",
  memberId: "m",
  status: "ACTIVE",
  total,
  available,
  reserved,
});

describe("Soldes séances — assemblage", () => {
  it("joins orders with their credit pool and resolves client names", () => {
    const rows = assemblePlanBalanceRows(
      [order("o1", "c1", "L'Invitée — Clé 3 séances", "2026-09-04T23:59:59.999Z")],
      [pool("o1", "2", "3")],
      new Map([["c1", "Mame Mbarou"]]),
    );
    expect(rows).toEqual([
      {
        clientName: "Mame Mbarou",
        planName: "L'Invitée — Clé 3 séances",
        endDate: "2026-09-04T23:59:59.999Z",
        available: 2,
        total: 3,
        reserved: 0,
      },
    ]);
  });

  it("keeps an order with no matching pool visible as an anomaly (never invents 0)", () => {
    const rows = assemblePlanBalanceRows(
      [order("orphan", "c1", "Carnet", "2026-09-01T00:00:00Z")],
      [],
      new Map(),
    );
    expect(rows[0].available).toBeNull();
    expect(rows[0].total).toBeNull();
    const html = renderPlanBalances(rows);
    expect(html).toContain("Solde introuvable");
    expect(html).not.toContain("0 / ");
  });

  it("sorts by end date (soonest first), unknown dates last", () => {
    const rows = assemblePlanBalanceRows(
      [
        order("late", "c1", "Plan", "2026-10-01T00:00:00Z"),
        order("none", "c2", "Plan", null),
        order("soon", "c3", "Plan", "2026-08-20T00:00:00Z"),
      ],
      [pool("late", "1", "3"), pool("none", "2", "3"), pool("soon", "3", "3")],
      new Map(),
    );
    expect(rows.map((r) => r.available)).toEqual([3, 1, 2]);
  });
});

describe("Soldes séances — rendu", () => {
  const rows = assemblePlanBalanceRows(
    [
      order("o1", "c1", "L'Invitée — Clé 3 séances", "2026-09-04T23:59:59.999Z"),
      order("o2", "c2", "Carnet de 10 Bébé nageur et Natation", "2026-10-14T23:59:59.999Z"),
      order("o3", "c3", "Carnet épuisé", "2026-12-01T00:00:00Z"),
    ],
    [pool("o1", "2", "3"), pool("o2", "9", "10", "1"), pool("o3", "0", "10")],
    new Map([
      ["c1", "Mame Mbarou"],
      ["c2", "Mariama Thiam"],
    ]),
  );
  const html = renderPlanBalances(rows);

  it("shows each subscription with its live balance", () => {
    expect(html).toContain("Mame Mbarou");
    expect(html).toContain("2 / 3");
    expect(html).toContain("Mariama Thiam");
    expect(html).toContain("9 / 10");
    expect(html).toContain("(+1 réservée)");
  });

  it("flags an empty balance without hiding the row", () => {
    expect(html).toContain("0 / 10");
    expect(html).toContain("badge--gray");
  });

  it("escapes client-sourced text", () => {
    const evil = assemblePlanBalanceRows(
      [order("o1", "c1", "<script>alert(1)</script>", null)],
      [pool("o1", "1", "3")],
      new Map([["c1", "<img src=x>"]]),
    );
    const out = renderPlanBalances(evil);
    expect(out).not.toContain("<script>alert(1)</script>");
    expect(out).not.toContain("<img src=x>");
  });

  it("announces a partial Wix failure instead of an empty silent page", () => {
    const out = renderPlanBalances([], true);
    expect(out).toContain("Wix n'a pas répondu complètement");
    expect(out).toContain("Aucun abonnement actif");
  });
});
