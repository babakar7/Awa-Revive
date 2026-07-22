import fs from "node:fs";
import path from "node:path";
import { createCanvas, GlobalFonts } from "@napi-rs/canvas";

/**
 * og:image de la page menu publique (menu.revive.sn) — carte 1200×630 pour les
 * aperçus de lien WhatsApp/Instagram. Contenu statique (marque seule, aucune
 * donnée menu) → rendu une fois par process et mis en cache par l'appelant.
 * Mêmes fondations que scheduleImage/storyImage : polices bundlées dans
 * assets/fonts, rendu 100 % déterministe côté serveur.
 */

const FONT_DIR = path.resolve(process.cwd(), "assets/fonts");
let fontsRegistered = false;

const TITLE_FONT = "Noto Serif Display XCond";
const SANS_SEMI = "Montserrat SemiBold";

function registerFonts(): void {
  if (fontsRegistered) return;
  for (const [file, family] of [
    ["NotoSerifDisplay-ExtraCondensedMedium.ttf", TITLE_FONT],
    ["Montserrat-SemiBold.ttf", SANS_SEMI],
  ] as const) {
    const p = path.join(FONT_DIR, file);
    if (!fs.existsSync(p)) throw new Error(`menu og image font missing: ${p}`);
    GlobalFonts.registerFromPath(p, family);
  }
  fontsRegistered = true;
}

// Charte Revive : crème #fbf6f0, prune #7c547d, prune foncé #211921, rose #f2e7e2.
const W = 1200;
const H = 630;

export function renderMenuOgImage(): Buffer {
  registerFonts();
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext("2d");
  const cx = W / 2;

  ctx.fillStyle = "#fbf6f0";
  ctx.fillRect(0, 0, W, H);

  // Liseré rose poudré discret en haut et en bas.
  ctx.fillStyle = "#f2e7e2";
  ctx.fillRect(0, 0, W, 10);
  ctx.fillRect(0, H - 10, W, 10);

  // Chevron Revive (même géométrie que le SVG inline de la page : 36×28).
  const chW = 90;
  const chH = 70;
  const chX = cx - chW / 2;
  const chY = 120;
  ctx.fillStyle = "#7c547d";
  ctx.beginPath();
  ctx.moveTo(chX + chW / 2, chY);
  ctx.lineTo(chX + chW, chY + chH);
  ctx.lineTo(chX + chW * 0.75, chY + chH);
  ctx.lineTo(chX + chW / 2, chY + chH / 2);
  ctx.lineTo(chX + chW * 0.25, chY + chH);
  ctx.lineTo(chX, chY + chH);
  ctx.closePath();
  ctx.fill();

  ctx.textAlign = "center";

  ctx.fillStyle = "#211921";
  ctx.font = `170px "${TITLE_FONT}"`;
  ctx.fillText("Le Menu", cx, 400);

  ctx.fillStyle = "#7c547d";
  ctx.font = `34px "${SANS_SEMI}"`;
  // Espacement manuel des lettres (letterSpacing n'existe pas sur ce canvas).
  ctx.fillText("R E V I V E   —   D A K A R", cx, 500);

  return canvas.toBuffer("image/png");
}
