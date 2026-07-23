import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { pool, migrate } from "../../src/db/index.js";
import { truncateAll } from "./helpers.js";
import type { ExtraLine } from "../../src/lib/cafeMenu.js";
import { listActiveAreas } from "../../src/domain/serviceAreaRepo.js";
import {
  openSession,
  listOpenSessions,
  getOpenSession,
  setSessionPosition,
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
 * On-site service sessions + TABLE kitchen tickets against a real Postgres.
 * Locks the Phase 2 invariants: short-code allocation/reuse, the atomic accueil
 * "Je prends" claim, "Servie" leaving both boards, and — the safety one — a
 * session cannot be closed while a kitchen ticket of it is still open. The
 * seeded service_areas survive beforeEach (only sessions/tickets are wiped).
 */

const LINES: ExtraLine[] = [
  { id: "JANTBI", name: "Jant Bi", qty: 2, unitPriceXof: 3000, lineTotalXof: 6000, note: "sans sucre" },
];

let areaId: string; // Canapé
let areaCode: string;

beforeAll(async () => {
  await migrate();
});

beforeEach(async () => {
  await truncateAll();
  await pool.query(
    "truncate kitchen_tickets, ops_devices, ops_events, service_sessions, push_subscriptions restart identity cascade",
  );
  const areas = await listActiveAreas();
  const canape = areas.find((a) => a.name === "Canapé")!;
  areaId = canape.id;
  areaCode = canape.code;
});

let reqSeq = 0;
const reqId = () => `req-${Date.now()}-${reqSeq++}`;

async function makeSession(firstName?: string) {
  const s = await openSession({ areaId, firstName, openedBy: "Accueil 1" });
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

describe("service areas", () => {
  it("seeds Canapé / Terrasse / Pergola", async () => {
    const areas = await listActiveAreas();
    expect(areas.map((a) => a.name)).toEqual(["Canapé", "Terrasse", "Pergola"]);
    expect(areas.map((a) => a.code)).toEqual(["C", "T", "P"]);
  });
});

describe("openSession — short code allocation", () => {
  it("allocates sequential codes per area and emits session_new", async () => {
    const before = await latestOpsEventId("accueil");
    const a = await makeSession("Awa");
    const b = await makeSession("Bby");
    expect(a.short_code).toBe(`${areaCode}-01`);
    expect(b.short_code).toBe(`${areaCode}-02`);
    expect(a.area_name).toBe("Canapé");
    expect(a.first_name).toBe("Awa");

    const events = await opsEventsSince("accueil", before);
    expect(events.filter((e) => e.kind === "session_new")).toHaveLength(2);
  });

  it("reuses the smallest free code after a session closes", async () => {
    const a = await makeSession(); // C-01
    await makeSession(); // C-02
    expect((await closeSession(a.id, "Accueil 1")).ok).toBe(true);
    const c = await makeSession(); // reuses C-01
    expect(c.short_code).toBe(`${areaCode}-01`);
  });

  it("lists only open sessions with their area denormalized", async () => {
    await makeSession("Awa");
    const open = await listOpenSessions();
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ area_name: "Canapé", first_name: "Awa" });
  });
});

describe("setSessionPosition", () => {
  it("stores a proportional position and emits session_update", async () => {
    const s = await makeSession();
    const before = await latestOpsEventId("accueil");
    const updated = await setSessionPosition(s.id, { x: 0.4, y: 0.6 });
    expect(updated?.pos_x).toBeCloseTo(0.4);
    expect(updated?.pos_y).toBeCloseTo(0.6);
    const events = await opsEventsSince("accueil", before);
    expect(events.some((e) => e.kind === "session_update")).toBe(true);
  });
});

describe("createTableTicket", () => {
  it("creates a NEW TABLE ticket linked to the session, on both channels", async () => {
    const s = await makeSession();
    const beforeCuisine = await latestOpsEventId("cuisine");
    const beforeAccueil = await latestOpsEventId("accueil");
    const t = await makeTableTicket(s.id, s.short_code);
    expect(t.status).toBe("NEW");
    expect(t.source).toBe("TABLE");
    expect(t.session_id).toBe(s.id);
    expect(t.delivery_order_id).toBeNull();
    expect(t.fallback_due_at).toBeNull(); // no WhatsApp fallback for on-site
    expect(t.heading).toBe(s.short_code);

    expect((await opsEventsSince("cuisine", beforeCuisine)).some((e) => e.kind === "ticket_new")).toBe(true);
    expect((await opsEventsSince("accueil", beforeAccueil)).some((e) => e.kind === "ticket_new")).toBe(true);
    // per-line note is frozen into the snapshot
    expect((t.items_json as any[])[0].note).toBe("sans sucre");
  });

  it("is idempotent on client_request_id (double-tap → one ticket)", async () => {
    const s = await makeSession();
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
    const s = await makeSession();
    const t = await makeTableTicket(s.id, s.short_code);
    // Not READY yet → claim refused.
    expect(await claimTableServe(t.id, "Fatou")).toBeNull();
    await advanceTicketByCuisine(t.id, "READY", "iPad Cuisine");

    const win = await claimTableServe(t.id, "Fatou");
    expect(win?.serve_by).toBe("Fatou");
    // Second phone loses the race.
    expect(await claimTableServe(t.id, "Awa")).toBeNull();
  });

  it("Servie completes the ticket and removes it from both boards", async () => {
    const s = await makeSession();
    const t = await makeTableTicket(s.id, s.short_code);
    await advanceTicketByCuisine(t.id, "READY", "iPad Cuisine");
    const beforeAccueil = await latestOpsEventId("accueil");

    const served = await serveTableTicket(t.id, "Fatou");
    expect(served?.status).toBe("COMPLETED");
    expect(served?.serve_by).toBe("Fatou");
    expect(await listOpenKitchenTickets()).toHaveLength(0);
    // idempotent
    expect(await serveTableTicket(t.id, "Fatou")).toBeNull();

    const events = await opsEventsSince("accueil", beforeAccueil);
    expect(events.some((e) => e.kind === "ticket_removed")).toBe(true);
  });
});

describe("closeSession guard", () => {
  it("refuses to close while a kitchen ticket is still open", async () => {
    const s = await makeSession();
    const t = await makeTableTicket(s.id, s.short_code);

    const blocked = await closeSession(s.id, "Accueil 1");
    expect(blocked).toEqual({ ok: false, reason: "open_tickets" });
    // still open
    expect(await getOpenSession(s.id)).not.toBeNull();

    // serve it, then close is allowed
    await advanceTicketByCuisine(t.id, "READY", "iPad Cuisine");
    await serveTableTicket(t.id, "Fatou");
    expect((await closeSession(s.id, "Accueil 1")).ok).toBe(true);
    expect(await getOpenSession(s.id)).toBeNull();
  });

  it("a cancelled ticket no longer blocks the close", async () => {
    const s = await makeSession();
    const t = await makeTableTicket(s.id, s.short_code);
    await cancelTableTicket(t.id, "client parti");
    expect((await closeSession(s.id, "Accueil 1")).ok).toBe(true);
  });

  it("closing an unknown/closed session reports not_open", async () => {
    const s = await makeSession();
    await closeSession(s.id, "Accueil 1");
    expect(await closeSession(s.id, "Accueil 1")).toEqual({ ok: false, reason: "not_open" });
  });
});
