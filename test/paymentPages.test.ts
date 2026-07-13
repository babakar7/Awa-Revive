import { describe, expect, it } from "vitest";
import { buildServer } from "../src/server.js";

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
