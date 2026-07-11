import { describe, expect, it } from "vitest";
import { waitlistNudgeMessage } from "../src/domain/waitlistSweep.js";

const slot = new Date("2026-07-17T10:00:00Z"); // vendredi 17 juillet, 10:00 Dakar

describe("waitlistNudgeMessage", () => {
  it("fr: names the class and slot, urges speed, states first come first served", () => {
    const msg = waitlistNudgeMessage("fr", "Pilates Fusion", slot);
    expect(msg).toContain("Pilates Fusion");
    expect(msg).toContain("vendredi 17 juillet");
    expect(msg).toContain("10:00");
    expect(msg).toContain("se libérer");
    expect(msg).toContain("premier arrivé, premier servi");
  });

  it("en: same content in English", () => {
    const msg = waitlistNudgeMessage("en", "Pilates Fusion", slot);
    expect(msg).toContain("Pilates Fusion");
    expect(msg).toContain("Friday 17 July");
    expect(msg).toContain("freed up");
    expect(msg).toContain("first come, first served");
  });

  it("wo: has a Wolof variant", () => {
    const msg = waitlistNudgeMessage("wo", "Pilates Fusion", slot);
    expect(msg).toContain("Pilates Fusion");
    expect(msg).toContain("palaas");
  });

  it("unknown/null language falls back to French", () => {
    expect(waitlistNudgeMessage(null, "Yoga", slot)).toContain("se libérer");
    expect(waitlistNudgeMessage("de", "Yoga", slot)).toContain("se libérer");
  });
});
