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
};

export function menuPhotoUrl(itemId: string, version: string): string {
  return `/menu/photos/${encodeURIComponent(itemId)}/${encodeURIComponent(version)}`;
}

/** Validate, auto-orient, crop, resize, and encode an admin-supplied menu photo. */
export async function normalizeMenuPhoto(
  input: Buffer,
  declaredMimeType: string,
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
    const bytes = await sharp(input, { failOn: "error", limitInputPixels: 100_000_000 })
      .rotate()
      .resize(MENU_PHOTO_WIDTH, MENU_PHOTO_HEIGHT, {
        fit: "cover",
        position: "centre",
      })
      .webp({ quality: 80 })
      .toBuffer();
    return {
      bytes,
      mimeType: MENU_PHOTO_MIME,
      width: MENU_PHOTO_WIDTH,
      height: MENU_PHOTO_HEIGHT,
    };
  } catch {
    return { error: "image illisible ou endommagée — choisissez un autre fichier." };
  }
}
