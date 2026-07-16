import fs from "node:fs";
import path from "node:path";
import { createCanvas, GlobalFonts } from "@napi-rs/canvas";
import { formatXof } from "./receiptImage.js";
import type { InvoiceLine } from "../domain/invoiceRules.js";

/**
 * Studio-branded FACTURE as a PNG (same canvas stack + palette as the receipt
 * and weekly schedule). Amounts are always server-provided. Reception sends it
 * to the client on WhatsApp; the printable version is a separate HTML page.
 *
 * `formatXof` is imported from receiptImage; the palette/fonts/wrapText/fmtDate
 * below are COPIED from receiptImage.ts (private there) — keep them in sync if
 * the Revive charte changes. Not refactored into a shared module on purpose:
 * receiptImage.ts is a shipped file other agents may touch (shared tree).
 */

export interface InvoiceImageData {
  number: string;
  clientName: string;
  clientRef?: string | null;
  lines: InvoiceLine[];
  totalXof: number;
  note?: string | null;
  paidVia?: string | null;
  paymentRef?: string | null;
  paidAt?: Date | null;
  createdAt: Date;
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
    if (!fs.existsSync(p)) throw new Error(`invoice image font missing: ${p}`);
    GlobalFonts.registerFromPath(p, family);
  }
  fontsRegistered = true;
}

const W = 720;
const PAD = 40;
const LINE_H = 34;
const MAX_LINES = 20;
// Charte Revive (copiée de receiptImage.ts) + accents facture.
const COLORS = {
  bg: "#fbf6f0",
  band: "#7c547d",
  bandText: "#fbf6f0",
  text: "#211921",
  meta: "#a98baa",
  metaDark: "#6c5a6d",
  rule: "#e8d9d2",
  pill: "#3d2b3e",
};

function fmtDate(d: Date): string {
  return d.toLocaleString("fr-FR", {
    timeZone: "Africa/Dakar",
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}

/** Amount for table columns: integer FCFA, no "FCFA" suffix. */
function amount(n: number): string {
  return Math.round(n).toLocaleString("fr-FR").replace(/ /g, " ");
}

/** Truncate a label with an ellipsis to fit maxWidth (measured on ctx). */
function fit(
  ctx: { measureText: (t: string) => { width: number } },
  text: string,
  maxWidth: number,
): string {
  if (ctx.measureText(text).width <= maxWidth) return text;
  let t = text;
  while (t.length > 1 && ctx.measureText(`${t}…`).width > maxWidth) t = t.slice(0, -1);
  return `${t}…`;
}

/** Render a facture PNG. Throws if fonts are missing or the line count is out of range. */
export function renderInvoiceImage(data: InvoiceImageData): Buffer {
  if (data.lines.length === 0) throw new Error("invoice image: no lines");
  if (data.lines.length > MAX_LINES) throw new Error("invoice image: too many lines");
  registerFonts();

  const hasNote = !!(data.note && data.note.trim());
  const hasPaid = !!data.paidAt;
  const H =
    300 + data.lines.length * LINE_H + (hasPaid ? 34 : 0) + (hasNote ? 44 : 0) + 60;

  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = COLORS.bg;
  ctx.fillRect(0, 0, W, H);

  // Header band
  ctx.fillStyle = COLORS.band;
  ctx.fillRect(0, 0, W, 92);
  ctx.fillStyle = COLORS.bandText;
  ctx.font = '26px "DejaVu Sans Bold"';
  ctx.fillText("REVIVE VENTURES", PAD, 40);
  ctx.font = '13px "DejaVu Sans"';
  ctx.fillText("Centre de bien-être — Almadies, Dakar · revive.sn", PAD, 66);
  ctx.font = '22px "DejaVu Sans Bold"';
  const right = (t: string, yy: number) => ctx.fillText(t, W - PAD - ctx.measureText(t).width, yy);
  right("FACTURE", 40);
  ctx.font = '13px "DejaVu Sans"';
  right(`N° ${data.number} · ${fmtDate(data.createdAt)}`, 66);

  // Client block
  let y = 132;
  ctx.fillStyle = COLORS.meta;
  ctx.font = '12px "DejaVu Sans Bold"';
  ctx.fillText("FACTURÉ À", PAD, y);
  y += 24;
  ctx.fillStyle = COLORS.text;
  ctx.font = '17px "DejaVu Sans Bold"';
  ctx.fillText(fit(ctx, data.clientName, W - 2 * PAD), PAD, y);
  y += 22;
  if (data.clientRef && data.clientRef.trim()) {
    ctx.fillStyle = COLORS.metaDark;
    ctx.font = '14px "DejaVu Sans"';
    ctx.fillText(fit(ctx, data.clientRef, W - 2 * PAD), PAD, y);
    y += 22;
  }
  y += 12;

  // Table header
  const colTot = W - PAD;
  const colPU = colTot - 130;
  const colQty = colPU - 90;
  ctx.fillStyle = COLORS.band;
  ctx.fillRect(PAD - 10, y - 6, W - 2 * (PAD - 10), 30);
  ctx.fillStyle = COLORS.bandText;
  ctx.font = '12px "DejaVu Sans Bold"';
  ctx.fillText("DÉSIGNATION", PAD, y + 14);
  const rlab = (t: string, x: number) => ctx.fillText(t, x - ctx.measureText(t).width, y + 14);
  rlab("QTÉ", colQty);
  rlab("PU", colPU);
  rlab("TOTAL", colTot);
  y += 44;

  // Lines
  for (const l of data.lines) {
    ctx.fillStyle = COLORS.text;
    ctx.font = '14px "DejaVu Sans"';
    ctx.fillText(fit(ctx, l.label, colQty - PAD - 55), PAD, y);
    const rnum = (t: string, x: number, bold = false) => {
      ctx.font = bold ? '14px "DejaVu Sans Bold"' : '14px "DejaVu Sans"';
      ctx.fillText(t, x - ctx.measureText(t).width, y);
    };
    rnum(String(l.qty), colQty);
    rnum(amount(l.unit_xof), colPU);
    rnum(amount(l.total_xof), colTot, true);
    y += 8;
    ctx.strokeStyle = COLORS.rule;
    ctx.beginPath();
    ctx.moveTo(PAD, y);
    ctx.lineTo(W - PAD, y);
    ctx.stroke();
    y += LINE_H - 8;
  }

  // Total pill
  y += 8;
  const pillW = 320;
  const pillH = 52;
  const pillX = W - PAD - pillW;
  ctx.fillStyle = COLORS.pill;
  ctx.beginPath();
  ctx.roundRect(pillX, y, pillW, pillH, 12);
  ctx.fill();
  ctx.fillStyle = COLORS.bandText;
  ctx.font = '12px "DejaVu Sans Bold"';
  ctx.fillText("TOTAL", pillX + 22, y + 31);
  ctx.font = '20px "DejaVu Sans Bold"';
  const totTxt = formatXof(data.totalXof);
  ctx.fillText(totTxt, pillX + pillW - 22 - ctx.measureText(totTxt).width, y + 34);
  y += pillH + 28;

  // Payment line
  if (hasPaid) {
    ctx.fillStyle = COLORS.metaDark;
    ctx.font = '13px "DejaVu Sans"';
    const via = data.paidVia ? `Payée via ${data.paidVia}` : "Payée";
    const ref = data.paymentRef ? ` — réf. ${data.paymentRef}` : "";
    ctx.fillText(fit(ctx, `✓ ${via}${ref} · le ${fmtDate(data.paidAt!)}`, W - 2 * PAD), PAD, y);
    y += 34;
  }

  // Note
  if (hasNote) {
    ctx.fillStyle = COLORS.metaDark;
    ctx.font = '13px "DejaVu Sans"';
    ctx.fillText(fit(ctx, `Note : ${data.note!.trim()}`, W - 2 * PAD), PAD, y);
    y += 44;
  }

  // Footer
  ctx.strokeStyle = COLORS.rule;
  ctx.beginPath();
  ctx.moveTo(PAD, H - 44);
  ctx.lineTo(W - PAD, H - 44);
  ctx.stroke();
  ctx.fillStyle = COLORS.meta;
  ctx.font = '12px "DejaVu Sans"';
  const foot = "Revive Ventures · Centre de bien-être · Almadies, Dakar · revive.sn — Merci de votre confiance";
  ctx.fillText(foot, (W - ctx.measureText(foot).width) / 2, H - 22);

  return canvas.toBuffer("image/png");
}
