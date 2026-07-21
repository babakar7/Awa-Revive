import fs from "node:fs";
import path from "node:path";
import { createCanvas, GlobalFonts } from "@napi-rs/canvas";

/**
 * Story Instagram quotidienne — "PLANNING DU {JOUR}".
 *
 * Rendu déterministe (aucune donnée ne vient du modèle, même posture que les
 * prix/créneaux) d'une image 1080×1920 annonçant les cours du lendemain et les
 * places restantes. Reprend la charte des Canva de Babakar (fond prune, titre
 * Noto Serif Display Extra Condensed, reste en Montserrat), validée le 20/07.
 *
 * Les cours sont regroupés (un cours = un bloc), avec une rangée de pastilles
 * horaires colorées — la couleur est déterministe par NOM de cours, donc un
 * même cours garde sa couleur d'un jour à l'autre. Jamais de nom de cours en
 * dur : tout vient de `StoryData` (construit depuis Wix live).
 *
 * Fonts bundlées dans assets/fonts/ (OFL) → rendu identique en local, en CI et
 * sur Railway quelle que soit la police du conteneur.
 */

export interface StorySlot {
  time: string; // "10H15" (Dakar == UTC)
  openSpots: number;
  totalSpots: number; // 0 = inconnu
}

export interface StoryClass {
  name: string;
  coach: string | null;
  slots: StorySlot[]; // triés par heure
}

export interface StoryData {
  dayLabel: string; // "MARDI"
  dateLabel: string; // "21 juillet"
  classes: StoryClass[]; // regroupés par cours, ordonnés par 1er créneau
}

// ---------- charte ----------

const THEME = {
  bg: "#8a6390", // fond prune
  ink: "#ffffff",
  sub: "rgba(255,255,255,0.85)",
  rule: "rgba(255,255,255,0.6)",
  chipInk: "#ffffff",
  fullChipBg: "rgba(255,255,255,0.12)",
  fullChipInk: "rgba(255,255,255,0.5)",
  // Couleurs de pastille par cours (assignées de façon déterministe par nom).
  classColors: ["#a9ab4a", "#ee7c3d", "#5157a8", "#ef70c5", "#4aab8f", "#d9a13b"],
  // Seuil de rareté : au-delà, on affiche "DISPO" plutôt qu'un compte précis.
  scarcityThreshold: 4,
};

// ---------- statut ----------

/** Libellé sous une pastille horaire (vocabulaire des stories de Babakar). */
export function statusLabel(openSpots: number, _totalSpots = 0): string {
  if (openSpots <= 0) return "FULL";
  if (openSpots === 1) return "1 PLACE";
  if (openSpots <= THEME.scarcityThreshold) return `${openSpots} PLACES`;
  return "DISPO";
}

/**
 * Couleur d'un cours, stable pour un nom donné sur la durée de vie du process
 * (l'ordre d'apparition détermine l'index dans la palette). Déterministe et
 * testable : deux `StoryClass` du même nom obtiennent la même couleur.
 */
export function classColorMap(classes: StoryClass[]): Map<string, string> {
  const map = new Map<string, string>();
  let i = 0;
  for (const c of classes) {
    if (!map.has(c.name)) {
      map.set(c.name, THEME.classColors[i % THEME.classColors.length]);
      i++;
    }
  }
  return map;
}

// ---------- fonts ----------

const FONT_DIR = path.resolve(process.cwd(), "assets/fonts");
let fontsRegistered = false;

const TITLE_FONT = "Noto Serif Display XCond";
const SANS = "Montserrat";
const SANS_SEMI = "Montserrat SemiBold";
const SANS_BOLD = "Montserrat Bold";

function registerFonts(): void {
  if (fontsRegistered) return;
  // Une font manquante doit échouer bruyamment ici (le job bascule sur un texte),
  // jamais rendre une image au texte invisible.
  for (const [file, family] of [
    ["NotoSerifDisplay-ExtraCondensedMedium.ttf", TITLE_FONT],
    ["Montserrat-Medium.ttf", SANS],
    ["Montserrat-SemiBold.ttf", SANS_SEMI],
    ["Montserrat-Bold.ttf", SANS_BOLD],
  ] as const) {
    const p = path.join(FONT_DIR, file);
    if (!fs.existsSync(p)) throw new Error(`story image font missing: ${p}`);
    GlobalFonts.registerFromPath(p, family);
  }
  fontsRegistered = true;
}

// ---------- rendu ----------

const W = 1080;
const H = 1920;
// Marge latérale de respiration : aucun texte ni pastille ne s'approche à moins
// de cette distance des bords (retour de Babakar 21/07 : 60px était trop serré).
const SIDE_MARGIN = 120;

/**
 * Rend la story en PNG (1080×1920). Lève une erreur s'il n'y a aucun cours —
 * l'appelant gère le cas "pas de cours demain" (message texte).
 */
export function renderStoryImage(data: StoryData): Buffer {
  if (data.classes.length === 0) throw new Error("empty story — nothing to render");
  registerFonts();

  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext("2d");
  const cx = W / 2;
  const colors = classColorMap(data.classes);

  // fond + léger dégradé
  ctx.fillStyle = THEME.bg;
  ctx.fillRect(0, 0, W, H);
  const wash = ctx.createLinearGradient(0, 0, W, H);
  wash.addColorStop(0, "rgba(255,255,255,0.05)");
  wash.addColorStop(0.5, "rgba(0,0,0,0.03)");
  wash.addColorStop(1, "rgba(255,255,255,0.04)");
  ctx.fillStyle = wash;
  ctx.fillRect(0, 0, W, H);

  ctx.textAlign = "left";

  /** Texte centré avec inter-lettrage, rétréci jusqu'à tenir dans maxW. */
  function spacedCentered(
    text: string,
    font: string,
    size: number,
    color: string,
    y: number,
    tracking: number,
    maxW = W - SIDE_MARGIN * 2,
  ): void {
    let s = size;
    let t = tracking;
    let widths: number[] = [];
    let total = 0;
    for (;;) {
      ctx.font = `${s}px "${font}"`;
      widths = [...text].map((ch) => ctx.measureText(ch).width);
      total = widths.reduce((a, b) => a + b, 0) + t * (text.length - 1);
      if (total <= maxW || s <= 20) break;
      s *= 0.94;
      t *= 0.94;
    }
    ctx.fillStyle = color;
    let x = cx - total / 2;
    [...text].forEach((ch, i) => {
      ctx.fillText(ch, x, y);
      x += widths[i] + t;
    });
  }

  /** Texte simple centré (pas d'inter-lettrage). */
  function centered(text: string, y: number): number {
    const w = ctx.measureText(text).width;
    ctx.fillText(text, cx - w / 2, y);
    return w;
  }

  // ---------- en-tête ----------
  spacedCentered(`PLANNING DU ${data.dayLabel}`, TITLE_FONT, 118, THEME.ink, 220, 6);
  spacedCentered("RÉSERVATION AVEC AWA SUR WHATSAPP", SANS_SEMI, 27, THEME.sub, 300, 9);

  // ---------- sections par cours ----------
  // Le contenu s'adapte au canvas : chaque cours occupe une bande, les pastilles
  // horaires s'enroulent en rangées équilibrées, et un facteur d'échelle global
  // garantit que même une journée très chargée (plusieurs cours, jusqu'à 8
  // créneaux) tienne entre l'en-tête et le footer sans jamais rogner un cours.
  const CONTENT_TOP = 400;
  const CONTENT_BOTTOM = H - 250; // laisse la place au wordmark + tagline
  const MAX_ROW_W = W - SIDE_MARGIN * 2; // largeur utile pour une rangée de pastilles

  // Rangées équilibrées, au plus 4 pastilles par rangée.
  const rowsFor = (cls: StoryClass): StorySlot[][] => {
    const n = cls.slots.length;
    const perRow = n <= 4 ? n : Math.ceil(n / Math.ceil(n / 4));
    const rows: StorySlot[][] = [];
    for (let i = 0; i < n; i += Math.max(1, perRow)) rows.push(cls.slots.slice(i, i + Math.max(1, perRow)));
    return rows;
  };

  // Métriques "naturelles" (échelle 1), scindées ensuite par le facteur `s`.
  const HEADER_H = 110; // nom du cours + ligne coach
  const CHIP_H = 82;
  const ROW_BLOCK = CHIP_H + 96; // pastille + libellé + inter-rangée
  const SECTION_GAP = 64;

  const rowsPerClass = data.classes.map((c) => rowsFor(c));
  const naturalH =
    data.classes.reduce((sum, _c, i) => sum + HEADER_H + rowsPerClass[i].length * ROW_BLOCK, 0) +
    SECTION_GAP * Math.max(0, data.classes.length - 1);
  const available = CONTENT_BOTTOM - CONTENT_TOP;
  const s = Math.min(1, available / naturalH); // ≤ 1 : on ne grossit jamais

  const headerH = HEADER_H * s;
  const chipH = CHIP_H * s;
  const rowBlock = ROW_BLOCK * s;
  const sectionGap = SECTION_GAP * s;
  const nameSize = 58 * s;
  const coachSize = 26 * s;
  const timeSize = 44 * s;
  const statusSize = 28 * s;

  let y = CONTENT_TOP + (available - naturalH * s) / 2; // centré verticalement

  data.classes.forEach((cls, ci) => {
    const color = colors.get(cls.name)!;
    const rows = rowsPerClass[ci];
    const nameY = y + 40 * s;

    // nom du cours (Montserrat SemiBold, inter-lettré)
    spacedCentered(cls.name.toUpperCase(), SANS_SEMI, nameSize, THEME.ink, nameY, 8 * s);

    // "AVEC {COACH}" avec deux traits latéraux
    if (cls.coach) {
      const coachLabel = `AVEC ${cls.coach.toUpperCase()}`;
      ctx.font = `${coachSize}px "${SANS}"`;
      const cw = [...coachLabel].reduce((a, ch) => a + ctx.measureText(ch).width, 0) + 7 * s * (coachLabel.length - 1);
      spacedCentered(coachLabel, SANS, coachSize, THEME.sub, nameY + 46 * s, 7 * s);
      ctx.strokeStyle = THEME.rule;
      ctx.lineWidth = 2;
      const ruleY = nameY + 37 * s;
      const ruleGap = cw / 2 + 40 * s;
      const ruleLen = 130 * s;
      ctx.beginPath();
      ctx.moveTo(cx - ruleGap - ruleLen, ruleY);
      ctx.lineTo(cx - ruleGap, ruleY);
      ctx.moveTo(cx + ruleGap, ruleY);
      ctx.lineTo(cx + ruleGap + ruleLen, ruleY);
      ctx.stroke();
    }

    // pastilles horaires (rangées centrées, largeur ajustée pour tenir)
    const chipGap = 44 * s;
    let rowY = nameY + 74 * s;
    for (const row of rows) {
      // largeur de pastille bornée pour que la rangée tienne dans MAX_ROW_W
      const chipW = Math.min(230 * s, (MAX_ROW_W - (row.length - 1) * chipGap) / row.length);
      const rowW = row.length * chipW + (row.length - 1) * chipGap;
      let x = cx - rowW / 2;
      for (const slot of row) {
        const full = slot.openSpots <= 0;
        ctx.fillStyle = full ? THEME.fullChipBg : color;
        ctx.beginPath();
        ctx.roundRect(x, rowY, chipW, chipH, chipH / 2);
        ctx.fill();

        // heure au centre de la pastille
        ctx.font = `${timeSize}px "${SANS_SEMI}"`;
        ctx.fillStyle = full ? THEME.fullChipInk : THEME.chipInk;
        const tw = ctx.measureText(slot.time).width;
        ctx.fillText(slot.time, x + (chipW - tw) / 2, rowY + chipH / 2 + timeSize * 0.35);

        // statut sous la pastille (inter-lettré, centré sous la pastille)
        const label = statusLabel(slot.openSpots, slot.totalSpots);
        ctx.font = `${statusSize}px "${SANS_SEMI}"`;
        const track = 5 * s;
        const chars = [...label];
        const lw = chars.reduce((a, ch) => a + ctx.measureText(ch).width, 0) + track * (chars.length - 1);
        let lx = x + (chipW - lw) / 2;
        ctx.fillStyle = full ? THEME.fullChipInk : THEME.ink;
        for (const ch of chars) {
          ctx.fillText(ch, lx, rowY + chipH + 44 * s);
          lx += ctx.measureText(ch).width + track;
        }
        x += chipW + chipGap;
      }
      rowY += rowBlock;
    }

    y += headerH + rows.length * rowBlock + sectionGap;
  });

  // ---------- footer ----------
  ctx.font = `120px "${SANS_BOLD}"`;
  ctx.fillStyle = THEME.ink;
  centered("revive", H - 130);
  spacedCentered("PILATES . WELLNESS . COMMUNITY", SANS_SEMI, 30, THEME.ink, H - 62, 8);

  return canvas.toBuffer("image/png");
}
