import { describe, expect, it } from "vitest";
import {
  cleanResolutionNote,
  isHumanTakeoverActive,
  isWithinWhatsAppWindow,
  parseResolutionOutcome,
} from "../src/domain/adminOperations.js";

describe("admin follow-up rules", () => {
  it("accepts only explicit closure outcomes and caps notes", () => {
    expect(parseResolutionOutcome("resolved")).toBe("resolved");
    expect(parseResolutionOutcome("anything")).toBeNull();
    expect(cleanResolutionNote("  rappel effectué  ")).toBe("rappel effectué");
    expect(cleanResolutionNote("x".repeat(600))).toHaveLength(500);
    expect(cleanResolutionNote("   ")).toBeNull();
  });

  it("uses the takeover deadline as a hard Awa gate", () => {
    const now = new Date("2026-07-20T12:00:00Z").getTime();
    expect(isHumanTakeoverActive({ human_takeover_until: new Date(now + 1) } as any, now)).toBe(true);
    expect(isHumanTakeoverActive({ human_takeover_until: new Date(now) } as any, now)).toBe(false);
    expect(isHumanTakeoverActive({ human_takeover_until: null } as any, now)).toBe(false);
  });

  it("opens free-text messaging only for a client message under 24 hours old", () => {
    const now = new Date("2026-07-20T12:00:00Z").getTime();
    expect(isWithinWhatsAppWindow(new Date(now - 23 * 3_600_000), now)).toBe(true);
    expect(isWithinWhatsAppWindow(new Date(now - 24 * 3_600_000), now)).toBe(false);
    expect(isWithinWhatsAppWindow(null, now)).toBe(false);
  });
});
