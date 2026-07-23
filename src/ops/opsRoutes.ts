import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { config } from "../config.js";
import { parseCookies } from "../admin/auth.js";
import {
  provisionDevCuisineDevice,
  provisionDevAccueilDevice,
  redeemPairing,
  verifyDeviceSession,
  type OpsDevice,
} from "../domain/opsDeviceRepo.js";
import {
  listOpenKitchenTickets,
  kitchenTicketView,
  advanceTicketByCuisine,
  ackTicketDisplayed,
  createTableTicket,
  claimTableServe,
  serveTableTicket,
  cancelTableTicket,
  ticketsForSession,
} from "../domain/kitchenTicketRepo.js";
import { onOpsEvent, opsEventsSince, latestOpsEventId, type OpsEvent } from "../domain/opsEvents.js";
import { ACCUEIL_CHANNEL, CUISINE_CHANNEL } from "../domain/kitchenTicketRules.js";
import { listActiveSpots } from "../domain/serviceSpotRepo.js";
import {
  openSessionAtSpot,
  getOpenSessionBySpot,
  listOpenSessions,
  closeSession,
  closeEmptyOpenSessions,
} from "../domain/serviceSessionRepo.js";
import { getCafeMenu, computeExtras } from "../lib/cafeMenu.js";
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
  const tickets = await listOpenKitchenTickets();
  const cursor = await latestOpsEventId(CUISINE_CHANNEL);
  const boot = JSON.stringify({ cursor, tickets: tickets.map(kitchenTicketView) });
  return reply.send(cuisineKitchenPage(boot));
}

/** Host-aware redirect for cuisine.revive.sn "/" → the PWA scope. */
export async function serveCuisineRoot(_req: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> {
  return reply.redirect(`${BASE}/`, 302);
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
    return reply.type("application/json").send({ ok: !!t });
  });

  // ── SSE stream (cuisine channel) ──
  app.get(`${BASE}/events`, async (req, reply) => {
    const device = await deviceFromReq(req, "cuisine");
    if (!device) return reply.code(401).send({ error: "unpaired" });
    return pipeOpsEvents(req, reply, CUISINE_CHANNEL);
  });

  registerServiceRoutes(app);
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

  const write = (e: OpsEvent) => {
    raw.write(`id: ${e.id}\nevent: ${e.kind}\ndata: ${JSON.stringify(e.payload)}\n\n`);
  };

  void opsEventsSince(channel, sinceId)
    .then((events) => {
      for (const e of events) write(e);
    })
    .catch(() => {
      /* a replay hiccup shouldn't kill the live stream */
    });

  const unsubscribe = onOpsEvent((e) => {
    if (e.channel === channel) {
      try {
        write(e);
      } catch {
        /* a broken pipe is cleaned up by the close handler below */
      }
    }
  });
  const keepAlive = setInterval(() => {
    try {
      raw.write(": ping\n\n");
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
 *  ids + prices only from the server snapshot — the client never sets a price. */
function buildServiceMenu(): Array<{ category: string; items: unknown[] }> {
  const { items } = getCafeMenu();
  const cats: Array<{ category: string; items: unknown[] }> = [];
  const byCat = new Map<string, unknown[]>();
  for (const it of items.values()) {
    let arr = byCat.get(it.category);
    if (!arr) {
      arr = [];
      byCat.set(it.category, arr);
      cats.push({ category: it.category, items: arr });
    }
    arr.push({
      id: it.id,
      name: it.name,
      price: it.priceXof,
      optionLabel: it.optionLabel,
      choices: it.optionChoices ?? [],
    });
  }
  return cats;
}

/** Everything the reception board needs to render: the fixed spot tiles, which
 *  are occupied (open sessions), their open tickets, and the menu. Used both for
 *  the inline page boot AND the /state endpoint the client re-fetches on load (so
 *  a stale cached page self-heals). */
async function serviceBootData(): Promise<unknown> {
  // Self-heal: free any table left with no open order (orphan / all-served).
  await closeEmptyOpenSessions().catch(() => {});
  const [spots, sessions, tickets, cursor] = await Promise.all([
    listActiveSpots(),
    listOpenSessions(),
    listOpenKitchenTickets(),
    latestOpsEventId(ACCUEIL_CHANNEL),
  ]);
  return {
    cursor,
    spots,
    sessions,
    tickets: tickets.filter((t) => t.source === "TABLE").map(kitchenTicketView),
    menu: buildServiceMenu(),
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
  return reply.send(serviceBoardPage(JSON.stringify(await serviceBootData())));
}

/** Host-aware redirect for service.revive.sn "/" → the PWA scope. */
export async function serveServiceRoot(_req: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> {
  return reply.redirect(`${SERVICE_BASE}/`, 302);
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
  // session, never the client.
  app.post(`${SERVICE_BASE}/spots/:id/orders`, async (req, reply) => {
    const device = await requireAccueil(req, reply);
    if (!device) return reply;
    const spotId = (req.params as any).id;
    const b = (req.body as any) ?? {};
    // Validate the ORDER first — a rejected order must never open a table (else the
    // spot shows "Occupé — aucune commande en cours" with nothing in it).
    const result = computeExtras(getCafeMenu().items, b.items, { requireChoices: true });
    if (!result.ok) {
      return reply.code(400).type("application/json").send({ ok: false, message: result.message });
    }
    // Now open the spot's session (or reuse the open one).
    let session = await getOpenSessionBySpot(spotId);
    if (!session) {
      session = await openSessionAtSpot({ spotId, firstName: b.first_name, openedBy: device.label });
    }
    if (!session) {
      return reply.code(400).type("application/json").send({ ok: false, message: "Emplacement inconnu." });
    }
    const note = typeof b.note === "string" ? b.note.trim().slice(0, 280) || null : null;
    const clientRequestId = String(b.client_request_id ?? "").slice(0, 80) || newOpsToken();
    const { ticket } = await createTableTicket({
      sessionId: session.id,
      heading: session.short_code,
      subheading: session.area_name + (session.first_name ? ` · ${session.first_name}` : ""),
      lines: result.lines,
      amountXof: result.totalXof,
      note,
      clientRequestId,
      isTest: false,
    });
    return reply.type("application/json").send({ ok: true, session_id: session.id, id: ticket.id });
  });

  // A table auto-clears once its LAST open ticket leaves (served or cancelled) —
  // no manual "Libérer". Closing an already-empty session frees the spot back to
  // "tap to order". Best-effort: a close hiccup never fails the serve/cancel.
  const autoCloseIfEmpty = async (sessionId: string | null, by: string | null): Promise<void> => {
    if (!sessionId) return;
    const remaining = await ticketsForSession(sessionId);
    if (remaining.length === 0) await closeSession(sessionId, by);
  };

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

  // Fresh board state (JSON) — the client re-fetches this on load so a stale
  // cached page (old inline boot) self-heals to the current spots/sessions.
  app.get(`${SERVICE_BASE}/state`, async (req, reply) => {
    const device = await requireAccueil(req, reply);
    if (!device) return reply;
    reply.header("Cache-Control", "no-store");
    return reply.type("application/json").send(await serviceBootData());
  });

  // ── SSE stream (accueil channel) ──
  app.get(`${SERVICE_BASE}/events`, async (req, reply) => {
    const device = await deviceFromReq(req, "accueil");
    if (!device) return reply.code(401).send({ error: "unpaired" });
    return pipeOpsEvents(req, reply, ACCUEIL_CHANNEL);
  });
}
