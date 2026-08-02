import { describe, expect, it } from "vitest";
import {
  coachPaymentCourseBuckets,
  coachPaymentState,
} from "../src/domain/coachPaymentRules.js";
import { renderCoachPaymentsDashboard } from "../src/admin/coachPaymentsPage.js";
import type {
  CoachPaymentCockpitStatement,
  CoachPaymentProfile,
} from "../src/domain/coachPaymentRepo.js";

const now = new Date("2026-08-02T12:00:00Z");

function statement(overrides: Partial<CoachPaymentCockpitStatement> = {}): CoachPaymentCockpitStatement {
  return {
    id: "00000000-0000-4000-8000-000000000010",
    coach_profile_id: "00000000-0000-4000-8000-000000000001",
    month: "2026-06-01",
    version: 1,
    revises_statement_id: null,
    is_current: true,
    status: "draft",
    coach_name_snapshot: "Yass",
    coach_email_snapshot: null,
    wix_resource_id_snapshot: "coach-yass",
    tariff_json: { type: "per_session", perSessionXof: 9500 },
    sync_status: "ok",
    sync_error: null,
    synced_at: new Date("2026-07-01T00:00:00Z"),
    course_count: 3,
    base_total_xof: 28_500,
    adjustment_total_xof: 0,
    total_xof: 28_500,
    validated_at: null,
    validated_by: null,
    paid_at: null,
    paid_by: null,
    created_by: null,
    created_at: new Date("2026-06-01T00:00:00Z"),
    updated_at: new Date("2026-07-01T00:00:00Z"),
    reformer_count: 2,
    mat_count: 0,
    manual_count: 1,
    other_wix_count: 0,
    anomaly_count: 1,
    ...overrides,
  };
}

function profile(overrides: Partial<CoachPaymentProfile> = {}): CoachPaymentProfile {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    slug: "yass",
    display_name: "Yass",
    wix_resource_id: "coach-yass",
    email: "yass@revive.sn",
    formula_type: "per_session",
    base_amount_xof: null,
    base_session_count: null,
    per_session_xof: 9_500,
    enabled: true,
    created_at: new Date("2026-01-01T00:00:00Z"),
    updated_at: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  };
}

describe("shared coach payment state", () => {
  it.each([
    ["À préparer", null, true, "2026-06", ["statement_missing"]],
    ["Association Wix requise", statement({ sync_status: "unlinked" }), false, "2026-06", ["coach_unlinked"]],
    ["Erreur Wix", statement({ sync_status: "failed" }), true, "2026-06", ["sync_after_close_missing"]],
    ["Brouillon en cours", statement({ synced_at: new Date("2026-08-02T00:00:00Z") }), true, "2026-08", ["month_open", "sync_after_close_missing"]],
    ["À resynchroniser", statement({ synced_at: new Date("2026-06-30T23:59:59Z") }), true, "2026-06", ["sync_after_close_missing"]],
    ["À corriger", statement({ total_xof: -1 }), true, "2026-06", ["negative_total"]],
    ["Prêt à valider", statement(), true, "2026-06", []],
    ["Validé", statement({ status: "validated" }), true, "2026-06", []],
    ["Payé", statement({ status: "paid" }), true, "2026-06", []],
  ])("returns %s with its blockers", (expected, value, linked, month, blockers) => {
    const state = coachPaymentState({
      month: String(month),
      statement: value as CoachPaymentCockpitStatement | null,
      coachLinked: Boolean(linked),
      now,
    });
    expect(state.status).toBe(expected);
    expect(state.blockers).toEqual(expect.arrayContaining(blockers as string[]));
    expect(state.canValidate).toBe(expected === "Prêt à valider");
  });

  it("applies resynchronization before a negative-total correction", () => {
    expect(coachPaymentState({
      month: "2026-06",
      statement: statement({ total_xof: -1, synced_at: null }),
      coachLinked: true,
      now,
    }).status).toBe("À resynchroniser");
  });
});

describe("coach payment course buckets", () => {
  it("partitions included courses exactly once", () => {
    const buckets = coachPaymentCourseBuckets([
      { source: "manual", service_name: "Remplacement", included: true },
      { source: "wix", service_name: "Pilates Mat", included: true },
      { source: "wix", service_name: "Pilates Reformer", included: true },
      { source: "wix", service_name: "Atelier respiration", included: true },
      { source: "wix", service_name: "Pilates Reformer", included: false },
    ]);
    expect(buckets).toEqual({ manual: 1, mat: 1, reformer: 1, otherWix: 1, total: 4 });
    expect(buckets.manual + buckets.mat + buckets.reformer + buckets.otherWix).toBe(buckets.total);
  });
});

describe("coach payment cockpit coverage", () => {
  it("shows partial coverage and never turns a missing snapshot into zero", () => {
    const html = renderCoachPaymentsDashboard({
      month: "2026-06",
      profiles: [profile(), profile({ id: "00000000-0000-4000-8000-000000000002", display_name: "Leslie" })],
      statements: [statement()],
      banner: "",
      now,
    });
    expect(html).toContain("1 état sur 2 coachs");
    expect(html).toContain("28 500 FCFA");
    expect(html).toContain("À préparer");
    expect(html).toMatch(/data-label="Reformer">—/);
    expect(html).toContain("Mois précédent");
    expect(html).toContain("Mois suivant");
  });

  it("uses dashes for every uncovered indicator", () => {
    const html = renderCoachPaymentsDashboard({
      month: "2026-06",
      profiles: [profile()],
      statements: [],
      banner: "",
      now,
    });
    expect(html).toContain("0 état sur 1 coach");
    expect(html).not.toContain("0 FCFA");
    expect(html.match(/<b>—<\/b>/g)?.length).toBeGreaterThanOrEqual(3);
  });

  it("does not present a failed first Wix sync as a real zero snapshot", () => {
    const html = renderCoachPaymentsDashboard({
      month: "2026-06",
      profiles: [profile()],
      statements: [statement({
        sync_status: "failed",
        synced_at: null,
        course_count: 0,
        total_xof: 0,
        reformer_count: 0,
        manual_count: 0,
        anomaly_count: 0,
      })],
      banner: "",
      now,
    });
    expect(html).toContain("Erreur Wix");
    expect(html).toContain("0 état sur 1 coach");
    expect(html).not.toContain("0 FCFA");
  });
});
