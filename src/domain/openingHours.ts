import { config } from "../config.js";
import { getPublishedSchedule, getShifts, listPlanningStaff } from "./staffPlanningRepo.js";
import { planningNowSlot, WEEKDAYS_FR, fmtMin } from "./staffPlanningRules.js";

/**
 * Is the bar open for public ordering RIGHT NOW? The public /commander page gates
 * on the PUBLISHED staff planning: the bar is "open" while at least one staff with
 * role='bar' is on shift. Delivery has an extra hard cutoff (the kitchen stops
 * taking deliveries in the evening). Pure decision logic lives in computeBarOpen()
 * so it is unit-testable without a DB; barOpenNow() is the async DB wrapper.
 *
 * FAIL-CLOSED: on a public endpoint, "no schedule published" must NOT fall open
 * to "everyone can order 24/7" — it returns closed with a neutral message. (This
 * is the opposite of onShiftStaffIds, which fails OPEN for internal notification
 * gating where a missing planning should never suppress an alert.)
 */

export interface BarAvailability {
  /** Bar staffed right now → on-site/takeaway/pickup ordering allowed. */
  open: boolean;
  /** open AND before the evening delivery cutoff → delivery mode allowed. */
  deliveryOpen: boolean;
  /** Human "réouvre …" hint when closed, e.g. "demain à 8h00"; null if unknown. */
  reopensLabel: string | null;
  reason: "open" | "closed" | "no_schedule";
}

interface BarShift {
  weekday: number;
  start_min: number;
  end_min: number;
}

/** Pure: given the bar's shifts, the current slot and the delivery cutoff, decide
 *  availability and (when closed) the next reopening. weekday 0=Monday…6=Sunday. */
export function computeBarOpen(
  barShifts: BarShift[],
  now: { weekday: number; minute: number },
  cutoffMin: number,
): BarAvailability {
  const openNow = barShifts.some(
    (s) => s.weekday === now.weekday && s.start_min <= now.minute && s.end_min > now.minute,
  );
  if (openNow) {
    return {
      open: true,
      deliveryOpen: now.minute < cutoffMin,
      reopensLabel: null,
      reason: "open",
    };
  }
  // Next reopening: earliest bar shift start scanning the next 7 days (handles the
  // Sunday → Monday week wrap). Same-day shifts count only if they start later.
  let best: { dayOffset: number; start: number } | null = null;
  for (let d = 0; d < 7; d++) {
    const wd = (now.weekday + d) % 7;
    for (const s of barShifts) {
      if (s.weekday !== wd) continue;
      if (d === 0 && s.start_min <= now.minute) continue;
      if (!best || d < best.dayOffset || (d === best.dayOffset && s.start_min < best.start)) {
        best = { dayOffset: d, start: s.start_min };
      }
    }
  }
  let reopensLabel: string | null = null;
  if (best) {
    const wdIdx = (now.weekday + best.dayOffset) % 7;
    const dayName =
      best.dayOffset === 0 ? "aujourd'hui" : best.dayOffset === 1 ? "demain" : WEEKDAYS_FR[wdIdx].toLowerCase();
    reopensLabel = `${dayName} à ${fmtMin(best.start)}`;
  }
  return { open: false, deliveryOpen: false, reopensLabel, reason: "closed" };
}

/** Async: read the published planning + bar staff and decide availability now. */
export async function barOpenNow(now: Date = new Date()): Promise<BarAvailability> {
  const published = await getPublishedSchedule();
  // Fail-closed on a public endpoint (see module note).
  if (!published) {
    return { open: false, deliveryOpen: false, reopensLabel: null, reason: "no_schedule" };
  }
  const [shifts, staff] = await Promise.all([getShifts(published.id), listPlanningStaff()]);
  const barIds = new Set(staff.filter((s) => s.role === "bar").map((s) => s.id));
  const barShifts = shifts.filter((s) => barIds.has(s.staff_id));
  return computeBarOpen(barShifts, planningNowSlot(now), config.DELIVERY_ORDER_CUTOFF_MIN);
}
