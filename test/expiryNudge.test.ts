import { describe, expect, it } from "vitest";
import { expiryNudgeMessage } from "../src/domain/expiryNudge.js";

const slot = new Date("2026-07-17T10:00:00Z"); // vendredi 17 juillet, 10:00 Dakar

describe("expiryNudgeMessage", () => {
  it("fr: names the class, the slot, reassures nothing was charged, offers a fresh link", () => {
    const msg = expiryNudgeMessage("fr", "Pilates Fusion", slot);
    expect(msg).toContain("Pilates Fusion");
    expect(msg).toContain("vendredi 17 juillet");
    expect(msg).toContain("10:00");
    expect(msg).toContain("rien n'a été débité");
    expect(msg).toContain("renvoie un tout frais");
  });

  it("en: same content in English", () => {
    const msg = expiryNudgeMessage("en", "Pilates Fusion", slot);
    expect(msg).toContain("Pilates Fusion");
    expect(msg).toContain("Friday 17 July");
    expect(msg).toContain("nothing was charged");
    expect(msg).toContain("fresh link");
  });

  it("wo: has a Wolof variant", () => {
    const msg = expiryNudgeMessage("wo", "Pilates Fusion", slot);
    expect(msg).toContain("Pilates Fusion");
    expect(msg).toContain("jeex na");
  });

  it("unknown/null language falls back to French", () => {
    expect(expiryNudgeMessage(null, "Yoga", slot)).toContain("a expiré");
    expect(expiryNudgeMessage("de", "Yoga", slot)).toContain("a expiré");
  });
});
