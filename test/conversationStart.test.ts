import { describe, expect, it } from "vitest";
import { isConversationStart } from "../src/agent/index.js";

const NOW = new Date("2026-07-13T18:00:00Z").getTime();
const GAP = 6; // hours
const hoursAgo = (h: number) => new Date(NOW - h * 3_600_000);

describe("isConversationStart", () => {
  it("is a start when the client has never messaged", () => {
    expect(isConversationStart(null, NOW, GAP)).toBe(true);
  });

  it("is NOT a start during an ongoing exchange (recent activity)", () => {
    expect(isConversationStart(hoursAgo(1), NOW, GAP)).toBe(false);
  });

  it("is a start after a quiet gap of at least gapHours", () => {
    expect(isConversationStart(hoursAgo(7), NOW, GAP)).toBe(true);
  });

  it("treats exactly gapHours of silence as a start (inclusive boundary)", () => {
    expect(isConversationStart(hoursAgo(6), NOW, GAP)).toBe(true);
  });

  it("just under gapHours is still the same conversation", () => {
    expect(isConversationStart(new Date(NOW - (6 * 3_600_000 - 1)), NOW, GAP)).toBe(false);
  });
});
