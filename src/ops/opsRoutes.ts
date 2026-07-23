import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { config } from "../config.js";
import { parseCookies } from "../admin/auth.js";
import {
  provisionDevCuisineDevice,
  redeemPairing,
  verifyDeviceSession,
  type OpsDevice,
} from "../domain/opsDeviceRepo.js";
import {
  listOpenKitchenTickets,
  kitchenTicketView,
  advanceTicketByCuisine,
  ackTicketDisplayed,
} from "../domain/kitchenTicketRepo.js";
import { onOpsEvent, opsEventsSince, latestOpsEventId, type OpsEvent } from "../domain/opsEvents.js";
import { CUISINE_CHANNEL } from "../domain/kitchenTicketRules.js";
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

  // ── SSE stream ──
  app.get(`${BASE}/events`, async (req, reply) => {
    const device = await deviceFromReq(req, "cuisine");
    if (!device) return reply.code(401).send({ error: "unpaired" });

    // Prefer the browser's automatic Last-Event-ID on reconnect; fall back to
    // the ?since= cursor the page bootstraps with on the very first connect.
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

    // Replay whatever this device missed since its last seen id.
    try {
      for (const e of await opsEventsSince(CUISINE_CHANNEL, sinceId)) write(e);
    } catch {
      /* a replay hiccup shouldn't kill the live stream */
    }

    const unsubscribe = onOpsEvent((e) => {
      if (e.channel === CUISINE_CHANNEL) {
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
  });
}
