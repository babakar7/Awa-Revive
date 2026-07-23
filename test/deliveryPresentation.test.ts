import { describe, expect, it } from "vitest";
import {
  deriveDeliveryPresentation,
  groupDeliveryOrders,
  sortDeliveryPresentations,
} from "../src/domain/deliveryPresentation.js";
import type { OpenDeliveryOrder } from "../src/domain/deliveryRepo.js";
import { renderLivraisonsBoardFragment } from "../src/admin/livraisonsPage.js";

const NOW = new Date("2026-07-23T12:00:00.000Z");

function order(
  overrides: Partial<OpenDeliveryOrder> = {},
): OpenDeliveryOrder {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    client_name: "Rama",
    client_phone: "221770000001",
    wix_contact_id: null,
    recipient_name: null,
    recipient_phone: null,
    address: "Almadies",
    note: null,
    items_json: [
      {
        id: "ESPRESSO",
        name: "Espresso",
        qty: 1,
        unitPriceXof: 2_000,
        lineTotalXof: 2_000,
      },
    ],
    amount_xof: 2_000,
    is_test: false,
    payment_status: "PAID",
    payment_method: "wave",
    active_payment_attempt_id: null,
    payment_ref: "pay-1",
    paid_at: new Date("2026-07-23T11:30:00.000Z"),
    payment_issue: null,
    status: "IN_KITCHEN",
    sla_minutes: 20,
    ready_token_hash: "hash",
    created_by: "reception",
    scheduled_for: null,
    kitchen_notify_at: null,
    activated_at: new Date("2026-07-23T11:50:00.000Z"),
    kitchen_notify_status: "sent",
    kitchen_notified_at: new Date("2026-07-23T11:50:00.000Z"),
    kitchen_notify_attempts: 1,
    activation_notify_status: "sent",
    activation_notified_at: null,
    activation_notify_attempts: 0,
    activation_notify_wamid: null,
    reschedule_notify_status: "sent",
    reschedule_notified_at: null,
    reschedule_notify_attempts: 0,
    reschedule_notify_wamid: null,
    created_notify_status: "sent",
    created_notified_at: new Date("2026-07-23T11:50:00.000Z"),
    created_notify_attempts: 1,
    created_notify_wamid: null,
    route_notify_status: "pending",
    route_notified_at: null,
    route_notify_attempts: 0,
    route_notify_wamid: null,
    recipient_route_notify_status: "sent",
    recipient_route_notified_at: null,
    recipient_route_notify_attempts: 0,
    recipient_route_notify_wamid: null,
    alerted_at: null,
    out_for_delivery_at: null,
    out_for_delivery_by: null,
    delivered_at: null,
    delivered_by: null,
    cancelled_at: null,
    cancelled_by: null,
    created_at: new Date("2026-07-23T11:50:00.000Z"),
    updated_at: new Date("2026-07-23T11:50:00.000Z"),
    kitchen_ticket_status: "PREPARING",
    kitchen_ready_at: null,
    ...overrides,
  } as OpenDeliveryOrder;
}

describe("delivery reception presentation", () => {
  it("classifies every operational state without changing business status", () => {
    expect(
      deriveDeliveryPresentation(
        order({
          scheduled_for: new Date("2026-07-24T13:00:00Z"),
          activated_at: null,
          kitchen_ticket_status: null,
        }),
        NOW,
      ),
    ).toMatchObject({ group: "scheduled", primaryAction: null });

    expect(
      deriveDeliveryPresentation(
        order({ payment_status: "AWAITING_PAYMENT" }),
        NOW,
      ),
    ).toMatchObject({
      group: "intervention",
      primaryAction: "resolve_payment",
      blockingReason: expect.stringContaining("Paiement mobile"),
    });

    expect(
      deriveDeliveryPresentation(
        order({ created_notify_status: "failed" }),
        NOW,
      ),
    ).toMatchObject({
      group: "intervention",
      primaryAction: null,
      blockingReason: expect.stringContaining("appeler"),
    });

    expect(
      deriveDeliveryPresentation(order({ kitchen_ticket_status: "PREPARING" }), NOW),
    ).toMatchObject({ group: "preparing", primaryAction: null });

    expect(
      deriveDeliveryPresentation(
        order({
          kitchen_ticket_status: "READY",
          kitchen_ready_at: new Date("2026-07-23T11:58:00Z"),
        }),
        NOW,
      ),
    ).toMatchObject({ group: "ready", primaryAction: "mark_departed" });

    expect(
      deriveDeliveryPresentation(
        order({
          status: "OUT_FOR_DELIVERY",
          out_for_delivery_at: new Date("2026-07-23T11:55:00Z"),
          kitchen_ticket_status: "COMPLETED",
          route_notify_status: "sent",
        }),
        NOW,
      ),
    ).toMatchObject({ group: "en_route", primaryAction: "mark_delivered" });

    expect(
      deriveDeliveryPresentation(
        order({ payment_status: "REFUND_NEEDED" }),
        NOW,
      ),
    ).toMatchObject({
      group: "intervention",
      primaryAction: null,
      blockingReason: expect.stringContaining("Remboursement"),
    });
  });

  it("surfaces a missing kitchen projection and never proposes departure", () => {
    const result = deriveDeliveryPresentation(
      order({ kitchen_ticket_status: null }),
      NOW,
    );
    expect(result.group).toBe("intervention");
    expect(result.blockingReason).toContain("Ticket cuisine manquant");
    expect(result.primaryAction).toBeNull();
  });

  it("orders late, then near deadlines, then oldest normal work", () => {
    const late = deriveDeliveryPresentation(
      order({
        id: "00000000-0000-4000-8000-000000000002",
        activated_at: new Date("2026-07-23T11:20:00Z"),
        created_at: new Date("2026-07-23T11:20:00Z"),
      }),
      NOW,
    );
    const soon = deriveDeliveryPresentation(
      order({
        id: "00000000-0000-4000-8000-000000000003",
        activated_at: new Date("2026-07-23T11:50:00Z"),
      }),
      NOW,
    );
    const normalOld = deriveDeliveryPresentation(
      order({
        id: "00000000-0000-4000-8000-000000000004",
        activated_at: new Date("2026-07-23T12:30:00Z"),
        created_at: new Date("2026-07-23T10:00:00Z"),
      }),
      NOW,
    );
    const normalNew = deriveDeliveryPresentation(
      order({
        id: "00000000-0000-4000-8000-000000000005",
        activated_at: new Date("2026-07-23T12:30:00Z"),
        created_at: new Date("2026-07-23T11:00:00Z"),
      }),
      NOW,
    );

    expect(
      sortDeliveryPresentations([normalNew, soon, late, normalOld]).map(
        (item) => item.order.id,
      ),
    ).toEqual([
      late.order.id,
      soon.order.id,
      normalOld.order.id,
      normalNew.order.id,
    ]);
  });

  it("builds group counters and at most one primary action per active card", () => {
    const groups = groupDeliveryOrders([
      order(),
      order({
        id: "00000000-0000-4000-8000-000000000006",
        payment_status: "PENDING_CHOICE",
      }),
    ], NOW);
    expect(groups.preparing).toHaveLength(1);
    expect(groups.intervention).toHaveLength(1);

    const html = renderLivraisonsBoardFragment(
      { open: [groups.preparing[0].order, groups.intervention[0].order], recent: [] },
      NOW,
    );
    const cards = html.match(/<article class="delivery-card[\s\S]*?<\/article>/g) ?? [];
    expect(cards).toHaveLength(2);
    for (const card of cards) {
      expect((card.match(/data-primary-action/g) ?? []).length).toBeLessThanOrEqual(1);
    }
    expect(html).not.toContain("<table");
    expect(html).toContain("Prêtes à partir");
    expect(html).toContain("Programmées");
  });
});
