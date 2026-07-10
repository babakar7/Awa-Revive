import type { FastifyInstance } from "fastify";
import { pool } from "../../src/db/index.js";
import { signWavePayload } from "../../src/lib/wave.js";

/**
 * Integration-test toolkit: fetch mock for the external APIs, DB seed
 * helpers, and a signed Wave-webhook delivery helper.
 *
 * The Wix response shapes mirror what production has actually stored in
 * slot_cache.slot_json / conversations tool turns (slot = { sessionId,
 * serviceId, startDate, endDate }, wrapped in availabilityEntries with
 * openSpots) — the same shapes src/lib/wix.ts parses.
 */

// ---------- fetch mock ----------

export interface RecordedCall {
  url: string;
  method: string;
  body: any;
}

export interface WixState {
  /** Open spots returned by the availability query. */
  openSpots: number;
  /** Slot template returned by availability (startDate settable per test). */
  slotStart: string;
  slotEnd: string;
  serviceId: string;
  eventId: string;
  /** Ids handed out by create-booking, in order. */
  createdBookingIds: string[];
  /** Make create-booking answer 500 (Wix outage). */
  failCreateBooking: boolean;
}

export interface FetchMock {
  wix: WixState;
  calls: RecordedCall[];
  /** Calls to the WhatsApp Cloud API, parsed. */
  waCalls: () => RecordedCall[];
  /** WhatsApp text messages sent to one number. */
  waTextsTo: (waId: string) => string[];
  /** Brevo email sends, parsed. */
  emailCalls: () => RecordedCall[];
  wixCreateBookingCalls: () => RecordedCall[];
  install: () => void;
  restore: () => void;
  /**
   * Reset recorded calls + Wix state between tests. The mock itself stays
   * installed for the whole suite: fire-and-forget notifications
   * (notifyReception) can still be in flight when a test ends, and a
   * per-test restore would let those stragglers reach the REAL APIs.
   */
  reset: () => void;
}

export function makeFetchMock(): FetchMock {
  const realFetch = globalThis.fetch;
  const calls: RecordedCall[] = [];
  let bookingSeq = 0;

  const wix: WixState = {
    openSpots: 5,
    slotStart: inHours(24),
    slotEnd: inHours(25),
    serviceId: "svc_1",
    eventId: "ev_1",
    createdBookingIds: [],
    failCreateBooking: false,
  };

  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });

  async function mockFetch(input: any, init?: any): Promise<Response> {
    const url = String(input instanceof Request ? input.url : input);
    const method = (init?.method ?? "GET").toUpperCase();
    let body: any = null;
    if (init?.body) {
      try {
        body = JSON.parse(String(init.body));
      } catch {
        body = String(init.body);
      }
    }
    calls.push({ url, method, body });

    // --- Meta WhatsApp Cloud API ---
    if (url.includes("graph.facebook.com")) {
      return json(200, { messages: [{ id: `wamid.test.${calls.length}` }] });
    }

    // --- Brevo (reception email) ---
    if (url.includes("api.brevo.com")) {
      return json(201, { messageId: `brevo-${calls.length}` });
    }

    // --- Wix availability ---
    if (url.includes("/availability-calendar/v1/availability/query")) {
      return json(200, {
        availabilityEntries: [
          {
            slot: {
              sessionId: wix.eventId,
              serviceId: wix.serviceId,
              startDate: wix.slotStart,
              endDate: wix.slotEnd,
            },
            openSpots: wix.openSpots,
          },
        ],
      });
    }

    // --- Wix contacts (phone → contact match; none = Wix creates its own) ---
    if (url.includes("/contacts/v4/contacts/query")) {
      return json(200, { contacts: [] });
    }

    // --- Wix create booking ---
    if (url.endsWith("/bookings/v2/bookings") && method === "POST") {
      if (wix.failCreateBooking) return json(500, { message: "wix exploded" });
      const id = `wb_${++bookingSeq}`;
      wix.createdBookingIds.push(id);
      return json(200, { booking: { id } });
    }

    // --- Wix confirm booking ---
    if (url.includes(":confirmOrDecline")) {
      return json(200, { booking: { status: "CONFIRMED" } });
    }

    throw new Error(`Integration fetch mock: unexpected call ${method} ${url}`);
  }

  return {
    wix,
    calls,
    waCalls: () => calls.filter((c) => c.url.includes("graph.facebook.com")),
    waTextsTo: (waId: string) =>
      calls
        .filter(
          (c) =>
            c.url.includes("graph.facebook.com") &&
            c.body?.to === waId &&
            c.body?.type === "text",
        )
        .map((c) => c.body.text.body as string),
    emailCalls: () => calls.filter((c) => c.url.includes("api.brevo.com")),
    wixCreateBookingCalls: () =>
      calls.filter((c) => c.url.endsWith("/bookings/v2/bookings") && c.method === "POST"),
    install: () => {
      globalThis.fetch = mockFetch as typeof fetch;
    },
    restore: () => {
      globalThis.fetch = realFetch;
    },
    reset: () => {
      calls.length = 0;
      wix.openSpots = 5;
      wix.slotStart = inHours(24);
      wix.slotEnd = inHours(25);
      wix.serviceId = "svc_1";
      wix.eventId = "ev_1";
      wix.createdBookingIds.length = 0;
      wix.failCreateBooking = false;
    },
  };
}

// ---------- time & polling ----------

export function inHours(h: number): string {
  return new Date(Date.now() + h * 3_600_000).toISOString();
}

/** Poll until fn() is truthy (returns it) or time out. */
export async function waitFor<T>(
  fn: () => Promise<T | null | undefined | false>,
  what: string,
  timeoutMs = 4_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`waitFor timed out: ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

/** Fixed pause — for asserting that something did NOT happen. */
export const settle = (ms = 300) => new Promise((r) => setTimeout(r, ms));

// ---------- DB seeds ----------

export async function truncateAll(): Promise<void> {
  await pool.query(
    `truncate clients, pending_bookings, pending_plan_orders, conversations,
              processed_webhooks, handoffs, slot_cache cascade`,
  );
}

export async function seedClient(
  overrides: Partial<{ wa_phone: string; name: string; language: string }> = {},
): Promise<{ id: string; wa_phone: string }> {
  const res = await pool.query(
    `insert into clients (wa_phone, name, language) values ($1, $2, $3)
     returning id, wa_phone`,
    [
      overrides.wa_phone ?? "221770000001",
      overrides.name ?? "Test Client",
      overrides.language ?? "fr",
    ],
  );
  return res.rows[0];
}

export async function seedBooking(
  clientId: string,
  overrides: Partial<Record<string, unknown>> = {},
): Promise<any> {
  const slotStart = (overrides.slot_start as string) ?? inHours(24);
  const defaults: Record<string, unknown> = {
    client_id: clientId,
    service_id: "svc_1",
    service_name: "Pilates Reformer",
    event_id: "ev_1",
    slot_json: JSON.stringify({
      sessionId: "ev_1",
      serviceId: "svc_1",
      startDate: slotStart,
      endDate: inHours(25),
    }),
    slot_start: slotStart,
    slot_end: overrides.slot_end ?? inHours(25),
    amount_xof: 15000,
    participants: 1,
    status: "AWAITING_PAYMENT",
    wave_session_id: "cos-test-1",
    payment_link: "https://pay.wave.com/test",
    link_expires_at: inHours(1),
  };
  const row = { ...defaults, ...overrides };
  const keys = Object.keys(row);
  const res = await pool.query(
    `insert into pending_bookings (${keys.join(", ")})
     values (${keys.map((_, i) => `$${i + 1}`).join(", ")}) returning *`,
    keys.map((k) => row[k]),
  );
  return res.rows[0];
}

export async function bookingById(id: string): Promise<any> {
  const res = await pool.query(`select * from pending_bookings where id = $1`, [id]);
  return res.rows[0] ?? null;
}

export async function waitForStatus(bookingId: string, status: string): Promise<any> {
  return waitFor(async () => {
    const b = await bookingById(bookingId);
    return b?.status === status ? b : null;
  }, `booking ${bookingId} → ${status}`);
}

// ---------- Wave webhook delivery ----------

/**
 * POST a signed checkout.session.completed to the app, exactly like Wave
 * would (same payload shape as scripts/simulate-wave-webhook.ts, which was
 * validated against real Wave deliveries).
 */
export async function deliverWaveWebhook(
  app: FastifyInstance,
  clientReference: string,
  opts: Partial<{ eventId: string; badSignature: boolean; type: string }> = {},
): Promise<{ statusCode: number }> {
  const payload = JSON.stringify({
    id: opts.eventId ?? `EV_test_${Math.random().toString(36).slice(2, 10)}`,
    type: opts.type ?? "checkout.session.completed",
    data: {
      id: `cos-test-${Math.random().toString(36).slice(2, 10)}`,
      amount: "15000",
      currency: "XOF",
      client_reference: clientReference,
      payment_status: "succeeded",
      checkout_status: "complete",
      mobile: "+221770000001",
      when_completed: new Date().toISOString(),
    },
  });
  const signature = opts.badSignature
    ? "t=1234567890,v1=" + "0".repeat(64)
    : signWavePayload(payload, process.env.WAVE_WEBHOOK_SECRET!);

  const res = await app.inject({
    method: "POST",
    url: "/webhooks/wave",
    payload,
    headers: { "content-type": "application/json", "wave-signature": signature },
  });
  return { statusCode: res.statusCode };
}
