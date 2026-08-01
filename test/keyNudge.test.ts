import { describe, expect, it } from "vitest";
import {
  inviteeConversionDedupKey,
  isCalendarDaysBefore,
  thirdSessionDueWithin24h,
} from "../src/domain/keyNudge.js";

describe("Key lifecycle reminder rules", () => {
  it("uses one durable claim for both L'Invitée conversion moments", () => {
    expect(inviteeConversionDedupKey("key-123")).toBe(
      "INVITEE_CONVERSION:key-123",
    );
  });

  it("matches J-5 by Dakar calendar date", () => {
    const now = new Date("2026-07-26T23:58:00Z");
    expect(isCalendarDaysBefore(new Date("2026-07-31T08:00:00Z"), now, 5)).toBe(true);
    expect(isCalendarDaysBefore(new Date("2026-08-01T08:00:00Z"), now, 5)).toBe(false);
  });

  it("matches J+10 from the same Key start date without a reminder column", () => {
    const now = new Date("2026-08-01T23:58:00Z");
    expect(isCalendarDaysBefore(new Date("2026-07-22T08:00:00Z"), now, -10)).toBe(true);
    expect(isCalendarDaysBefore(new Date("2026-07-21T08:00:00Z"), now, -10)).toBe(false);
    expect(isCalendarDaysBefore(new Date("2026-07-23T08:00:00Z"), now, -10)).toBe(false);
  });

  it("targets the third session only in the next 24 hours", () => {
    const now = new Date("2026-07-26T10:00:00Z");
    expect(
      thirdSessionDueWithin24h(
        [
          { slot_start: new Date("2026-07-20T10:00:00Z") },
          { slot_start: new Date("2026-07-23T10:00:00Z") },
          { slot_start: new Date("2026-07-27T09:59:00Z") },
        ],
        now,
      )?.toISOString(),
    ).toBe("2026-07-27T09:59:00.000Z");
    expect(
      thirdSessionDueWithin24h(
        [
          { slot_start: new Date("2026-07-20T10:00:00Z") },
          { slot_start: new Date("2026-07-23T10:00:00Z") },
          { slot_start: new Date("2026-07-27T10:01:00Z") },
        ],
        now,
      ),
    ).toBeNull();
    expect(thirdSessionDueWithin24h([], now)).toBeNull();
  });
});
