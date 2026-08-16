import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../../src/server.js";
import { config } from "../../src/config.js";
import { pool } from "../../src/db/index.js";
import { truncateAll } from "./helpers.js";
import { type ExtraLine, type CafeMenuRow, setCafeMenu } from "../../src/lib/cafeMenu.js";
import { createPairingDevice } from "../../src/domain/opsDeviceRepo.js";
import { hashOpsToken, newPairCode } from "../../src/ops/opsAuth.js";
import { listActiveSpots } from "../../src/domain/serviceSpotRepo.js";
import {
  openSessionAtSpot,
  getOpenSessionBySpot,
  listOpenSessions,
  getOpenSession,
  closeSession,
  closeEmptyOpenSessions,
  publishOpenSessionUpdate,
  listRecentClosedSessions,
} from "../../src/domain/serviceSessionRepo.js";
import {
  createTableTicket,
  advanceTicketByCuisine,
  claimTableServe,
  serveTableTicket,
  cancelTableTicket,
  setTicketUrgent,
  kitchenTicketView,
  ticketStatsToday,
  getKitchenTicket,
  ticketsForSession,
  listOpenKitchenTickets,
  listRecentClosedTickets,
  claimStaleServeEscalations,
  topOrderedItemIds,
  __resetTopCache,
  activateDueTableTickets,
  activateTableTicketNow,
} from "../../src/domain/kitchenTicketRepo.js";
import {
  savePushSubscription,
  listPushSubscriptionsForRole,
  deletePushSubscription,
} from "../../src/domain/pushRepo.js";
import { opsEventsSince, latestOpsEventId } from "../../src/domain/opsEvents.js";

/**
 * On-site FIXED-spot service + TABLE kitchen tickets against a real Postgres.
 * Locks the Phase 2 invariants: one open session per spot (tap an occupied spot
 * → the existing session), the atomic "Je prends" claim, "Servie" leaving both
 * boards, and — the safety one — a session can't be freed while a ticket is still
 * open. The seeded service_areas + service_spots survive beforeEach.
 */

const LINES: ExtraLine[] = [
  { id: "JANTBI", name: "Jant Bi", qty: 2, unitPriceXof: 3000, lineTotalXof: 6000, note: "sans sucre" },
];

let canapeSpot: string;
let terrasseSpot: string;
let pergolaSpot: string;


beforeEach(async () => {
  await truncateAll();
  await pool.query(
    "truncate kitchen_tickets, ops_devices, ops_events, service_sessions, push_subscriptions restart identity cascade",
  );
  __resetTopCache(); // the 5-min best-seller memo must not leak across truncations
  const spots = await listActiveSpots();
  canapeSpot = spots.find((s) => s.label === "Canapé")!.id;
  terrasseSpot = spots.find((s) => s.label === "Terrasse")!.id;
  pergolaSpot = spots.find((s) => s.label === "Pergola")!.id;
});

let reqSeq = 0;
const reqId = () => `req-${Date.now()}-${reqSeq++}`;

async function seat(spotId: string, firstName?: string) {
  const s = await openSessionAtSpot({ spotId, firstName, openedBy: "Accueil 1" });
  if (!s) throw new Error("session not opened");
  return s;
}

async function makeTableTicket(sessionId: string, heading: string) {
  const { ticket } = await createTableTicket({
    sessionId,
    heading,
    subheading: "Canapé · Awa",
    lines: LINES,
    amountXof: 6000,
    note: null,
    clientRequestId: reqId(),
    isTest: false,
  });
  return ticket;
}

describe("spots seed", () => {
  it("seeds one spot per space with capacities", async () => {
    const spots = await listActiveSpots();
    const byLabel = Object.fromEntries(spots.map((s) => [s.label, s]));
    expect(Object.keys(byLabel).sort()).toEqual(["Canapé", "Pergola", "Terrasse"]);
    expect(byLabel["Canapé"].capacity).toBe(4);
    expect(byLabel["Terrasse"].capacity).toBe(6);
    expect(byLabel["Terrasse"].capacity_max).toBe(8);
    expect(byLabel["Pergola"].capacity).toBe(10);
  });
});

describe("openSessionAtSpot", () => {
  it("opens a session whose code IS the spot label, and emits session_new", async () => {
    const before = await latestOpsEventId("accueil");
    const s = await seat(canapeSpot, "Awa");
    expect(s.spot_id).toBe(canapeSpot);
    expect(s.short_code).toBe("Canapé");
    expect(s.first_name).toBe("Awa");
    const events = await opsEventsSince("accueil", before);
    expect(events.some((e) => e.kind === "session_new")).toBe(true);
  });

  it("a second tap on an occupied spot returns the SAME session (idempotent)", async () => {
    const first = await seat(canapeSpot, "Awa");
    const again = await openSessionAtSpot({ spotId: canapeSpot, firstName: "Bby" });
    expect(again?.id).toBe(first.id);
    expect(again?.first_name).toBe("Awa"); // original kept
    expect(await listOpenSessions()).toHaveLength(1);
  });

  it("frees the spot on close, so it can be seated again", async () => {
    const first = await seat(canapeSpot);
    expect((await closeSession(first.id, "Accueil 1")).ok).toBe(true);
    expect(await getOpenSessionBySpot(canapeSpot)).toBeNull();
    const second = await seat(canapeSpot);
    expect(second.id).not.toBe(first.id);
  });

  it("different spots are independent", async () => {
    const a = await seat(canapeSpot);
    const b = await seat(terrasseSpot);
    expect(a.id).not.toBe(b.id);
    expect((await listOpenSessions()).length).toBe(2);
  });
});

describe("createTableTicket", () => {
  it("creates a NEW TABLE ticket on both channels, no WhatsApp fallback", async () => {
    const s = await seat(canapeSpot);
    const beforeCuisine = await latestOpsEventId("cuisine");
    const beforeAccueil = await latestOpsEventId("accueil");
    const t = await makeTableTicket(s.id, s.short_code);
    expect(t.status).toBe("NEW");
    expect(t.source).toBe("TABLE");
    expect(t.session_id).toBe(s.id);
    expect(t.delivery_order_id).toBeNull();
    expect(t.fallback_due_at).toBeNull();
    expect((t.items_json as any[])[0].note).toBe("sans sucre");
    expect((await opsEventsSince("cuisine", beforeCuisine)).some((e) => e.kind === "ticket_new")).toBe(true);
    expect((await opsEventsSince("accueil", beforeAccueil)).some((e) => e.kind === "ticket_new")).toBe(true);
  });

  it("holds a future TABLE ticket until its preparation window, then activates once", async () => {
    const s = await seat(canapeSpot);
    const scheduledFor = new Date(Date.now() + 10 * 60_000); // already inside the 15-min prep window
    const { ticket } = await createTableTicket({
      sessionId: s.id, heading: s.short_code, subheading: "Canapé", lines: LINES,
      amountXof: 6000, note: null, clientRequestId: reqId(), isTest: false, scheduledFor,
    });
    expect(ticket.scheduled_for).not.toBeNull();
    expect(ticket.activated_at).toBeNull();
    expect(await advanceTicketByCuisine(ticket.id, "PREPARING", "Cuisine")).toBeNull();

    const before = await latestOpsEventId("cuisine");
    const activated = await activateDueTableTickets();
    expect(activated.map((t) => t.id)).toContain(ticket.id);
    expect(activated[0].activated_at).not.toBeNull();
    expect((await opsEventsSince("cuisine", before)).some((e) => e.kind === "ticket_new")).toBe(true);
    expect(await activateDueTableTickets()).toHaveLength(0);
  });

  it("can release a future TABLE ticket to Cuisine immediately", async () => {
    const s = await seat(canapeSpot);
    const { ticket } = await createTableTicket({
      sessionId: s.id, heading: s.short_code, subheading: "Canapé", lines: LINES,
      amountXof: 6000, note: null, clientRequestId: reqId(), isTest: false,
      scheduledFor: new Date(Date.now() + 50 * 60_000),
    });
    expect((await activateTableTicketNow(ticket.id))?.activated_at).not.toBeNull();
    expect(await activateTableTicketNow(ticket.id)).toBeNull();
  });

  it("is idempotent on client_request_id (double-tap → one ticket)", async () => {
    const s = await seat(canapeSpot);
    const rid = reqId();
    const first = await createTableTicket({
      sessionId: s.id, heading: s.short_code, subheading: "Canapé", lines: LINES,
      amountXof: 6000, note: null, clientRequestId: rid, isTest: false,
    });
    const second = await createTableTicket({
      sessionId: s.id, heading: s.short_code, subheading: "Canapé", lines: LINES,
      amountXof: 6000, note: null, clientRequestId: rid, isTest: false,
    });
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.ticket.id).toBe(first.ticket.id);
    expect(await ticketsForSession(s.id)).toHaveLength(1);
  });

  it("carries the à-emporter flag (default false = sur place)", async () => {
    const s = await seat(canapeSpot);
    const away = await createTableTicket({
      sessionId: s.id, heading: s.short_code, subheading: "Canapé", lines: LINES,
      amountXof: 6000, note: null, clientRequestId: reqId(), isTest: false, takeaway: true,
    });
    expect(away.ticket.takeaway).toBe(true);
    // Absent flag → sur place (the default), never accidentally to-go.
    const dineIn = await makeTableTicket(s.id, s.short_code);
    expect(dineIn.takeaway).toBe(false);
  });

  it("accueil can flag then clear urgency (view exposes it, sorts to the top)", async () => {
    const s = await seat(canapeSpot);
    const t = await makeTableTicket(s.id, s.short_code);
    expect(kitchenTicketView(t).urgent).toBe(false);
    const on = await setTicketUrgent(t.id, true, "Fatou");
    expect(on?.urgent_at).not.toBeNull();
    expect(kitchenTicketView(on!).urgent).toBe(true);
    const off = await setTicketUrgent(t.id, false, "Fatou");
    expect(off?.urgent_at).toBeNull();
    expect(kitchenTicketView(off!).urgent).toBe(false);
  });

  it("urgency can't be set on a completed ticket", async () => {
    const s = await seat(canapeSpot);
    const t = await makeTableTicket(s.id, s.short_code);
    await advanceTicketByCuisine(t.id, "READY", "iPad Cuisine");
    await serveTableTicket(t.id, "Fatou"); // → COMPLETED, leaves the board
    expect(await setTicketUrgent(t.id, true, "Fatou")).toBeNull();
  });

  it("ticketStatsToday aggregates today's counts + average prep (owner KPIs)", async () => {
    const s = await seat(canapeSpot);
    const a = await makeTableTicket(s.id, s.short_code);
    const b = await makeTableTicket(s.id, s.short_code);
    await setTicketUrgent(b.id, true, "Fatou");
    await advanceTicketByCuisine(a.id, "READY", "iPad Cuisine"); // stamps ready_at → avg prep
    const stats = await ticketStatsToday();
    expect(stats.totalToday).toBeGreaterThanOrEqual(2);
    expect(stats.urgentToday).toBeGreaterThanOrEqual(1);
    expect(stats.inProgress).toBeGreaterThanOrEqual(1);
    expect(stats.avgPrepSecs).not.toBeNull();
  });

  it("ticketStatsToday excludes test tickets from every aggregate", async () => {
    const s = await seat(canapeSpot);
    const before = await ticketStatsToday();
    // A create→instant-ready test order: it would wreck avg prep and inflate counts
    // if it counted. Mark it urgent + in-progress too, to prove ALL filters exclude it.
    const { ticket } = await createTableTicket({
      sessionId: s.id, heading: s.short_code, subheading: "test", lines: LINES,
      amountXof: 6000, note: null, clientRequestId: reqId(), isTest: true,
    });
    await setTicketUrgent(ticket.id, true, "Fatou");
    const after = await ticketStatsToday();
    expect(after.totalToday).toBe(before.totalToday);
    expect(after.urgentToday).toBe(before.urgentToday);
    expect(after.inProgress).toBe(before.inProgress);
  });
});

describe("topOrderedItemIds (🔥 Populaires ranking)", () => {
  const line = (id: string, name: string, qty: number): ExtraLine => ({
    id, name, qty, unitPriceXof: 1000, lineTotalXof: 1000 * qty, note: null,
  });
  async function order(sessionId: string, heading: string, lines: ExtraLine[], opts: { isTest?: boolean } = {}) {
    return createTableTicket({
      sessionId, heading, subheading: "x", lines, amountXof: 1000,
      note: null, clientRequestId: reqId(), isTest: opts.isTest ?? false,
    });
  }

  it("ranks by total qty sold, excludes suppléments / test / cancelled", async () => {
    const s = await seat(canapeSpot);
    await order(s.id, s.short_code, [line("TOAST", "Tuna Toast", 5), line("MATCHA", "Iced Matcha", 1)]);
    await order(s.id, s.short_code, [line("MATCHA", "Iced Matcha", 4), line("SUPP", "Supplément œufs", 9)]);
    // A test ticket and a cancelled one must NOT feed the ranking.
    await order(s.id, s.short_code, [line("BRUNCH", "Brunch", 50)], { isTest: true });
    const cancelled = await order(s.id, s.short_code, [line("MATCHA", "Iced Matcha", 50)]);
    await cancelTableTicket(cancelled.ticket.id, "annulé");

    __resetTopCache();
    const top = await topOrderedItemIds(30, 8);
    // TOAST=5, MATCHA=1+4=5 (order between the two is a tie, don't pin it);
    // SUPP (add-on), BRUNCH (is_test) and the cancelled matcha all excluded.
    expect(top.slice().sort()).toEqual(["MATCHA", "TOAST"]);
    expect(top).not.toContain("SUPP");
    expect(top).not.toContain("BRUNCH");
  });

  it("memoizes within the TTL and returns [] on an empty window", async () => {
    __resetTopCache();
    expect(await topOrderedItemIds(30, 8)).toEqual([]); // no sales yet
    const s = await seat(terrasseSpot);
    await order(s.id, s.short_code, [line("MATCHA", "Iced Matcha", 3)]);
    // Still cached as empty until the memo is reset.
    expect(await topOrderedItemIds(30, 8)).toEqual([]);
    __resetTopCache();
    expect(await topOrderedItemIds(30, 8)).toEqual(["MATCHA"]);
  });
});

describe("session subtotal (indicative)", () => {
  it("total_xof sums non-cancelled tickets — served included, cancelled excluded", async () => {
    const s = await seat(canapeSpot);
    const a = await makeTableTicket(s.id, s.short_code); // 6000
    const b = await makeTableTicket(s.id, s.short_code); // 6000
    expect((await getOpenSession(s.id))!.total_xof).toBe(12000);
    // Serving keeps it in the running subtotal (the client can't recompute it).
    await advanceTicketByCuisine(a.id, "READY", "iPad Cuisine");
    await serveTableTicket(a.id, "Fatou");
    expect((await getOpenSession(s.id))!.total_xof).toBe(12000);
    // Cancelling drops it out.
    await cancelTableTicket(b.id, "erreur");
    expect((await getOpenSession(s.id))!.total_xof).toBe(6000);
  });

  it("publishOpenSessionUpdate emits session_update carrying the fresh total", async () => {
    const s = await seat(canapeSpot);
    await makeTableTicket(s.id, s.short_code);
    const before = await latestOpsEventId("accueil");
    await publishOpenSessionUpdate(s.id);
    const upd = (await opsEventsSince("accueil", before)).find((e) => e.kind === "session_update");
    expect(upd).toBeTruthy();
    expect((upd!.payload as any).total_xof).toBe(6000);
  });

  it("publishOpenSessionUpdate is a silent no-op once the session is closed", async () => {
    const s = await seat(canapeSpot); // empty → closeable
    await closeSession(s.id, "Accueil 1");
    const before = await latestOpsEventId("accueil");
    await publishOpenSessionUpdate(s.id);
    expect(await opsEventsSince("accueil", before)).toHaveLength(0);
  });
});

describe("recent history (read-only)", () => {
  it("listRecentClosedSessions returns today's closed tables with subtotal + all lines", async () => {
    const s = await seat(canapeSpot, "Awa");
    const a = await makeTableTicket(s.id, s.short_code);
    const b = await makeTableTicket(s.id, s.short_code);
    await advanceTicketByCuisine(a.id, "READY", "iPad Cuisine");
    await serveTableTicket(a.id, "Fatou");
    await cancelTableTicket(b.id, "erreur");
    expect((await closeSession(s.id, "Accueil 1")).ok).toBe(true);
    const recent = await listRecentClosedSessions(20);
    const found = recent.find((r) => r.id === s.id);
    expect(found).toBeTruthy();
    expect(found!.short_code).toBe("Canapé");
    expect(found!.first_name).toBe("Awa");
    // Served counted, cancelled excluded from the subtotal — but both lines shown.
    expect(found!.total_xof).toBe(6000);
    expect(found!.tickets).toHaveLength(2);
    expect(found!.tickets.find((t) => t.status === "CANCELLED")!.cancel_reason).toBe("erreur");
  });

  it("listRecentClosedTickets returns today's served/cancelled tickets with finished_at + reason", async () => {
    const s = await seat(terrasseSpot);
    const a = await makeTableTicket(s.id, s.short_code);
    const b = await makeTableTicket(s.id, s.short_code);
    await advanceTicketByCuisine(a.id, "READY", "iPad Cuisine");
    await serveTableTicket(a.id, "Fatou");
    await cancelTableTicket(b.id, "erreur");
    const rows = await listRecentClosedTickets(30);
    expect(rows).toHaveLength(2);
    const cancelled = rows.find((r) => r.id === b.id)!;
    expect(cancelled.status).toBe("CANCELLED");
    expect(cancelled.cancel_reason).toBe("erreur");
    expect(cancelled.finished_at).toBeTruthy();
    // Still-open tickets never appear.
    const s2 = await seat(canapeSpot);
    await makeTableTicket(s2.id, s2.short_code);
    expect((await listRecentClosedTickets(30)).some((r) => r.status === "NEW")).toBe(false);
  });
});

describe("accueil serve flow", () => {
  it("Je prends is an atomic single-winner claim, only when READY", async () => {
    const s = await seat(canapeSpot);
    const t = await makeTableTicket(s.id, s.short_code);
    expect(await claimTableServe(t.id, "Fatou")).toBeNull(); // not READY yet
    await advanceTicketByCuisine(t.id, "READY", "iPad Cuisine");
    expect((await claimTableServe(t.id, "Fatou"))?.serve_by).toBe("Fatou");
    expect(await claimTableServe(t.id, "Awa")).toBeNull(); // loser
  });

  it("Servie completes the ticket and removes it from both boards", async () => {
    const s = await seat(canapeSpot);
    const t = await makeTableTicket(s.id, s.short_code);
    await advanceTicketByCuisine(t.id, "READY", "iPad Cuisine");
    const before = await latestOpsEventId("accueil");
    const served = await serveTableTicket(t.id, "Fatou");
    expect(served?.status).toBe("COMPLETED");
    expect(await listOpenKitchenTickets()).toHaveLength(0);
    expect(await serveTableTicket(t.id, "Fatou")).toBeNull(); // idempotent
    expect((await opsEventsSince("accueil", before)).some((e) => e.kind === "ticket_removed")).toBe(true);
  });
});

describe("close (Libérer) guard", () => {
  it("refuses to free a spot while a kitchen ticket is still open", async () => {
    const s = await seat(canapeSpot);
    const t = await makeTableTicket(s.id, s.short_code);
    expect(await closeSession(s.id, "Accueil 1")).toEqual({ ok: false, reason: "open_tickets" });
    expect(await getOpenSession(s.id)).not.toBeNull();
    await advanceTicketByCuisine(t.id, "READY", "iPad Cuisine");
    await serveTableTicket(t.id, "Fatou");
    expect((await closeSession(s.id, "Accueil 1")).ok).toBe(true);
    expect(await getOpenSessionBySpot(canapeSpot)).toBeNull();
  });

  it("a cancelled ticket no longer blocks the close", async () => {
    const s = await seat(canapeSpot);
    const t = await makeTableTicket(s.id, s.short_code);
    await cancelTableTicket(t.id, "client parti");
    expect((await closeSession(s.id, "Accueil 1")).ok).toBe(true);
  });

  it("closing an unknown/closed session reports not_open", async () => {
    const s = await seat(canapeSpot);
    await closeSession(s.id, "Accueil 1");
    expect(await closeSession(s.id, "Accueil 1")).toEqual({ ok: false, reason: "not_open" });
  });
});

describe("closeEmptyOpenSessions (self-heal orphans)", () => {
  it("closes empty tables, keeps ticketed ones, respects the grace window", async () => {
    const empty = await seat(canapeSpot); // no ticket → orphan
    const busy = await seat(terrasseSpot);
    await makeTableTicket(busy.id, busy.short_code);

    // grace 0 → the empty one closes now; the ticketed one survives
    expect(await closeEmptyOpenSessions(0)).toBe(1);
    expect(await getOpenSessionBySpot(canapeSpot)).toBeNull();
    expect(await getOpenSessionBySpot(terrasseSpot)).not.toBeNull();
    expect(empty).toBeTruthy();

    // grace protects a just-opened empty table (its first order may still be inserting)
    await seat(canapeSpot);
    expect(await closeEmptyOpenSessions(30)).toBe(0);
    expect(await getOpenSessionBySpot(canapeSpot)).not.toBeNull();
  });
});

describe("push subscriptions", () => {
  it("saves per device, lists by role, upserts on endpoint, deletes", async () => {
    const acc = await createPairingDevice("Accueil 1", "accueil", hashOpsToken(newPairCode()), new Date(Date.now() + 60_000));
    const cui = await createPairingDevice("iPad", "cuisine", hashOpsToken(newPairCode()), new Date(Date.now() + 60_000));
    await savePushSubscription(acc.id, { endpoint: "https://push/acc", p256dh: "k1", auth: "a1" });
    await savePushSubscription(cui.id, { endpoint: "https://push/cui", p256dh: "k2", auth: "a2" });

    const accSubs = await listPushSubscriptionsForRole("accueil");
    expect(accSubs).toHaveLength(1);
    expect(accSubs[0].endpoint).toBe("https://push/acc");

    // Re-subscribe same endpoint → upsert (still one), keys updated.
    await savePushSubscription(acc.id, { endpoint: "https://push/acc", p256dh: "k1b", auth: "a1b" });
    const again = await listPushSubscriptionsForRole("accueil");
    expect(again).toHaveLength(1);
    expect(again[0].p256dh).toBe("k1b");

    await deletePushSubscription("https://push/acc");
    expect(await listPushSubscriptionsForRole("accueil")).toHaveLength(0);
  });
});

describe("owner escalation (claimStaleServeEscalations)", () => {
  it("claims a stale un-taken READY table ticket exactly once", async () => {
    const s = await seat(canapeSpot);
    const t = await makeTableTicket(s.id, s.short_code);
    await advanceTicketByCuisine(t.id, "READY", "iPad Cuisine");

    // Fresh READY → not yet due.
    expect(await claimStaleServeEscalations(60)).toHaveLength(0);

    // Age it past the threshold.
    await pool.query("update kitchen_tickets set ready_at = now() - interval '5 minutes' where id = $1", [t.id]);
    const claimed = await claimStaleServeEscalations(60);
    expect(claimed).toHaveLength(1);
    expect(claimed[0].id).toBe(t.id);
    // Escalates exactly once.
    expect(await claimStaleServeEscalations(60)).toHaveLength(0);
  });

  it("never escalates a ticket already taken by a server", async () => {
    const s = await seat(terrasseSpot);
    const t = await makeTableTicket(s.id, s.short_code);
    await advanceTicketByCuisine(t.id, "READY", "iPad Cuisine");
    await claimTableServe(t.id, "Fatou"); // taken
    await pool.query("update kitchen_tickets set ready_at = now() - interval '5 minutes' where id = $1", [t.id]);
    expect(await claimStaleServeEscalations(60)).toHaveLength(0);
  });
});

describe("service PWA over HTTP", () => {
  let app: FastifyInstance;

  const MENU_ROW: CafeMenuRow = {
    id: "JANTBI", name: "Jant Bi", priceXof: 3000, category: "Smoothies",
    favourite: true, enabled: true, sortOrder: 1,
  };

  beforeAll(async () => {
    app = buildServer();
    await app.ready();
    setCafeMenu([MENU_ROW]);
  });

  async function pairAccueil(): Promise<string> {
    const code = newPairCode();
    await createPairingDevice("Accueil 1", "accueil", hashOpsToken(code), new Date(Date.now() + 60_000));
    const pair = await app.inject({
      method: "POST", url: "/ops/service/pair",
      payload: `code=${code}`, headers: { "content-type": "application/x-www-form-urlencoded" },
    });
    expect(pair.statusCode).toBe(303);
    return String(pair.headers["set-cookie"]).split(";")[0];
  }

  async function pairCuisine(): Promise<string> {
    const code = newPairCode();
    await createPairingDevice("iPad Cuisine", "cuisine", hashOpsToken(code), new Date(Date.now() + 60_000));
    const pair = await app.inject({
      method: "POST", url: "/ops/cuisine/pair",
      payload: `code=${code}`, headers: { "content-type": "application/x-www-form-urlencoded" },
    });
    expect(pair.statusCode).toBe(303);
    return String(pair.headers["set-cookie"]).split(";")[0];
  }

  async function pairOwner(): Promise<string> {
    const code = newPairCode();
    await createPairingDevice("Patron", "owner", hashOpsToken(code), new Date(Date.now() + 60_000));
    const pair = await app.inject({
      method: "POST", url: "/ops/owner/pair",
      payload: `code=${code}`, headers: { "content-type": "application/x-www-form-urlencoded" },
    });
    expect(pair.statusCode).toBe(303);
    return String(pair.headers["set-cookie"]).split(";")[0];
  }

  // Order at a spot, drive it READY, serve it → the table closes. Returns cookie.
  async function orderServeClose(cookie: string, spot: string, reqSuffix: string): Promise<void> {
    const ordered = await app.inject({
      method: "POST", url: `/ops/service/spots/${spot}/orders`, headers: { cookie },
      payload: { items: [{ item_id: "JANTBI", qty: 1 }], client_request_id: `req-${reqSuffix}` },
    });
    const id = JSON.parse(ordered.body).id;
    await advanceTicketByCuisine(id, "READY", "iPad Cuisine");
    await app.inject({ method: "POST", url: `/ops/service/tickets/${id}/served`, headers: { cookie } });
  }

  it("serves the manifest scoped to /ops/service/ and boots spots from /state", async () => {
    const m = await app.inject({ method: "GET", url: "/ops/service/manifest.webmanifest" });
    expect(JSON.parse(m.body).scope).toBe("/ops/service/");
    const cookie = await pairAccueil();
    // The paired home is the kiosque shell (boots from /state) — no CSP-blocked inline boot.
    const home = await app.inject({ method: "GET", url: "/ops/service/", headers: { cookie } });
    expect(home.body).toContain("/ops/service/app.js");
    expect(home.body).not.toContain("window.__BOOT__");
    // The spots (Canapé…) now come from the authoritative /state, no-store.
    const state = await app.inject({ method: "GET", url: "/ops/service/state", headers: { cookie } });
    expect(state.statusCode).toBe(200);
    expect(state.headers["cache-control"]).toContain("no-store");
    const body = JSON.parse(state.body);
    expect(typeof body.cursor).toBe("number");
    expect(JSON.stringify(body.spots)).toContain("Canapé");
  });

  it("the composer's test flag creates an is_test ticket (real orders stay is_test=false)", async () => {
    const cookie = await pairAccueil();
    const real = await app.inject({
      method: "POST", url: `/ops/service/spots/${canapeSpot}/orders`, headers: { cookie },
      payload: { items: [{ item_id: "JANTBI", qty: 1 }], client_request_id: "req-real-1" },
    });
    expect((await getKitchenTicket(JSON.parse(real.body).id))?.is_test).toBe(false);

    const test = await app.inject({
      method: "POST", url: `/ops/service/spots/${canapeSpot}/orders`, headers: { cookie },
      payload: { items: [{ item_id: "JANTBI", qty: 1 }], client_request_id: "req-test-1", test: true },
    });
    expect((await getKitchenTicket(JSON.parse(test.body).id))?.is_test).toBe(true);
  });

  it("schedules only 30/50-minute orders, shows them to staff, and withholds them from Cuisine", async () => {
    const accueil = await pairAccueil();
    const cuisine = await pairCuisine();
    const ordered = await app.inject({
      method: "POST", url: `/ops/service/spots/${canapeSpot}/orders`, headers: { cookie: accueil },
      payload: { items: [{ item_id: "JANTBI", qty: 1, note: "sans glace" }], client_request_id: "req-future-50", ready_in_minutes: 50 },
    });
    expect(ordered.statusCode).toBe(200);
    const created = JSON.parse(ordered.body);
    expect(created.scheduled_for).toBeTruthy();
    const ticket = await getKitchenTicket(created.id);
    expect(ticket?.activated_at).toBeNull();

    const serviceState = JSON.parse((await app.inject({ method: "GET", url: "/ops/service/state", headers: { cookie: accueil } })).body);
    expect(serviceState.tickets.some((t: any) => t.id === created.id && t.scheduled_for && !t.activated_at)).toBe(true);
    const cuisineState = JSON.parse((await app.inject({ method: "GET", url: "/ops/cuisine/state", headers: { cookie: cuisine } })).body);
    expect(cuisineState.tickets.some((t: any) => t.id === created.id)).toBe(false);

    const released = await app.inject({ method: "POST", url: `/ops/service/tickets/${created.id}/prepare-now`, headers: { cookie: accueil } });
    expect(released.statusCode).toBe(200);
    expect(JSON.parse(released.body).ok).toBe(true);
    const cuisineAfter = JSON.parse((await app.inject({ method: "GET", url: "/ops/cuisine/state", headers: { cookie: cuisine } })).body);
    expect(cuisineAfter.tickets.some((t: any) => t.id === created.id && t.activated_at)).toBe(true);
  });

  it("rejects any future delay other than 30 or 50 before opening the table", async () => {
    const cookie = await pairAccueil();
    const bad = await app.inject({
      method: "POST", url: `/ops/service/spots/${pergolaSpot}/orders`, headers: { cookie },
      payload: { items: [{ item_id: "JANTBI", qty: 1 }], client_request_id: "req-future-45", ready_in_minutes: 45 },
    });
    expect(bad.statusCode).toBe(400);
    expect(await getOpenSessionBySpot(pergolaSpot)).toBeNull();
  });

  it("redirects the service host root into the PWA scope", async () => {
    const res = await app.inject({ method: "GET", url: "/", headers: { host: config.SERVICE_HOST } });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe("/ops/service/");
  });

  it("shows the pairing screen and 401s the SSE stream when unpaired", async () => {
    const home = await app.inject({ method: "GET", url: "/ops/service/" });
    expect(home.body).toContain("Appairer ce téléphone");
    expect((await app.inject({ method: "GET", url: "/ops/service/events" })).statusCode).toBe(401);
  });

  it("full flow: tap free spot → order → serve → table auto-clears", async () => {
    const cookie = await pairAccueil();

    // Ordering at a free spot opens its session and creates the ticket in one call.
    const ordered = await app.inject({
      method: "POST", url: `/ops/service/spots/${canapeSpot}/orders`, headers: { cookie },
      payload: { items: [{ item_id: "JANTBI", qty: 2, note: "sans sucre" }], note: "pressé", first_name: "Awa", client_request_id: "req-http-1" },
    });
    expect(ordered.statusCode).toBe(200);
    const body = JSON.parse(ordered.body);
    expect(body.ok).toBe(true);
    const sessionId = body.session_id;
    const ticketId = body.id;
    expect(await getOpenSessionBySpot(canapeSpot)).not.toBeNull();

    // A second order at the now-occupied spot reuses the same session.
    const more = await app.inject({
      method: "POST", url: `/ops/service/spots/${canapeSpot}/orders`, headers: { cookie },
      payload: { items: [{ item_id: "JANTBI", qty: 1 }], client_request_id: "req-http-2" },
    });
    expect(JSON.parse(more.body).session_id).toBe(sessionId);
    const ticket2 = JSON.parse(more.body).id;

    // Serving the FIRST of two does NOT clear the table (one still open).
    await advanceTicketByCuisine(ticketId, "READY", "iPad Cuisine");
    await app.inject({ method: "POST", url: `/ops/service/tickets/${ticketId}/served`, headers: { cookie } });
    expect(await getOpenSessionBySpot(canapeSpot)).not.toBeNull();

    // Serving the LAST one auto-clears the table (no manual "Libérer").
    await advanceTicketByCuisine(ticket2, "READY", "iPad Cuisine");
    await app.inject({ method: "POST", url: `/ops/service/tickets/${ticket2}/served`, headers: { cookie } });
    expect(await getOpenSessionBySpot(canapeSpot)).toBeNull();
  });

  it("cancelling the last open ticket also auto-clears the table", async () => {
    const cookie = await pairAccueil();
    const ordered = await app.inject({
      method: "POST", url: `/ops/service/spots/${terrasseSpot}/orders`, headers: { cookie },
      payload: { items: [{ item_id: "JANTBI", qty: 1 }], client_request_id: "req-cancel-1" },
    });
    const id = JSON.parse(ordered.body).id;
    expect(await getOpenSessionBySpot(terrasseSpot)).not.toBeNull();
    await app.inject({ method: "POST", url: `/ops/service/tickets/${id}/cancel`, headers: { cookie }, payload: { reason: "annulée" } });
    expect(await getOpenSessionBySpot(terrasseSpot)).toBeNull();
  });

  it("a rejected order never opens a table (validate before seating)", async () => {
    const cookie = await pairAccueil();
    const bad = await app.inject({
      method: "POST", url: `/ops/service/spots/${canapeSpot}/orders`, headers: { cookie },
      payload: { items: [{ item_id: "NOPE_UNKNOWN", qty: 1 }], client_request_id: "req-bad-1" },
    });
    expect(bad.statusCode).toBe(400);
    expect(await getOpenSessionBySpot(canapeSpot)).toBeNull();
  });

  it("rejects spot/ticket actions without a device cookie", async () => {
    const denied = await app.inject({ method: "POST", url: `/ops/service/spots/${canapeSpot}/orders`, payload: { items: [] } });
    expect(denied.statusCode).toBe(401);
  });

  it("/state exposes the favourite flag so the picker can build its ⭐ shortcut", async () => {
    const cookie = await pairAccueil();
    const st = await app.inject({ method: "GET", url: "/ops/service/state", headers: { cookie } });
    const body = JSON.parse(st.body);
    const menu = body.menu as Array<{ items: any[] }>;
    const item = menu.flatMap((c) => c.items).find((i) => i.id === "JANTBI");
    expect(item.fav).toBe(true);
    expect(Array.isArray(body.top)).toBe(true); // best-seller ids for 🔥 Populaires
  });

  it("service /recent returns today's closed tables with their subtotal; 401 unpaired", async () => {
    const cookie = await pairAccueil();
    await orderServeClose(cookie, canapeSpot, "srec-1");
    const recent = await app.inject({ method: "GET", url: "/ops/service/recent", headers: { cookie } });
    expect(recent.statusCode).toBe(200);
    const sessions = JSON.parse(recent.body).sessions as any[];
    expect(sessions.length).toBeGreaterThanOrEqual(1);
    expect(sessions[0].total_xof).toBeGreaterThan(0);
    expect((await app.inject({ method: "GET", url: "/ops/service/recent" })).statusCode).toBe(401);
  });

  it("cuisine /recent lists closed tickets and enforces the cuisine role", async () => {
    const accueil = await pairAccueil();
    const cuisine = await pairCuisine();
    await orderServeClose(accueil, terrasseSpot, "crec-1");
    const rec = await app.inject({ method: "GET", url: "/ops/cuisine/recent", headers: { cookie: cuisine } });
    expect(rec.statusCode).toBe(200);
    expect((JSON.parse(rec.body).tickets as any[]).length).toBeGreaterThanOrEqual(1);
    // An accueil cookie must NOT reach the cuisine recall (role mismatch → 401).
    expect((await app.inject({ method: "GET", url: "/ops/cuisine/recent", headers: { cookie: accueil } })).statusCode).toBe(401);
  });

  it("owner boot exposes spots + menu so its composer can take an order", async () => {
    const cookie = await pairOwner();
    const st = await app.inject({ method: "GET", url: "/ops/owner/state", headers: { cookie } });
    expect(st.statusCode).toBe(200);
    const boot = JSON.parse(st.body);
    expect((boot.spots as any[]).some((s) => s.label === "Canapé")).toBe(true);
    expect((boot.menu as any[]).flatMap((c) => c.items).some((i) => i.id === "JANTBI")).toBe(true);
    expect(Array.isArray(boot.top)).toBe(true); // 🔥 Populaires ids for the owner composer
  });

  it("owner can take a salle order (same server-decided path as the accueil)", async () => {
    const cookie = await pairOwner();
    const ordered = await app.inject({
      method: "POST", url: `/ops/owner/spots/${pergolaSpot}/orders`, headers: { cookie },
      payload: { items: [{ item_id: "JANTBI", qty: 1, note: "bien frais" }], first_name: "Patron", client_request_id: "req-owner-1" },
    });
    expect(ordered.statusCode).toBe(200);
    expect(JSON.parse(ordered.body).ok).toBe(true);
    // The order really seated a session at the spot (visible to the whole ops floor).
    expect(await getOpenSessionBySpot(pergolaSpot)).not.toBeNull();
  });

  it("owner order-taking still enforces the device cookie + validates the menu", async () => {
    // No cookie → 401 (an owner endpoint, not open).
    const denied = await app.inject({ method: "POST", url: `/ops/owner/spots/${canapeSpot}/orders`, payload: { items: [] } });
    expect(denied.statusCode).toBe(401);
    // Paired but a bogus item → 400 and no table seated.
    const cookie = await pairOwner();
    const bad = await app.inject({
      method: "POST", url: `/ops/owner/spots/${canapeSpot}/orders`, headers: { cookie },
      payload: { items: [{ item_id: "NOPE_UNKNOWN", qty: 1 }], client_request_id: "req-owner-bad" },
    });
    expect(bad.statusCode).toBe(400);
    expect(await getOpenSessionBySpot(canapeSpot)).toBeNull();
  });
});
