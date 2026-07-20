import { config } from "../config.js";
import { phoneKey } from "./crmAudit.js";

/**
 * Wix Bookings REST client (SPEC §4.2).
 *
 * NOTE: endpoint paths and response shapes below follow the current Wix REST
 * docs (Services V2, Availability Calendar V1, Bookings V2). The spec calls
 * for verifying them against https://dev.wix.com/docs/rest/business-solutions/bookings
 * at build time — if a call 404s or a field comes back empty once real
 * credentials are in place, this file is the only place to adjust.
 */

const WIX_API = "https://www.wixapis.com";

// Cap every outbound Wix call: inbound messages are serialized per client, so a
// hung connection would otherwise stall that client's whole queue.
const HTTP_TIMEOUT_MS = 15_000;

// The eCommerce endpoints are throttled more aggressively than the Bookings
// APIs. A booking-order sync performs several dependent Wix calls; spacing
// them prevents Create Order / Add Payments from becoming the third request in
// the same short rate-limit window. Tests use mocked HTTP and skip the wait.
const WIX_ECOM_PACE_MS = process.env.NODE_ENV === "test" ? 0 : 1_250;

async function paceWixEcomCall(): Promise<void> {
  if (WIX_ECOM_PACE_MS === 0) return;
  await new Promise<void>((resolve) => setTimeout(resolve, WIX_ECOM_PACE_MS));
}

function headers(): Record<string, string> {
  return {
    Authorization: config.WIX_API_KEY,
    "wix-site-id": config.WIX_SITE_ID,
    "Content-Type": "application/json",
    // Wix/Cloudflare fingerprint-blocks Node's default undici User-Agent (403
    // with an empty body, verified 11/07 — curl works, Node fetch doesn't).
    // Setting an explicit UA makes server-side and script calls behave.
    "User-Agent": "resabot/1.0",
  };
}

async function wixPost(path: string, body: unknown): Promise<any> {
  const res = await fetch(`${WIX_API}${path}`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Wix ${path} failed (${res.status}): ${text}`);
  }
  return res.json();
}

async function wixGet(path: string): Promise<any> {
  const res = await fetch(`${WIX_API}${path}`, {
    method: "GET",
    headers: headers(),
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Wix ${path} failed (${res.status}): ${text}`);
  }
  return res.json();
}

// ---------- Calendar Events V3 (historical coach compensation) ----------

export interface WixCalendarEvent {
  id: string;
  serviceId: string | null;
  serviceName: string;
  title: string;
  type: string;
  status: string;
  startDate: string;
  endDate: string;
  resources: Array<{ id: string; name: string; type: string | null }>;
  raw: unknown;
}

/**
 * Query concrete calendar occurrences over local Dakar bounds. Calendar V3 is
 * used intentionally: the retired Availability endpoint is unsuitable for
 * historical payroll and may omit completed/full sessions. Cursor pagination
 * is mandatory because Wix defaults to only 50 events.
 */
export async function queryCalendarEventsV3(
  fromLocalDate: string,
  toLocalDate: string,
): Promise<WixCalendarEvent[]> {
  const out: WixCalendarEvent[] = [];
  let cursor: string | undefined;
  const seenCursors = new Set<string>();
  for (;;) {
    const data = await wixPost("/calendar/v3/events/query", {
      fromLocalDate,
      toLocalDate,
      timeZone: config.TIMEZONE,
      recurrenceType: ["NONE", "INSTANCE", "EXCEPTION"],
      query: {
        filter: {
          appId: "13d21c63-b5ec-5912-8397-c3a5ddb27a97",
          type: { $in: ["CLASS", "COURSE", "APPOINTMENT"] },
        },
        cursorPaging: { limit: 100, ...(cursor ? { cursor } : {}) },
      },
    });
    for (const event of Array.isArray(data?.events) ? data.events : []) {
      const startDate =
        event?.adjustedStart?.localDate ?? event?.start?.utcDate ?? event?.start?.localDate;
      const endDate = event?.adjustedEnd?.localDate ?? event?.end?.utcDate ?? event?.end?.localDate;
      if (!event?.id || !startDate || !endDate) continue;
      out.push({
        id: String(event.id),
        serviceId:
          typeof event.externalScheduleId === "string" ? event.externalScheduleId : null,
        serviceName: String(event.scheduleName ?? event.title ?? ""),
        title: String(event.title ?? event.scheduleName ?? "Cours"),
        type: String(event.type ?? "").toUpperCase(),
        status: String(event.status ?? "").toUpperCase(),
        startDate: String(startDate),
        endDate: String(endDate),
        resources: (Array.isArray(event.resources) ? event.resources : [])
          .filter((r: any) => r?.id)
          .map((r: any) => ({
            id: String(r.id),
            name: String(r.name ?? ""),
            type: typeof r.type === "string" ? r.type : null,
          })),
        raw: event,
      });
    }
    const next = data?.pagingMetadata?.cursors?.next;
    if (typeof next !== "string" || !next || seenCursors.has(next)) break;
    seenCursors.add(next);
    cursor = next;
  }
  return out;
}

async function wixPatch(path: string, body: unknown): Promise<any> {
  const res = await fetch(`${WIX_API}${path}`, {
    method: "PATCH",
    headers: headers(),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Wix ${path} failed (${res.status}): ${text}`);
  }
  return res.json();
}

// ---------- services (class catalog) ----------

export interface WixService {
  id: string;
  name: string;
  description: string;
  priceXof: number | null;
  durationMinutes: number | null;
  /** Wix booking-policy cap — a single booking above this is REJECTED by Wix. */
  maxParticipantsPerBooking: number;
  /** Pricing plans connected to this service in Wix (plans that can pay for it). */
  pricingPlanIds: string[];
  /**
   * Wix service type — "CLASS" / "COURSE" (group) or "APPOINTMENT" (1-on-1).
   * The canonical group-vs-private signal for the staff-notification rules.
   * Uppercased; "" when Wix doesn't return it.
   */
  type: string;
}

let servicesCache: { fetchedAt: number; services: WixService[] } | null = null;
const SERVICES_TTL_MS = 10 * 60 * 1000; // cache 10 min (SPEC §6)

export async function listServices(): Promise<WixService[]> {
  if (servicesCache && Date.now() - servicesCache.fetchedAt < SERVICES_TTL_MS) {
    return servicesCache.services;
  }
  const data = await wixPost("/bookings/v2/services/query", { query: {} });
  const services: WixService[] = (data?.services ?? [])
    .filter((s: any) => !s?.hidden)
    .map((s: any) => {
      const pp = s?.bookingPolicy?.participantsPolicy;
      return {
        id: s.id,
        name: s.name ?? "Unnamed class",
        description: (s.description ?? s.tagLine ?? "").slice(0, 300),
        priceXof: extractPrice(s),
        durationMinutes: extractDuration(s),
        maxParticipantsPerBooking: pp?.enabled ? Number(pp.maxParticipantsPerBooking ?? 1) : 1,
        pricingPlanIds: Array.isArray(s?.payment?.pricingPlanIds)
          ? s.payment.pricingPlanIds.map(String)
          : [],
        type: String(s?.type ?? "").toUpperCase(),
      };
    });
  servicesCache = { fetchedAt: Date.now(), services };
  return services;
}

function extractPrice(service: any): number | null {
  const value =
    service?.payment?.fixed?.price?.value ??
    service?.payment?.varied?.defaultPrice?.value ??
    service?.payment?.custom?.description ??
    null;
  if (value == null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n) : null;
}

function extractDuration(service: any): number | null {
  const d =
    service?.schedule?.availabilityConstraints?.sessionDurations?.[0] ??
    service?.schedule?.availabilityConstraints?.durationInMinutes ??
    null;
  const n = Number(d);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export async function getService(serviceId: string): Promise<WixService | null> {
  const services = await listServices();
  return services.find((s) => s.id === serviceId) ?? null;
}

/**
 * Names of the classes a pricing plan can pay for, from the service catalog's
 * plan↔service connections. Returns null when NO service in the catalog
 * declares any connected plan — that means the data isn't available (rather
 * than "this plan covers nothing"), so callers must fall back to the
 * booking-time check instead of claiming zero coverage.
 */
export async function planCoveredClassNames(planId: string): Promise<string[] | null> {
  const services = await listServices();
  if (!services.some((s) => s.pricingPlanIds.length > 0)) return null;
  return services.filter((s) => s.pricingPlanIds.includes(planId)).map((s) => s.name);
}

// ---------- availability ----------

export interface WixSlot {
  eventId: string; // sessionId of the class event
  serviceId: string;
  startDate: string; // ISO
  endDate: string; // ISO
  openSpots: number;
  /**
   * Total capacity of the session, used for the coach headcount
   * (booked = totalSpots − openSpots). 0 when Wix doesn't expose it — callers
   * must render the headcount as "?" rather than a wrong number. LIVE PROBE:
   * the exact field name on the availability entry is verified in prod.
   */
  totalSpots: number;
  /** Coach assigned to this session (slot.resource.name) — verified live 11/07. */
  coach: string | null;
  /** Wix resource id of the coach (slot.resource.id) — resolves to a phone via
   *  listStaffResources(); more reliable than matching on the name. */
  coachId: string | null;
  /** Full slot object exactly as returned by Wix — passed back on Create Booking. */
  raw: unknown;
}

export async function queryAvailability(
  serviceId: string,
  dateFrom: string,
  dateTo: string,
): Promise<WixSlot[]> {
  return queryAvailabilityMulti([serviceId], dateFrom, dateTo);
}

/**
 * Same availability query for SEVERAL services at once (the filter natively
 * takes an array) — one Wix call for the whole weekly schedule.
 */
export async function queryAvailabilityMulti(
  serviceIds: string[],
  dateFrom: string,
  dateTo: string,
): Promise<WixSlot[]> {
  if (serviceIds.length === 0) return [];
  // No `bookable` filter: full classes must come back too, so the agent can
  // say "that class exists but is full" instead of "there is no class".
  const data = await wixPost("/availability-calendar/v1/availability/query", {
    query: {
      filter: {
        serviceId: serviceIds,
        startDate: dateFrom,
        endDate: dateTo,
      },
    },
  });
  // Single-service calls keep the historical fallback (slot.serviceId missing
  // → the requested id); with several ids an entry without serviceId is
  // unattributable and dropped.
  const fallbackId = serviceIds.length === 1 ? serviceIds[0] : undefined;
  const entries: any[] = data?.availabilityEntries ?? [];
  return entries
    .filter((e) => e?.slot?.sessionId && (e?.slot?.serviceId || fallbackId))
    .map((e) => ({
      eventId: e.slot.sessionId as string,
      serviceId: (e.slot.serviceId ?? fallbackId) as string,
      startDate: e.slot.startDate,
      endDate: e.slot.endDate,
      openSpots: Number(e.openSpots ?? 0),
      // Availability entries carry capacity as `totalSpots`; fall back to a few
      // spellings so a schema tweak degrades to "?" (0) instead of a wrong count.
      totalSpots: Number(e.totalSpots ?? e.slot?.totalSpots ?? e.slot?.capacity ?? 0),
      coach: typeof e.slot.resource?.name === "string" ? e.slot.resource.name : null,
      coachId: typeof e.slot.resource?.id === "string" ? e.slot.resource.id : null,
      raw: e.slot,
    }));
}

// ---------- staff resources (coaches, with contact details) ----------

export interface WixStaffResource {
  id: string;
  name: string;
  phone: string | null;
  email: string | null;
}

let staffCache: { fetchedAt: number; staff: WixStaffResource[] } | null = null;

/**
 * Staff resources (coaches) with their contact details — the source of truth
 * for coach phone numbers in the staff-notification engine. Keeps only entries
 * tagged "staff" (excludes rooms/equipment). Cached 10 min like the catalog.
 */
export async function listStaffResources(): Promise<WixStaffResource[]> {
  if (staffCache && Date.now() - staffCache.fetchedAt < SERVICES_TTL_MS) {
    return staffCache.staff;
  }
  const data = await wixPost("/bookings/v1/resources/query", { query: {} });
  const staff: WixStaffResource[] = (data?.resources ?? [])
    .filter(
      (r: any) => !Array.isArray(r?.tags) || r.tags.length === 0 || r.tags.includes("staff"),
    )
    .map((r: any) => ({
      id: String(r.id),
      name: String(r.name ?? ""),
      phone: typeof r.phone === "string" && r.phone.trim() ? r.phone.trim() : null,
      email: typeof r.email === "string" && r.email.trim() ? r.email.trim() : null,
    }));
  staffCache = { fetchedAt: Date.now(), staff };
  return staff;
}

/** Fetch the current state of one specific class event (whatever its capacity). */
export async function findSlot(
  serviceId: string,
  eventId: string,
  slotStartIso: string,
): Promise<WixSlot | null> {
  const start = new Date(slotStartIso);
  const from = new Date(start.getTime() - 60 * 60 * 1000).toISOString();
  const to = new Date(start.getTime() + 60 * 60 * 1000).toISOString();
  const slots = await queryAvailability(serviceId, from, to);
  return slots.find((s) => s.eventId === eventId) ?? null;
}

/** Re-check that a specific class event still has enough open spots. */
export async function isSlotStillOpen(
  serviceId: string,
  eventId: string,
  slotStartIso: string,
  minSpots = 1,
): Promise<WixSlot | null> {
  const match = await findSlot(serviceId, eventId, slotStartIso);
  return match && match.openSpots >= minSpots ? match : null;
}

/**
 * Live status of bookings in Wix (CONFIRMED / CANCELED / ...), keyed by
 * booking id. Used to sync cancellations made in the Wix dashboard.
 */
export async function getBookingStatuses(bookingIds: string[]): Promise<Record<string, string>> {
  if (bookingIds.length === 0) return {};
  const data = await wixPost("/_api/bookings-reader/v2/extended-bookings/query", {
    query: { filter: { id: { $in: bookingIds } } },
  });
  const out: Record<string, string> = {};
  for (const eb of data?.extendedBookings ?? []) {
    const b = eb?.booking;
    if (b?.id) out[b.id] = b.status ?? "UNKNOWN";
  }
  return out;
}

// ---------- Booking contact repair (cas « A »/Amy Ndiaye, PROGRESS §6.6bis) ----------

export interface BookingContactSnapshot {
  bookingId: string;
  revision: string;
  contactId: string | null;
  firstName: string | null;
  lastName: string | null;
}

/**
 * Read revision + contactDetails for a set of bookings via the reader query —
 * there is no GET /bookings/v2/bookings/{id} (404, verified live 21/07).
 */
export async function getBookingContactSnapshots(
  bookingIds: string[],
): Promise<BookingContactSnapshot[]> {
  if (bookingIds.length === 0) return [];
  const data = await wixPost("/_api/bookings-reader/v2/extended-bookings/query", {
    query: { filter: { id: { $in: bookingIds } } },
  });
  const out: BookingContactSnapshot[] = [];
  for (const eb of data?.extendedBookings ?? []) {
    const b = eb?.booking;
    if (!b?.id || !b?.revision) continue;
    out.push({
      bookingId: String(b.id),
      revision: String(b.revision),
      contactId: b?.contactDetails?.contactId ? String(b.contactDetails.contactId) : null,
      firstName: b?.contactDetails?.firstName ? String(b.contactDetails.firstName) : null,
      lastName: b?.contactDetails?.lastName ? String(b.contactDetails.lastName) : null,
    });
  }
  return out;
}

/**
 * UNDOCUMENTED endpoint: PATCH /bookings/v2/bookings/{id} with the current
 * revision re-attaches a booking to a contact and fixes its display name,
 * leaving status/payment/participants intact (verified live 21/07 on the Amy
 * Ndiaye and Habott Lina bookings). It is absent from the public Writer V2
 * API, so Wix could remove it — callers MUST treat a failure as non-fatal
 * (the booking stays valid, only its label is off).
 */
export async function updateBookingContactDetails(args: {
  bookingId: string;
  revision: string;
  contactId: string;
  firstName: string;
  lastName?: string;
  phone: string;
}): Promise<void> {
  await wixPatch(`/bookings/v2/bookings/${args.bookingId}`, {
    booking: {
      revision: args.revision,
      contactDetails: {
        contactId: args.contactId,
        firstName: args.firstName,
        ...(args.lastName ? { lastName: args.lastName } : {}),
        phone: args.phone,
      },
    },
  });
}

/**
 * All of a contact's upcoming CONFIRMED bookings straight from Wix — so
 * get_my_bookings can also show classes booked at the counter or on the
 * website, not just the ones taken through Awa (money side of a cancellation
 * still goes through reception — no local payment context).
 *
 * Shape and filter paths VERIFIED on live data (11/07, Marie's contact):
 * the filter field is `contactDetails.contactId` — `booking.contactDetails.*`
 * is rejected with a 400 (that bug silently emptied get_my_bookings until
 * today). `status` filters fine server-side; date filters return 200 with 0
 * rows (unreliable) → the future-only cut stays client-side, with paging
 * (default page is 50, unsorted — old rows come first, so paging is a MUST
 * for regulars with history). Still defensive: an unexpected shape yields an
 * empty list, never a throw that would break get_my_bookings.
 */
export interface WixContactBooking {
  id: string;
  serviceName: string;
  startDate: string; // ISO
  participants: number;
}

/**
 * Booking activity of these contacts, for the /admin/crm activity ranking —
 * batched ($in verified live 11/07). Returns two sets: `upcoming` (a confirmed
 * booking still in the future) and `recent` (a booking whose class ran within
 * the last `recentDays`, default 30). Same caveats as above: the date filter is
 * unusable server-side → the past/future cut is done here.
 */
export async function contactBookingActivity(
  contactIds: string[],
  recentDays = 30,
): Promise<{ upcoming: Set<string>; recent: Set<string> }> {
  const upcoming = new Set<string>();
  const recent = new Set<string>();
  const now = Date.now();
  const recentFloor = now - recentDays * 86_400_000;
  for (let i = 0; i < contactIds.length; i += 50) {
    const batch = contactIds.slice(i, i + 50);
    for (let offset = 0; offset < 500; offset += 100) {
      const data = await wixPost("/_api/bookings-reader/v2/extended-bookings/query", {
        query: {
          filter: {
            "contactDetails.contactId": { $in: batch },
            status: { $in: ["CONFIRMED", "PENDING"] },
          },
          paging: { limit: 100, offset },
        },
      });
      const ebs: any[] = data?.extendedBookings ?? [];
      for (const eb of ebs) {
        const b = eb?.booking;
        const cid = b?.contactDetails?.contactId;
        const slot = b?.bookedEntity?.slot ?? b?.bookedEntity?.schedule ?? {};
        const start: string | undefined = slot.startDate ?? slot.firstSessionStart;
        if (!cid || !start) continue;
        const t = Date.parse(start);
        if (Number.isNaN(t)) continue;
        if (t > now) upcoming.add(cid);
        else if (t >= recentFloor) recent.add(cid);
      }
      if (ebs.length < 100) break;
    }
  }
  return { upcoming, recent };
}

export async function listContactUpcomingBookings(
  contactId: string,
): Promise<WixContactBooking[]> {
  const extendedBookings: any[] = [];
  for (let offset = 0; offset < 500; offset += 100) {
    const data = await wixPost("/_api/bookings-reader/v2/extended-bookings/query", {
      query: {
        filter: { "contactDetails.contactId": contactId, status: { $in: ["CONFIRMED", "PENDING"] } },
        paging: { limit: 100, offset },
      },
    });
    const batch: any[] = data?.extendedBookings ?? [];
    extendedBookings.push(...batch);
    if (batch.length < 100) break;
  }
  const services = await listServices().catch(() => [] as WixService[]);
  const serviceName = (id: string | undefined) =>
    services.find((s) => s.id === id)?.name ?? "Cours";

  const now = Date.now();
  const out: WixContactBooking[] = [];
  for (const eb of extendedBookings) {
    const b = eb?.booking;
    if (!b?.id) continue;
    const status = b.status ?? "UNKNOWN";
    if (status !== "CONFIRMED" && status !== "PENDING") continue;
    const slot = b?.bookedEntity?.slot ?? b?.bookedEntity?.schedule ?? {};
    const startDate: string | undefined = slot.startDate ?? slot.firstSessionStart;
    if (!startDate || Number.isNaN(Date.parse(startDate)) || Date.parse(startDate) <= now) continue;
    out.push({
      id: b.id,
      serviceName: b?.bookedEntity?.title ?? serviceName(slot.serviceId),
      startDate,
      participants: Math.max(1, Number(b.numberOfParticipants ?? 1)),
    });
  }
  return out.sort((a, b) => Date.parse(a.startDate) - Date.parse(b.startDate));
}

/**
 * Has this contact ever booked a Pilates class at Revive (confirmed or pending)?
 *
 * Used to gate the Pack Découverte: the pack is for first-time Pilates clients
 * only. Other past classes (aquabike, yoga…) do NOT disqualify. Past OR future
 * Pilates bookings both count — a confirmed booking proves they are no longer
 * "new to Pilates", and Wix date filters are unreliable server-side (see
 * listContactUpcomingBookings comments).
 *
 * Defensive: any unexpected shape or network error → false. Prefer letting a
 * sale through over blocking on a bug (unknown / unlinked numbers also sell
 * without asking — friction is only applied when history is clearly visible).
 */
export async function hasPastPilatesBooking(contactId: string): Promise<boolean> {
  try {
    const extendedBookings: any[] = [];
    for (let offset = 0; offset < 500; offset += 100) {
      const data = await wixPost("/_api/bookings-reader/v2/extended-bookings/query", {
        query: {
          filter: {
            "contactDetails.contactId": contactId,
            status: { $in: ["CONFIRMED", "PENDING"] },
          },
          paging: { limit: 100, offset },
        },
      });
      const batch: any[] = data?.extendedBookings ?? [];
      extendedBookings.push(...batch);
      if (batch.length < 100) break;
    }
    if (extendedBookings.length === 0) return false;

    const services = await listServices().catch(() => [] as WixService[]);
    const serviceName = (id: string | undefined) =>
      services.find((s) => s.id === id)?.name ?? "";

    for (const eb of extendedBookings) {
      const b = eb?.booking;
      if (!b?.id) continue;
      const status = b.status ?? "UNKNOWN";
      if (status !== "CONFIRMED" && status !== "PENDING") continue;
      const slot = b?.bookedEntity?.slot ?? b?.bookedEntity?.schedule ?? {};
      const name: string = b?.bookedEntity?.title ?? serviceName(slot.serviceId);
      if (/pilates/i.test(name)) return true;
    }
    return false;
  } catch (err) {
    console.error("hasPastPilatesBooking failed (allowing sale):", err);
    return false;
  }
}

// ---------- contacts ----------

/**
 * Find an existing Wix CRM contact for this phone number, so bookings attach
 * to the client's existing account instead of creating a duplicate contact.
 *
 * Deliberately conservative — linking the WRONG contact is worse than
 * creating a new one:
 *   - exactly one contact with this phone → link it
 *   - several → link only if exactly one also matches the first name
 *   - none / still ambiguous → return null (Wix default behavior applies)
 */
/**
 * Every spelling under which this client's number may be stored in Wix.
 * ~1 contact in 7 (prod audit, 11/07) has a phone saved RAW by reception,
 * without e164 — "774446666" or "77 444 66 66". For Senegalese numbers
 * (+221 7XXXXXXXX, where WhatsApp lives) we therefore also match the local
 * spellings; other countries only get the international forms (a bare local
 * number would be ambiguous across countries).
 */
export function phoneMatchVariants(phone: string): string[] {
  const e164 = phone.startsWith("+") ? phone : `+${phone}`;
  const digits = e164.replace(/\D/g, ""); // 221774446666
  const variants = new Set<string>([e164, digits, `00${digits}`]);
  if (digits.startsWith("2217") && digits.length === 12) {
    const local = digits.slice(3); // 774446666
    variants.add(local);
    // Common Senegalese display grouping: 77 444 66 66
    variants.add(
      `${local.slice(0, 2)} ${local.slice(2, 5)} ${local.slice(5, 7)} ${local.slice(7, 9)}`,
    );
  }
  return [...variants];
}

export interface WixContactMatch {
  id: string;
  /** Canonical display name stored on the Wix CRM contact. */
  fullName: string | null;
}

export function wixContactFullName(contact: any): string | null {
  const first = String(contact?.info?.name?.first ?? "").trim();
  const last = String(contact?.info?.name?.last ?? "").trim();
  const name = [first, last].filter(Boolean).join(" ").trim();
  return name || null;
}

export function splitContactName(name: string): { firstName: string; lastName?: string } {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const firstName = parts.shift() || "Client Revive";
  const lastName = parts.join(" ");
  return { firstName, ...(lastName ? { lastName } : {}) };
}

function normalizeContactName(value: string): string {
  return (value ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim();
}

function chooseContact(contacts: any[], nameHint?: string): any | null {
  if (contacts.length === 0) return null;
  if (contacts.length === 1) return contacts[0];
  if (!nameHint) return null;

  const normalizedHint = normalizeContactName(nameHint);
  const hintFirst = normalizedHint.split(/\s+/)[0] ?? "";
  const matches = contacts.filter((contact) => {
    const fullName = normalizeContactName(wixContactFullName(contact) ?? "");
    const firstName = normalizeContactName(contact?.info?.name?.first ?? "");
    return fullName === normalizedHint || (!!hintFirst && firstName === hintFirst);
  });
  return matches.length === 1 ? matches[0] : null;
}

export async function findContactByPhone(
  phone: string,
  nameHint?: string,
): Promise<WixContactMatch | null> {
  try {
    const contacts = await queryContactsByPhone(phone);
    const contact = chooseContact(contacts, nameHint);
    if (!contact?.id) return null;
    return { id: String(contact.id), fullName: wixContactFullName(contact) };
  } catch (err) {
    console.error("Wix contact lookup failed (booking will create/match contact itself):", err);
    return null;
  }
}

export async function findContactIdByPhone(
  phone: string,
  firstName?: string,
): Promise<string | null> {
  return (await findContactByPhone(phone, firstName))?.id ?? null;
}

async function queryContactsByPhone(phone: string): Promise<any[]> {
  const e164 = phone.startsWith("+") ? phone : `+${phone}`;
  const data = await wixPost("/contacts/v4/contacts/query", {
    query: { filter: { "info.phones.e164Phone": { $eq: e164 } } },
  });
  let contacts: any[] = data?.contacts ?? [];
  if (contacts.length === 0) {
    // No e164 match → try the raw spellings (field verified live 11/07:
    // info.phones.phone matches the stored string, spaces included).
    const fallback = await wixPost("/contacts/v4/contacts/query", {
      query: { filter: { "info.phones.phone": { $in: phoneMatchVariants(phone) } } },
    });
    contacts = fallback?.contacts ?? [];
  }
  return contacts;
}

/**
 * ALL contacts carrying this phone (e164 first, raw spellings as fallback) —
 * the raw list, not the "unique or null" collapse of findContactIdByPhone.
 * Needed by the post-verification step: that step must tell "index lag / 0
 * result" apart from "a real second fiche" (both make findContactIdByPhone
 * return null), and, when there IS a real duplicate, get every fiche id to
 * auto-merge. Returns [] on error (caller then falls back to no-merge).
 */
export async function findContactsByPhone(phone: string): Promise<any[]> {
  try {
    return await queryContactsByPhone(phone);
  } catch (err) {
    console.error("findContactsByPhone failed:", err);
    return [];
  }
}

/**
 * Merge duplicate contacts: `sourceIds` are absorbed into `targetId` (Wix
 * DELETES the sources — irreversible). Used by the /admin/crm cleanup page;
 * the route re-verifies that every contact involved shares the same phone
 * before calling this.
 */
export async function mergeContacts(targetId: string, sourceIds: string[]): Promise<void> {
  // Field names + required revision verified live (11/07) — the endpoint
  // wants the target's current revision (optimistic concurrency).
  const target = await getContactById(targetId);
  if (!target) throw new Error(`merge target ${targetId} not found`);
  await wixPost(`/contacts/v4/contacts/${targetId}/merge`, {
    sourceContactIds: sourceIds,
    targetContactRevision: target.revision,
  });
}

/**
 * Which of these contacts are SITE MEMBERS (login accounts). Wix refuses to
 * merge a member contact as a merge SOURCE (428 FAILED_PRECONDITION, seen
 * live 11/07 on Dieynaba's duplicates) — the CRM page needs to know upfront.
 * One query for the whole batch ($in verified live).
 */
export async function findMemberContactIds(contactIds: string[]): Promise<Set<string>> {
  const out = new Set<string>();
  for (let i = 0; i < contactIds.length; i += 100) {
    const data = await wixPost("/members/v1/members/query", {
      query: { filter: { contactId: { $in: contactIds.slice(i, i + 100) } } },
    });
    for (const m of data?.members ?? []) {
      if (m?.contactId) out.add(m.contactId);
    }
  }
  return out;
}

/** One contact by id (used to re-verify a merge server-side). */
export async function getContactById(contactId: string): Promise<any | null> {
  const res = await fetch(`${WIX_API}/contacts/v4/contacts/${contactId}`, {
    headers: headers(),
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Wix get contact failed (${res.status}): ${await res.text()}`);
  const data: any = await res.json();
  return data?.contact ?? null;
}

// ---------- email-based account linking (liaison par email vérifié) ----------

/**
 * Contacts whose stored email equals `email`. Filterability AND case-
 * insensitivity of the filter verified live (sonde 11/07: $eq matches the
 * stored address regardless of case), so one $eq on the trimmed input is
 * enough.
 */
export async function findContactsByEmail(email: string): Promise<any[]> {
  const data = await wixPost("/contacts/v4/contacts/query", {
    query: { filter: { "info.emails.email": { $eq: email.trim() } } },
  });
  return data?.contacts ?? [];
}

export type EmailCandidate =
  | { kind: "none" }
  | { kind: "already_linked"; contactId: string }
  | { kind: "one"; contact: any }
  | { kind: "ambiguous"; count: number };

/**
 * Which fiche (if any) an email verification should link to. Several fiches
 * can share one email (family plans, reception-created cards): linking is
 * only safe when the choice is unambiguous — exactly one fiche, or exactly
 * one holding an active abonnement (the whole point of the flow). A fiche
 * already carrying the client's WhatsApp number means there is nothing to
 * link.
 */
export function resolveEmailCandidate(
  contacts: any[],
  planHolderIds: Set<string>,
  waPhone: string,
): EmailCandidate {
  if (contacts.length === 0) return { kind: "none" };
  const waKey = phoneKey(waPhone);
  for (const c of contacts) {
    const phones: any[] = c?.info?.phones?.items ?? [];
    if (
      waKey &&
      phones.some((p) => phoneKey(String(p?.e164Phone ?? p?.phone ?? "")) === waKey)
    ) {
      return { kind: "already_linked", contactId: c.id };
    }
  }
  if (contacts.length === 1) return { kind: "one", contact: contacts[0] };
  const holders = contacts.filter((c) => planHolderIds.has(c?.id));
  if (holders.length === 1) return { kind: "one", contact: holders[0] };
  return { kind: "ambiguous", count: contacts.length };
}

/**
 * Phone items to PATCH so `phone` is ADDED to a contact. Wix replaces the
 * WHOLE phones array on update (verified live 11/07 on a disposable contact),
 * so the existing items must always be resent. Senegalese numbers are sent as
 * countryCode SN + local digits — Wix then computes e164Phone itself (the
 * field findContactIdByPhone matches first). Returns null when the number is
 * already on the fiche (no-op).
 */
export function appendPhoneItems(existingItems: any[], phone: string): any[] | null {
  const e164 = phone.startsWith("+") ? phone : `+${phone}`;
  const key = phoneKey(e164);
  if (!key) return null;
  if (existingItems.some((p) => phoneKey(String(p?.e164Phone ?? p?.phone ?? "")) === key)) {
    return null;
  }
  // Resend only the input fields — e164Phone/formattedPhone are computed by
  // Wix and rejected as input.
  const kept = existingItems.map((p) => ({
    ...(p?.tag ? { tag: p.tag } : {}),
    phone: String(p?.phone ?? p?.e164Phone ?? ""),
    ...(p?.countryCode ? { countryCode: p.countryCode } : {}),
    ...(p?.primary !== undefined ? { primary: p.primary } : {}),
  }));
  const digits = e164.replace(/\D/g, "");
  const added =
    digits.startsWith("2217") && digits.length === 12
      ? { tag: "MOBILE", countryCode: "SN", phone: digits.slice(3) }
      : { tag: "MOBILE", phone: e164 };
  return [...kept, added];
}

/**
 * Add a phone number to an existing contact WITHOUT touching its other
 * phones. Revision is mandatory (400 without, 409 when stale — both verified
 * live); a stale revision is retried once with a fresh fetch.
 */
export async function addPhoneToContact(
  contactId: string,
  phone: string,
): Promise<"added" | "already_present"> {
  for (let attempt = 0; ; attempt++) {
    const contact = await getContactById(contactId);
    if (!contact) throw new Error(`contact ${contactId} not found`);
    const items = appendPhoneItems(contact?.info?.phones?.items ?? [], phone);
    if (items === null) return "already_present";
    try {
      await wixPatch(`/contacts/v4/contacts/${contactId}`, {
        revision: contact.revision,
        info: { phones: { items } },
      });
      return "added";
    } catch (err) {
      if (attempt === 0 && String(err).includes("(409)")) continue; // stale revision — refetch once
      throw err;
    }
  }
}

/**
 * Create a brand-new CRM contact for a client who has no Wix account yet.
 * Called only AFTER the client proved ownership of the email by code
 * (submit_verification_code) — the email is therefore known-good and, per the
 * "none" candidate that routed here, carried by no existing fiche, so this
 * never duplicates on email. The WhatsApp number may still exist on an
 * anonymous fiche from a past Wave payment; the caller's post-verification
 * merge absorbs that. Senegalese numbers go in as countryCode SN + local
 * digits so Wix computes the e164Phone that findContactIdByPhone matches.
 */
export async function createContact(args: {
  name?: string;
  phone: string;
  email?: string;
}): Promise<string> {
  const info: any = {};
  const name = args.name?.trim();
  if (name) {
    const parts = name.split(/\s+/);
    info.name = {
      first: parts[0],
      ...(parts.length > 1 ? { last: parts.slice(1).join(" ") } : {}),
    };
  }
  const e164 = args.phone.startsWith("+") ? args.phone : `+${args.phone}`;
  const digits = e164.replace(/\D/g, "");
  info.phones = {
    items: [
      digits.startsWith("2217") && digits.length === 12
        ? { tag: "MOBILE", countryCode: "SN", phone: digits.slice(3) }
        : { tag: "MOBILE", phone: e164 },
    ],
  };
  if (args.email) info.emails = { items: [{ tag: "MAIN", email: args.email }] };
  const data = await wixPost("/contacts/v4/contacts", { info });
  const id = data?.contact?.id;
  if (!id) throw new Error(`Wix create contact returned no id: ${JSON.stringify(data)}`);
  return id;
}

// ---------- pricing plans (memberships / abonnements) ----------

export interface Membership {
  orderId: string;
  planId: string;
  planName: string;
  contactId: string;
  expiresAt: string | null;
}

/**
 * Active pricing-plan orders for a contact (client-side filter). The orders
 * endpoint caps limit at 50 and prod already has 46 ACTIVE orders (11/07) —
 * WITHOUT pagination, clients beyond the first page would silently lose
 * their abonnement in Awa's eyes. Paged until hasNext=false (cap 1000).
 */
export async function listAllActiveOrders(): Promise<any[]> {
  const orders: any[] = [];
  for (let offset = 0; offset < 1000; offset += 50) {
    const res = await fetch(
      `${WIX_API}/pricing-plans/v2/orders?orderStatuses=ACTIVE&limit=50&offset=${offset}`,
      { headers: headers(), signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) },
    );
    if (!res.ok) throw new Error(`Wix orders list failed (${res.status}): ${await res.text()}`);
    const data: any = await res.json();
    orders.push(...(data?.orders ?? []));
    if (!data?.pagingMetadata?.hasNext) break;
  }
  return orders;
}

export async function listActiveMemberships(contactId: string): Promise<Membership[]> {
  const orders = await listAllActiveOrders();
  return orders
    .filter((o: any) => o?.buyer?.contactId === contactId)
    .map((o: any) => ({
      orderId: o.id,
      planId: o.planId,
      planName: o.planName ?? o.planId,
      contactId: o.buyer.contactId,
      expiresAt: o.endDate ?? null,
    }));
}

// ---------- pricing plans catalog & selling ----------

export interface WixPlan {
  id: string;
  name: string;
  description: string;
  priceXof: number;
  /** "one_time" (carnet/pack à durée) ou "recurring" (mensuel reconduit). */
  billing: "one_time" | "recurring";
  /** Durée/période humaine, ex "1 mois", "2 semaines", ou null si illimité. */
  periodLabel: string | null;
  /**
   * Awa peut proposer de le RENOUVELER. Règle métier (Babakar, 12/07) : durée
   * ≥ 1 mois ET pas une carte cadeau. Le Pack Découverte (2 semaines) et les
   * cartes cadeaux sont donc exclus ; les carnets (≥ 1 mois) sont inclus. Les
   * programmes gratuits n'arrivent jamais ici (listPlans écarte les plans à 0 F).
   */
  renewable: boolean;
}

let plansCache: { fetchedAt: number; plans: WixPlan[] } | null = null;

const DURATION_DAYS: Record<string, number> = { DAY: 1, WEEK: 7, MONTH: 30, YEAR: 365 };

function durationToDays(duration: any): number | null {
  if (!duration?.count || !duration?.unit) return null;
  const per = DURATION_DAYS[duration.unit];
  return per ? per * duration.count : null;
}

/**
 * Business rule for "Awa may offer to renew this plan". Pure (unit-tested).
 * Renewable = a real plan of ~a month or more, and NOT a gift card (a gift
 * isn't a subscription to renew). Short trials like the Pack Découverte
 * (2 weeks → 14 days) fall under the 28-day floor and are excluded. Free promo
 * programs (0 F) never reach this — listPlans drops them before this runs.
 */
export function isPlanRenewable(name: string, durationDays: number | null): boolean {
  if (durationDays === null || durationDays < 28) return false;
  if (/cadeau/i.test(name)) return false;
  return true;
}

/**
 * Business rule: is this the one-shot discovery / trial pack for first-time
 * Pilates clients? Name-based (same approach as isPlanRenewable / gift cards) —
 * the live catalogue is the source of plan names, we only classify them here.
 * Matches "Pack Découverte", "Discovery", "Essai", "Trial", etc.
 */
export function isDiscoveryPlan(name: string): boolean {
  return /découverte|discovery|essai|trial/i.test(name);
}

/**
 * Business rule: is this a gift card ("Carte Cadeau") ? Awa must NOT sell gift
 * cards (they would activate on the buyer's own account instead of being
 * gifted) — listPlans drops them so they never reach list_plans / getPlan.
 * They still exist in Wix for manual/website gifting, and clients who already
 * OWN one keep using it (redemption goes through the benefit pools, not here).
 * Same name-based approach as isPlanRenewable, which already treats /cadeau/ as
 * non-renewable.
 */
export function isGiftCard(name: string): boolean {
  return /cadeau|gift/i.test(name);
}

function periodLabel(duration: any): string | null {
  if (!duration?.count || !duration?.unit) return null;
  const units: Record<string, [string, string]> = {
    DAY: ["jour", "jours"],
    WEEK: ["semaine", "semaines"],
    MONTH: ["mois", "mois"],
    YEAR: ["an", "ans"],
  };
  const u = units[duration.unit];
  if (!u) return null;
  return `${duration.count} ${duration.count > 1 ? u[1] : u[0]}`;
}

/**
 * Sellable plans: visible, not archived, with a real price. Zero-priced promo
 * plans (Invitation, Collab...) are internal — never sold by Awa.
 */
export async function listPlans(): Promise<WixPlan[]> {
  if (plansCache && Date.now() - plansCache.fetchedAt < SERVICES_TTL_MS) {
    return plansCache.plans;
  }
  const res = await fetch(`${WIX_API}/pricing-plans/v2/plans?limit=100`, {
    headers: headers(),
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Wix plans list failed (${res.status}): ${await res.text()}`);
  const data: any = await res.json();
  // Visibility model (verified live 16/07): the ONLY reliable "hide from Awa"
  // signal is `archived` — archive a plan in Wix to pull it from the catalogue.
  // `public` is NOT usable here: plans sold via Awa but hidden from the website
  // pricing page are `public:false` (e.g. Pack Découverte). Do NOT filter on
  // `public` — it would remove the discovery pack and break the trial flow.
  // (The old `!p.hidden` clause was a no-op: Wix plans have no `hidden` field.)
  const plans: WixPlan[] = (data?.plans ?? [])
    .filter((p: any) => !p.archived)
    .map((p: any) => {
      const price = Number(p?.pricing?.price?.value ?? 0);
      const recurring = !!p?.pricing?.subscription;
      const duration = recurring
        ? p.pricing.subscription.cycleDuration
        : p?.pricing?.singlePaymentForDuration;
      const name = p.name ?? "Abonnement";
      return {
        id: p.id,
        name,
        description: (p.description ?? "").slice(0, 300),
        priceXof: price,
        billing: recurring ? "recurring" : "one_time",
        periodLabel: periodLabel(duration),
        renewable: isPlanRenewable(name, durationToDays(duration)),
      } as WixPlan;
    })
    // Sellable by Awa: real price, and not a gift card (never self-sold — see
    // isGiftCard). Zero-priced promo plans (Invitation, Collab…) are internal.
    .filter((p: WixPlan) => p.priceXof > 0 && !isGiftCard(p.name));
  plansCache = { fetchedAt: Date.now(), plans };
  return plans;
}

export async function getPlan(planId: string): Promise<WixPlan | null> {
  const plans = await listPlans();
  return plans.find((p) => p.id === planId) ?? null;
}

/**
 * Activate a plan for a member after an offline (Wave) payment. The offline
 * order API REQUIRES a real Wix member id (a bare contactId → 400
 * MEMBER_DOESNT_EXIST, probed 13/07) — the caller must resolve memberId first
 * and fall back to manual reception activation when the client has none. Note
 * a contact CAN hold a plan when assigned in the dashboard; the constraint is
 * only about auto-activating via this API. Awa deliberately does NOT create
 * members to fill the gap: POST /members/v1/members works but emails the client
 * a Wix invite/set-password mail (probed 13/07), unacceptable in a silent
 * WhatsApp flow. See PLAN-PACK-DECOUVERTE-ACTIVATION.md.
 *
 * startDate (ISO): optional. When in the FUTURE, Wix creates the order as
 * PENDING and activates it automatically on that date — this is how a renewal
 * bought early chains onto the end of the current plan (no lost days, no cron
 * on our side). Omitted/past → activates immediately (Wix default = now).
 */
export async function createOfflinePlanOrder(
  planId: string,
  memberId: string,
  startDate?: string,
): Promise<string> {
  const data = await wixPost("/pricing-plans/v2/checkout/orders/offline", {
    planId,
    memberId,
    paid: true,
    ...(startDate ? { startDate } : {}),
  });
  const orderId = data?.order?.id;
  if (!orderId) throw new Error(`Offline plan order returned no id: ${JSON.stringify(data)}`);
  return orderId;
}

/**
 * The latest future end date among a contact's active plans, or null when they
 * have none (or none with a readable future endDate). Used to chain a renewal:
 * the new plan starts when the current one ends. Server-resolved from Wix so
 * the date is never taken from the model (anti prompt-injection).
 */
export async function latestPlanEndDate(contactId: string): Promise<string | null> {
  const memberships = await listActiveMemberships(contactId);
  const now = Date.now();
  let latest: number | null = null;
  for (const m of memberships) {
    if (!m.expiresAt) continue;
    const t = new Date(m.expiresAt).getTime();
    if (!Number.isNaN(t) && t > now && (latest === null || t > latest)) latest = t;
  }
  return latest === null ? null : new Date(latest).toISOString();
}

/** Contact → member GUID (offline plan activation via API needs a member id).
 *  Null if the contact has no member account. */
export async function resolveMemberIdForPlan(
  phone: string,
  firstName?: string,
): Promise<string | null> {
  const contactId = await findContactIdByPhone(phone, firstName);
  if (!contactId) return null;
  return findMemberIdByContactId(contactId);
}

// ---------- benefit programs (membership redemption) ----------

/** Well-known Wix Bookings app id — provider of plan-covered class sessions. */
const WIX_BOOKINGS_APP_ID = "13d21c63-b5ec-5912-8397-c3a5ddb27a97";
/** Namespace under which the Pricing Plans app registers its benefit pools. */
const PRICING_PLANS_NAMESPACE = "@wix/pricing-plans";

/**
 * Membership redemption uses the Benefit Programs API — the same ledger the
 * Pricing Plans app maintains for session credits. The eCommerce-checkout
 * route does NOT work server-side: an API-key checkout is anonymous
 * (buyerInfo.openAccess), so Wix never lists the client's memberships as
 * eligible. Benefit Programs accepts an explicit beneficiary instead.
 */

export interface EligibleBenefit {
  poolId: string;
  benefitKey: string;
  memberId: string;
  planName: string;
  available: number;
}

/** Members and contacts are distinct entities; resolve via the Members API. */
export async function findMemberIdByContactId(contactId: string): Promise<string | null> {
  try {
    const data = await wixPost("/members/v1/members/query", {
      query: { filter: { contactId } },
    });
    return data?.members?.[0]?.id ?? null;
  } catch (err) {
    console.error("Wix member lookup by contactId failed:", err);
    return null;
  }
}

/**
 * Does one of this contact's active plans cover this service right now
 * (with balance left)? Returns the redeemable benefit, or null.
 */
export async function findEligibleBenefit(
  serviceId: string,
  contactId: string,
): Promise<EligibleBenefit | null> {
  const memberId = (await findMemberIdByContactId(contactId)) ?? contactId;
  const data = await wixPost("/benefit-programs/v1/pools/eligible-pools", {
    itemReference: { externalId: serviceId, providerAppId: WIX_BOOKINGS_APP_ID },
    count: 1,
    beneficiary: { identityType: "MEMBER", memberId },
    namespace: PRICING_PLANS_NAMESPACE,
  });
  const benefit = (data?.eligibleBenefits ?? [])[0];
  if (!benefit?.poolId || !benefit?.benefitKey) return null;
  return {
    poolId: benefit.poolId,
    benefitKey: benefit.benefitKey,
    memberId,
    planName:
      benefit.poolInfo?.displayName ?? benefit.benefitInfo?.displayName ?? "abonnement",
    available: Number(benefit.poolInfo?.balance?.available ?? 0),
  };
}

/**
 * Remaining session credits on one of this contact's plans, or null when the
 * balance cannot be determined (no covered service in the catalog, pool not
 * eligible right now, or the eligible pool belongs to another plan). Reuses
 * the proven eligible-pools call — the balance rides on the same pool object
 * used for redemption — instead of a separate, unverified pools-query API.
 * Callers must treat null as "unknown", never as zero.
 */
export async function planRemainingSessions(
  contactId: string,
  planId: string,
  planName: string,
): Promise<number | null> {
  try {
    const services = await listServices();
    const covered = services.find((s) => s.pricingPlanIds.includes(planId));
    if (!covered) return null;
    const benefit = await findEligibleBenefit(covered.id, contactId);
    if (!benefit) return null;
    // eligible-pools returns pools for the SERVICE — with several active plans
    // the first pool may belong to another one. Only trust a name match.
    const norm = (s: string) => s.trim().toLowerCase();
    if (norm(benefit.planName) !== norm(planName)) return null;
    return benefit.available;
  } catch (err) {
    console.error("Plan balance lookup failed (treated as unknown):", err);
    return null;
  }
}

/**
 * Deduct one session credit from the plan for this booking. Idempotent per
 * booking (idempotencyKey = booking id — Wix rejects duplicates with 409).
 * Throws "not_eligible" when the balance ran out or the plan's policy says no.
 */
export async function redeemMembershipForBooking(args: {
  wixBookingId: string;
  serviceId: string;
  benefit: EligibleBenefit;
  /** Number of sessions to deduct (group booking on one plan). Defaults to 1. */
  count?: number;
}): Promise<{ transactionId: string; membershipName: string }> {
  try {
    const data = await wixPost("/benefit-programs/v1/benefits/redeem", {
      poolId: args.benefit.poolId,
      benefitKey: args.benefit.benefitKey,
      itemReference: { externalId: args.serviceId, providerAppId: WIX_BOOKINGS_APP_ID },
      count: Math.max(1, Math.floor(args.count ?? 1)),
      beneficiary: { identityType: "MEMBER", memberId: args.benefit.memberId },
      namespace: PRICING_PLANS_NAMESPACE,
      idempotencyKey: `awa-booking-${args.wixBookingId}`,
    });
    return { transactionId: data?.transactionId ?? "", membershipName: args.benefit.planName };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // 428 = NOT_ENOUGH_BALANCE / POLICY_EXPRESSION_EVALUATED_TO_FALSE / POOL_NOT_ACTIVE
    if (msg.includes("(428)") || msg.includes("(404)")) throw new Error("not_eligible");
    throw err;
  }
}

/**
 * Confirm a booking in the calendar (custom-payment flow). Exported for the
 * membership path, which confirms only after the credit deduction succeeded.
 */
export async function confirmBookingPaid(bookingId: string): Promise<void> {
  const conf = await wixPost(`/bookings/v2/confirmation/${bookingId}:confirmOrDecline`, {
    paymentStatus: "PAID",
  });
  const status = conf?.booking?.status;
  if (status !== "CONFIRMED" && status !== "PENDING") {
    throw new Error(`confirmOrDecline returned unexpected status: ${status}`);
  }
}

/** Decline a CREATED booking (cleanup when redemption fails after creation). */
export async function declineBooking(bookingId: string, revision = "1"): Promise<void> {
  await wixPost(`/_api/bookings-service/v2/bookings/${bookingId}/decline`, { revision });
}

/** Current revision of a booking — required by cancel/decline mutations. */
async function getBookingRevision(bookingId: string): Promise<string> {
  const data = await wixPost("/_api/bookings-reader/v2/extended-bookings/query", {
    query: { filter: { id: { $in: [bookingId] } } },
  });
  return data?.extendedBookings?.[0]?.booking?.revision ?? "1";
}

/**
 * Cancel a booking (client removed from the class session). Our own 16h rule
 * is enforced by the caller; ignoreCancellationPolicy bypasses any stricter
 * Wix-side policy. No Wix notification — Awa is already talking to the client.
 */
export async function cancelBooking(bookingId: string): Promise<void> {
  const revision = await getBookingRevision(bookingId);
  await wixPost(`/_api/bookings-service/v2/bookings/${bookingId}/cancel`, {
    revision,
    participantNotification: { notifyParticipants: false },
    flowControlSettings: { ignoreCancellationPolicy: true },
  });
}

/** Re-credit a plan session by reverting its redemption transaction. */
export async function revertBenefitTransaction(transactionId: string): Promise<void> {
  await wixPost(`/benefit-programs/v1/balances/changes/${transactionId}/revert`, {
    idempotencyKey: `awa-revert-${transactionId}`,
  });
}

/** Look up one booking's current status (used to verify membership confirmation). */
export async function getBookingStatus(bookingId: string): Promise<string | null> {
  const statuses = await getBookingStatuses([bookingId]);
  return statuses[bookingId] ?? null;
}

// ---------- create booking ----------

/**
 * Create a class booking (Bookings V2) and confirm it as PAID.
 *
 * Two steps, per Wix's "custom checkout" flow (payment happens in Wave, not
 * Wix eCommerce):
 *   1. Create Booking → booking exists with status CREATED (NOT visible in
 *      the business calendar yet).
 *   2. Confirm Or Decline with paymentStatus PAID → status CONFIRMED, booking
 *      appears in the calendar with payment marked as received.
 */
/** Create the booking only (status CREATED — not yet in the calendar). */
export async function createBookingRaw(args: {
  slot: unknown;
  name: string;
  phone: string;
  participants?: number;
  paymentOption?: "OFFLINE" | "MEMBERSHIP";
  /** Pass null to state that lookup was already attempted and found nothing. */
  resolvedContact?: WixContactMatch | null;
}): Promise<string> {
  // Attach to the CRM contact and use its canonical name. Previously we sent
  // the model-provided name even after finding the contact, which is how a
  // one-letter WhatsApp/profile name such as "L" leaked into Wix bookings.
  const contact =
    args.resolvedContact === undefined
      ? await findContactByPhone(args.phone, args.name)
      : args.resolvedContact;
  const contactName = splitContactName(contact?.fullName || args.name);

  const data = await wixPost("/bookings/v2/bookings", {
    booking: {
      bookedEntity: { slot: args.slot },
      contactDetails: {
        ...(contact?.id ? { contactId: contact.id } : {}),
        ...contactName,
        phone: args.phone,
      },
      selectedPaymentOption: args.paymentOption ?? "OFFLINE",
      numberOfParticipants: Math.max(1, args.participants ?? 1),
    },
  });
  const id = data?.booking?.id;
  if (!id) throw new Error(`Wix create booking returned no id: ${JSON.stringify(data)}`);
  return id;
}

export async function createBooking(args: {
  slot: unknown;
  name: string;
  phone: string;
  participants?: number;
  resolvedContact?: WixContactMatch | null;
}): Promise<string> {
  const id = await createBookingRaw(args);

  // Confirm as paid so the booking shows up in the business calendar (custom
  // checkout flow — payment already verified in Wave). If this call fails we
  // still return the id — the booking exists and the caller has already taken
  // payment; reception can confirm manually.
  try {
    const conf = await wixPost(`/bookings/v2/confirmation/${id}:confirmOrDecline`, {
      paymentStatus: "PAID",
    });
    const status = conf?.booking?.status;
    if (status !== "CONFIRMED" && status !== "PENDING") {
      console.error(`Wix confirmOrDecline returned unexpected status for ${id}: ${status}`);
    }
  } catch (err) {
    console.error(`Wix confirmOrDecline failed for booking ${id} (booking still exists):`, err);
  }
  return id;
}

export async function findOrderIdByExternalId(externalOrderId: string): Promise<string | null> {
  await paceWixEcomCall();
  const data = await wixPost("/ecom/v1/orders/search", {
    search: {
      filter: { "channelInfo.externalOrderId": externalOrderId },
      cursorPaging: { limit: 1 },
    },
  });
  return data?.orders?.[0]?.id ? String(data.orders[0].id) : null;
}

/** Create the eCommerce record required after a custom-checkout booking. */
export async function createBookingOrder(args: {
  wixBookingId: string;
  externalOrderId: string;
  serviceName: string;
  amountXof: number;
  participants: number;
  phone: string;
  name: string;
  contactId?: string | null;
}): Promise<string> {
  await paceWixEcomCall();
  const amount = String(Math.max(0, Math.round(args.amountXof)));
  const contactName = splitContactName(args.name);
  const data = await wixPost("/ecom/v1/orders", {
    order: {
      ...(args.contactId ? { buyerInfo: { contactId: args.contactId } } : {}),
      billingInfo: {
        contactDetails: { ...contactName, phone: args.phone },
      },
      lineItems: [
        {
          productName: {
            original:
              args.participants > 1
                ? `${args.serviceName} — ${args.participants} places`
                : args.serviceName,
          },
          catalogReference: {
            catalogItemId: args.wixBookingId,
            appId: WIX_BOOKINGS_APP_ID,
          },
          quantity: 1,
          itemType: { preset: "SERVICE" },
          price: { amount },
          paymentOption: "FULL_PAYMENT_OFFLINE",
          taxDetails: {
            taxRate: "0",
            totalTax: { amount: "0" },
          },
        },
      ],
      channelInfo: { type: "OTHER_PLATFORM", externalOrderId: args.externalOrderId },
      currency: "XOF",
      currencyConversionDetails: { originalCurrency: "XOF", conversionRate: "1" },
      taxIncludedInPrices: true,
      priceSummary: {
        subtotal: { amount },
        shipping: { amount: "0" },
        tax: { amount: "0" },
        discount: { amount: "0" },
        total: { amount },
      },
    },
  });
  const orderId = data?.order?.id;
  if (!orderId) throw new Error(`Wix create order returned no id: ${JSON.stringify(data)}`);
  return String(orderId);
}

/** True when this imported order already has a successful payment record. */
export async function hasApprovedOrderPayment(
  orderId: string,
  amountXof: number,
): Promise<boolean> {
  await paceWixEcomCall();
  const data = await wixGet(`/ecom/v1/payments/orders/${encodeURIComponent(orderId)}`);
  const target = Math.max(0, Math.round(amountXof));
  const payments: any[] = data?.orderTransactions?.payments ?? [];
  return payments.some(
    (payment) =>
      String(payment?.regularPaymentDetails?.status ?? "").toUpperCase() === "APPROVED" &&
      Math.round(Number(payment?.amount?.amount)) === target,
  );
}

/** Record an already-collected Wave/OM/Max It payment; this never charges. */
export async function addApprovedOrderPayment(args: {
  orderId: string;
  amountXof: number;
  paymentMethod: string;
}): Promise<void> {
  await paceWixEcomCall();
  const data = await wixPost(
    `/ecom/v1/payments/orders/${encodeURIComponent(args.orderId)}/add-payment`,
    {
      payments: [
        {
          amount: { amount: String(Math.max(0, Math.round(args.amountXof))) },
          refundDisabled: false,
          regularPaymentDetails: {
            paymentMethod: args.paymentMethod,
            offlinePayment: true,
            status: "APPROVED",
          },
        },
      ],
    },
  );
  if (!Array.isArray(data?.paymentsIds) || data.paymentsIds.length === 0) {
    throw new Error(`Wix add payment returned no payment id: ${JSON.stringify(data)}`);
  }
}
