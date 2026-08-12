import sharp from "sharp";

export const MENU_PHOTO_WIDTH = 900;
export const MENU_PHOTO_HEIGHT = 600;
export const MAX_MENU_PHOTO_BYTES = 10 * 1024 * 1024;
export const MENU_PHOTO_MIME = "image/webp";

const ACCEPTED_UPLOAD_MIMES = new Set(["image/jpeg", "image/png", "image/webp"]);
const ACCEPTED_INPUT_FORMATS = new Set(["jpeg", "png", "webp"]);

export type NormalizedMenuPhoto = {
  bytes: Buffer;
  mimeType: typeof MENU_PHOTO_MIME;
  width: typeof MENU_PHOTO_WIDTH;
  height: typeof MENU_PHOTO_HEIGHT;
  sourceBytes: Buffer;
  sourceWidth: number;
  sourceHeight: number;
  focalX: number;
  focalY: number;
};

export function menuPhotoUrl(itemId: string, version: string): string {
  return `/menu/photos/${encodeURIComponent(itemId)}/${encodeURIComponent(version)}`;
}

export function normalizeFocalPoint(value: unknown): number {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.min(1, number)) : 0.5;
}

/** Crop an optimized full-frame source around a user-selected focal point. */
export async function cropMenuPhotoSource(
  sourceBytes: Buffer,
  sourceWidth: number,
  sourceHeight: number,
  focalX: number,
  focalY: number,
): Promise<Buffer> {
  const x = normalizeFocalPoint(focalX);
  const y = normalizeFocalPoint(focalY);
  const targetRatio = MENU_PHOTO_WIDTH / MENU_PHOTO_HEIGHT;
  let left = 0;
  let top = 0;
  let width = sourceWidth;
  let height = sourceHeight;

  if (sourceWidth / sourceHeight > targetRatio) {
    width = Math.min(sourceWidth, Math.round(sourceHeight * targetRatio));
    left = Math.round((sourceWidth - width) * x);
  } else {
    height = Math.min(sourceHeight, Math.round(sourceWidth / targetRatio));
    top = Math.round((sourceHeight - height) * y);
  }

  return sharp(sourceBytes, { failOn: "error", limitInputPixels: 100_000_000 })
    .extract({ left, top, width, height })
    .resize(MENU_PHOTO_WIDTH, MENU_PHOTO_HEIGHT, { fit: "fill" })
    .webp({ quality: 80 })
    .toBuffer();
}

/** Validate and auto-orient an upload, retaining a bounded full-frame source. */
export async function normalizeMenuPhoto(
  input: Buffer,
  declaredMimeType: string,
  focalX = 0.5,
  focalY = 0.5,
): Promise<NormalizedMenuPhoto | { error: string }> {
  if (!ACCEPTED_UPLOAD_MIMES.has(declaredMimeType)) {
    return { error: "format non pris en charge — utilisez une image JPEG, PNG ou WebP." };
  }
  if (!input.length) return { error: "sélectionnez une image à envoyer." };
  if (input.length > MAX_MENU_PHOTO_BYTES) {
    return { error: "image trop volumineuse — 10 Mo maximum." };
  }

  try {
    const metadata = await sharp(input, {
      failOn: "error",
      limitInputPixels: 100_000_000,
    }).metadata();
    if (!metadata.format || !ACCEPTED_INPUT_FORMATS.has(metadata.format)) {
      return { error: "format non pris en charge — utilisez une image JPEG, PNG ou WebP." };
    }
    const source = await sharp(input, { failOn: "error", limitInputPixels: 100_000_000 })
      .rotate()
      .resize({
        width: 1800,
        height: 1800,
        fit: "inside",
        withoutEnlargement: true,
      })
      .webp({ quality: 85 })
      .toBuffer({ resolveWithObject: true });
    const x = normalizeFocalPoint(focalX);
    const y = normalizeFocalPoint(focalY);
    const bytes = await cropMenuPhotoSource(
      source.data,
      source.info.width,
      source.info.height,
      x,
      y,
    );
    return {
      bytes,
      mimeType: MENU_PHOTO_MIME,
      width: MENU_PHOTO_WIDTH,
      height: MENU_PHOTO_HEIGHT,
      sourceBytes: source.data,
      sourceWidth: source.info.width,
      sourceHeight: source.info.height,
      focalX: x,
      focalY: y,
    };
  } catch {
    return { error: "image illisible ou endommagée — choisissez un autre fichier." };
  }
}
