import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../../src/server.js";
import { config } from "../../src/config.js";
import { pool, migrate } from "../../src/db/index.js";
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
} from "../../src/domain/serviceSessionRepo.js";
import {
  createTableTicket,
  advanceTicketByCuisine,
  claimTableServe,
  serveTableTicket,
  cancelTableTicket,
  ticketsForSession,
  listOpenKitchenTickets,
} from "../../src/domain/kitchenTicketRepo.js";
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

beforeAll(async () => {
  await migrate();
});

beforeEach(async () => {
  await truncateAll();
  await pool.query(
    "truncate kitchen_tickets, ops_devices, ops_events, service_sessions, push_subscriptions restart identity cascade",
  );
  const spots = await listActiveSpots();
  canapeSpot = spots.find((s) => s.label === "Canapé")!.id;
  terrasseSpot = spots.find((s) => s.label === "Terrasse")!.id;
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

  it("serves the manifest scoped to /ops/service/ and boots with spots", async () => {
    const m = await app.inject({ method: "GET", url: "/ops/service/manifest.webmanifest" });
    expect(JSON.parse(m.body).scope).toBe("/ops/service/");
    const cookie = await pairAccueil();
    const home = await app.inject({ method: "GET", url: "/ops/service/", headers: { cookie } });
    expect(home.body).toContain("window.__BOOT__");
    expect(home.body).toContain("Canapé");
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

  it("full flow: tap free spot → order (opens session) → take → serve → free", async () => {
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

    // Free is refused while tickets are open.
    const blocked = await app.inject({ method: "POST", url: `/ops/service/sessions/${sessionId}/close`, headers: { cookie } });
    expect(JSON.parse(blocked.body)).toEqual({ ok: false, reason: "open_tickets" });

    // Serve both, then free the spot.
    for (const id of [ticketId, JSON.parse(more.body).id]) {
      await advanceTicketByCuisine(id, "READY", "iPad Cuisine");
      await app.inject({ method: "POST", url: `/ops/service/tickets/${id}/served`, headers: { cookie } });
    }
    const freed = await app.inject({ method: "POST", url: `/ops/service/sessions/${sessionId}/close`, headers: { cookie } });
    expect(JSON.parse(freed.body).ok).toBe(true);
  });

  it("rejects spot/ticket actions without a device cookie", async () => {
    const denied = await app.inject({ method: "POST", url: `/ops/service/spots/${canapeSpot}/orders`, payload: { items: [] } });
    expect(denied.statusCode).toBe(401);
  });
});
