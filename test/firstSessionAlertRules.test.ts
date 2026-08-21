import { describe, expect, it } from "vitest";
import {
  assembleFirstSessionRecipients,
  buildFirstSessionMessage,
  firstSessionDedupKey,
  isFirstSessionAlertDue,
  FIRST_SESSION_LEAD_MINUTES,
} from "../src/domain/firstSessionAlertRules.js";

const START = "2026-08-24T10:15:00.000Z"; // Dakar == UTC: a 10h15 class
const startMs = new Date(START).getTime();
const digits = (phone: string) => phone.replace(/\D/g, "");

describe("isFirstSessionAlertDue", () => {
  it("is due exactly at start − lead", () => {
    expect(
      isFirstSessionAlertDue(START, new Date(startMs - FIRST_SESSION_LEAD_MINUTES * 60_000)),
    ).toBe(true);
  });

  it("is not due before the lead window", () => {
    expect(
      isFirstSessionAlertDue(START, new Date(startMs - FIRST_SESSION_LEAD_MINUTES * 60_000 - 1)),
    ).toBe(false);
  });

  it("stays due through the window, up to the class start (excluded)", () => {
    expect(isFirstSessionAlertDue(START, new Date(startMs - 60_000))).toBe(true);
    expect(isFirstSessionAlertDue(START, new Date(startMs))).toBe(false);
    expect(isFirstSessionAlertDue(START, new Date(startMs + 60_000))).toBe(false);
  });

  it("rejects an unparseable start date", () => {
    expect(isFirstSessionAlertDue("garbage", new Date(startMs))).toBe(false);
  });
});

describe("firstSessionDedupKey", () => {
  it("is one key per (occurrence, recipient)", () => {
    expect(firstSessionDedupKey("evt1", "221771234567")).toBe("INVITEE_FIRST:evt1:221771234567");
    expect(firstSessionDedupKey("evt1", "221771234567")).not.toBe(
      firstSessionDedupKey("evt2", "221771234567"),
    );
    expect(firstSessionDedupKey("evt1", "221771234567")).not.toBe(
      firstSessionDedupKey("evt1", "221779999999"),
    );
  });
});

describe("buildFirstSessionMessage", () => {
  const slot = { serviceName: "Reformer", startDate: START, coach: "Yass" };

  it("names the class, the time, the coach and every client", () => {
    const { subject, body } = buildFirstSessionMessage(slot, [
      { clientName: "Fatou Diop", waPhone: "+221771234567", isTest: false },
      { clientName: "Awa Ndiaye", waPhone: "+221779999999", isTest: false },
    ]);
    expect(subject).toContain("🍵");
    expect(subject).toContain("Reformer");
    expect(subject).toContain("10:15");
    expect(body).toContain("Fatou Diop");
    expect(body).toContain("+221771234567");
    expect(body).toContain("Awa Ndiaye");
    expect(body).toContain("Coach : Yass");
    expect(body).toContain("1re séance L'Invitée");
    expect(body).toContain("matcha");
  });

  it("marks test clients and survives a missing name or coach", () => {
    const { body } = buildFirstSessionMessage(
      { serviceName: "Reformer", startDate: START, coach: undefined },
      [{ clientName: null, waPhone: "+221770000000", isTest: true }],
    );
    expect(body).toContain("[TEST]");
    expect(body).toContain("Cliente sans nom enregistré");
    expect(body).toContain("+221770000000");
    expect(body).not.toContain("Coach :");
  });
});

describe("assembleFirstSessionRecipients", () => {
  const owner = "+221774982711";
  const reception = "+221784644329";

  it("targets the owner plus every accueil on shift", () => {
    const out = assembleFirstSessionRecipients({
      onShiftAccueil: [
        { name: "Syndel", phone: "+221781111111" },
        { name: "Mame", phone: "+221782222222" },
      ],
      ownerPhone: owner,
      receptionPhone: reception,
      phoneDigits: digits,
    });
    expect(out.map((r) => r.phone)).toEqual([owner, "+221781111111", "+221782222222"]);
  });

  it("dedups by phone digits (owner doubling as accueil, twin contacts)", () => {
    const out = assembleFirstSessionRecipients({
      onShiftAccueil: [
        { name: "Babakar", phone: "+221 77 498 27 11" },
        { name: "Syndel", phone: "+221781111111" },
        { name: "Syndel bis", phone: "+221781111111" },
      ],
      ownerPhone: owner,
      receptionPhone: reception,
      phoneDigits: digits,
    });
    expect(out.map((r) => r.phone)).toEqual([owner, "+221781111111"]);
  });

  it("falls back to the reception number when nobody is on shift", () => {
    const out = assembleFirstSessionRecipients({
      onShiftAccueil: [],
      ownerPhone: owner,
      receptionPhone: reception,
      phoneDigits: digits,
    });
    expect(out.map((r) => r.phone)).toEqual([owner, reception]);
  });

  it("drops an invalid accueil phone and falls back to reception", () => {
    const out = assembleFirstSessionRecipients({
      onShiftAccueil: [{ name: "sans-numéro", phone: "" }],
      ownerPhone: owner,
      receptionPhone: reception,
      phoneDigits: digits,
    });
    expect(out.map((r) => r.phone)).toEqual([owner, reception]);
  });
});
