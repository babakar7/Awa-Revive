import { describe, expect, it } from "vitest";
import {
  isCalendarDaysBefore,
  thirdSessionDueWithin24h,
} from "../src/domain/keyNudge.js";

describe("Key lifecycle reminder rules", () => {
  it("matches J-5 by Dakar calendar date", () => {
    const now = new Date("2026-07-26T23:58:00Z");
    expect(isCalendarDaysBefore(new Date("2026-07-31T08:00:00Z"), now, 5)).toBe(true);
    expect(isCalendarDaysBefore(new Date("2026-08-01T08:00:00Z"), now, 5)).toBe(false);
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
