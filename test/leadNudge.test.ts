import { describe, expect, it } from "vitest";
import {
  fnv1aMod,
  isHoldout,
  isQuietHour,
  silentLeadNudgeMessage,
} from "../src/domain/leadNudge.js";

describe("silentLeadNudgeMessage", () => {
  it("greets by name in French and never promises a reservation", () => {
    const msg = silentLeadNudgeMessage(null, "Fatou");
    expect(msg).toContain("Coucou, Fatou");
    expect(msg).toContain("Awa, de Revive");
    expect(msg).toContain("L'Invitée");
    expect(msg).toContain("matin ou soir");
    // payment-first: help find a spot, not hold one
    expect(msg).toContain("t'aider à trouver une place");
    expect(msg).not.toMatch(/garde.* une place/i);
  });

  it("omits the comma when there is no name", () => {
    expect(silentLeadNudgeMessage(null, null)).toMatch(/^Coucou 👋🏾/);
    expect(silentLeadNudgeMessage(null, "   ")).toMatch(/^Coucou 👋🏾/);
  });

  it("switches to English on language=en", () => {
    const msg = silentLeadNudgeMessage("en", "Sophie");
    expect(msg).toContain("Hi, Sophie!");
    expect(msg).toContain("Awa from Revive");
    expect(msg).toContain("mornings or evenings");
  });
});

describe("fnv1aMod", () => {
  it("is deterministic and stays within the modulus", () => {
    for (const mod of [2, 6, 100]) {
      const a = fnv1aMod("abc-123", mod);
      const b = fnv1aMod("abc-123", mod);
      expect(a).toBe(b);
      expect(a).toBeGreaterThanOrEqual(0);
      expect(a).toBeLessThan(mod);
    }
  });

  it("differs across inputs (no low-bit collapse from float overflow)", () => {
    // Regression guard: naive hash*prime would collapse these to the same bucket.
    const buckets = new Set(
      Array.from({ length: 50 }, (_, i) => fnv1aMod(`client-${i}`, 6)),
    );
    expect(buckets.size).toBeGreaterThan(3);
  });

  it("gives a roughly even split into the holdout bucket", () => {
    let control = 0;
    const n = 6000;
    for (let i = 0; i < n; i++) if (fnv1aMod(`uuid-${i}`, 6) === 0) control++;
    // ~1/6 ≈ 1000; allow generous slack, just assert it's not degenerate.
    expect(control).toBeGreaterThan(700);
    expect(control).toBeLessThan(1300);
  });
});

describe("isHoldout", () => {
  it("disables the holdout when mod <= 0 (everyone treated)", () => {
    expect(isHoldout("any", 0)).toBe(false);
    expect(isHoldout("any", -1)).toBe(false);
  });

  it("is stable for a given id/mod", () => {
    const id = "d4f1c0de-0000-0000-0000-000000000001";
    expect(isHoldout(id, 6)).toBe(isHoldout(id, 6));
  });
});

describe("isQuietHour", () => {
  it("treats 21→9 as a midnight-wrapping quiet window", () => {
    const quiet = (h: number) => isQuietHour(h, 21, 9);
    expect(quiet(21)).toBe(true); // start inclusive
    expect(quiet(23)).toBe(true);
    expect(quiet(0)).toBe(true);
    expect(quiet(8)).toBe(true); // 08:59 still quiet
    expect(quiet(9)).toBe(false); // end exclusive → send allowed
    expect(quiet(12)).toBe(false);
    expect(quiet(20)).toBe(false); // 20:xx still allowed
  });

  it("handles a non-wrapping window", () => {
    const quiet = (h: number) => isQuietHour(h, 1, 6);
    expect(quiet(0)).toBe(false);
    expect(quiet(1)).toBe(true);
    expect(quiet(5)).toBe(true);
    expect(quiet(6)).toBe(false);
  });

  it("never suppresses when start == end", () => {
    expect(isQuietHour(3, 9, 9)).toBe(false);
  });
});
