import fs from "node:fs";
import path from "node:path";
import { createCanvas, GlobalFonts, loadImage } from "@napi-rs/canvas";

/**
 * Revive gift-card visual as a PNG. Everything is fixed except three zones:
 * the offer text (1–2 lines, rendered UPPERCASE), the recipient (POUR) and the
 * giver (DE). We draw those over a pre-wiped template image
 * (assets/gift-card-template.png) whose variable zones were painted back to the
 * panel cream — so the layout matches the studio's Canva design exactly and we
 * only place text. Coordinates were measured on the original 1748×1240 export.
 */

export interface GiftCardData {
  offerLine1: string;
  offerLine2: string | null;
  recipientName: string; // POUR
  fromName: string; // DE
}

const ASSET_DIR = path.resolve(process.cwd(), "assets");
const TEMPLATE = path.join(ASSET_DIR, "gift-card-template.png");
const FONT_DIR = path.join(ASSET_DIR, "fonts");
let fontsRegistered = false;

function registerFonts(): void {
  if (fontsRegistered) return;
  for (const [file, family] of [
    ["DejaVuSans.ttf", "DejaVu Sans"],
    ["DejaVuSans-Bold.ttf", "DejaVu Sans Bold"],
  ] as const) {
    const p = path.join(FONT_DIR, file);
    if (!fs.existsSync(p)) throw new Error(`gift card font missing: ${p}`);
    GlobalFonts.registerFromPath(p, family);
  }
  fontsRegistered = true;
}

const W = 1748;
const H = 1240;
// Measured on the original export.
const OFFER_CENTER_X = 1247;
const OFFER_Y1 = 420; // center of line 1 when two lines
const OFFER_Y2 = 508; // center of line 2
const OFFER_Y_SINGLE = 464; // center when a single line
const OFFER_MAX_W = 660;
const OFFER_COLOR = "#353433";
const POUR_CENTER = { x: 1282, y: 745 };
const DE_CENTER = { x: 1300, y: 840 };
const VALUE_MAX_W = 470;
const VALUE_COLOR = "#3a3a3a";

type Ctx = ReturnType<ReturnType<typeof createCanvas>["getContext"]>;

/** Draw one centered line, shrinking the font until it fits maxWidth. */
function drawFitted(
  ctx: Ctx,
  text: string,
  cx: number,
  cy: number,
  basePx: number,
  maxWidth: number,
  family = "DejaVu Sans",
): void {
  let size = basePx;
  ctx.font = `${size}px "${family}"`;
  while (ctx.measureText(text).width > maxWidth && size > 12) {
    size -= 2;
    ctx.font = `${size}px "${family}"`;
  }
  ctx.fillText(text, cx, cy);
}

/** Render the gift-card PNG. Throws if the template or fonts are missing. */
export async function renderGiftCardImage(data: GiftCardData): Promise<Buffer> {
  registerFonts();
  if (!fs.existsSync(TEMPLATE)) throw new Error(`gift card template missing: ${TEMPLATE}`);
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext("2d");
  const bg = await loadImage(TEMPLATE);
  ctx.drawImage(bg, 0, 0, W, H);

  ctx.textAlign = "center";
  ctx.textBaseline = "middle";

  // Offer (uppercase, dark grey). One or two lines.
  ctx.fillStyle = OFFER_COLOR;
  const l1 = data.offerLine1.toUpperCase();
  const l2 = data.offerLine2?.trim() ? data.offerLine2.toUpperCase() : null;
  if (l2) {
    drawFitted(ctx, l1, OFFER_CENTER_X, OFFER_Y1, 54, OFFER_MAX_W);
    drawFitted(ctx, l2, OFFER_CENTER_X, OFFER_Y2, 54, OFFER_MAX_W);
  } else {
    drawFitted(ctx, l1, OFFER_CENTER_X, OFFER_Y_SINGLE, 54, OFFER_MAX_W);
  }

  // POUR / DE values.
  ctx.fillStyle = VALUE_COLOR;
  drawFitted(ctx, data.recipientName, POUR_CENTER.x, POUR_CENTER.y, 46, VALUE_MAX_W);
  drawFitted(ctx, data.fromName, DE_CENTER.x, DE_CENTER.y, 46, VALUE_MAX_W);

  return canvas.toBuffer("image/png");
}
