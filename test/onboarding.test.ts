import { describe, expect, it } from "vitest";
import {
  CAPABILITY_MENU_WINDOW_MS,
  capabilityMenuKind,
  isVagueOpener,
  isCapabilityOptionId,
} from "../src/lib/capabilityMenu.js";

describe("isVagueOpener", () => {
  it("true for plain greetings", () => {
    for (const t of ["bonjour", "Bonjour !", "salut", "hello", "hi", "bonsoir", "bjr", "Hey"]) {
      expect(isVagueOpener(t), t).toBe(true);
    }
  });

  it("true for short help / availability", () => {
    expect(isVagueOpener("dispo ?")).toBe(true);
    expect(isVagueOpener("aide")).toBe(true);
    expect(isVagueOpener("tu es là")).toBe(true);
    expect(isVagueOpener("help")).toBe(true);
  });

  it("false when greeting + real intent", () => {
    expect(isVagueOpener("bonjour je veux du reformer")).toBe(false);
    expect(isVagueOpener("salut pilates demain")).toBe(false);
  });

  it("false for clicks, media prefixes, long messages", () => {
    expect(isVagueOpener("[choix cliqué] Oui (id: habit_yes)")).toBe(false);
    expect(isVagueOpener("[note vocale] salut")).toBe(false);
    expect(isVagueOpener("a".repeat(60))).toBe(false);
  });
});

describe("capabilityMenuKind", () => {
  const base = {
    isVague: true,
    unlinkedNeverAsked: false,
    hasActivePaymentLink: false,
    upcomingBookingsCount: 0,
    capabilityMenuAt: null as Date | null,
    now: new Date("2026-07-13T12:00:00Z"),
  };

  it("onboarding for vague opener with no upcoming bookings (new OR returning)", () => {
    expect(capabilityMenuKind(base)).toBe("onboarding");
  });

  it("upcoming when client has future bookings", () => {
    expect(capabilityMenuKind({ ...base, upcomingBookingsCount: 2 })).toBe("upcoming");
  });

  it("none when not vague", () => {
    expect(capabilityMenuKind({ ...base, isVague: false })).toBeNull();
  });

  it("none when account-linking invite is due", () => {
    expect(capabilityMenuKind({ ...base, unlinkedNeverAsked: true })).toBeNull();
  });

  it("none when an unpaid payment link is active", () => {
    expect(capabilityMenuKind({ ...base, hasActivePaymentLink: true })).toBeNull();
  });

  it("none within the once-per-conversation window after a menu was shown", () => {
    const recent = new Date(base.now.getTime() - 2 * 60 * 60 * 1000); // 2h ago
    expect(capabilityMenuKind({ ...base, capabilityMenuAt: recent })).toBeNull();
  });

  it("allows a new menu after the 24h window", () => {
    const old = new Date(base.now.getTime() - CAPABILITY_MENU_WINDOW_MS - 1000);
    expect(capabilityMenuKind({ ...base, capabilityMenuAt: old })).toBe("onboarding");
    expect(
      capabilityMenuKind({ ...base, capabilityMenuAt: old, upcomingBookingsCount: 1 }),
    ).toBe("upcoming");
  });
});

describe("isCapabilityOptionId", () => {
  it("recognizes both menu families", () => {
    expect(isCapabilityOptionId("my_bookings")).toBe(true);
    expect(isCapabilityOptionId("cap_menu")).toBe(true);
    expect(isCapabilityOptionId("habit_yes")).toBe(false);
  });
});
