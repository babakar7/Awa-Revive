import { describe, expect, it } from "vitest";
import { ADMIN_CLIENT_JS } from "../src/admin/adminClient.js";
import { renderInbox } from "../src/admin/inboxPage.js";
import { layout } from "../src/admin/layout.js";
import type { NavBadges } from "../src/admin/navBadges.js";

const badges: NavBadges = {
  refunds: 1,
  plans: 2,
  handoffs: 3,
  reviews: 4,
  crmLinks: 5,
  livraisons: 6,
  total: 21,
};

describe("admin design system shell", () => {
  it("renders task-oriented navigation and accessible mobile controls", async () => {
    const html = await layout("Réservations", "/admin/bookings", "<p>contenu</p>", {
      badges,
      subtitle: "Suivi du studio",
      contentWidth: "full",
      breadcrumbs: [{ href: "/admin", label: "Accueil" }, { label: "Réservations" }],
    });

    expect(html).toContain('class="sidebar"');
    expect(html).toContain('aria-current="page"');
    expect(html).toContain('aria-controls="admin-sidebar"');
    expect(html).toContain('id="global-client-search"');
    expect(html).toContain('class="content-full"');
    expect(html).toContain('id="confirm-dialog"');
    expect(html).toContain("#7c547d");
    expect(html).toContain("#a98baa");
    expect(html).toContain("font-size:16px");
    expect(html).toContain("--ink-500:#665c68");
    expect(html).toContain("--surface:#fbf7f2");
    expect(html).toContain("Suivi du studio");
    expect(html).toContain(ADMIN_CLIENT_JS);

    const overview = html.indexOf("Aperçu");
    const clients = html.indexOf("Clients");
    const studio = html.indexOf("Studio");
    const documents = html.indexOf("Documents");
    expect(overview).toBeLessThan(clients);
    expect(clients).toBeLessThan(studio);
    expect(studio).toBeLessThan(documents);
  });

  it("escapes titles, subtitles and breadcrumb labels", async () => {
    const html = await layout("<script>x</script>", "/admin", "", {
      badges,
      subtitle: '<img src=x onerror="bad">',
      breadcrumbs: [{ label: "<unsafe>" }],
    });

    expect(html).not.toContain("<script>x</script>");
    expect(html).not.toContain('<img src=x onerror="bad">');
    expect(html).toContain("&lt;unsafe&gt;");
  });
});

describe("admin operational homepage", () => {
  it("presents urgent work as an actionable queue", () => {
    const html = renderInbox({
      refunds: [{
        id: "refund-1",
        client_id: "client-1",
        client_name: "Awa <Test>",
        service_name: "Reformer",
        slot_start: new Date("2026-07-20T09:00:00Z"),
        participants: 1,
        amount_xof: 12_000,
        wave_session_id: "wave-1",
      }],
      planActivations: [],
      openHandoffs: [],
      openReviews: [],
      crmLinks: 0,
      livraisonAlerts: { late: 0, kitchenFailed: 0, clientFailed: 0, open: 0 },
      stats: {
        msgToday: 3,
        msg7d: 20,
        msg30d: 92,
        activeClientsToday: 2,
        activeClients7d: 12,
        activeClients30d: 44,
        bookingsToday: 4,
        bookings7d: 18,
        bookings30d: 71,
        revenueToday: 30_000,
        revenue7d: 210_000,
        revenue30d: 880_000,
        refundsPending: 1,
        handoffsOpen: 0,
      },
      badges: { ...badges, total: 1 },
      adminUser: "reception",
    });

    expect(html).toContain("Priorités du jour");
    expect(html.indexOf("Activité du studio")).toBeLessThan(html.indexOf("Paiements à finaliser"));
    expect(html).toContain('data-activity-period="week" aria-pressed="true"');
    expect(html).toContain('data-week="20"');
    expect(html).toContain('data-month="92"');
    expect(html).toContain("Résultats des 7 derniers jours");
    expect(html.match(/activity-stat-icon/g)).toHaveLength(4);
    expect(html).toContain("Paiements à finaliser");
    expect(html).toContain("Remboursement effectué");
    expect(html).toContain('data-confirm="Confirmer que le remboursement');
    expect(html).toContain("Awa &lt;Test&gt;");
    expect(html).not.toContain("Awa <Test>");
  });

  it("shows a calm all-clear state when no action is pending", () => {
    const html = renderInbox({
      refunds: [],
      planActivations: [],
      openHandoffs: [],
      openReviews: [],
      crmLinks: 0,
      livraisonAlerts: { late: 0, kitchenFailed: 0, clientFailed: 0, open: 0 },
      stats: {
        msgToday: 0,
        msg7d: 0,
        msg30d: 0,
        activeClientsToday: 0,
        activeClients7d: 0,
        activeClients30d: 0,
        bookingsToday: 0,
        bookings7d: 0,
        bookings30d: 0,
        revenueToday: 0,
        revenue7d: 0,
        revenue30d: 0,
        refundsPending: 0,
        handoffsOpen: 0,
      },
      badges: { ...badges, refunds: 0, plans: 0, handoffs: 0, reviews: 0, crmLinks: 0, livraisons: 0, total: 0 },
      adminUser: "reception",
    });

    expect(html).toContain("Rien d’urgent");
    expect(html).toContain("Paiements à jour");
    expect(html).toContain("Clients à jour");
  });
});
