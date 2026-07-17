/**
 * Pure logic for the staff weekly planning: time parsing/formatting, worked-hours
 * with the unpaid lunch break, grid-payload validation, and the per-employee
 * WhatsApp message. No DB, no network — the server stays authoritative on save.
 */

/** Unpaid lunch break, in minutes-from-midnight (13h30–14h30). */
export const BREAK_START_MIN = 810;
export const BREAK_END_MIN = 870;

/** weekday index 0 = Monday … 6 = Sunday (grid starts Monday, like the owner's sheet). */
export const WEEKDAYS_FR = ["Lundi", "Mardi", "Mercredi", "Jeudi", "Vendredi", "Samedi", "Dimanche"];

/** staff_contacts roles that appear in the planning (coaches are Wix-driven, out). */
export const PLANNING_ROLES = ["accueil", "bar", "entretien"] as const;

export interface GridShift {
  staff_id: string;
  weekday: number;
  start_min: number;
  end_min: number;
}

/** "9h15" | "09:15" | "9:15" | "8h" → minutes; null if malformed/out of range. */
export function parseTimeToMin(raw: string): number | null {
  const s = String(raw ?? "").trim().toLowerCase();
  const m = s.match(/^(\d{1,2})\s*[h:]\s*(\d{0,2})$/);
  if (!m) return null;
  const h = Number(m[1]);
  const min = m[2] === "" ? 0 : Number(m[2]);
  if (!Number.isInteger(h) || !Number.isInteger(min) || h > 24 || min > 59) return null;
  const total = h * 60 + min;
  return total >= 0 && total <= 1440 ? total : null;
}

/** 555 → "9h15", 480 → "8h00", 1175 → "19h35". */
export function fmtMin(min: number): string {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return `${h}h${String(m).padStart(2, "0")}`;
}

/** A duration in minutes → "39h25" (same shape as a clock but it's a total). */
export function fmtDuration(min: number): string {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return `${h}h${String(m).padStart(2, "0")}`;
}

/**
 * Worked minutes for one continuous shift. The 13h30–14h30 break is deducted
 * ONLY when the shift actually continues past 14h30 (the person really took
 * lunch): a shift ending at 13h35 keeps its 5 extra minutes. Deduction = the
 * overlap with the break window.
 */
export function workedMinutes(startMin: number, endMin: number): number {
  const raw = endMin - startMin;
  if (endMin <= BREAK_END_MIN) return raw; // ends at/before 14h30 → no lunch taken
  const overlap = Math.max(0, Math.min(endMin, BREAK_END_MIN) - Math.max(startMin, BREAK_START_MIN));
  return raw - overlap;
}

export function weeklyTotalMinutes(shifts: { start_min: number; end_min: number }[]): number {
  return shifts.reduce((sum, s) => sum + workedMinutes(s.start_min, s.end_min), 0);
}

/**
 * Validate the grid POST payload (JSON string → shifts). Absent cell = repos.
 * Server recomputes nothing from the client except which cells exist and their
 * start/end; totals are derived here, never trusted from the form.
 */
export function validateGridPayload(
  raw: string,
  knownStaffIds: Set<string>,
): { shifts: GridShift[] } | { error: string } {
  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { error: "grille illisible (JSON invalide)." };
  }
  const arr = parsed?.shifts;
  if (!Array.isArray(arr)) return { error: "grille invalide." };
  if (arr.length > 200) return { error: "trop de créneaux." };
  const seen = new Set<string>();
  const shifts: GridShift[] = [];
  for (const e of arr) {
    const staff_id = String(e?.staff_id ?? "");
    if (!knownStaffIds.has(staff_id)) return { error: "employé(e) inconnu(e) dans la grille." };
    const weekday = Number(e?.weekday);
    if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6) return { error: "jour invalide." };
    const start_min = Number(e?.start_min);
    const end_min = Number(e?.end_min);
    if (!Number.isInteger(start_min) || !Number.isInteger(end_min) || start_min < 0 || end_min > 1440 || start_min >= end_min) {
      return { error: "horaire invalide (début avant fin, 0–24h)." };
    }
    const key = `${staff_id}:${weekday}`;
    if (seen.has(key)) return { error: "deux créneaux le même jour pour une même personne." };
    seen.add(key);
    shifts.push({ staff_id, weekday, start_min, end_min });
  }
  return { shifts };
}

function firstName(name: string): string {
  return String(name ?? "").trim().split(/\s+/)[0] ?? "";
}

/**
 * The per-employee WhatsApp message (7 lines Mon→Sun, missing day = repos) with
 * the break-deducted weekly total. `shifts` are this employee's shifts only.
 */
export function buildEmployeeScheduleMessage(
  scheduleName: string,
  staffName: string,
  shifts: { weekday: number; start_min: number; end_min: number }[],
): { subject: string; body: string } {
  const byDay = new Map<number, { start_min: number; end_min: number }>();
  for (const s of shifts) byDay.set(s.weekday, s);
  const lines = WEEKDAYS_FR.map((label, wd) => {
    const s = byDay.get(wd);
    return s ? `${label} : ${fmtMin(s.start_min)} – ${fmtMin(s.end_min)}` : `${label} : repos`;
  });
  const total = weeklyTotalMinutes(shifts);
  const body =
    `🗓 Planning « ${scheduleName} » — ${firstName(staffName) || staffName}\n` +
    `${lines.join("\n")}\n` +
    `Total : ${fmtDuration(total)} / semaine (pause 13h30–14h30 déduite)`;
  return { subject: "Ton planning Revive", body };
}
