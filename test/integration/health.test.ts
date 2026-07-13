import { afterAll, describe, expect, it } from "vitest";
import { buildServer } from "../../src/server.js";

const app = buildServer();

afterAll(async () => {
  await app.close();
});

describe("healthz readiness", () => {
  it("returns 200 against the integration Postgres", async () => {
    const res = await app.inject({ method: "GET", url: "/healthz" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
  });
});
