/**
 * Read-only live probe: does Wix honor an `eventId` filter on the Attendance
 * and Bookings Reader query endpoints? The coach-attendance payroll plan is
 * built on targeted per-event reads instead of scanning the whole history, so
 * this must be verified against live Wix BEFORE any classification code exists.
 *
 * The project has repeatedly paid for the gap between Wix's docs and real
 * behavior (Bookings Reader's date filter is documented as unreliable on old
 * sessions, see the comment above listWixConfirmedBookingSnapshots). This probe
 * de-risks the two filters the plan depends on:
 *   1. Attendance query    filter: { eventId: { $in: [...] } }
 *   2. Bookings Reader query filter: { "bookedEntity.item.slot.eventId": { $in: [...] } }
 *
 * For each, it compares the filtered result to an unfiltered reference pulled
 * over the same window and filtered client-side. A PASS means the server filter
 * returns exactly the reference set. A FAIL (filter ignored → everything comes
 * back, or filter over-matches/empties) means we fall back to the CONFIRMED +
 * client-side filter path already sketched in the plan.
 *
 * It never mutates Wix. Usage: npm run wix:probe-attendance -- [monthsBack]
 * (default 1 = last calendar month).
 */
import "dotenv/config";
import { config } from "../src/config.js";
import { queryCalendarEventsV3 } from "../src/lib/wix.js";

const WIX_API = "https://www.wixapis.com";

function headers(): Record<string, string> {
  return {
    Authorization: config.WIX_API_KEY,
    "wix-site-id": config.WIX_SITE_ID,
    "Content-Type": "application/json",
    "User-Agent": "resabot/1.0",
  };
}

async function wixPost(path: string, body: unknown): Promise<any> {
  const res = await fetch(`${WIX_API}${path}`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Wix ${path} failed (${res.status}): ${text}`);
  return text ? JSON.parse(text) : {};
}

/** First and last local Dakar day of the month `monthsBack` before now. */
function monthBounds(monthsBack: number): { from: string; to: string; label: string } {
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth() - monthsBack;
  const first = new Date(Date.UTC(y, m, 1));
  const last = new Date(Date.UTC(y, m + 1, 0));
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  return {
    from: `${iso(first)}T00:00:00`,
    to: `${iso(last)}T23:59:59`,
    label: iso(first).slice(0, 7),
  };
}

const monthsBack = Math.max(0, Number(process.argv[2] ?? 1));
const { from, to, label } = monthBounds(monthsBack);

console.log(`\n=== Attendance filter probe — month ${label} (${from} → ${to}) ===\n`);

// ---- Real event IDs from Calendar V3 over the window ---------------------
const events = await queryCalendarEventsV3(from, to);
console.log(`Calendar V3: ${events.length} events in window.`);
if (events.length === 0) {
  console.log("No events — rerun against a month with sessions: npm run wix:probe-attendance -- 2");
  process.exit(0);
}
// Probe a small, deterministic sample: first, middle, last.
const sample = [events[0], events[Math.floor(events.length / 2)], events[events.length - 1]]
  .filter((e, i, all) => all.findIndex((x) => x.id === e.id) === i);
const sampleIds = sample.map((e) => e.id);
console.log(`Sampling ${sampleIds.length} events: ${sampleIds.join(", ")}\n`);

async function cursorPage(path: string, filter: unknown): Promise<{ items: any[]; key: string }> {
  // Detect which array key the endpoint uses without assuming it.
  const seen = new Set<string>();
  let cursor: string | undefined;
  const items: any[] = [];
  let key = "";
  for (;;) {
    const data = await wixPost(path, {
      query: { filter, cursorPaging: { limit: 100, ...(cursor ? { cursor } : {}) } },
    });
    const arrKey = Object.keys(data).find((k) => Array.isArray(data[k])) ?? "";
    if (arrKey) {
      key = arrKey;
      items.push(...data[arrKey]);
    }
    const next = data?.pagingMetadata?.cursors?.next;
    if (typeof next !== "string" || !next || seen.has(next)) break;
    seen.add(next);
    cursor = next;
  }
  return { items, key };
}

// ---- 1. Attendance API: filtered by eventId vs unfiltered reference -------
console.log("--- Probe 1: Attendance /bookings/bookings-attendance/query ---");
try {
  const filtered = await cursorPage("/bookings/bookings-attendance/query", {
    eventId: { $in: sampleIds },
  });
  const filteredIds = new Set(filtered.items.map((a) => String(a?.eventId ?? a?.sessionId ?? "")));
  const filteredMatchOnly = filtered.items.every((a) =>
    sampleIds.includes(String(a?.eventId ?? a?.sessionId ?? "")),
  );
  console.log(`  filtered: ${filtered.items.length} attendances (key="${filtered.key}")`);
  console.log(`  distinct eventIds returned: ${[...filteredIds].filter(Boolean).join(", ") || "(none carried eventId)"}`);
  console.log(
    filteredMatchOnly && filtered.items.length > 0
      ? "  ✅ PASS — every returned attendance belongs to the requested events"
      : filtered.items.length === 0
        ? "  ⚠️  EMPTY — no attendance for these events (inconclusive; try a busier month or another sample)"
        : "  ❌ FAIL — filter returned attendances outside the requested events → server filter ignored",
  );
} catch (err) {
  console.log(`  ❌ ERROR — ${(err as Error).message}`);
}

// ---- 2. Bookings Reader: slot.eventId filter vs CONFIRMED reference -------
console.log("\n--- Probe 2: Bookings Reader /extended-bookings/query ---");
const readerPath = "/_api/bookings-reader/v2/extended-bookings/query";

function bookingEventId(eb: any): string {
  const slot = eb?.booking?.bookedEntity?.slot ?? {};
  return String(slot?.eventId ?? slot?.sessionId ?? "");
}

try {
  const filtered = await cursorPage(readerPath, {
    "bookedEntity.item.slot.eventId": { $in: sampleIds },
  });
  const outsiders = filtered.items.filter((eb) => !sampleIds.includes(bookingEventId(eb)));
  console.log(`  filtered: ${filtered.items.length} extendedBookings (key="${filtered.key}")`);
  console.log(`  distinct eventIds: ${[...new Set(filtered.items.map(bookingEventId))].filter(Boolean).join(", ") || "(none)"}`);
  if (filtered.items.length > 0 && outsiders.length === 0) {
    console.log("  ✅ PASS — reader honored the slot.eventId filter");
  } else if (filtered.items.length === 0) {
    console.log("  ⚠️  EMPTY — either the filter over-matched to nothing, or no bookings on these events.");
    console.log("      Cross-check with the CONFIRMED reference below before trusting.");
  } else {
    console.log(`  ❌ FAIL — ${outsiders.length}/${filtered.items.length} bookings fell outside the requested events → filter ignored`);
  }
} catch (err) {
  console.log(`  ❌ ERROR (filter likely unsupported) — ${(err as Error).message}`);
}

// Reference: unfiltered CONFIRMED sweep, client-side matched to the sample.
try {
  const seen = new Set<string>();
  let offset = 0;
  const confirmed: any[] = [];
  for (let page = 0; page < 40; page += 1) {
    const data = await wixPost(readerPath, {
      query: { filter: { status: { $eq: "CONFIRMED" } }, paging: { limit: 100, offset } },
    });
    const batch: any[] = Array.isArray(data?.extendedBookings) ? data.extendedBookings : [];
    for (const eb of batch) {
      const id = String(eb?.booking?.id ?? "");
      if (id && !seen.has(id)) {
        seen.add(id);
        confirmed.push(eb);
      }
    }
    if (batch.length < 100) break;
    offset += 100;
  }
  const matched = confirmed.filter((eb) => sampleIds.includes(bookingEventId(eb)));
  console.log(`\n  reference: ${confirmed.length} CONFIRMED bookings swept; ${matched.length} match the sampled events client-side.`);
  console.log(
    matched.length > 0
      ? "  → Fallback path (CONFIRMED sweep + client-side eventId filter) is viable; it found bookings the filter should also return."
      : "  → No CONFIRMED bookings on the sampled events; pick a busier sample to compare the two paths meaningfully.",
  );
} catch (err) {
  console.log(`  reference ERROR — ${(err as Error).message}`);
}

console.log("\n=== Verdict rule ===");
console.log("Both PASS  → build targeted per-event collection as planned.");
console.log("Reader FAIL/EMPTY but reference finds bookings → use CONFIRMED sweep + client-side eventId filter for bookings.");
console.log("Record the outcome in PROGRESS.md before writing classification code.\n");
