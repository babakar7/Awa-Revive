import fs from "node:fs";
import path from "node:path";
import PDFDocument from "pdfkit";
import type { InvoiceLine } from "../domain/invoiceRules.js";

/**
 * FACTURE as an A4 PDF, layout modelled on the studio's Wix invoices (white
 * page, light-blue table band, seller block top-left, "Facturer à :" block,
 * Sous-total / Taxes / Total / Montant payé / Reste à payer). Every value is
 * server-provided. Sent as a WhatsApp DOCUMENT (real PDF attachment) by both
 * Awa (send_invoice) and reception (/admin/factures) — the PNG renderer
 * (invoiceImage.ts) is retired from those paths.
 */

export interface InvoicePdfData {
  number: string;
  clientName: string;
  clientRef?: string | null;
  clientPhone?: string | null;
  lines: InvoiceLine[];
  totalXof: number;
  note?: string | null;
  paidVia?: string | null;
  paymentRef?: string | null;
  paidAt?: Date | null;
  createdAt: Date;
}

const FONT_DIR = path.resolve(process.cwd(), "assets/fonts");
const BODY = "Body";
const BOLD = "Bold";

// Palette calquée sur la facture Wix : page blanche, bande tableau bleu clair.
const C = {
  text: "#1f2126",
  muted: "#6b7075",
  band: "#cfdcf3",
  rule: "#e3e5e8",
  darkRule: "#1f2126",
};

const MARGIN = 56;
const PAGE_W = 595.28; // A4 portrait
const CONTENT_W = PAGE_W - MARGIN * 2;

function fmtFcfa(n: number): string {
  return `${Math.round(n).toLocaleString("fr-FR").replace(/ /g, " ")} FCFA`;
}

function fmtLongDate(d: Date): string {
  return d.toLocaleDateString("fr-FR", {
    timeZone: "Africa/Dakar",
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

function registerFonts(doc: PDFKit.PDFDocument): void {
  for (const [name, file] of [
    [BODY, "DejaVuSans.ttf"],
    [BOLD, "DejaVuSans-Bold.ttf"],
  ] as const) {
    const p = path.join(FONT_DIR, file);
    if (!fs.existsSync(p)) throw new Error(`invoice pdf font missing: ${p}`);
    doc.registerFont(name, p);
  }
}

/** Render the facture PDF. Resolves to the full buffer; throws if fonts are missing. */
export function renderInvoicePdf(data: InvoicePdfData): Promise<Buffer> {
  if (data.lines.length === 0) throw new Error("invoice pdf: no lines");
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

function drawBody(doc: PDFKit.PDFDocument, data: InvoicePdfData): void {
  const left = MARGIN;
  const right = PAGE_W - MARGIN;
  let y = MARGIN;

  // ---- Wordmark + facture meta (right) ----
  doc.font(BOLD).fontSize(30).fillColor(C.text).text("revive", left, y - 8);

  doc.font(BOLD).fontSize(15).fillColor(C.text).text(`Facture n° ${data.number}`, left, y - 4, {
    width: CONTENT_W,
    align: "right",
  });
  doc.font(BODY).fontSize(9).fillColor(C.muted);
  doc.text(`Date d'émission : ${fmtLongDate(data.createdAt)}`, left, y + 18, {
    width: CONTENT_W,
    align: "right",
  });
  y += 58;

  // ---- Seller block ----
  doc.font(BOLD).fontSize(9).fillColor(C.text).text("Revive", left, y);
  doc.font(BODY).fontSize(9).fillColor(C.muted);
  for (const line of ["Dakar, Dakar", "Sénégal", "support@revive.sn", "Téléphone : 78 464 43 29"]) {
    doc.text(line, left, doc.y + 1);
  }
  y = doc.y + 16;
  doc.moveTo(left, y).lineTo(right, y).lineWidth(0.75).strokeColor(C.rule).stroke();
  y += 18;

  // ---- Facturer à / infos client ----
  const colW = CONTENT_W / 2 - 10;
  doc.font(BODY).fontSize(9).fillColor(C.muted).text("Facturer à :", left, y);
  doc.font(BOLD).fontSize(10).fillColor(C.text).text(data.clientName, left, doc.y + 2, { width: colW });
  if (data.clientRef?.trim()) {
    doc.font(BODY).fontSize(9).fillColor(C.muted).text(data.clientRef.trim(), left, doc.y + 1, { width: colW });
  }
  doc.font(BODY).fontSize(9).fillColor(C.muted).text("Sénégal", left, doc.y + 1);
  const leftEndY = doc.y;

  const infoX = left + CONTENT_W / 2 + 10;
  doc.font(BODY).fontSize(9).fillColor(C.muted).text("Infos client supplémentaires :", infoX, y);
  if (data.clientPhone) {
    doc.text(`Téléphone : +${data.clientPhone.replace(/^\+/, "")}`, infoX, doc.y + 2);
  }
  y = Math.max(leftEndY, doc.y) + 26;

  // ---- Table: Article ou service | Quantité | Prix | Total ----
  const colTot = right;
  const colPrix = right - 110;
  const colQty = colPrix - 100;
  const headH = 24;
  doc.rect(left - 8, y, CONTENT_W + 16, headH).fill(C.band);
  doc.font(BOLD).fontSize(9).fillColor(C.text);
  doc.text("Article ou service", left, y + 7);
  const rightHead = (t: string, x: number) =>
    doc.text(t, x - doc.widthOfString(t), y + 7);
  rightHead("Quantité", colQty);
  rightHead("Prix", colPrix);
  rightHead("Total", colTot);
  y += headH + 14;

  for (const l of data.lines) {
    doc.font(BODY).fontSize(10).fillColor(C.text);
    const labelW = colQty - left - 70;
    const labelH = doc.heightOfString(l.label, { width: labelW });
    doc.text(l.label, left, y, { width: labelW });
    const cell = (t: string, x: number) => doc.text(t, x - doc.widthOfString(t), y);
    cell(String(l.qty), colQty);
    cell(fmtFcfa(l.unit_xof), colPrix);
    doc.font(BOLD);
    cell(fmtFcfa(l.total_xof), colTot);
    y += Math.max(labelH, 12) + 12;
  }
  doc.moveTo(left, y).lineTo(right, y).lineWidth(1.2).strokeColor(C.darkRule).stroke();
  y += 20;

  // ---- Total (right) ----
  const labelX = left + CONTENT_W * 0.45;
  doc.font(BOLD).fontSize(12).fillColor(C.text);
  doc.text("Total de la facture", labelX, y);
  doc.text(fmtFcfa(data.totalXof), labelX, y, { width: right - labelX, align: "right" });
  y += 32;

  // ---- Payment reference / note ----
  if (data.paidAt) {
    const via = data.paidVia ? `Payée via ${data.paidVia}` : "Payée";
    const ref = data.paymentRef ? ` — réf. ${data.paymentRef}` : "";
    doc.font(BODY).fontSize(9).fillColor(C.muted);
    doc.text(`✓ ${via}${ref} · le ${fmtLongDate(data.paidAt)}`, left, y, { width: CONTENT_W });
    y = doc.y + 8;
  }
  if (data.note?.trim()) {
    doc.font(BODY).fontSize(9).fillColor(C.muted);
    doc.text(`Note : ${data.note.trim()}`, left, y, { width: CONTENT_W });
  }
}
