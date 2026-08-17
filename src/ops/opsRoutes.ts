import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { config } from "../config.js";
import { parseCookies } from "../admin/auth.js";
import {
  provisionDevCuisineDevice,
  provisionDevAccueilDevice,
  redeemPairing,
  verifyDeviceSession,
  listOpsDevices,
  type OpsDevice,
} from "../domain/opsDeviceRepo.js";
import {
  listOpenKitchenTickets,
  kitchenTicketView,
  advanceTicketByCuisine,
  type KitchenTicket,
  ackTicketDisplayed,
  createTableTicket,
  completeBarTicket,
  claimTableServe,
  serveTableTicket,
  cancelTableTicket,
  setTicketUrgent,
  ticketStatsToday,
  topOrderedItemIds,
  ticketsForSession,
  listRecentClosedTickets,
  activateTableTicketNow,
} from "../domain/kitchenTicketRepo.js";
import { onOpsEvent, opsEventsSince, latestOpsEventId, type OpsEvent } from "../domain/opsEvents.js";
import { ACCUEIL_CHANNEL, CUISINE_CHANNEL, parseTableOrderReadyDelay } from "../domain/kitchenTicketRules.js";
import { listActiveSpots } from "../domain/serviceSpotRepo.js";
import {
  openSessionAtSpot,
  getOpenSessionBySpot,
  listOpenSessions,
  closeSession,
  closeEmptyOpenSessions,
  publishOpenSessionUpdate,
  listRecentClosedSessions,
} from "../domain/serviceSessionRepo.js";
import { getCafeMenu, computeExtras, pickerMenu } from "../lib/cafeMenu.js";
import { savePushSubscription } from "../domain/pushRepo.js";
import { pushToRole, pushToDevice } from "./pushSender.js";
import { ticketItemsSummary } from "../domain/kitchenTicketRules.js";
import { renderOpsIcon } from "./opsIcon.js";
import {
  OPS_COOKIE,
  PAIR_CODE_TTL_MS,
  clearOpsCookieHeader,
  hashOpsToken,
  newOpsToken,
  normalizePairCode,
  opsCookieHeader,
} from "./opsAuth.js";
import {
  CUISINE_APP_JS,
  CUISINE_MANIFEST,
  CUISINE_SW,
  cuisineKitchenPage,
  cuisinePairingPage,
  hardenCuisine,
} from "./opsCuisinePage.js";
import {
  SERVICE_APP_JS,
  SERVICE_MANIFEST,
  SERVICE_SW,
  serviceBoardPage,
  servicePairingPage,
  hardenService,
} from "./opsServicePage.js";
import {
  OWNER_APP_JS,
  OWNER_MANIFEST,
  OWNER_SW,
  ownerBoardPage,
  ownerPairingPage,
  hardenOwner,
} from "./opsOwnerPage.js";

/**
 * Realtime ops surface (Phase 1: the cuisine iPad at cuisine.revive.sn). All
 * routes live under /ops/cuisine so they work on any host; the cuisine host's
 * bare "/" just redirects into the PWA scope. Device auth is a server-side,
 * revocable session cookie (see opsAuth) — never the admin cookie. The SSE
 * endpoint fans out ops_events to connected iPads and replays anything missed
 * since the device's last-seen id, so a dropped connection self-heals.
 */

const BASE = "/ops/cuisine";

// Icons are static → render once per size, lazily (boot/tests never pay for it).
let icon192: Buffer | null = null;
let icon512: Buffer | null = null;

// Open SSE connections, tracked so the SIGTERM drain can end them (otherwise
// app.close() would hang waiting on never-ending responses).
const sseConnections = new Set<FastifyReply>();

/** End every open SSE stream — called from the server shutdown before app.close(). */
export function closeOpsSseConnections(): void {
  for (const reply of sseConnections) {
    try {
      reply.raw.end();
    } catch {
      /* ignore */
    }
  }
  sseConnections.clear();
}

async function deviceFromReq(
  req: FastifyRequest,
  role: "cuisine" | "accueil" | "owner",
): Promise<OpsDevice | null> {
  const token = parseCookies(req.headers.cookie)[OPS_COOKIE];
  if (!token) return null;
  return verifyDeviceSession(hashOpsToken(token), role);
}

/** Serve the cuisine home: kiosque if paired, pairing screen otherwise. */
async function serveCuisineHome(req: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> {
  hardenCuisine(reply);
  let device = await deviceFromReq(req, "cuisine");
  // DEV ONLY: auto-provision a cuisine device so the kiosque works without an
  // iPad and without a pairing code. Gated by OPS_DEV_AUTOPAIR — never set in prod.
  if (!device && config.OPS_DEV_AUTOPAIR) {
    const token = newOpsToken();
    await provisionDevCuisineDevice(hashOpsToken(token));
    reply.header("Set-Cookie", opsCookieHeader(token));
    device = await verifyDeviceSession(hashOpsToken(token), "cuisine");
  }
  reply.type("text/html");
  if (!device) return reply.send(cuisinePairingPage());
  return reply.send(cuisineKitchenPage());
}

/** Everything the cuisine board needs to render, authoritatively: the open
 *  kitchen tickets and the current event cursor. The client fetches this on load
 *  (the inline boot is CSP-blocked, so /state is the REAL first paint) and on
 *  every resync — the cursor is read so any later change replays over SSE. */
async function cuisineBootData(): Promise<{ cursor: number; tickets: unknown[] }> {
  const [tickets, cursor] = await Promise.all([
    listOpenKitchenTickets(),
    latestOpsEventId(CUISINE_CHANNEL),
  ]);
  return { cursor, tickets: tickets.map(kitchenTicketView) };
}

/** Host-aware redirect for cuisine.revive.sn "/" → the PWA scope. */
export async function serveCuisineRoot(_req: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> {
  return reply.redirect(`${BASE}/`, 302);
}

/**
 * A room order going READY rings lock screens: the reception phones (who serve
 * it) AND the owner's phone (supervision). Fire-and-forget — never fails the
 * route; each PWA's tap lands on its own board.
 */
function pushReadyTableAlert(t: KitchenTicket): void {
  if (t.source !== "TABLE") return;
  const view = kitchenTicketView(t);
  const title = "🔔 Commande prête";
  const body = `${view.heading} · ${ticketItemsSummary(view)}`;
  void pushToRole("accueil", { title, body, url: "/ops/service/", tag: `ready-${t.id}` }).catch(() => {});
  void pushToRole("owner", { title, body, url: "/ops/owner/", tag: `ready-${t.id}` }).catch(() => {});
}

export function registerOps(app: FastifyInstance): void {
  // ── Static PWA assets (cache-friendly; no device auth needed) ──
  app.get(`${BASE}/manifest.webmanifest`, async (_req, reply) => {
    reply.header("Cache-Control", "no-store");
    return reply.type("application/manifest+json").send(CUISINE_MANIFEST);
  });
  app.get(`${BASE}/sw.js`, async (_req, reply) => {
    // Served from the scope root so the SW can control /ops/cuisine/*.
    reply.header("Cache-Control", "no-store");
    reply.header("Service-Worker-Allowed", `${BASE}/`);
    return reply.type("text/javascript").send(CUISINE_SW);
  });
  app.get(`${BASE}/app.js`, async (_req, reply) => {
    reply.header("Cache-Control", "no-store");
    return reply.type("text/javascript").send(CUISINE_APP_JS);
  });
  app.get(`${BASE}/icon-192.png`, async (_req, reply) => {
    if (!icon192) icon192 = renderOpsIcon(192);
    reply.header("Cache-Control", "public, max-age=86400");
    return reply.type("image/png").send(icon192);
  });
  app.get(`${BASE}/icon-512.png`, async (_req, reply) => {
    if (!icon512) icon512 = renderOpsIcon(512);
    reply.header("Cache-Control", "public, max-age=86400");
    return reply.type("image/png").send(icon512);
  });

  // ── Home + pairing ──
  app.get(`${BASE}/`, serveCuisineHome);
  app.get(`${BASE}`, async (_req, reply) => reply.redirect(`${BASE}/`, 302));

  app.post(`${BASE}/pair`, async (req, reply) => {
    hardenCuisine(reply);
    const code = normalizePairCode((req.body as any)?.code ?? "");
    if (!code) {
      reply.type("text/html");
      return reply.code(400).send(cuisinePairingPage("Code manquant."));
    }
    const token = newOpsToken();
    const device = await redeemPairing(hashOpsToken(code), hashOpsToken(token));
    if (!device) {
      reply.type("text/html");
      return reply.code(400).send(cuisinePairingPage("Code invalide ou expiré. Regénérez-en un dans l'administration."));
    }
    reply.header("Set-Cookie", opsCookieHeader(token));
    return reply.redirect(`${BASE}/`, 303);
  });

  app.post(`${BASE}/unpair`, async (req, reply) => {
    reply.header("Set-Cookie", clearOpsCookieHeader());
    return reply.redirect(`${BASE}/`, 303);
  });

  // ── Ticket actions (device-authed) ──
  const requireCuisine = async (
    req: FastifyRequest,
    reply: FastifyReply,
  ): Promise<OpsDevice | null> => {
    const device = await deviceFromReq(req, "cuisine");
    if (!device) {
      reply.code(401).type("application/json").send({ error: "unpaired" });
      return null;
    }
    return device;
  };

  app.post(`${BASE}/tickets/:id/ack`, async (req, reply) => {
    const device = await requireCuisine(req, reply);
    if (!device) return reply;
    await ackTicketDisplayed((req.params as any).id);
    return reply.type("application/json").send({ ok: true });
  });

  app.post(`${BASE}/tickets/:id/preparing`, async (req, reply) => {
    const device = await requireCuisine(req, reply);
    if (!device) return reply;
    const t = await advanceTicketByCuisine((req.params as any).id, "PREPARING", device.label);
    return reply.type("application/json").send({ ok: !!t });
  });

  app.post(`${BASE}/tickets/:id/ready`, async (req, reply) => {
    const device = await requireCuisine(req, reply);
    if (!device) return reply;
    const t = await advanceTicketByCuisine((req.params as any).id, "READY", device.label);
    if (t) pushReadyTableAlert(t);
    return reply.type("application/json").send({ ok: !!t });
  });

  app.post(`${BASE}/tickets/:id/complete`, async (req, reply) => {
    const device = await requireCuisine(req, reply);
    if (!device) return reply;
    const t = await completeBarTicket((req.params as any).id, device.label);
    return reply.type("application/json").send({ ok: !!t });
  });

  // Read-only recall: today's served/cancelled tickets (no actions).
  app.get(`${BASE}/recent`, async (req, reply) => {
    const device = await requireCuisine(req, reply);
    if (!device) return reply;
    reply.header("Cache-Control", "no-store");
    return reply.type("application/json").send({ tickets: await listRecentClosedTickets(30) });
  });

  // Authoritative board state (JSON) — the client loads this before opening the
  // SSE stream, and re-fetches it on resync, so a CSP-blocked/stale page self-heals.
  app.get(`${BASE}/state`, async (req, reply) => {
    const device = await deviceFromReq(req, "cuisine");
    if (!device) return reply.code(401).type("application/json").send({ error: "unpaired" });
    reply.header("Cache-Control", "no-store");
    return reply.type("application/json").send(await cuisineBootData());
  });

  // ── SSE stream (cuisine channel) ──
  app.get(`${BASE}/events`, async (req, reply) => {
    const device = await deviceFromReq(req, "cuisine");
    if (!device) return reply.code(401).send({ error: "unpaired" });
    return pipeOpsEvents(req, reply, CUISINE_CHANNEL);
  });

  registerServiceRoutes(app);
  registerOwnerRoutes(app);
}

/**
 * Attach a hijacked SSE response to one ops channel: replay everything since the
 * device's last-seen id (Last-Event-ID header, else the ?since cursor), then
 * fan out live events of that channel. Shared by the cuisine iPad and the
 * reception phones (each on its own channel). The device is already authed.
 */
function pipeOpsEvents(req: FastifyRequest, reply: FastifyReply, channel: string): FastifyReply {
  const lastEventId = Number(req.headers["last-event-id"]);
  const sinceParam = Number((req.query as any)?.since);
  const sinceId = Number.isFinite(lastEventId)
    ? lastEventId
    : Number.isFinite(sinceParam)
      ? sinceParam
      : 0;

  reply.hijack();
  const raw = reply.raw;
  raw.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-store",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  raw.write("retry: 3000\n\n");

  // Every event leaves through here, in strictly increasing id order. `lastSentId`
  // is the dedup/ordering guard: a lower-or-equal id is dropped, so an old
  // `ticket_new` buffered during replay can never be written after the
  // `ticket_removed` (higher id) that retired it — the exact "finished order
  // reappears" regression. Pings carry no id and are written raw (below).
  let lastSentId = sinceId;
  const write = (e: OpsEvent) => {
    if (e.id <= lastSentId) return;
    lastSentId = e.id;
    raw.write(`id: ${e.id}\nevent: ${e.kind}\ndata: ${JSON.stringify(e.payload)}\n\n`);
  };

  // Live events that arrive WHILE we page through the durable replay are held
  // here, then flushed (sorted, deduped) once replay is done — never interleaved
  // out of order with it. After that, `replaying` is false and events write live.
  let replaying = true;
  const buffer: OpsEvent[] = [];
  const unsubscribe = onOpsEvent((e) => {
    if (e.channel !== channel) return;
    if (replaying) {
      buffer.push(e);
      return;
    }
    try {
      write(e);
    } catch {
      /* a broken pipe is cleaned up by the close handler below */
    }
  });

  // Drain the durable log in pages of 200 (the single-page cap was the catch-up
  // bug: a device more than 200 events behind — e.g. booting at cursor 0 — only
  // ever saw the OLDEST 200 and never reached the present). Page until a short
  // page proves the tail is reached, then flush the live buffer and go direct.
  void (async () => {
    try {
      for (;;) {
        const page = await opsEventsSince(channel, lastSentId, 200);
        for (const e of page) write(e);
        if (page.length < 200) break;
      }
      buffer.sort((a, b) => a.id - b.id);
      for (const e of buffer) write(e); // write() dedups anything replay already sent
    } catch {
      // A replay hiccup must not kill the live stream: flush what we buffered and
      // let the client's /state resync repair any gap.
      buffer.sort((a, b) => a.id - b.id);
      for (const e of buffer) {
        try {
          write(e);
        } catch {
          /* broken pipe — cleaned up below */
        }
      }
    } finally {
      buffer.length = 0;
      replaying = false;
    }
  })();
  // A real `ping` EVENT (not an SSE comment): comments are invisible to the
  // EventSource API, so clients could never tell a silently dead socket (half-open
  // TCP — no onerror, no auto-reconnect) from a quiet board. The apps run a
  // watchdog on this heartbeat and rebuild the stream when it stops. No id field,
  // so pings never advance the Last-Event-ID replay cursor.
  const keepAlive = setInterval(() => {
    try {
      raw.write("event: ping\ndata: {}\n\n");
    } catch {
      /* ignore */
    }
  }, 25_000);

  sseConnections.add(reply);
  const cleanup = () => {
    clearInterval(keepAlive);
    unsubscribe();
    sseConnections.delete(reply);
  };
  req.raw.on("close", cleanup);
  req.raw.on("error", cleanup);
  return reply;
}

// ═══════════════════════════════════════════════════════════════════════════
// Phase 2: the reception PWA (service.revive.sn) — on-site table service.
// Same device-auth/SSE plumbing as the cuisine kiosque, role "accueil".
// ═══════════════════════════════════════════════════════════════════════════

const SERVICE_BASE = "/ops/service";

/** The bar menu grouped by category (sort order preserved) for the order picker.
 *  ids + prices only from the server snapshot — the client never sets a price.
 *  Delegates to the shared pickerMenu() (single source of truth with /commander);
 *  the composer reads optionLabel/choices/fav, which pickerMenu still exposes. */
function buildServiceMenu(): Array<{ category: string; items: unknown[] }> {
  return pickerMenu();
}

/** Everything the reception board needs to render: the fixed spot tiles, which
 *  are occupied (open sessions), their open tickets, and the menu. Used both for
 *  the inline page boot AND the /state endpoint the client re-fetches on load (so
 *  a stale cached page self-heals). */
async function serviceBootData(): Promise<unknown> {
  // Self-heal: free any table left with no open order (orphan / all-served).
  await closeEmptyOpenSessions().catch(() => {});
  const [spots, sessions, tickets, cursor, top] = await Promise.all([
    listActiveSpots(),
    listOpenSessions(),
    listOpenKitchenTickets(),
    latestOpsEventId(ACCUEIL_CHANNEL),
    topOrderedItemIds(),
  ]);
  return {
    cursor,
    spots,
    sessions,
    tickets: tickets.filter((t) => t.source === "TABLE").map(kitchenTicketView),
    menu: buildServiceMenu(),
    // Item ids best-sellers-first for the "🔥 Populaires" picker section.
    top,
    // Public VAPID key so the PWA can subscribe to push; "" = push disabled.
    vapidKey: config.VAPID_PUBLIC_KEY,
  };
}

/** Serve the reception home: board if paired, pairing screen otherwise. */
async function serveServiceHome(req: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> {
  hardenService(reply);
  let device = await deviceFromReq(req, "accueil");
  // DEV ONLY (OPS_DEV_AUTOPAIR): auto-provision an accueil device so the PWA works
  // without pairing a phone. Never set in production.
  if (!device && config.OPS_DEV_AUTOPAIR) {
    const token = newOpsToken();
    await provisionDevAccueilDevice(hashOpsToken(token));
    reply.header("Set-Cookie", opsCookieHeader(token));
    device = await verifyDeviceSession(hashOpsToken(token), "accueil");
  }
  reply.type("text/html");
  if (!device) return reply.send(servicePairingPage());
  return reply.send(serviceBoardPage());
}

/** Host-aware redirect for service.revive.sn "/" → the PWA scope. */
export async function serveServiceRoot(_req: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> {
  return reply.redirect(`${SERVICE_BASE}/`, 302);
}

/**
 * Create a TABLE order at a fixed spot — the shared body behind BOTH the accueil
 * salle board and the owner supervision board. Server is the single decision
 * point: prices/choices from the menu snapshot, session opened/reused here, the
 * heading/subheading derived from the session (never the client). Returns an HTTP
 * code + JSON body so each caller just forwards it.
 */
async function createSpotOrder(
  deviceLabel: string,
  spotId: string,
  b: any,
): Promise<{ code: number; body: Record<string, unknown> }> {
  // Validate the ORDER first — a rejected order must never open a table (else the
  // spot shows "Occupé — aucune commande en cours" with nothing in it).
  const result = computeExtras(getCafeMenu().items, b.items, { requireChoices: true });
  if (!result.ok) {
    return { code: 400, body: { ok: false, message: result.message } };
  }
  const readyDelay = parseTableOrderReadyDelay(b.ready_in_minutes);
  if (readyDelay === "invalid") {
    return { code: 400, body: { ok: false, message: "Choisissez 30 ou 50 minutes pour une commande différée." } };
  }
  const scheduledFor = readyDelay === null ? null : new Date(Date.now() + readyDelay * 60_000);
  // Now open the spot's session (or reuse the open one).
  let session = await getOpenSessionBySpot(spotId);
  if (!session) {
    session = await openSessionAtSpot({ spotId, firstName: b.first_name, openedBy: deviceLabel });
  }
  if (!session) {
    return { code: 400, body: { ok: false, message: "Emplacement inconnu." } };
  }
  const note = typeof b.note === "string" ? b.note.trim().slice(0, 280) || null : null;
  const clientRequestId = String(b.client_request_id ?? "").slice(0, 80) || newOpsToken();
  // Packaging mode is a server-side boolean — the client sends a flag, never trust
  // anything else. Default (and any non-true value) = sur place.
  const takeaway = b.takeaway === true;
  // Test order: staff toggled "Test" in the composer. It still reaches the kitchen
  // (already red-badged "Test") so the flow can be exercised end-to-end, but is
  // excluded from every report (ticketStatsToday). Any non-true value = real order.
  const isTest = b.test === true;
  const { ticket } = await createTableTicket({
    sessionId: session.id,
    heading: session.short_code,
    subheading: session.area_name + (session.first_name ? ` · ${session.first_name}` : ""),
    lines: result.lines,
    amountXof: result.totalXof,
    note,
    clientRequestId,
    isTest,
    takeaway,
    scheduledFor,
  });
  // Refresh the spot's live subtotal on the reception boards (aggregate isn't
  // carried by the ticket event). Best-effort — never fails the order.
  await publishOpenSessionUpdate(session.id).catch(() => {});
  return { code: 200, body: { ok: true, session_id: session.id, id: ticket.id, scheduled_for: ticket.scheduled_for } };
}

function registerServiceRoutes(app: FastifyInstance): void {
  // ── Static PWA assets ──
  app.get(`${SERVICE_BASE}/manifest.webmanifest`, async (_req, reply) => {
    reply.header("Cache-Control", "no-store");
    return reply.type("application/manifest+json").send(SERVICE_MANIFEST);
  });
  app.get(`${SERVICE_BASE}/sw.js`, async (_req, reply) => {
    reply.header("Cache-Control", "no-store");
    reply.header("Service-Worker-Allowed", `${SERVICE_BASE}/`);
    return reply.type("text/javascript").send(SERVICE_SW);
  });
  app.get(`${SERVICE_BASE}/app.js`, async (_req, reply) => {
    reply.header("Cache-Control", "no-store");
    return reply.type("text/javascript").send(SERVICE_APP_JS);
  });
  app.get(`${SERVICE_BASE}/icon-192.png`, async (_req, reply) => {
    if (!icon192) icon192 = renderOpsIcon(192);
    reply.header("Cache-Control", "public, max-age=86400");
    return reply.type("image/png").send(icon192);
  });
  app.get(`${SERVICE_BASE}/icon-512.png`, async (_req, reply) => {
    if (!icon512) icon512 = renderOpsIcon(512);
    reply.header("Cache-Control", "public, max-age=86400");
    return reply.type("image/png").send(icon512);
  });

  // ── Home + pairing ──
  app.get(`${SERVICE_BASE}/`, serveServiceHome);
  app.get(`${SERVICE_BASE}`, async (_req, reply) => reply.redirect(`${SERVICE_BASE}/`, 302));

  app.post(`${SERVICE_BASE}/pair`, async (req, reply) => {
    hardenService(reply);
    const code = normalizePairCode((req.body as any)?.code ?? "");
    if (!code) {
      reply.type("text/html");
      return reply.code(400).send(servicePairingPage("Code manquant."));
    }
    const token = newOpsToken();
    const device = await redeemPairing(hashOpsToken(code), hashOpsToken(token));
    if (!device) {
      reply.type("text/html");
      return reply.code(400).send(servicePairingPage("Code invalide ou expiré. Regénérez-en un dans l'administration."));
    }
    reply.header("Set-Cookie", opsCookieHeader(token));
    return reply.redirect(`${SERVICE_BASE}/`, 303);
  });

  app.post(`${SERVICE_BASE}/unpair`, async (_req, reply) => {
    reply.header("Set-Cookie", clearOpsCookieHeader());
    return reply.redirect(`${SERVICE_BASE}/`, 303);
  });

  // ── Session + ticket actions (device-authed, role accueil) ──
  const requireAccueil = async (
    req: FastifyRequest,
    reply: FastifyReply,
  ): Promise<OpsDevice | null> => {
    const device = await deviceFromReq(req, "accueil");
    if (!device) {
      reply.code(401).type("application/json").send({ error: "unpaired" });
      return null;
    }
    return device;
  };

  // "Libérer" a spot: close its session (refused server-side while a ticket is open).
  app.post(`${SERVICE_BASE}/sessions/:id/close`, async (req, reply) => {
    const device = await requireAccueil(req, reply);
    if (!device) return reply;
    const result = await closeSession((req.params as any).id, device.label);
    return reply.type("application/json").send(result);
  });

  // Take an order at a FIXED spot: opens the spot's session if free (or reuses the
  // open one), then creates the kitchen ticket. Prices ALWAYS from the server menu
  // (a required choice is enforced); the heading/subheading come from the spot's
  // session, never the client. Shared by the accueil (salle) and owner boards.
  app.post(`${SERVICE_BASE}/spots/:id/orders`, async (req, reply) => {
    const device = await requireAccueil(req, reply);
    if (!device) return reply;
    const { code, body } = await createSpotOrder(device.label, (req.params as any).id, (req.body as any) ?? {});
    return reply.code(code).type("application/json").send(body);
  });

  app.post(`${SERVICE_BASE}/tickets/:id/take`, async (req, reply) => {
    const device = await requireAccueil(req, reply);
    if (!device) return reply;
    const t = await claimTableServe((req.params as any).id, device.label);
    return reply.type("application/json").send({ ok: !!t });
  });

  app.post(`${SERVICE_BASE}/tickets/:id/served`, async (req, reply) => {
    const device = await requireAccueil(req, reply);
    if (!device) return reply;
    const t = await serveTableTicket((req.params as any).id, device.label);
    if (t) await autoCloseIfEmpty(t.session_id, device.label);
    return reply.type("application/json").send({ ok: !!t });
  });

  app.post(`${SERVICE_BASE}/tickets/:id/cancel`, async (req, reply) => {
    const device = await requireAccueil(req, reply);
    if (!device) return reply;
    const reason = typeof (req.body as any)?.reason === "string" ? (req.body as any).reason.slice(0, 200) : null;
    const t = await cancelTableTicket((req.params as any).id, reason);
    if (t) await autoCloseIfEmpty(t.session_id, device.label);
    return reply.type("application/json").send({ ok: !!t });
  });

  app.post(`${SERVICE_BASE}/tickets/:id/prepare-now`, async (req, reply) => {
    const device = await requireAccueil(req, reply);
    if (!device) return reply;
    const t = await activateTableTicketNow((req.params as any).id);
    return reply.type("application/json").send({ ok: !!t });
  });

  // Accueil escalates / de-escalates an order as urgent (impatient client). The
  // flag is a server-side boolean; the kitchen board re-sorts + announces it.
  app.post(`${SERVICE_BASE}/tickets/:id/urgent`, async (req, reply) => {
    const device = await requireAccueil(req, reply);
    if (!device) return reply;
    const urgent = (req.body as any)?.urgent === true;
    const t = await setTicketUrgent((req.params as any).id, urgent, device.label);
    return reply.type("application/json").send({ ok: !!t });
  });

  // Register a device's Web Push subscription (lock-screen alerts).
  app.post(`${SERVICE_BASE}/push/subscribe`, async (req, reply) => {
    const device = await requireAccueil(req, reply);
    if (!device) return reply;
    const b = (req.body as any) ?? {};
    const endpoint = String(b.endpoint ?? "");
    const p256dh = String(b.keys?.p256dh ?? "");
    const auth = String(b.keys?.auth ?? "");
    if (!endpoint || !p256dh || !auth) {
      return reply.code(400).type("application/json").send({ ok: false });
    }
    await savePushSubscription(device.id, { endpoint, p256dh, auth });
    return reply.type("application/json").send({ ok: true });
  });

  // Self-check: ring THIS phone's lock screen so staff can prove alerts work
  // (and catch a silent-mode / low-volume phone) without waiting on a real order.
  app.post(`${SERVICE_BASE}/push/test`, async (req, reply) => {
    const device = await requireAccueil(req, reply);
    if (!device) return reply;
    const sent = await pushToDevice(device.id, {
      title: "🔔 Test — la sonnerie fonctionne",
      body: "Si tu vois et entends ceci, les alertes commandes prêtes sont bien actives.",
      url: "/ops/service/",
      tag: "push-test",
    });
    return reply.type("application/json").send({ sent });
  });

  // Fresh board state (JSON) — the client re-fetches this on load so a stale
  // cached page (old inline boot) self-heals to the current spots/sessions.
  app.get(`${SERVICE_BASE}/state`, async (req, reply) => {
    const device = await requireAccueil(req, reply);
    if (!device) return reply;
    reply.header("Cache-Control", "no-store");
    return reply.type("application/json").send(await serviceBootData());
  });

  // Read-only recent history: today's closed sessions + their indicative subtotal
  // (the "addition" a client asks for after the table was auto-freed). No actions.
  app.get(`${SERVICE_BASE}/recent`, async (req, reply) => {
    const device = await requireAccueil(req, reply);
    if (!device) return reply;
    reply.header("Cache-Control", "no-store");
    return reply.type("application/json").send({ sessions: await listRecentClosedSessions(20) });
  });

  // ── SSE stream (accueil channel) ──
  app.get(`${SERVICE_BASE}/events`, async (req, reply) => {
    const device = await deviceFromReq(req, "accueil");
    if (!device) return reply.code(401).send({ error: "unpaired" });
    return pipeOpsEvents(req, reply, ACCUEIL_CHANNEL);
  });
}

// A table auto-clears once its LAST open ticket leaves (served or cancelled) —
// no manual "Libérer". Closing an already-empty session frees the spot back to
// "tap to order". Best-effort: a close hiccup never fails the serve/cancel.
// Shared by the accueil and owner boards (same served/cancel semantics).
async function autoCloseIfEmpty(sessionId: string | null, by: string | null): Promise<void> {
  if (!sessionId) return;
  const remaining = await ticketsForSession(sessionId);
  if (remaining.length === 0) await closeSession(sessionId, by);
  else await publishOpenSessionUpdate(sessionId).catch(() => {});
}

// ═══ Owner supervision PWA (/ops/owner, role "owner") ═══
// A manager overview: today's KPIs, device status, and every live ticket (both
// sources), urgents first — with FULL control: take a salle order (same
// server-decided createSpotOrder path as the accueil) and drive any ticket
// through the cuisine + salle transitions (see the owner ticket routes below).
// Subscribes to the cuisine channel (which already carries all tickets) and
// exposes /stats for the aggregates.
const OWNER_BASE = "/ops/owner";

async function ownerBootData(): Promise<unknown> {
  const [tickets, cursor, stats, devices, spots, top] = await Promise.all([
    listOpenKitchenTickets(),
    latestOpsEventId(CUISINE_CHANNEL),
    ticketStatsToday(),
    listOpsDevices(),
    listActiveSpots(),
    topOrderedItemIds(),
  ]);
  // spots + menu + top let the owner board also TAKE an order with the same
  // findability as the salle (server still decides prices/choices).
  return {
    cursor,
    tickets: tickets.map(kitchenTicketView),
    stats,
    devices,
    spots,
    menu: buildServiceMenu(),
    top,
    // Public VAPID key so the PWA can subscribe to push; "" = push disabled.
    vapidKey: config.VAPID_PUBLIC_KEY,
  };
}

async function serveOwnerHome(req: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> {
  hardenOwner(reply);
  const device = await deviceFromReq(req, "owner");
  reply.type("text/html");
  if (!device) return reply.send(ownerPairingPage());
  return reply.send(ownerBoardPage());
}

/** Host-aware redirect for owner.revive.sn "/" → the PWA scope. */
export async function serveOwnerRoot(_req: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> {
  return reply.redirect(`${OWNER_BASE}/`, 302);
}

function registerOwnerRoutes(app: FastifyInstance): void {
  app.get(`${OWNER_BASE}/manifest.webmanifest`, async (_req, reply) => {
    reply.header("Cache-Control", "no-store");
    return reply.type("application/manifest+json").send(OWNER_MANIFEST);
  });
  app.get(`${OWNER_BASE}/sw.js`, async (_req, reply) => {
    reply.header("Cache-Control", "no-store");
    reply.header("Service-Worker-Allowed", `${OWNER_BASE}/`);
    return reply.type("text/javascript").send(OWNER_SW);
  });
  app.get(`${OWNER_BASE}/app.js`, async (_req, reply) => {
    reply.header("Cache-Control", "no-store");
    return reply.type("text/javascript").send(OWNER_APP_JS);
  });
  app.get(`${OWNER_BASE}/icon-192.png`, async (_req, reply) => {
    if (!icon192) icon192 = renderOpsIcon(192);
    reply.header("Cache-Control", "public, max-age=86400");
    return reply.type("image/png").send(icon192);
  });
  app.get(`${OWNER_BASE}/icon-512.png`, async (_req, reply) => {
    if (!icon512) icon512 = renderOpsIcon(512);
    reply.header("Cache-Control", "public, max-age=86400");
    return reply.type("image/png").send(icon512);
  });

  app.get(`${OWNER_BASE}/`, serveOwnerHome);
  app.get(`${OWNER_BASE}`, async (_req, reply) => reply.redirect(`${OWNER_BASE}/`, 302));

  app.post(`${OWNER_BASE}/pair`, async (req, reply) => {
    hardenOwner(reply);
    const code = normalizePairCode((req.body as any)?.code ?? "");
    if (!code) {
      reply.type("text/html");
      return reply.code(400).send(ownerPairingPage("Code manquant."));
    }
    const token = newOpsToken();
    const device = await redeemPairing(hashOpsToken(code), hashOpsToken(token));
    if (!device) {
      reply.type("text/html");
      return reply.code(400).send(ownerPairingPage("Code invalide ou expiré. Regénérez-en un dans l'administration."));
    }
    reply.header("Set-Cookie", opsCookieHeader(token));
    return reply.redirect(`${OWNER_BASE}/`, 303);
  });

  app.post(`${OWNER_BASE}/unpair`, async (_req, reply) => {
    reply.header("Set-Cookie", clearOpsCookieHeader());
    return reply.redirect(`${OWNER_BASE}/`, 303);
  });

  // Read-only refresh of the whole board (self-heal a stale cached page).
  app.get(`${OWNER_BASE}/state`, async (req, reply) => {
    const device = await deviceFromReq(req, "owner");
    if (!device) return reply.code(401).type("application/json").send({ error: "unpaired" });
    reply.header("Cache-Control", "no-store");
    return reply.type("application/json").send(await ownerBootData());
  });

  // Just the aggregates (KPIs + device status) — polled every 60s.
  app.get(`${OWNER_BASE}/stats`, async (req, reply) => {
    const device = await deviceFromReq(req, "owner");
    if (!device) return reply.code(401).type("application/json").send({ error: "unpaired" });
    const [stats, devices] = await Promise.all([ticketStatsToday(), listOpsDevices()]);
    return reply.type("application/json").send({ stats, devices });
  });

  // Live stream: the cuisine channel carries every ticket event (both sources).
  app.get(`${OWNER_BASE}/events`, async (req, reply) => {
    const device = await deviceFromReq(req, "owner");
    if (!device) return reply.code(401).send({ error: "unpaired" });
    return pipeOpsEvents(req, reply, CUISINE_CHANNEL);
  });

  // The owner can ALSO take an order (same server-decided path as the salle). The
  // new ticket lands on the cuisine + accueil boards via the shared event channel.
  app.post(`${OWNER_BASE}/spots/:id/orders`, async (req, reply) => {
    const device = await deviceFromReq(req, "owner");
    if (!device) return reply.code(401).type("application/json").send({ ok: false, message: "unpaired" });
    const { code, body } = await createSpotOrder(device.label, (req.params as any).id, (req.body as any) ?? {});
    return reply.code(code).type("application/json").send(body);
  });

  // ── Full supervision control ──
  // The owner can drive a ticket through the SAME transitions as the cuisine iPad
  // (commencer / prête / terminée) and the accueil phones (servie / annuler /
  // urgent). Same repo functions, same atomic WHERE guards — a stale tap from any
  // board resolves to a single winner; only the device role differs.
  const requireOwner = async (
    req: FastifyRequest,
    reply: FastifyReply,
  ): Promise<OpsDevice | null> => {
    const device = await deviceFromReq(req, "owner");
    if (!device) {
      reply.code(401).type("application/json").send({ error: "unpaired" });
      return null;
    }
    return device;
  };

  // Register the owner phone's Web Push subscription (lock-screen "commande
  // prête" alerts) — same contract as the salle endpoint, scoped to this role.
  app.post(`${OWNER_BASE}/push/subscribe`, async (req, reply) => {
    const device = await requireOwner(req, reply);
    if (!device) return reply;
    const b = (req.body as any) ?? {};
    const endpoint = String(b.endpoint ?? "");
    const p256dh = String(b.keys?.p256dh ?? "");
    const auth = String(b.keys?.auth ?? "");
    if (!endpoint || !p256dh || !auth) {
      return reply.code(400).type("application/json").send({ ok: false });
    }
    await savePushSubscription(device.id, { endpoint, p256dh, auth });
    return reply.type("application/json").send({ ok: true });
  });

  // Self-check: ring THIS phone's lock screen to prove alerts work.
  app.post(`${OWNER_BASE}/push/test`, async (req, reply) => {
    const device = await requireOwner(req, reply);
    if (!device) return reply;
    const sent = await pushToDevice(device.id, {
      title: "🔔 Test — la sonnerie fonctionne",
      body: "Si tu vois et entends ceci, les alertes commandes prêtes sont bien actives.",
      url: `${OWNER_BASE}/`,
      tag: "push-test",
    });
    return reply.type("application/json").send({ sent });
  });

  app.post(`${OWNER_BASE}/tickets/:id/preparing`, async (req, reply) => {
    const device = await requireOwner(req, reply);
    if (!device) return reply;
    const t = await advanceTicketByCuisine((req.params as any).id, "PREPARING", device.label);
    return reply.type("application/json").send({ ok: !!t });
  });

  app.post(`${OWNER_BASE}/tickets/:id/ready`, async (req, reply) => {
    const device = await requireOwner(req, reply);
    if (!device) return reply;
    const t = await advanceTicketByCuisine((req.params as any).id, "READY", device.label);
    // Same side effect as the cuisine route: reception + owner lock screens ring.
    if (t) pushReadyTableAlert(t);
    return reply.type("application/json").send({ ok: !!t });
  });

  app.post(`${OWNER_BASE}/tickets/:id/complete`, async (req, reply) => {
    const device = await requireOwner(req, reply);
    if (!device) return reply;
    const t = await completeBarTicket((req.params as any).id, device.label);
    return reply.type("application/json").send({ ok: !!t });
  });

  app.post(`${OWNER_BASE}/tickets/:id/served`, async (req, reply) => {
    const device = await requireOwner(req, reply);
    if (!device) return reply;
    const t = await serveTableTicket((req.params as any).id, device.label);
    if (t) await autoCloseIfEmpty(t.session_id, device.label);
    return reply.type("application/json").send({ ok: !!t });
  });

  app.post(`${OWNER_BASE}/tickets/:id/cancel`, async (req, reply) => {
    const device = await requireOwner(req, reply);
    if (!device) return reply;
    const reason = typeof (req.body as any)?.reason === "string" ? (req.body as any).reason.slice(0, 200) : null;
    const t = await cancelTableTicket((req.params as any).id, reason);
    if (t) await autoCloseIfEmpty(t.session_id, device.label);
    return reply.type("application/json").send({ ok: !!t });
  });

  app.post(`${OWNER_BASE}/tickets/:id/prepare-now`, async (req, reply) => {
    const device = await requireOwner(req, reply);
    if (!device) return reply;
    const t = await activateTableTicketNow((req.params as any).id);
    return reply.type("application/json").send({ ok: !!t });
  });

  app.post(`${OWNER_BASE}/tickets/:id/urgent`, async (req, reply) => {
    const device = await requireOwner(req, reply);
    if (!device) return reply;
    const urgent = (req.body as any)?.urgent === true;
    const t = await setTicketUrgent((req.params as any).id, urgent, device.label);
    return reply.type("application/json").send({ ok: !!t });
  });
}
