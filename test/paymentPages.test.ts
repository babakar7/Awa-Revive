import { afterEach, describe, expect, it, vi } from "vitest";
import { buildServer, checkDatabaseHealth } from "../src/server.js";
import { pool } from "../src/db/index.js";

afterEach(() => vi.restoreAllMocks());

describe("healthz", () => {
  it("returns 200 only when Postgres answers", async () => {
    vi.spyOn(pool, "query").mockResolvedValueOnce({ rows: [{ ok: 1 }] } as never);
    const app = buildServer();
    const res = await app.inject({ method: "GET", url: "/healthz" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    await app.close();
  });

  it("returns 503 when Postgres rejects the query", async () => {
    vi.spyOn(pool, "query").mockRejectedValueOnce(new Error("database unavailable"));
    const app = buildServer();
    const res = await app.inject({ method: "GET", url: "/healthz" });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ ok: false });
    await app.close();
  });

  it("fails within the configured timeout when Postgres hangs", async () => {
    vi.spyOn(pool, "query").mockImplementationOnce(() => new Promise(() => {}) as never);
    await expect(checkDatabaseHealth(5)).resolves.toBe(false);
  });
});

describe("payment return pages", () => {
  it("success and error pages include a bare wa.me link (no text prefill)", async () => {
    const app = buildServer();
    for (const path of ["/payment/success", "/payment/error"]) {
      const res = await app.inject({ method: "GET", url: path });
      expect(res.statusCode).toBe(200);
      expect(res.headers["content-type"]).toMatch(/text\/html/);
      expect(res.body).toContain("https://wa.me/221789536676");
      expect(res.body).not.toContain("?text=");
      expect(res.body).toContain("WhatsApp");
    }
    await app.close();
  });

  it("success page mentions automatic WhatsApp confirmation", async () => {
    const app = buildServer();
    const res = await app.inject({ method: "GET", url: "/payment/success" });
    expect(res.body.toLowerCase()).toMatch(/automatiquement|confirmation/);
    await app.close();
  });
});
