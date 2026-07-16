import fs from "node:fs";
import path from "node:path";
import PDFDocument from "pdfkit";
import { formatXof } from "./receiptImage.js";

/**
 * Event quote ("devis") as a downloadable A4 PDF. Interface is local (no domain
 * import) — every value is provided by the server. Uses the bundled DejaVu TTFs
 * (full accents/€/·) rather than pdfkit's built-in AFM fonts. Layout mirrors the
 * studio's quote template: violet header, PRESTATAIRE/CLIENT cards, chips,
 * prestations table, TOTAL block, conditions, footer.
 */

export interface QuotePdfData {
  quoteNumber: string;
  issuedOn: Date;
  validityDays: number;
  clientName: string;
  clientCompany: string | null;
  clientRole: string | null;
  eventTitle: string;
  description: string | null;
  eventDate: Date | null;
  eventTime: string | null;
  participants: string | null;
  location: string;
  items: { label: string; detail: string | null; amount_xof: number | null }[];
  conditions: string[];
}

const FONT_DIR = path.resolve(process.cwd(), "assets/fonts");
const BODY = "Body";
const BOLD = "Bold";

const C = {
  band: "#6b4a6f",
  bandDark: "#4a2f4d",
  pale: "#f7edf3",
  text: "#211921",
  muted: "#8a7080",
  rule: "#e8d9d2",
  white: "#ffffff",
};

const MARGIN = 48;
const PAGE_W = 595.28; // A4 portrait
const CONTENT_W = PAGE_W - MARGIN * 2;

/** Plain grouped number for table cells (header already says "(XOF)"). */
function fmtAmount(n: number): string {
  return Math.round(n).toLocaleString("fr-FR").replace(/ /g, " ");
}

function fmtLongDate(d: Date): string {
  return d.toLocaleDateString("fr-FR", {
    timeZone: "Africa/Dakar",
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}

function registerFonts(doc: PDFKit.PDFDocument): void {
  for (const [name, file] of [
    [BODY, "DejaVuSans.ttf"],
    [BOLD, "DejaVuSans-Bold.ttf"],
  ] as const) {
    const p = path.join(FONT_DIR, file);
    if (!fs.existsSync(p)) throw new Error(`quote pdf font missing: ${p}`);
    doc.registerFont(name, p);
  }
}

/** Render a quote PDF. Resolves to the full buffer; throws if fonts are missing. */
export function renderQuotePdf(data: QuotePdfData): Promise<Buffer> {
  const doc = new PDFDocument({ size: "A4", margin: MARGIN });
  registerFonts(doc);

  const chunks: Buffer[] = [];
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on("data", (c: Buffer) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });

  drawBody(doc, data);
  doc.end();
  return done;
}

function drawBody(doc: PDFKit.PDFDocument, data: QuotePdfData): void {
  const left = MARGIN;
  const right = PAGE_W - MARGIN;
  let y = MARGIN;

  // ---- Header ----
  doc.font(BOLD).fontSize(20).fillColor(C.band).text("REVIVE VENTURES", left, y);
  doc.font(BODY).fontSize(9).fillColor(C.muted);
  doc.text("Centre de bien-être — Dakar", left, y + 26);
  doc.text("revive.sn", left, y + 38);

  // Right meta block
  const metaX = left + CONTENT_W / 2;
  doc.font(BOLD).fontSize(20).fillColor(C.band).text("DEVIS", metaX, y, {
    width: CONTENT_W / 2,
    align: "right",
  });
  doc.font(BODY).fontSize(9).fillColor(C.text);
  const meta = [
    `N° ${data.quoteNumber}`,
    `Date : ${fmtLongDate(data.issuedOn)}`,
    `Validité : ${data.validityDays} jours`,
  ];
  meta.forEach((line, i) => {
    doc.text(line, metaX, y + 28 + i * 13, { width: CONTENT_W / 2, align: "right" });
  });

  y += 74;
  doc.moveTo(left, y).lineTo(right, y).lineWidth(1).strokeColor(C.rule).stroke();
  y += 18;

  // ---- PRESTATAIRE / CLIENT cards ----
  const gutter = 16;
  const cardW = (CONTENT_W - gutter) / 2;
  const providerLines = ["Revive Ventures", "Centre de bien-être", "Almadies, Dakar — Sénégal", "revive.sn"];
  const clientLines = [data.clientName, data.clientCompany, data.clientRole].filter(
    (l): l is string => !!l,
  );
  const cardH = drawCards(doc, left, y, cardW, gutter, providerLines, clientLines);
  y += cardH + 20;

  // ---- Event title + description ----
  doc.font(BOLD).fontSize(14).fillColor(C.band).text(data.eventTitle, left, y, { width: CONTENT_W });
  y = doc.y + 4;
  if (data.description) {
    doc.font(BODY).fontSize(10).fillColor(C.text).text(data.description, left, y, { width: CONTENT_W });
    y = doc.y + 6;
  }
  y += 6;

  // ---- Chips ----
  const chips: [string, string][] = [
    ["DATE", data.eventDate ? fmtLongDate(data.eventDate) : "—"],
    ["HORAIRE", data.eventTime ?? "—"],
    ["PARTICIPANTS", data.participants ?? "—"],
    ["LIEU", data.location],
  ];
  y += drawChips(doc, left, y, CONTENT_W, chips) + 20;

  // ---- Prestations table ----
  y = drawTable(doc, left, y, CONTENT_W, data.items) + 16;

  // ---- Total ----
  const total = data.items.reduce((s, i) => s + (i.amount_xof ?? 0), 0);
  const totalH = 40;
  const totalW = CONTENT_W * 0.55;
  const totalX = right - totalW;
  doc.rect(totalX, y, totalW, totalH).fill(C.bandDark);
  doc.font(BOLD).fontSize(10).fillColor(C.white).text("TOTAL À RÉGLER", totalX + 16, y + 15, {
    width: totalW * 0.5,
  });
  doc.font(BOLD).fontSize(14).fillColor(C.white).text(formatXof(total), totalX, y + 12, {
    width: totalW - 16,
    align: "right",
  });
  y += totalH + 22;

  // ---- Conditions ----
  if (data.conditions.length) {
    doc.font(BOLD).fontSize(11).fillColor(C.band).text("CONDITIONS", left, y);
    y = doc.y + 6;
    doc.font(BODY).fontSize(9).fillColor(C.text);
    for (const cond of data.conditions) {
      const h = doc.heightOfString(cond, { width: CONTENT_W - 16 });
      doc.text("•", left, y, { continued: false });
      doc.text(cond, left + 14, y, { width: CONTENT_W - 14 });
      y += h + 4;
    }
  }

  // ---- Footer ----
  // Sit inside the bottom margin; drawn absolutely (lineBreak:false) so pdfkit
  // never inserts a page break to fit it.
  const footY = doc.page.height - MARGIN - 22;
  doc.moveTo(left, footY - 12).lineTo(right, footY - 12).lineWidth(1).strokeColor(C.rule).stroke();
  doc
    .font(BODY)
    .fontSize(8)
    .fillColor(C.muted)
    .text(
      "Revive Ventures · Centre de bien-être · Almadies, Dakar · revive.sn — Merci de votre confiance",
      left,
      footY,
      { width: CONTENT_W, align: "center", lineBreak: false },
    );
}

function drawCards(
  doc: PDFKit.PDFDocument,
  x: number,
  y: number,
  cardW: number,
  gutter: number,
  providerLines: string[],
  clientLines: string[],
): number {
  const pad = 12;
  const titleH = 16;
  const lineH = 13;
  const bodyLines = Math.max(providerLines.length, clientLines.length);
  const cardH = pad * 2 + titleH + bodyLines * lineH;

  const drawCard = (cx: number, title: string, lines: string[]) => {
    doc.roundedRect(cx, y, cardW, cardH, 8).fill(C.pale);
    doc.font(BOLD).fontSize(8).fillColor(C.band).text(title, cx + pad, y + pad, { width: cardW - pad * 2 });
    doc.font(BODY).fontSize(9).fillColor(C.text);
    lines.forEach((l, i) => {
      const bold = i === 0;
      doc.font(bold ? BOLD : BODY).text(l, cx + pad, y + pad + titleH + i * lineH, {
        width: cardW - pad * 2,
      });
    });
  };

  drawCard(x, "PRESTATAIRE", providerLines);
  drawCard(x + cardW + gutter, "CLIENT", clientLines);
  return cardH;
}

function drawChips(
  doc: PDFKit.PDFDocument,
  x: number,
  y: number,
  totalW: number,
  chips: [string, string][],
): number {
  const gap = 10;
  const chipW = (totalW - gap * (chips.length - 1)) / chips.length;
  const pad = 8;
  // Height driven by the tallest value (LIEU can wrap).
  let maxValH = 0;
  doc.font(BOLD).fontSize(9);
  for (const [, value] of chips) {
    maxValH = Math.max(maxValH, doc.heightOfString(value, { width: chipW - pad * 2 }));
  }
  const chipH = pad * 2 + 10 + maxValH;
  chips.forEach(([label, value], i) => {
    const cx = x + i * (chipW + gap);
    doc.roundedRect(cx, y, chipW, chipH, 6).fill(C.pale);
    doc.font(BODY).fontSize(7).fillColor(C.muted).text(label, cx + pad, y + pad, { width: chipW - pad * 2 });
    doc.font(BOLD).fontSize(9).fillColor(C.text).text(value, cx + pad, y + pad + 11, {
      width: chipW - pad * 2,
    });
  });
  return chipH;
}

function drawTable(
  doc: PDFKit.PDFDocument,
  x: number,
  y: number,
  totalW: number,
  items: { label: string; detail: string | null; amount_xof: number | null }[],
): number {
  const colLabel = totalW * 0.28;
  const colDetail = totalW * 0.5;
  const colAmount = totalW * 0.22;
  const pad = 8;
  const headH = 22;

  // Header band
  doc.rect(x, y, totalW, headH).fill(C.band);
  doc.font(BOLD).fontSize(8).fillColor(C.white);
  doc.text("PRESTATION", x + pad, y + 7, { width: colLabel - pad });
  doc.text("DÉTAIL", x + colLabel + pad, y + 7, { width: colDetail - pad });
  doc.text("MONTANT (XOF)", x + colLabel + colDetail, y + 7, {
    width: colAmount - pad,
    align: "right",
  });
  let cy = y + headH;

  items.forEach((it, i) => {
    doc.font(BODY).fontSize(9);
    const labelH = doc.heightOfString(it.label, { width: colLabel - pad * 2 });
    const detailH = it.detail ? doc.heightOfString(it.detail, { width: colDetail - pad * 2 }) : 0;
    const rowH = Math.max(labelH, detailH, 12) + pad * 2;
    if (i % 2 === 1) doc.rect(x, cy, totalW, rowH).fill(C.pale);
    doc.font(BOLD).fontSize(9).fillColor(C.text).text(it.label, x + pad, cy + pad, {
      width: colLabel - pad * 2,
    });
    if (it.detail)
      doc.font(BODY).fontSize(9).fillColor(C.text).text(it.detail, x + colLabel + pad, cy + pad, {
        width: colDetail - pad * 2,
      });
    const amountText = it.amount_xof == null ? "Inclus / 0" : fmtAmount(it.amount_xof);
    doc.font(it.amount_xof == null ? BODY : BOLD).fontSize(9).fillColor(C.text).text(
      amountText,
      x + colLabel + colDetail,
      cy + pad,
      { width: colAmount - pad, align: "right" },
    );
    cy += rowH;
  });

  // Outer border
  doc.rect(x, y, totalW, cy - y).lineWidth(0.5).strokeColor(C.rule).stroke();
  return cy;
}
