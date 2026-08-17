import { describe, expect, it } from "vitest";
import {
  renderNotificationsPage,
  type NotificationsPageData,
} from "../src/admin/notificationsPage.js";
import type { NotificationRuleRow } from "../src/admin/queries.js";

function makeRule(over: Partial<NotificationRuleRow> = {}): NotificationRuleRow {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    label: "Effectif Aquabike intermédiaire",
    kind: "class_reminder",
    enabled: true,
    service_ids: ["svc-aqua-intermediate"],
    service_id: null,
    class_pattern: null,
    exclude_pattern: null,
    lead_minutes: 180,
    suppress_gap_minutes: 30,
    recipient_kind: "coach",
    recipient_phone: null,
    message_template: "{class_name} : {booked_count} inscrit(s)",
    group_only: true,
    ...over,
  };
}

function render(over: Partial<NotificationsPageData> = {}): string {
  return renderNotificationsPage({
    rules: [],
    contacts: [],
    log: [],
    lastByRule: new Map(),
    coachHints: [],
    serviceOptions: [
      { id: "svc-aqua-intermediate", name: "Aquabike (Intermédiaire)" },
      { id: "svc-yoga", name: "Power Yoga" },
    ],
    editRule: null,
    showNewForm: false,
    openSection: null,
    banner: "",
    testPhone: "221770000000",
    alertsPaused: false,
    ...over,
  });
}

describe("notifications admin — alert cards (default view)", () => {
  it("lists live alerts as cards, no form, with an edit link and a « + Nouvelle alerte » button", () => {
    const html = render({ rules: [makeRule()] });
    expect(html).toContain("Effectif Aquabike intermédiaire");
    // resolved course chip
    expect(html).toContain("Aquabike (Intermédiaire)");
    // no create form fields on the default view
    expect(html).not.toContain('name="all_services"');
    expect(html).not.toContain('name="service_ids"');
    // edit + new affordances
    expect(html).toContain(
      'href="/admin/notifications?edit=11111111-1111-4111-8111-111111111111#rule-form"',
    );
    expect(html).toContain('href="/admin/notifications?new=1#rule-form"');
    // action endpoints still present
    expect(html).toContain(
      'action="/admin/notifications/rules/11111111-1111-4111-8111-111111111111/toggle"',
    );
  });

  it("renders « Tous les cours » for an untargeted rule and an amber chip for a deleted course", () => {
    const html = render({
      rules: [
        makeRule({ id: "22222222-2222-4222-8222-222222222222", service_ids: null }),
        makeRule({ id: "33333333-3333-4333-8333-333333333333", service_ids: ["svc-gone"] }),
      ],
    });
    expect(html).toContain("Tous les cours");
    expect(html).toContain("cours supprimé de Wix");
  });
});

describe("notifications admin — the form (on demand)", () => {
  it("shows the multi-select course picker and drops the old pattern/kind fields", () => {
    const html = render({ showNewForm: true });
    expect(html).toContain('name="all_services"');
    expect(html).toContain('name="service_ids" value="svc-aqua-intermediate"');
    expect(html).toContain('name="service_ids" value="svc-yoga"');
    // legacy UI is gone
    expect(html).not.toContain('name="class_pattern"');
    expect(html).not.toContain('name="exclude_pattern"');
    expect(html).not.toContain('name="kind"');
    expect(html).not.toContain('name="days_of_week"');
    expect(html).not.toContain("fixed_schedule");
  });

  it("pre-checks the exact course of an edited service_ids rule", () => {
    const html = render({ editRule: makeRule(), showNewForm: false });
    expect(html).toContain('value="svc-aqua-intermediate" checked');
    expect(html).not.toContain('value="svc-yoga" checked');
  });

  it("migrates a legacy pattern rule by pre-checking the matching courses + a note", () => {
    const legacy = makeRule({
      service_ids: null,
      service_id: null,
      class_pattern: "aquabike",
    });
    const html = render({ editRule: legacy });
    expect(html).toContain('value="svc-aqua-intermediate" checked');
    expect(html).not.toContain('value="svc-yoga" checked');
    expect(html).toContain("Règle migrée depuis l'ancien filtre");
  });

  it("keeps a checked course that has vanished from the Wix catalogue", () => {
    const orphan = makeRule({ service_ids: ["svc-removed"] });
    const html = render({ editRule: orphan });
    expect(html).toContain('name="service_ids" value="svc-removed" checked');
    expect(html).toContain("Cours indisponible dans Wix");
  });

  it("checks « Tous les cours » for a rule with no targeting", () => {
    const all = makeRule({ service_ids: null, service_id: null, class_pattern: null });
    const html = render({ editRule: all });
    expect(html).toContain('name="all_services" id="all-svcs" value="1" checked');
  });
});

describe("notifications admin — collapsed sections", () => {
  it("keeps contacts and the journal inside <details> panels", () => {
    const html = render({
      contacts: [
        { id: "c1", name: "Gardien", phone: "+221780000000", role: "gardien", muted: false },
      ],
      log: [],
    });
    expect(html).toContain("<summary");
    expect(html).toContain("Répertoire staff (1)");
    expect(html).toContain("Journal des envois (0)");
  });

  it("auto-opens the contacts panel after a contact action", () => {
    const html = render({ openSection: "contacts" });
    expect(html).toMatch(/<details class="card"[^>]* open>\s*<summary[^>]*>Répertoire staff/);
  });

  it("shows the owner-alert destination and its end-to-end test button", () => {
    const html = render();
    expect(html).toContain("Alertes gérant");
    expect(html).toContain('action="/admin/notifications/owner-test"');
    expect(html).toContain("Tester l'alerte gérant");
  });
});
