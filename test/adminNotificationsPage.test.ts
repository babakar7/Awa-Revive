import { describe, expect, it } from "vitest";
import { renderNotificationsPage } from "../src/admin/notificationsPage.js";
import type { NotificationRuleRow } from "../src/admin/queries.js";

const rule: NotificationRuleRow = {
  id: "11111111-1111-4111-8111-111111111111",
  label: "Effectif Aquabike intermédiaire",
  kind: "class_reminder",
  enabled: true,
  service_id: "svc-aqua-intermediate",
  class_pattern: null,
  exclude_pattern: null,
  lead_minutes: 180,
  suppress_gap_minutes: 30,
  recipient_kind: "coach",
  recipient_phone: null,
  days_of_week: null,
  send_time: null,
  message_template: "{class_name} : {booked_count} inscrit(s)",
  group_only: true,
};

describe("notifications admin — exact course selector", () => {
  it("renders the live Wix courses and keeps the edited course selected", () => {
    const html = renderNotificationsPage({
      rules: [rule],
      contacts: [],
      log: [],
      lastByRule: new Map(),
      coachHints: [],
      serviceOptions: [
        { id: "svc-aqua-intermediate", name: "Aquabike (Intermédiaire)" },
        { id: "svc-yoga", name: "Power Yoga" },
      ],
      editRule: rule,
      banner: "",
      testPhone: "221770000000",
      alertsPaused: false,
    });

    expect(html).toContain(`select name="service_id" id="service-select"`);
    expect(html).toContain(
      `<option value="svc-aqua-intermediate" selected>Aquabike (Intermédiaire)</option>`,
    );
    expect(html).toContain("le cours « Aquabike (Intermédiaire) »");
    expect(html).toContain("Le catalogue vient de Wix");
  });

  it("keeps the all-courses option for existing general coach alerts", () => {
    const html = renderNotificationsPage({
      rules: [],
      contacts: [],
      log: [],
      lastByRule: new Map(),
      coachHints: [],
      serviceOptions: [{ id: "svc-yoga", name: "Power Yoga" }],
      editRule: null,
      banner: "",
      testPhone: "221770000000",
      alertsPaused: false,
    });
    expect(html).toContain("Tous les cours / utiliser les filtres ci-dessous");
  });
});
