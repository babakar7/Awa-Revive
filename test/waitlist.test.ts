import { describe, expect, it } from "vitest";
import {
  shouldFallbackWaitlistTemplate,
  waitlistNudgeMessage,
  waitlistTemplateParams,
} from "../src/domain/waitlistSweep.js";

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

describe("shouldFallbackWaitlistTemplate", () => {
  it("true only on 131047 when a template name is configured", () => {
    expect(shouldFallbackWaitlistTemplate(new Error("…131047…"), "waitlist_spot_open")).toBe(true);
    expect(shouldFallbackWaitlistTemplate("error code 131047 (window)", "t")).toBe(true);
  });

  it("false when template env is empty (keep free-text-only behaviour)", () => {
    expect(shouldFallbackWaitlistTemplate(new Error("131047"), "")).toBe(false);
  });

  it("false on non-131047 errors even with a template", () => {
    expect(shouldFallbackWaitlistTemplate(new Error("timeout"), "waitlist_spot_open")).toBe(false);
    expect(shouldFallbackWaitlistTemplate(new Error("500"), "t")).toBe(false);
  });
});

describe("waitlistTemplateParams", () => {
  it("returns two sanitized body params (class + date)", () => {
    const [cls, when] = waitlistTemplateParams("Pilates Fusion", slot);
    expect(cls).toContain("Pilates");
    expect(when).toMatch(/juillet|17/);
    // no newlines (Meta template rule)
    expect(cls).not.toMatch(/[\n\t]/);
    expect(when).not.toMatch(/[\n\t]/);
  });
});
