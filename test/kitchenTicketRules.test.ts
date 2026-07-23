import { describe, expect, it } from "vitest";
import {
  canCuisineAdvance,
  fallbackIsDue,
  isOpenStatus,
  parseInternalNotifyMode,
  ticketItemsSummary,
  type KitchenTicketStatus,
} from "../src/domain/kitchenTicketRules.js";
import type { ExtraLine } from "../src/lib/cafeMenu.js";

describe("canCuisineAdvance", () => {
  it("allows NEW → PREPARING and NEW → READY (quick items)", () => {
    expect(canCuisineAdvance("NEW", "PREPARING")).toBe(true);
    expect(canCuisineAdvance("NEW", "READY")).toBe(true);
  });

  it("allows PREPARING → READY", () => {
    expect(canCuisineAdvance("PREPARING", "READY")).toBe(true);
  });

  it("never lets the kitchen reach COMPLETED or CANCELLED (source-driven only)", () => {
    for (const from of ["NEW", "PREPARING", "READY"] as KitchenTicketStatus[]) {
      expect(canCuisineAdvance(from, "COMPLETED")).toBe(false);
      expect(canCuisineAdvance(from, "CANCELLED")).toBe(false);
    }
  });

  it("refuses moves out of terminal states and backward moves", () => {
    expect(canCuisineAdvance("READY", "PREPARING")).toBe(false);
    expect(canCuisineAdvance("PREPARING", "NEW")).toBe(false);
    expect(canCuisineAdvance("COMPLETED", "READY")).toBe(false);
    expect(canCuisineAdvance("CANCELLED", "READY")).toBe(false);
  });
});

describe("isOpenStatus", () => {
  it("open for NEW/PREPARING/READY, closed for COMPLETED/CANCELLED", () => {
    expect(isOpenStatus("NEW")).toBe(true);
    expect(isOpenStatus("PREPARING")).toBe(true);
    expect(isOpenStatus("READY")).toBe(true);
    expect(isOpenStatus("COMPLETED")).toBe(false);
    expect(isOpenStatus("CANCELLED")).toBe(false);
  });
});

describe("parseInternalNotifyMode", () => {
  it("only the exact `fallback` keyword switches off parallel", () => {
    expect(parseInternalNotifyMode("fallback")).toBe("fallback");
    expect(parseInternalNotifyMode("  FALLBACK  ")).toBe("fallback");
  });
  it("defaults to the safe pilot mode (parallel) for anything else", () => {
    expect(parseInternalNotifyMode("parallel")).toBe("parallel");
    expect(parseInternalNotifyMode("")).toBe("parallel");
    expect(parseInternalNotifyMode(undefined)).toBe("parallel");
    expect(parseInternalNotifyMode("nonsense")).toBe("parallel");
  });
});

describe("fallbackIsDue", () => {
  const base = { ipad_ack_at: null, fallback_claimed_at: null, fallback_due_at: null };
  const now = new Date("2026-07-23T10:00:15Z");

  it("is due when unacked, unclaimed, and past the deadline", () => {
    expect(
      fallbackIsDue({ ...base, fallback_due_at: new Date("2026-07-23T10:00:00Z") }, now),
    ).toBe(true);
  });

  it("is not due before the deadline", () => {
    expect(
      fallbackIsDue({ ...base, fallback_due_at: new Date("2026-07-23T10:00:30Z") }, now),
    ).toBe(false);
  });

  it("an iPad ack cancels the fallback", () => {
    expect(
      fallbackIsDue(
        { ...base, fallback_due_at: new Date("2026-07-23T10:00:00Z"), ipad_ack_at: new Date() },
        now,
      ),
    ).toBe(false);
  });

  it("an existing claim prevents a second fallback", () => {
    expect(
      fallbackIsDue(
        { ...base, fallback_due_at: new Date("2026-07-23T10:00:00Z"), fallback_claimed_at: new Date() },
        now,
      ),
    ).toBe(false);
  });

  it("no deadline (fallback disabled for this ticket) is never due", () => {
    expect(fallbackIsDue(base, now)).toBe(false);
  });
});

describe("ticketItemsSummary", () => {
  it("renders a one-line summary reused by the card and the fallback text", () => {
    const items: ExtraLine[] = [
      { id: "A", name: "Jant Bi", qty: 2, unitPriceXof: 3000, lineTotalXof: 6000 },
      { id: "B", name: "Iced Matcha", qty: 1, unitPriceXof: 3500, lineTotalXof: 3500, choice: "Lait d'avoine" },
    ];
    expect(ticketItemsSummary({ items })).toBe("2× Jant Bi + 1× Iced Matcha (Lait d'avoine)");
  });
});
