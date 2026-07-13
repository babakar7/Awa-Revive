import fs from "node:fs";
import path from "node:path";
import { createCanvas, GlobalFonts } from "@napi-rs/canvas";

/**
 * Studio-branded payment receipt as a PNG (same canvas stack as the weekly
 * schedule). Amounts and labels are always provided by the server — never
 * from the model. On-demand only (tool send_receipt); never auto-sent after
 * payment.
 */

export interface ReceiptData {
  title: string; // e.g. "Reçu de paiement"
  clientName: string | null;
  /** Main line: class name, plan name, or café summary */
  itemLabel: string;
  /** Optional second line (slot datetime, etc.) */
  detailLine?: string | null;
  amountXof: number;
  /** e.g. Wave session id or booking id */
  paymentRef: string;
  /** "Wave" | "Abonnement" | … */
  paidVia: string;
  paidAt: Date;
}

const FONT_DIR = path.resolve(process.cwd(), "assets/fonts");
let fontsRegistered = false;

function registerFonts(): void {
  if (fontsRegistered) return;
  for (const [file, family] of [
    ["DejaVuSans.ttf", "DejaVu Sans"],
    ["DejaVuSans-Bold.ttf", "DejaVu Sans Bold"],
  ] as const) {
    const p = path.join(FONT_DIR, file);
    if (!fs.existsSync(p)) throw new Error(`receipt image font missing: ${p}`);
    GlobalFonts.registerFromPath(p, family);
  }
  fontsRegistered = true;
}

/** Format XOF without inventing decimals (integer FCFA). Pure. */
export function formatXof(amount: number): string {
  const n = Math.round(amount);
  return `${n.toLocaleString("fr-FR").replace(/\u202f/g, " ")} FCFA`;
}

function fmtDate(d: Date): string {
  return d.toLocaleString("fr-FR", {
    timeZone: "Africa/Dakar",
    day: "numeric",
    month: "long",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

const W = 720;
const PAD = 40;
// Charte Revive (same as scheduleImage).
const COLORS = {
  bg: "#fbf6f0",
  title: "#211921",
  band: "#7c547d",
  bandText: "#fbf6f0",
  text: "#211921",
  meta: "#a98baa",
  rule: "#e8d9d2",
};

function wrapText(
  ctx: { measureText: (t: string) => { width: number } },
  text: string,
  maxWidth: number,
): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    const trial = cur ? `${cur} ${w}` : w;
    if (ctx.measureText(trial).width <= maxWidth) {
      cur = trial;
    } else {
      if (cur) lines.push(cur);
      cur = w;
    }
  }
  if (cur) lines.push(cur);
  return lines.length ? lines : [text];
}

/** Render a receipt PNG. Throws if fonts are missing. */
export function renderReceiptImage(data: ReceiptData): Buffer {
  registerFonts();
  const H = 560;
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext("2d");

  ctx.fillStyle = COLORS.bg;
  ctx.fillRect(0, 0, W, H);

  // Header band
  ctx.fillStyle = COLORS.band;
  ctx.fillRect(0, 0, W, 88);
  ctx.fillStyle = COLORS.bandText;
  ctx.font = '28px "DejaVu Sans Bold"';
  ctx.fillText("Revive", PAD, 40);
  ctx.font = '18px "DejaVu Sans"';
  ctx.fillText(data.title, PAD, 68);

  let y = 130;
  const maxText = W - PAD * 2;

  const row = (label: string, value: string, bold = false) => {
    ctx.fillStyle = COLORS.meta;
    ctx.font = '15px "DejaVu Sans"';
    ctx.fillText(label, PAD, y);
    y += 26;
    ctx.fillStyle = COLORS.text;
    ctx.font = bold ? '22px "DejaVu Sans Bold"' : '20px "DejaVu Sans"';
    for (const line of wrapText(ctx, value, maxText)) {
      ctx.fillText(line, PAD, y);
      y += 28;
    }
    y += 10;
  };

  if (data.clientName) row("Client", data.clientName);
  row("Détail", data.itemLabel, true);
  if (data.detailLine) row("Quand", data.detailLine);
  row("Montant", formatXof(data.amountXof), true);
  row("Payé via", data.paidVia);
  row("Référence", data.paymentRef);
  row("Date de paiement", fmtDate(data.paidAt));

  // Footer rule
  ctx.strokeStyle = COLORS.rule;
  ctx.beginPath();
  ctx.moveTo(PAD, H - 56);
  ctx.lineTo(W - PAD, H - 56);
  ctx.stroke();
  ctx.fillStyle = COLORS.meta;
  ctx.font = '14px "DejaVu Sans"';
  ctx.fillText("Justificatif de paiement — Revive · Almadies, Dakar", PAD, H - 28);

  return canvas.toBuffer("image/png");
}
