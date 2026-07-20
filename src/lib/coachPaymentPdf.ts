import fs from "node:fs";
import path from "node:path";
import PDFDocument from "pdfkit";
import type { StatementDetail } from "../domain/coachPaymentRepo.js";
import { storedMonthKey, tariffFromJson, tariffLabel } from "../domain/coachPaymentRules.js";

const FONT_DIR = path.resolve(process.cwd(), "assets/fonts");
const BODY = "Body";
const BOLD = "Bold";
const PAGE_W = 595.28;
const PAGE_H = 841.89;
const MARGIN = 48;
const CONTENT_W = PAGE_W - 2 * MARGIN;
const COLORS = { text: "#241c24", muted: "#716771", rule: "#e7dee6", brand: "#6b4a6f", pale: "#f5edf4" };

function fmtXof(value: number): string {
  return `${Math.round(value).toLocaleString("fr-FR").replace(/ /g, " ")} FCFA`;
}

function fmtDate(value: Date): string {
  return value.toLocaleString("fr-FR", {
    timeZone: "Africa/Dakar",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

function monthLabel(value: string | Date): string {
  const [year, month] = storedMonthKey(value).split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, 1)).toLocaleDateString("fr-FR", {
    timeZone: "Africa/Dakar",
    month: "long",
    year: "numeric",
  });
}

function registerFonts(doc: PDFKit.PDFDocument): void {
  doc.registerFont(BODY, path.join(FONT_DIR, "DejaVuSans.ttf"));
  doc.registerFont(BOLD, path.join(FONT_DIR, "DejaVuSans-Bold.ttf"));
}

function assertFonts(): void {
  for (const file of ["DejaVuSans.ttf", "DejaVuSans-Bold.ttf"]) {
    const full = path.join(FONT_DIR, file);
    if (!fs.existsSync(full)) throw new Error(`coach payment pdf font missing: ${full}`);
  }
}

function watermark(doc: PDFKit.PDFDocument): void {
  doc.save();
  doc.opacity(0.1).fillColor(COLORS.brand).font(BOLD).fontSize(72);
  doc.rotate(-35, { origin: [PAGE_W / 2, PAGE_H / 2] });
  doc.text("BROUILLON", 55, PAGE_H / 2 - 25, { width: PAGE_W - 110, align: "center" });
  doc.restore();
  doc.opacity(1);
}

function ensureSpace(doc: PDFKit.PDFDocument, y: number, needed: number, draft: boolean): number {
  if (y + needed < PAGE_H - MARGIN) return y;
  doc.addPage();
  if (draft) watermark(doc);
  return MARGIN;
}

/** Render from stored snapshots only; no Wix/profile lookup occurs here. */
export function renderCoachPaymentPdf(detail: StatementDetail): Promise<Buffer> {
  assertFonts();
  const { statement, courses, adjustments } = detail;
  const draft = statement.status === "draft";
  const documentDate = statement.status === "draft"
    ? statement.created_at
    : (statement.validated_at ?? statement.created_at);
  const doc = new PDFDocument({
    size: "A4",
    margin: MARGIN,
    bufferPages: true,
    info: {
      Title: `État de paiement ${statement.coach_name_snapshot} ${storedMonthKey(statement.month)} v${statement.version}`,
      Author: "Revive Dakar",
      CreationDate: new Date(documentDate),
      ModDate: new Date(documentDate),
    },
  });
  registerFonts(doc);
  if (draft) watermark(doc);

  const chunks: Buffer[] = [];
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on("data", (chunk: Buffer) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });

  let y = MARGIN;
  doc.font(BOLD).fontSize(27).fillColor(COLORS.text).text("revive", MARGIN, y);
  doc.font(BOLD).fontSize(16).text("État de paiement coach", MARGIN, y + 4, {
    width: CONTENT_W,
    align: "right",
  });
  doc.font(BODY).fontSize(9).fillColor(COLORS.muted).text(
    `${draft ? "BROUILLON" : "VALIDÉ"} · version ${statement.version}`,
    MARGIN,
    y + 28,
    { width: CONTENT_W, align: "right" },
  );
  y += 66;

  doc.rect(MARGIN, y, CONTENT_W, 74).fill(COLORS.pale);
  doc.font(BOLD).fontSize(13).fillColor(COLORS.text).text(statement.coach_name_snapshot, MARGIN + 14, y + 12);
  doc.font(BODY).fontSize(10).fillColor(COLORS.muted);
  doc.text(`Période : ${monthLabel(statement.month)}`, MARGIN + 14, y + 34);
  if (statement.coach_email_snapshot) doc.text(statement.coach_email_snapshot, MARGIN + 14, y + 50);
  doc.font(BOLD).fontSize(11).fillColor(COLORS.text).text(
    fmtXof(statement.total_xof),
    MARGIN + CONTENT_W - 180,
    y + 28,
    { width: 165, align: "right" },
  );
  y += 94;

  doc.font(BOLD).fontSize(12).fillColor(COLORS.text).text("Séances", MARGIN, y);
  y += 22;
  const drawCourseHeader = () => {
    doc.rect(MARGIN, y, CONTENT_W, 22).fill(COLORS.brand);
    doc.font(BOLD).fontSize(8).fillColor("#ffffff");
    doc.text("Date", MARGIN + 7, y + 7);
    doc.text("Séance", MARGIN + 104, y + 7);
    doc.text("Source", MARGIN + 360, y + 7);
    doc.text("Comptée", MARGIN + 434, y + 7);
    y += 22;
  };
  drawCourseHeader();
  for (const course of courses) {
    y = ensureSpace(doc, y, 40, draft);
    if (y === MARGIN) drawCourseHeader();
    const reason = course.manual_reason ? `Motif : ${course.manual_reason}` : "";
    const h = reason ? 38 : 28;
    doc.font(BODY).fontSize(8.5).fillColor(course.included ? COLORS.text : COLORS.muted);
    doc.text(fmtDate(course.starts_at), MARGIN + 7, y + 7, { width: 92 });
    doc.text(course.service_name, MARGIN + 104, y + 7, { width: 248 });
    if (reason) doc.fontSize(7.5).fillColor(COLORS.muted).text(reason, MARGIN + 104, y + 20, { width: 248 });
    doc.font(BODY).fontSize(8.5).fillColor(COLORS.text).text(course.source === "wix" ? "Wix" : "Manuel", MARGIN + 360, y + 7);
    doc.font(course.included ? BOLD : BODY).text(course.included ? "Oui" : "Non", MARGIN + 434, y + 7);
    doc.moveTo(MARGIN, y + h).lineTo(MARGIN + CONTENT_W, y + h).lineWidth(0.5).strokeColor(COLORS.rule).stroke();
    y += h;
  }
  if (courses.length === 0) {
    doc.font(BODY).fontSize(9).fillColor(COLORS.muted).text("Aucune séance dans cet instantané.", MARGIN + 7, y + 8);
    y += 30;
  }

  y = ensureSpace(doc, y + 20, 145, draft);
  doc.font(BOLD).fontSize(12).fillColor(COLORS.text).text("Calcul", MARGIN, y);
  y += 22;
  doc.font(BODY).fontSize(9).fillColor(COLORS.text);
  doc.text(`Formule figée : ${tariffLabel(tariffFromJson(statement.tariff_json))}`, MARGIN, y, { width: CONTENT_W });
  y = doc.y + 8;
  doc.text(`${statement.course_count} séance(s) comptée(s)`, MARGIN, y);
  doc.font(BOLD).text(fmtXof(statement.base_total_xof), MARGIN, y, { width: CONTENT_W, align: "right" });
  y += 24;

  for (const adjustment of adjustments) {
    y = ensureSpace(doc, y, 25, draft);
    const sign = adjustment.kind === "bonus" ? "+" : "−";
    doc.font(BODY).fontSize(9).fillColor(COLORS.text).text(
      `${adjustment.kind === "bonus" ? "Prime" : "Retenue"} — ${adjustment.reason}`,
      MARGIN,
      y,
      { width: CONTENT_W - 140 },
    );
    doc.font(BOLD).text(`${sign} ${fmtXof(adjustment.amount_xof)}`, MARGIN, y, { width: CONTENT_W, align: "right" });
    y = Math.max(doc.y, y + 18);
  }

  y = ensureSpace(doc, y + 12, 70, draft);
  doc.moveTo(MARGIN, y).lineTo(MARGIN + CONTENT_W, y).lineWidth(1.2).strokeColor(COLORS.brand).stroke();
  y += 14;
  doc.font(BOLD).fontSize(14).fillColor(COLORS.text).text("TOTAL À PAYER", MARGIN, y);
  doc.text(fmtXof(statement.total_xof), MARGIN, y, { width: CONTENT_W, align: "right" });
  y += 38;
  doc.font(BODY).fontSize(8).fillColor(COLORS.muted).text(
    draft
      ? "Document de travail non validé."
      : `Validé le ${fmtDate(statement.validated_at ?? statement.created_at)}${statement.validated_by ? ` par ${statement.validated_by}` : ""}.`,
    MARGIN,
    y,
    { width: CONTENT_W },
  );

  doc.end();
  return done;
}

export function coachPaymentPdfFilename(detail: StatementDetail): string {
  const coach = detail.statement.coach_name_snapshot
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9_-]+/g, "-")
    .replace(/^-|-$/g, "");
  return `Etat-paiement-${coach || "coach"}-${storedMonthKey(detail.statement.month)}-v${detail.statement.version}.pdf`;
}
