import { describe, expect, it } from "vitest";
import sharp from "sharp";
import {
  MENU_PHOTO_HEIGHT,
  MENU_PHOTO_MIME,
  MENU_PHOTO_WIDTH,
  normalizeMenuPhoto,
} from "../src/lib/cafeMenuPhoto.js";

describe("menu photo normalization", () => {
  it("auto-rotates EXIF, center-crops to 3:2, and produces a 900×600 WebP", async () => {
    const source = await sharp({
      create: { width: 600, height: 900, channels: 3, background: "#ff0000" },
    })
      .composite([{ input: Buffer.from('<svg width="600" height="450"><rect width="600" height="450" fill="#0000ff"/></svg>'), top: 450, left: 0 }])
      .jpeg()
      .withMetadata({ orientation: 6 })
      .toBuffer();

    const result = await normalizeMenuPhoto(source, "image/jpeg");
    expect(result).not.toHaveProperty("error");
    if ("error" in result) return;
    expect(result).toMatchObject({
      mimeType: MENU_PHOTO_MIME,
      width: MENU_PHOTO_WIDTH,
      height: MENU_PHOTO_HEIGHT,
      sourceWidth: 900,
      sourceHeight: 600,
      focalX: 0.5,
      focalY: 0.5,
    });
    const metadata = await sharp(result.bytes).metadata();
    expect(metadata).toMatchObject({ format: "webp", width: 900, height: 600 });
    expect(metadata.orientation).toBeUndefined();

    // EXIF orientation 6 rotates clockwise: the raw bottom blue half becomes
    // the displayed left half, proving pixels—not only metadata—were rotated.
    const { data, info } = await sharp(result.bytes).raw().toBuffer({ resolveWithObject: true });
    const pixel = (x: number, y: number) => {
      const offset = (y * info.width + x) * info.channels;
      return [data[offset], data[offset + 1], data[offset + 2]];
    };
    const left = pixel(100, 300);
    const right = pixel(800, 300);
    expect(left[2]).toBeGreaterThan(left[0]);
    expect(right[0]).toBeGreaterThan(right[2]);
  });

  it("moves a portrait crop from the top to the bottom using manual focal coordinates", async () => {
    const source = await sharp({
      create: { width: 600, height: 1200, channels: 3, background: "#ff0000" },
    })
      .composite([
        {
          input: Buffer.from('<svg width="600" height="600"><rect width="600" height="600" fill="#0000ff"/></svg>'),
          top: 600,
          left: 0,
        },
      ])
      .png()
      .toBuffer();
    const top = await normalizeMenuPhoto(source, "image/png", 0.5, 0);
    const bottom = await normalizeMenuPhoto(source, "image/png", 0.5, 1);
    if ("error" in top || "error" in bottom) throw new Error("normalization failed");

    const topPixel = await sharp(top.bytes).extract({ left: 450, top: 300, width: 1, height: 1 }).raw().toBuffer();
    const bottomPixel = await sharp(bottom.bytes).extract({ left: 450, top: 300, width: 1, height: 1 }).raw().toBuffer();
    expect(topPixel[0]).toBeGreaterThan(topPixel[2]);
    expect(bottomPixel[2]).toBeGreaterThan(bottomPixel[0]);
    expect(top.sourceHeight).toBe(1200);
    expect(bottom.focalY).toBe(1);
  });

  it("rejects unsupported and malformed uploads with French messages", async () => {
    await expect(normalizeMenuPhoto(Buffer.from("gif"), "image/gif")).resolves.toEqual({
      error: "format non pris en charge — utilisez une image JPEG, PNG ou WebP.",
    });
    await expect(normalizeMenuPhoto(Buffer.from("not an image"), "image/png")).resolves.toEqual({
      error: "image illisible ou endommagée — choisissez un autre fichier.",
    });
    const disguisedSvg = Buffer.from('<svg width="10" height="10"><rect width="10" height="10"/></svg>');
    await expect(normalizeMenuPhoto(disguisedSvg, "image/png")).resolves.toEqual({
      error: "format non pris en charge — utilisez une image JPEG, PNG ou WebP.",
    });
  });
});
