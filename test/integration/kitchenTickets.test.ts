import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { pool, migrate } from "../../src/db/index.js";
import { truncateAll } from "./helpers.js";
import type { ExtraLine } from "../../src/lib/cafeMenu.js";
import {
  createDeliveryOrder,
  selectDeliveryCash,
  markOutForDelivery,
  markCancelled,
  activateDueScheduledDeliveries,
} from "../../src/domain/deliveryRepo.js";
import {
  createDeliveryTicket,
  advanceTicketByCuisine,
  ackTicketDisplayed,
  claimTicketFallback,
  completeTicketForDelivery,
  cancelTicketForDelivery,
  reconcileDeliveryTickets,
  listOpenKitchenTickets,
  ticketByDeliveryOrder,
} from "../../src/domain/kitchenTicketRepo.js";
import { opsEventsSince, latestOpsEventId } from "../../src/domain/opsEvents.js";
import {
  createPairingDevice,
  redeemPairing,
  verifyDeviceSession,
  revokeOpsDevice,
} from "../../src/domain/opsDeviceRepo.js";
import { hashOpsToken, newOpsToken, newPairCode } from "../../src/ops/opsAuth.js";

/**
 * Kitchen-ticket projection + ops device pairing, end-to-end against a real
 * Postgres. Locks the exact behaviours the cuisine iPad relies on: create at
 * activation (idempotent), the NEW→PREPARING→READY machine, iPad ack cancels the
 * fallback, the atomic single-send fallback claim, delivery→ticket reconcile
 * (create/complete/cancel), the ops_events log powering SSE catch-up, and
 * revocable device sessions.
 */

const ITEMS: ExtraLine[] = [
  { id: "JANTBI", name: "Jant Bi", qty: 2, unitPriceXof: 3000, lineTotalXof: 6000 },
];

async function makeImmediateOrder(overrides: Partial<{ is_test: boolean }> = {}) {
  const { order } = await createDeliveryOrder({
    client_name: "Awa Diop",
    client_phone: "221771112233",
    wix_contact_id: null,
    address: "Almadies, villa 12",
    note: "sans sucre",
    items: ITEMS,
    amount_xof: 6000,
    sla_minutes: 20,
    created_by: "test",
    is_test: overrides.is_test ?? false,
    scheduled_for: null,
    kitchen_notify_at: null,
  });
  return order;
}

beforeAll(async () => {
  await migrate();
});

beforeEach(async () => {
  await truncateAll();
  await pool.query("truncate kitchen_tickets, ops_devices, ops_events restart identity cascade");
});

describe("createDeliveryTicket", () => {
  it("creates a NEW ticket that mirrors the order and emits ticket_new", async () => {
    const order = await makeImmediateOrder();
    const before = await latestOpsEventId("cuisine");
    const { ticket, created } = await createDeliveryTicket(order, 15);
    expect(created).toBe(true);
    expect(ticket.status).toBe("NEW");
    expect(ticket.source).toBe("DELIVERY");
    expect(ticket.heading).toBe("Awa Diop");
    expect(ticket.subheading).toBe("Almadies, villa 12");
    expect(ticket.note).toBe("sans sucre");
    expect(ticket.fallback_due_at).not.toBeNull();

    const events = await opsEventsSince("cuisine", before);
    expect(events.some((e) => e.kind === "ticket_new")).toBe(true);
  });

  it("is idempotent on delivery_order_id (retry/sweep never double-creates)", async () => {
    const order = await makeImmediateOrder();
    const first = await createDeliveryTicket(order, 15);
    const second = await createDeliveryTicket(order, 15);
    expect(second.created).toBe(false);
    expect(second.ticket.id).toBe(first.ticket.id);
    const open = await listOpenKitchenTickets();
    expect(open).toHaveLength(1);
  });
});

describe("cuisine transitions", () => {
  it("advances NEW → PREPARING → READY and rejects backward/stale taps", async () => {
    const order = await makeImmediateOrder();
    const { ticket } = await createDeliveryTicket(order, 15);

    const prep = await advanceTicketByCuisine(ticket.id, "PREPARING", "iPad Cuisine");
    expect(prep?.status).toBe("PREPARING");
    expect(prep?.claimed_by).toBe("iPad Cuisine");

    const ready = await advanceTicketByCuisine(ticket.id, "READY", "iPad Cuisine");
    expect(ready?.status).toBe("READY");
    expect(ready?.ready_at).not.toBeNull();

    // Already READY → a second READY tap (or a backward move) is a no-op.
    expect(await advanceTicketByCuisine(ticket.id, "READY", "iPad Cuisine")).toBeNull();
    expect(await advanceTicketByCuisine(ticket.id, "PREPARING", "iPad Cuisine")).toBeNull();
  });

  it("allows NEW → READY directly for quick items", async () => {
    const order = await makeImmediateOrder();
    const { ticket } = await createDeliveryTicket(order, 15);
    const ready = await advanceTicketByCuisine(ticket.id, "READY", null);
    expect(ready?.status).toBe("READY");
  });
});

describe("iPad ack + WhatsApp fallback", () => {
  it("an ack cancels the fallback; without it the claim fires exactly once", async () => {
    const acked = await makeImmediateOrder();
    const ackedTicket = (await createDeliveryTicket(acked, 15)).ticket;
    // Make both tickets already due.
    await pool.query("update kitchen_tickets set fallback_due_at = now() - interval '1 second'");
    expect(await ackTicketDisplayed(ackedTicket.id)).toBe(true);
    expect(await claimTicketFallback(ackedTicket.id)).toBeNull(); // acked → never fires

    const unacked = await makeImmediateOrder();
    const unackedTicket = (await createDeliveryTicket(unacked, 15)).ticket;
    await pool.query(
      "update kitchen_tickets set fallback_due_at = now() - interval '1 second' where id = $1",
      [unackedTicket.id],
    );
    const first = await claimTicketFallback(unackedTicket.id);
    expect(first?.deliveryOrderId).toBe(unacked.id);
    // Second claim (timer vs sweep race) returns nothing → single send.
    expect(await claimTicketFallback(unackedTicket.id)).toBeNull();
  });

  it("the fallback is not due before its deadline", async () => {
    const order = await makeImmediateOrder();
    const { ticket } = await createDeliveryTicket(order, 3600); // 1h grace
    expect(await claimTicketFallback(ticket.id)).toBeNull();
  });
});

describe("reconcile (delivery → ticket projection)", () => {
  it("completes the ticket when the delivery departs", async () => {
    const order = await makeImmediateOrder();
    await createDeliveryTicket(order, 15);
    await selectDeliveryCash(order.id); // CASH_DUE so departure is allowed
    const departed = await markOutForDelivery(order.id, "test");
    expect(departed?.status).toBe("OUT_FOR_DELIVERY");

    const res = await reconcileDeliveryTickets(15);
    expect(res.completed).toBe(1);
    const ticket = await ticketByDeliveryOrder(order.id);
    expect(ticket?.status).toBe("COMPLETED");
    expect(await listOpenKitchenTickets()).toHaveLength(0);
  });

  it("cancels the ticket when the delivery is cancelled", async () => {
    const order = await makeImmediateOrder();
    await createDeliveryTicket(order, 15);
    await markCancelled(order.id, "test");
    const res = await reconcileDeliveryTickets(15);
    expect(res.cancelled).toBe(1);
    expect((await ticketByDeliveryOrder(order.id))?.status).toBe("CANCELLED");
  });

  it("creates no ticket before activation, then one at activation", async () => {
    // Scheduled: arrival in the future, kitchen deadline still ahead → inactive.
    const future = new Date(Date.now() + 60 * 60 * 1000);
    const { order } = await createDeliveryOrder({
      client_name: "Later Client",
      client_phone: "221770000009",
      wix_contact_id: null,
      address: "Ngor",
      note: null,
      items: ITEMS,
      amount_xof: 6000,
      sla_minutes: 20,
      created_by: "test",
      is_test: false,
      scheduled_for: future,
      kitchen_notify_at: future,
    });
    expect(order.activated_at).toBeNull();

    let res = await reconcileDeliveryTickets(15);
    expect(res.created).toBe(0);
    expect(await ticketByDeliveryOrder(order.id)).toBeNull();

    // Bring the kitchen deadline into the past and activate.
    await pool.query(
      "update delivery_orders set kitchen_notify_at = now() - interval '1 minute' where id = $1",
      [order.id],
    );
    const activated = await activateDueScheduledDeliveries();
    expect(activated).toHaveLength(1);

    res = await reconcileDeliveryTickets(15);
    expect(res.created).toBe(1);
    expect((await ticketByDeliveryOrder(order.id))?.status).toBe("NEW");
  });
});

describe("source-driven terminal helpers", () => {
  it("completeTicketForDelivery / cancelTicketForDelivery emit ticket_removed", async () => {
    const a = await makeImmediateOrder();
    const b = await makeImmediateOrder();
    await createDeliveryTicket(a, 15);
    await createDeliveryTicket(b, 15);
    const cursor = await latestOpsEventId("cuisine");

    expect((await completeTicketForDelivery(a.id))?.status).toBe("COMPLETED");
    expect((await cancelTicketForDelivery(b.id, "annulée"))?.status).toBe("CANCELLED");

    const events = await opsEventsSince("cuisine", cursor);
    expect(events.filter((e) => e.kind === "ticket_removed")).toHaveLength(2);
  });
});

describe("ops device pairing", () => {
  it("redeems a code once, resolves the session, then revokes durably", async () => {
    const code = newPairCode();
    const device = await createPairingDevice(
      "iPad Cuisine",
      "cuisine",
      hashOpsToken(code),
      new Date(Date.now() + 10 * 60 * 1000),
    );
    expect(device.paired_at).toBeNull();

    const token = newOpsToken();
    const paired = await redeemPairing(hashOpsToken(code), hashOpsToken(token));
    expect(paired?.id).toBe(device.id);
    expect(paired?.paired_at).not.toBeNull();

    // The code is single-use.
    expect(await redeemPairing(hashOpsToken(code), hashOpsToken(newOpsToken()))).toBeNull();

    // Session resolves, and role isolation is enforced.
    expect((await verifyDeviceSession(hashOpsToken(token), "cuisine"))?.id).toBe(device.id);
    expect(await verifyDeviceSession(hashOpsToken(token), "accueil")).toBeNull();

    // Revocation is durable: the session stops resolving immediately.
    expect(await revokeOpsDevice(device.id)).toBe(true);
    expect(await verifyDeviceSession(hashOpsToken(token), "cuisine")).toBeNull();
  });

  it("rejects an expired pairing code", async () => {
    const code = newPairCode();
    await createPairingDevice(
      "iPad Cuisine",
      "cuisine",
      hashOpsToken(code),
      new Date(Date.now() - 1000), // already expired
    );
    expect(await redeemPairing(hashOpsToken(code), hashOpsToken(newOpsToken()))).toBeNull();
  });
});
