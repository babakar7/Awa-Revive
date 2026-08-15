import { describe, expect, it } from "vitest";
import {
  renderCoachPaymentSettings,
  renderCoachPaymentStatement,
} from "../src/admin/coachPaymentsPage.js";
import type {
  CoachPaymentCourse,
  CoachPaymentProfile,
  CoachPaymentStatement,
  StatementDetail,
} from "../src/domain/coachPaymentRepo.js";

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

function statement(overrides: Partial<CoachPaymentStatement> = {}): CoachPaymentStatement {
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
    course_count: 2,
    base_total_xof: 19_000,
    holiday_course_count: 0,
    holiday_bonus_xof: 0,
    adjustment_total_xof: 0,
    total_xof: 19_000,
    validated_at: null,
    validated_by: null,
    paid_at: null,
    paid_by: null,
    created_by: null,
    created_at: new Date("2026-06-01T00:00:00Z"),
    updated_at: new Date("2026-07-01T00:00:00Z"),
    ...overrides,
  };
}

function course(overrides: Partial<CoachPaymentCourse> = {}): CoachPaymentCourse {
  return {
    id: "00000000-0000-4000-8000-000000000020",
    statement_id: "00000000-0000-4000-8000-000000000010",
    source: "wix",
    wix_event_id: "evt-1",
    service_id: "reformer-1",
    service_name: "Pilates Reformer",
    starts_at: new Date("2026-06-05T10:00:00Z"),
    ends_at: new Date("2026-06-05T10:50:00Z"),
    participant_count: 4,
    wix_status: "CONFIRMED",
    coach_resource_id: "coach-yass",
    coach_name: "Yass",
    included: true,
    manual_decision: false,
    manual_reason: null,
    holiday: false,
    raw_snapshot: null,
    created_at: new Date("2026-06-05T11:00:00Z"),
    ...overrides,
  };
}

function detail(overrides: Partial<StatementDetail> = {}): StatementDetail {
  const st = overrides.statement ?? statement();
  return {
    statement: st,
    profile: profile(),
    courses: overrides.courses ?? [course()],
    adjustments: overrides.adjustments ?? [],
    sends: overrides.sends ?? [],
    versions: overrides.versions ?? [st],
  };
}

describe("coach payment settings page", () => {
  it("offers only Wix coaches that do not already have a payment profile", () => {
    const html = renderCoachPaymentSettings({
      profiles: [profile()],
      holidays: [],
      resources: [
        { id: "coach-yass", name: "Yass", phone: null, email: "yass@revive.sn" },
        { id: "coach-awa", name: "Awa Ndiaye", phone: null, email: "awa@revive.sn" },
      ],
      banner: "",
    });

    const addForm = html.match(/<form class="card" id="ajouter-coach" method="post" action="\/admin\/paiements-coachs\/reglages" data-new-coach>[\s\S]*?<\/form>/)?.[0];
    expect(addForm).toBeTruthy();
    expect(addForm).toContain("Awa Ndiaye");
    expect(addForm).toContain("awa@revive.sn");
    expect(addForm).not.toContain("coach-yass");
    expect(html).toContain("Ajouter la coach");
    expect(html).toContain('<details class="payment-settings-item"');
    expect(html).not.toContain('<details class="payment-settings-item" open');
  });

  it("explains when every Wix coach is already configured", () => {
    const html = renderCoachPaymentSettings({
      profiles: [profile()],
      holidays: [],
      resources: [
        { id: "coach-yass", name: "Yass", phone: null, email: "yass@revive.sn" },
      ],
      banner: "",
    });

    expect(html).toContain("Toutes les ressources coach Wix ont déjà une fiche de paiement.");
  });

  it("renders the public-holiday section with its add and remove forms", () => {
    const html = renderCoachPaymentSettings({
      profiles: [profile()],
      holidays: [
        {
          id: "00000000-0000-4000-8000-0000000000f1",
          holiday_date: "2026-06-05",
          label: "Tabaski",
          created_by: "owner",
          created_at: new Date("2026-06-01T00:00:00Z"),
        },
      ],
      resources: [{ id: "coach-yass", name: "Yass", phone: null, email: "yass@revive.sn" }],
      banner: "",
    });

    expect(html).toContain("Jours fériés (+50 %)");
    expect(html).toContain('action="/admin/paiements-coachs/reglages/feries"');
    expect(html).toContain('action="/admin/paiements-coachs/reglages/feries/00000000-0000-4000-8000-0000000000f1/supprimer"');
    expect(html).toContain("Tabaski");
  });

  it("shows an empty state when no holiday is defined", () => {
    const html = renderCoachPaymentSettings({
      profiles: [profile()],
      holidays: [],
      resources: [{ id: "coach-yass", name: "Yass", phone: null, email: "yass@revive.sn" }],
      banner: "",
    });
    expect(html).toContain("Aucun jour férié défini");
  });
});

describe("coach payment statement holiday markup", () => {
  it("badges holiday courses and shows the markup line in the calcul", () => {
    const html = renderCoachPaymentStatement({
      detail: detail({
        statement: statement({
          holiday_course_count: 1,
          holiday_bonus_xof: 4_750,
          total_xof: 23_750,
        }),
        courses: [
          course({ holiday: true }),
          course({ id: "00000000-0000-4000-8000-000000000021", wix_event_id: "evt-2", starts_at: new Date("2026-06-12T10:00:00Z") }),
        ],
      }),
      banner: "",
      emailEnabled: false,
    });
    expect(html).toContain("Férié +50 %");
    expect(html).toContain("Majoration jours fériés (+50 %) · 1 séance(s)");
    expect(html).toContain("+ 4 750 FCFA");
  });

  it("hides the markup line when no holiday course is counted", () => {
    const html = renderCoachPaymentStatement({
      detail: detail(),
      banner: "",
      emailEnabled: false,
    });
    expect(html).not.toContain("Majoration jours fériés");
    expect(html).not.toContain("Férié +50 %");
  });
});

describe("coach payment excluded-courses recap", () => {
  it("lists every excluded course with its exclusion reason", () => {
    const html = renderCoachPaymentStatement({
      detail: detail({
        courses: [
          course(),
          course({ id: "00000000-0000-4000-8000-000000000031", wix_event_id: "evt-cancel", wix_status: "CANCELLED", included: false }),
          course({ id: "00000000-0000-4000-8000-000000000032", wix_event_id: "evt-empty", participant_count: 0, included: false }),
          course({ id: "00000000-0000-4000-8000-000000000033", wix_event_id: "evt-manual", included: false, manual_decision: true }),
        ],
      }),
      banner: "",
      emailEnabled: false,
    });
    expect(html).toContain("Séances exclues du calcul");
    expect(html).toContain("Séance annulée");
    expect(html).toContain("Séance vide (0 participant)");
    expect(html).toContain("Exclue manuellement");
  });

  it("omits the recap when every course is counted", () => {
    const html = renderCoachPaymentStatement({
      detail: detail(),
      banner: "",
      emailEnabled: false,
    });
    expect(html).not.toContain("Séances exclues du calcul");
  });
});
