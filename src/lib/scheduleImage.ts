import fs from "node:fs";
import path from "node:path";
import { createCanvas, GlobalFonts } from "@napi-rs/canvas";

/**
 * Weekly class schedule as an image — "le planning des cours".
 *
 * The grid is the studio's standing Monday→Sunday timetable, WITHOUT dates
 * (product decision 10/07): a client asking for "le planning" wants the weekly
 * grid, not dated availability. It is built by projecting the next 7 days of
 * live Wix slots onto weekdays, so it always reflects the current Wix catalog
 * (never a hand-maintained image that can go stale). Booking still goes
 * through check_availability with real dated slots.
 *
 * Rendering is fully deterministic server code — the model never touches the
 * grid data (same stance as prices/slots). Fonts are bundled in assets/fonts/
 * (DejaVu Sans, free license) so the output is identical locally, in CI and
 * on Railway regardless of container fonts.
 */

export interface ScheduleSlotInput {
  serviceId: string;
  startDate: string; // ISO
}

export interface ScheduleServiceInput {
  id: string;
  name: string;
  durationMinutes: number | null;
}

export interface ScheduleEntry {
  weekday: number; // 0 = Monday … 6 = Sunday
  time: string; // "09:00" (Dakar == UTC)
  className: string;
  durationMinutes: number | null;
}

export const WEEKDAYS_FR = [
  "Lundi",
  "Mardi",
  "Mercredi",
  "Jeudi",
  "Vendredi",
  "Samedi",
  "Dimanche",
] as const;

/**
 * Project dated slots onto a Monday→Sunday grid. Pure and unit-tested.
 * Recurring sessions (same class, same weekday, same time on two different
 * dates) collapse into one row. Slots whose service is not in the catalog are
 * skipped (defensive). Dakar = GMT+0 = UTC, so UTC calendar math == Dakar.
 */
export function buildWeeklyGrid(
  slots: ScheduleSlotInput[],
  services: ScheduleServiceInput[],
): ScheduleEntry[] {
  const byId = new Map(services.map((s) => [s.id, s]));
  const seen = new Set<string>();
  const entries: ScheduleEntry[] = [];
  for (const slot of slots) {
    const service = byId.get(slot.serviceId);
    if (!service) continue;
    const d = new Date(slot.startDate);
    if (Number.isNaN(d.getTime())) continue;
    const weekday = (d.getUTCDay() + 6) % 7; // JS Sunday=0 → Monday=0
    const time = `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
    const key = `${weekday}|${time}|${service.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push({ weekday, time, className: service.name, durationMinutes: service.durationMinutes });
  }
  entries.sort(
    (a, b) =>
      a.weekday - b.weekday || a.time.localeCompare(b.time) || a.className.localeCompare(b.className),
  );
  return entries;
}

/** Compact text version of the grid — model context + fallback when the image can't be sent. */
export function scheduleText(entries: ScheduleEntry[]): string {
  const lines: string[] = [];
  for (let day = 0; day < 7; day++) {
    const rows = entries.filter((e) => e.weekday === day);
    if (rows.length === 0) continue;
    lines.push(`*${WEEKDAYS_FR[day]}*`);
    for (const r of rows) {
      lines.push(`  ${r.time} — ${r.className}${r.durationMinutes ? ` (${r.durationMinutes} min)` : ""}`);
    }
  }
  return lines.join("\n");
}

// ---------- rendering ----------

const FONT_DIR = path.resolve(process.cwd(), "assets/fonts");
let fontsRegistered = false;

function registerFonts(): void {
  if (fontsRegistered) return;
  // Missing font files must fail loudly here (the tool falls back to text),
  // never render an image with invisible/garbled text.
  for (const [file, family] of [
    ["DejaVuSans.ttf", "DejaVu Sans"],
    ["DejaVuSans-Bold.ttf", "DejaVu Sans Bold"],
  ] as const) {
    const p = path.join(FONT_DIR, file);
    if (!fs.existsSync(p)) throw new Error(`schedule image font missing: ${p}`);
    GlobalFonts.registerFromPath(p, family);
  }
  fontsRegistered = true;
}

// Phone-friendly vertical poster: a colored band per weekday, its classes
// listed underneath. Sized for WhatsApp (720px wide, dynamic height).
const W = 720;
const PAD = 36;
const TITLE_H = 92;
const DAY_BAND_H = 52;
const ROW_H = 42;
const DAY_GAP = 18;
const FOOTER_H = 56;

const COLORS = {
  bg: "#FAF7F2",
  title: "#1F2937",
  band: "#0F766E",
  bandText: "#FFFFFF",
  time: "#0F766E",
  text: "#1F2937",
  meta: "#6B7280",
  rule: "#E5E7EB",
};

/** Render the weekly grid to a PNG buffer. Throws if there is nothing to draw. */
export function renderScheduleImage(entries: ScheduleEntry[]): Buffer {
  if (entries.length === 0) throw new Error("empty schedule — nothing to render");
  registerFonts();

  const days = [...new Set(entries.map((e) => e.weekday))].sort((a, b) => a - b);
  const height =
    TITLE_H +
    days.reduce(
      (h, day) => h + DAY_BAND_H + entries.filter((e) => e.weekday === day).length * ROW_H + DAY_GAP,
      0,
    ) +
    FOOTER_H;

  const canvas = createCanvas(W, height);
  const ctx = canvas.getContext("2d");

  ctx.fillStyle = COLORS.bg;
  ctx.fillRect(0, 0, W, height);

  ctx.fillStyle = COLORS.title;
  ctx.font = '34px "DejaVu Sans Bold"';
  ctx.fillText("Planning des cours — Revive", PAD, 56);

  let y = TITLE_H;
  for (const day of days) {
    ctx.fillStyle = COLORS.band;
    ctx.beginPath();
    ctx.roundRect(PAD, y, W - PAD * 2, DAY_BAND_H - 12, 10);
    ctx.fill();
    ctx.fillStyle = COLORS.bandText;
    ctx.font = '22px "DejaVu Sans Bold"';
    ctx.fillText(WEEKDAYS_FR[day], PAD + 16, y + 28);
    y += DAY_BAND_H;

    for (const row of entries.filter((e) => e.weekday === day)) {
      ctx.fillStyle = COLORS.time;
      ctx.font = '21px "DejaVu Sans Bold"';
      ctx.fillText(row.time, PAD + 16, y + 26);
      ctx.fillStyle = COLORS.text;
      ctx.font = '21px "DejaVu Sans"';
      const name = row.className.length > 38 ? `${row.className.slice(0, 37)}…` : row.className;
      ctx.fillText(name, PAD + 100, y + 26);
      if (row.durationMinutes) {
        ctx.fillStyle = COLORS.meta;
        ctx.font = '17px "DejaVu Sans"';
        const label = `${row.durationMinutes} min`;
        ctx.fillText(label, W - PAD - ctx.measureText(label).width - 8, y + 26);
      }
      ctx.strokeStyle = COLORS.rule;
      ctx.beginPath();
      ctx.moveTo(PAD + 8, y + ROW_H - 6);
      ctx.lineTo(W - PAD - 8, y + ROW_H - 6);
      ctx.stroke();
      y += ROW_H;
    }
    y += DAY_GAP;
  }

  ctx.fillStyle = COLORS.meta;
  ctx.font = '16px "DejaVu Sans"';
  ctx.fillText("Réservation sur WhatsApp avec Awa · les places restantes varient selon la date", PAD, y + 24);

  return canvas.toBuffer("image/png");
}
