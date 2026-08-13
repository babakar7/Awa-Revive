import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import sharp from "sharp";
import { buildServer } from "../../src/server.js";
import { pool } from "../../src/db/index.js";
import {
  getMenuItem,
  listMenuItems,
  refreshCafeMenu,
} from "../../src/domain/cafeMenuRepo.js";
import { getCafeMenu, pickerMenu } from "../../src/lib/cafeMenu.js";
import { MAX_MENU_PHOTO_BYTES } from "../../src/lib/cafeMenuPhoto.js";

const AUTH = `Basic ${Buffer.from("revive:revive@5000").toString("base64")}`;
const ITEM_ID = "PHOTO_TEST";
let app: FastifyInstance;

beforeAll(async () => {
  app = buildServer();
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await pool.end();
});

beforeEach(async () => {
  await pool.query(`delete from cafe_menu_items where id = $1`, [ITEM_ID]);
  await pool.query(
    `insert into cafe_menu_items
       (id, name, price_xof, category, description, favourite, enabled, sort_order)
     values ($1, 'Poke photo test', 4500, 'PLATS', 'Description publique', false, true, 1)`,
    [ITEM_ID],
  );
  await refreshCafeMenu();
});

function multipartPayload(
  bytes: Buffer,
  mimeType: string,
  filename = "photo.png",
  fields: Record<string, string> = {},
) {
  const boundary = `----revive-${Math.random().toString(16).slice(2)}`;
  const fieldBytes = Object.entries(fields).map(([name, value]) =>
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
    ),
  );
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="photo"; filename="${filename}"\r\nContent-Type: ${mimeType}\r\n\r\n`,
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  return {
    payload: Buffer.concat([...fieldBytes, head, bytes, tail]),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

async function upload(
  bytes: Buffer,
  mimeType: string,
  authenticated = true,
  focal?: { x: number; y: number },
) {
  const multipart = multipartPayload(
    bytes,
    mimeType,
    "photo.png",
    focal ? { focal_x: String(focal.x), focal_y: String(focal.y) } : {},
  );
  return app.inject({
    method: "POST",
    url: `/admin/menu/items/${ITEM_ID}/photo`,
    headers: {
      ...(authenticated ? { authorization: AUTH } : {}),
      "content-type": multipart.contentType,
    },
    payload: multipart.payload,
  });
}

async function png(color: string) {
  return sharp({
    create: { width: 1200, height: 700, channels: 3, background: color },
  })
    .png()
    .toBuffer();
}

async function storedPhoto() {
  const result = await pool.query(
    `select image_bytes, mime_type, width, height, source_bytes, source_width,
            source_height, focal_x, focal_y, version
       from cafe_menu_item_photos where item_id = $1`,
    [ITEM_ID],
  );
  return result.rows[0] as
    | {
        image_bytes: Buffer;
        mime_type: string;
        width: number;
        height: number;
        source_bytes: Buffer | null;
        source_width: number | null;
        source_height: number | null;
        focal_x: number;
        focal_y: number;
        version: string;
      }
    | undefined;
}

describe("admin-managed menu photos", () => {
  it("requires admin authentication and keeps the database unchanged", async () => {
    const response = await upload(await png("#ff0000"), "image/png", false);
    expect(response.statusCode).toBe(401);
    expect(await storedPhoto()).toBeUndefined();
  });

  it("uploads normalized WebP bytes and refreshes metadata-only snapshots/picker data", async () => {
    const response = await upload(await png("#ff0000"), "image/png", true, {
      x: 0.2,
      y: 0.8,
    });
    expect(response.statusCode).toBe(303);
    expect(response.headers.location).toBe(
      `/admin/menu/items/${ITEM_ID}?done=photo_uploaded`,
    );

    const photo = (await storedPhoto())!;
    expect(photo).toMatchObject({
      mime_type: "image/webp",
      width: 900,
      height: 600,
      source_width: 1200,
      source_height: 700,
      focal_x: 0.2,
      focal_y: 0.8,
    });
    expect(photo.source_bytes).toBeInstanceOf(Buffer);
    const metadata = await sharp(photo.image_bytes).metadata();
    expect(metadata).toMatchObject({ format: "webp", width: 900, height: 600 });

    const ordinary = (await listMenuItems()).find((item) => item.id === ITEM_ID)!;
    expect(ordinary.photo_version).toBe(photo.version);
    expect(ordinary).not.toHaveProperty("image_bytes");
    expect(getCafeMenu().items.get(ITEM_ID)?.photoVersion).toBe(photo.version);
    expect(getCafeMenu().promptText).not.toContain(photo.version);
    const pickerItem = pickerMenu().flatMap((category) => category.items).find((item) => item.id === ITEM_ID)!;
    expect(pickerItem.photoUrl).toBe(`/menu/photos/${ITEM_ID}/${photo.version}`);
    expect(pickerItem).not.toHaveProperty("image_bytes");
  });

  it("serves the full-frame source only through the authenticated admin route", async () => {
    await upload(await png("#00ff00"), "image/png");
    const photo = (await storedPhoto())!;
    const url = `/admin/menu/items/${ITEM_ID}/photo/source/${photo.version}`;
    const denied = await app.inject({ method: "GET", url });
    expect(denied.statusCode).toBe(302);
    expect(denied.headers.location).toContain("/admin/login");
    const response = await app.inject({ method: "GET", url, headers: { authorization: AUTH } });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("image/webp");
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(await sharp(response.rawPayload).metadata()).toMatchObject({
      format: "webp",
      width: 1200,
      height: 700,
    });
  });

  it("repositions the retained source, changes the public version, and refreshes the picker", async () => {
    const portrait = await sharp({
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
    await upload(portrait, "image/png");
    const before = (await storedPhoto())!;
    const response = await app.inject({
      method: "POST",
      url: `/admin/menu/items/${ITEM_ID}/photo/position`,
      headers: { authorization: AUTH, "content-type": "application/x-www-form-urlencoded" },
      payload: new URLSearchParams({ version: before.version, focal_x: "0.5", focal_y: "1" }).toString(),
    });
    expect(response.statusCode).toBe(303);
    expect(response.headers.location).toBe(
      `/admin/menu/items/${ITEM_ID}?done=photo_positioned`,
    );
    const after = (await storedPhoto())!;
    expect(after.version).not.toBe(before.version);
    expect(after.focal_y).toBe(1);
    expect(after.source_bytes).toEqual(before.source_bytes);
    const center = await sharp(after.image_bytes)
      .extract({ left: 450, top: 300, width: 1, height: 1 })
      .raw()
      .toBuffer();
    expect(center[2]).toBeGreaterThan(center[0]);
    expect(getCafeMenu().items.get(ITEM_ID)?.photoVersion).toBe(after.version);
    expect(
      pickerMenu().flatMap((category) => category.items).find((item) => item.id === ITEM_ID)?.photoUrl,
    ).toBe(`/menu/photos/${ITEM_ID}/${after.version}`);
    const stale = await app.inject({ method: "GET", url: `/menu/photos/${ITEM_ID}/${before.version}` });
    expect(stale.statusCode).toBe(404);
    expect(stale.headers["cache-control"]).toBe("no-store");
  });

  it("preserves legacy crops and asks for one original re-upload", async () => {
    await upload(await png("#ff0000"), "image/png");
    await pool.query(
      `update cafe_menu_item_photos set source_bytes = null, source_width = null, source_height = null
        where item_id = $1`,
      [ITEM_ID],
    );
    const legacy = (await storedPhoto())!;
    const response = await app.inject({
      method: "POST",
      url: `/admin/menu/items/${ITEM_ID}/photo/position`,
      headers: { authorization: AUTH, "content-type": "application/x-www-form-urlencoded" },
      payload: new URLSearchParams({ version: legacy.version, focal_x: "0", focal_y: "1" }).toString(),
    });
    expect(response.statusCode).toBe(303);
    expect(decodeURIComponent(response.headers.location!)).toContain("remplacez cette ancienne photo");
    expect((await storedPhoto())!.version).toBe(legacy.version);
  });

  it("serves the same immutable versioned WebP on menu and ordering hosts", async () => {
    await upload(await png("#00ff00"), "image/png");
    const version = (await getMenuItem(ITEM_ID))!.photo_version!;
    for (const host of ["menu.revive.sn", "awa-production.up.railway.app"]) {
      const response = await app.inject({
        method: "GET",
        url: `/menu/photos/${ITEM_ID}/${version}`,
        headers: { host },
      });
      expect(response.statusCode).toBe(200);
      expect(response.headers["content-type"]).toContain("image/webp");
      expect(response.headers["cache-control"]).toBe(
        "public, max-age=31536000, immutable",
      );
      expect((await sharp(response.rawPayload).metadata()).format).toBe("webp");
    }
  });

  it("replaces atomically and leaves missing/stale versions as uncached 404s", async () => {
    await upload(await png("#ff0000"), "image/png");
    const first = (await storedPhoto())!;
    await upload(await png("#0000ff"), "image/png");
    const second = (await storedPhoto())!;
    expect(second.version).not.toBe(first.version);

    for (const url of [
      `/menu/photos/${ITEM_ID}/${first.version}`,
      `/menu/photos/${ITEM_ID}/missing-version`,
      `/menu/photos/UNKNOWN/${second.version}`,
    ]) {
      const response = await app.inject({ method: "GET", url });
      expect(response.statusCode).toBe(404);
      expect(response.headers["cache-control"]).toBe("no-store");
    }
    const current = await app.inject({
      method: "GET",
      url: `/menu/photos/${ITEM_ID}/${second.version}`,
    });
    expect(current.statusCode).toBe(200);
  });

  it("preserves an existing photo after malformed, unsupported, or oversized uploads", async () => {
    await upload(await png("#ff0000"), "image/png");
    const original = (await storedPhoto())!;

    const malformed = await upload(Buffer.from("not an image"), "image/png");
    expect(malformed.statusCode).toBe(303);
    expect(decodeURIComponent(malformed.headers.location!)).toContain("image illisible ou endommagée");
    expect((await storedPhoto())!.version).toBe(original.version);

    const unsupported = await upload(Buffer.from("GIF89a"), "image/gif");
    expect(unsupported.statusCode).toBe(303);
    expect(decodeURIComponent(unsupported.headers.location!)).toContain("format non pris en charge");
    expect((await storedPhoto())!.version).toBe(original.version);

    const oversized = await upload(Buffer.alloc(MAX_MENU_PHOTO_BYTES + 1), "image/png");
    expect(oversized.statusCode).toBe(303);
    expect(decodeURIComponent(oversized.headers.location!)).toContain("10 Mo maximum");
    expect((await storedPhoto())!.version).toBe(original.version);
  });

  it("removes a photo and refreshes the picker immediately", async () => {
    await upload(await png("#ff0000"), "image/png");
    const version = (await storedPhoto())!.version;
    const response = await app.inject({
      method: "POST",
      url: `/admin/menu/items/${ITEM_ID}/photo/remove`,
      headers: { authorization: AUTH, "content-type": "application/x-www-form-urlencoded" },
      payload: "",
    });
    expect(response.statusCode).toBe(303);
    expect(response.headers.location).toBe(
      `/admin/menu/items/${ITEM_ID}?done=photo_removed`,
    );
    expect(await storedPhoto()).toBeUndefined();
    expect(getCafeMenu().items.get(ITEM_ID)?.photoVersion).toBeUndefined();
    expect(
      pickerMenu().flatMap((category) => category.items).find((item) => item.id === ITEM_ID),
    ).not.toHaveProperty("photoUrl");

    const stale = await app.inject({
      method: "GET",
      url: `/menu/photos/${ITEM_ID}/${version}`,
    });
    expect(stale.statusCode).toBe(404);
    expect(stale.headers["cache-control"]).toBe("no-store");
  });
});
