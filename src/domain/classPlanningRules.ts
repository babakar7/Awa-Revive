/**
 * Pure logic for the weekly CLASS planning sandbox: level detection from a class
 * name, Reformer/Mat scope filter, grid-payload validation, next-week bounds, and
 * the Wix-calendar → slots import mapping. No DB, no network — the server stays
 * authoritative on save AND on import (both funnel through validateClassGridPayload).
 *
 * This planner is a sandbox: nothing here is ever pushed to Wix. weekday 0=Monday…
 * 6=Sunday, same convention as the staff planning (NOT getUTCDay's 0=Sunday).
 */

import type { WixCalendarEvent } from "../lib/wix.js";

/** Presets shown in the slot editor, minutes-from-midnight. 7h15 … 19h15. */
export const TIME_PRESETS_MIN = [435, 495, 555, 615, 675, 735, 750, 975, 1035, 1095, 1155];
export const DEFAULT_DURATION_MIN = 50;
export const MAX_SLOTS = 120;
export const MAX_TEXT = 80;

export type ClassLevel = "foundation" | "sculpt" | "intense" | "other";

export interface GridSlot {
  weekday: number;
  start_min: number;
  duration_min: number;
  coach_name: string;
  class_name: string;
  coach_wix_id: string | null;
  class_wix_id: string | null;
}

/** Lowercase, accent-stripped form for robust name matching. */
function normalize(s: string): string {
  return String(s ?? "")
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase();
}

/** Level derived from the class name ("Pilates Reformer (Sculpt)" → "sculpt"). */
export function levelFromClassName(name: string): ClassLevel {
  const n = normalize(name);
  if (n.includes("foundation")) return "foundation";
  if (n.includes("sculpt")) return "sculpt";
  if (n.includes("intense")) return "intense";
  return "other";
}

/** Scope filter: keep Reformer and Mat classes only (word-boundary on "mat"). */
export function isReformerOrMat(name: string): boolean {
  const n = normalize(name);
  return /reformer/.test(n) || /\bmat\b/.test(n);
}

/** Conflict key: one coach can't teach two classes at the same weekday+time. */
export function slotConflictKey(s: { weekday: number; start_min: number; coach_name: string }): string {
  return `${s.weekday}:${s.start_min}:${String(s.coach_name ?? "").trim().toLowerCase()}`;
}

function cleanId(v: unknown): string | null {
  const s = String(v ?? "").trim();
  return s && s.length <= 64 ? s : null;
}

/**
 * Validate the grid POST payload (JSON string → slots). Same server boundary for
 * manual edits AND the Wix import, so the import can never inject unvalidated
 * data. Rejects on the first problem (mirrors validateGridPayload's shape).
 */
export function validateClassGridPayload(raw: string): { slots: GridSlot[] } | { error: string } {
  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { error: "grille illisible (JSON invalide)." };
  }
  const arr = parsed?.slots;
  if (!Array.isArray(arr)) return { error: "grille invalide." };
  if (arr.length > MAX_SLOTS) return { error: `trop de cours (max ${MAX_SLOTS}).` };
  const seen = new Set<string>();
  const slots: GridSlot[] = [];
  for (const e of arr) {
    const weekday = Number(e?.weekday);
    if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6) return { error: "jour invalide." };
    const start_min = Number(e?.start_min);
    if (!Number.isInteger(start_min) || start_min < 0 || start_min > 1439) {
      return { error: "horaire invalide (0–24h)." };
    }
    let duration_min = Number(e?.duration_min);
    if (!Number.isInteger(duration_min)) duration_min = DEFAULT_DURATION_MIN;
    if (duration_min < 15 || duration_min > 240) return { error: "durée invalide (15–240 min)." };
    const coach_name = String(e?.coach_name ?? "").trim();
    const class_name = String(e?.class_name ?? "").trim();
    if (!coach_name || !class_name) return { error: "coach et cours obligatoires." };
    if (coach_name.length > MAX_TEXT || class_name.length > MAX_TEXT) {
      return { error: `nom trop long (max ${MAX_TEXT} caractères).` };
    }
    const key = slotConflictKey({ weekday, start_min, coach_name });
    if (seen.has(key)) return { error: "deux cours en même temps pour un même coach." };
    seen.add(key);
    slots.push({
      weekday,
      start_min,
      duration_min,
      coach_name,
      class_name,
      coach_wix_id: cleanId(e?.coach_wix_id),
      class_wix_id: cleanId(e?.class_wix_id),
    });
  }
  return { slots };
}

function pad2(n: number): string {
  return (n < 10 ? "0" : "") + n;
}

/**
 * Bounds of the NEXT full week, Monday 00:00:00 inclusive → the following Monday
 * exclusive. Dakar == UTC year-round so UTC fields ARE local time (same pattern
 * as planningNowSlot). Called on a Monday → the upcoming Monday, never "today".
 */
export function nextFullWeekBounds(now: Date): {
  fromLocalDate: string;
  toLocalDate: string;
  label: string;
} {
  // getUTCDay: 0=Sun…6=Sat. Days until next Monday (always 1..7, never 0).
  const dow = now.getUTCDay();
  const daysToNextMonday = ((8 - dow) % 7) || 7;
  const monday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + daysToNextMonday));
  const nextMonday = new Date(Date.UTC(monday.getUTCFullYear(), monday.getUTCMonth(), monday.getUTCDate() + 7));
  const fromLocalDate = `${monday.getUTCFullYear()}-${pad2(monday.getUTCMonth() + 1)}-${pad2(monday.getUTCDate())}T00:00:00`;
  const toLocalDate = `${nextMonday.getUTCFullYear()}-${pad2(nextMonday.getUTCMonth() + 1)}-${pad2(nextMonday.getUTCDate())}T00:00:00`;
  const label = `Semaine du ${pad2(monday.getUTCDate())}/${pad2(monday.getUTCMonth() + 1)}`;
  return { fromLocalDate, toLocalDate, label };
}

/** Parse a Wix LOCAL datetime string ("2026-08-17T09:15:00") by field — never
 *  new Date(str), which would reinterpret it in the host timezone. */
function parseLocalDateTime(raw: string): { y: number; mo: number; d: number; hh: number; mm: number } | null {
  const m = String(raw ?? "").match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  if (!m) return null;
  return { y: +m[1], mo: +m[2], d: +m[3], hh: +m[4], mm: +m[5] };
}

/**
 * Map Wix calendar events → grid slots. Caller pre-filters to eligible events
 * (CLASS/COURSE, CONFIRMED, Reformer/Mat). Coach = the resource whose id is a
 * known staff resource, else the first resource. Dedup by conflict key. The
 * result still passes through validateClassGridPayload before persistence.
 */
export function slotsFromCalendarEvents(
  events: WixCalendarEvent[],
  staffResourceIds: Set<string>,
): GridSlot[] {
  const out: GridSlot[] = [];
  const seen = new Set<string>();
  for (const ev of events) {
    const start = parseLocalDateTime(ev.startDate);
    if (!start) continue;
    const weekday = (new Date(Date.UTC(start.y, start.mo - 1, start.d)).getUTCDay() + 6) % 7;
    const start_min = start.hh * 60 + start.mm;
    let duration_min = DEFAULT_DURATION_MIN;
    const end = parseLocalDateTime(ev.endDate);
    if (end) {
      const raw = (end.hh * 60 + end.mm) - start_min;
      if (raw >= 15 && raw <= 240) duration_min = raw;
    }
    const staffRes = ev.resources.find((r) => staffResourceIds.has(r.id));
    const coachRes = staffRes ?? ev.resources[0] ?? null;
    const coach_name = (coachRes?.name ?? "").trim() || "Coach ?";
    const class_name = (ev.serviceName || ev.title || "Cours").trim();
    const key = slotConflictKey({ weekday, start_min, coach_name });
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      weekday,
      start_min,
      duration_min,
      coach_name: coach_name.slice(0, MAX_TEXT),
      class_name: class_name.slice(0, MAX_TEXT),
      coach_wix_id: coachRes?.id ?? null,
      class_wix_id: ev.serviceId ?? null,
    });
  }
  return out;
}

/** 555 → "9h15" (shared display helper). */
export function fmtSlotTime(min: number): string {
  return `${Math.floor(min / 60)}h${pad2(min % 60)}`;
}
