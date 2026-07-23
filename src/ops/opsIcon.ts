import { createCanvas } from "@napi-rs/canvas";

/**
 * PWA icon for the cuisine kiosque — the Revive chevron on cream, drawn with
 * canvas (no fonts, fully deterministic). Rendered once per size and cached by
 * the caller. Used for the manifest icons and the iOS apple-touch-icon.
 */

// Charte Revive : crème #fbf6f0, prune #7c547d.
export function renderOpsIcon(size: number): Buffer {
  const canvas = createCanvas(size, size);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#fbf6f0";
  ctx.fillRect(0, 0, size, size);

  // Chevron (même géométrie que le wordmark public), centré, ~54% de la largeur.
  const w = size * 0.54;
  const h = w * (28 / 36); // ratio du path 36×28
  const x0 = (size - w) / 2;
  const y0 = (size - h) / 2;
  const px = (fx: number) => x0 + (fx / 36) * w;
  const py = (fy: number) => y0 + (fy / 28) * h;
  ctx.fillStyle = "#7c547d";
  ctx.beginPath();
  ctx.moveTo(px(18), py(0));
  ctx.lineTo(px(36), py(28));
  ctx.lineTo(px(27), py(28));
  ctx.lineTo(px(18), py(14));
  ctx.lineTo(px(9), py(28));
  ctx.lineTo(px(0), py(28));
  ctx.closePath();
  ctx.fill();

  return canvas.toBuffer("image/png");
}
