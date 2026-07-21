import { describe, expect, it } from "vitest";
import {
  classColorMap,
  renderStoryImage,
  statusLabel,
  type StoryClass,
  type StoryData,
} from "../src/lib/storyImage.js";

/** PNG width/height live at bytes 16-19 / 20-23 of the IHDR chunk. */
const pngWidth = (b: Buffer) => b.readUInt32BE(16);
const pngHeight = (b: Buffer) => b.readUInt32BE(20);

const cls = (name: string, coach: string | null, slots: Array<[string, number, number]>): StoryClass => ({
  name,
  coach,
  slots: slots.map(([time, openSpots, totalSpots]) => ({ time, openSpots, totalSpots })),
});

const base: StoryData = {
  dayLabel: "MARDI",
  dateLabel: "21 juillet",
  classes: [
    cls("Reformer", "Yass", [
      ["08H15", 0, 6],
      ["09H15", 1, 6],
      ["10H15", 4, 6],
      ["11H15", 6, 6],
    ]),
    cls("Aquabike", "Yves", [["10H15", 2, 8]]),
  ],
};

describe("statusLabel", () => {
  it("maps spot counts to the studio vocabulary", () => {
    expect(statusLabel(0)).toBe("FULL");
    expect(statusLabel(-1)).toBe("FULL");
    expect(statusLabel(1)).toBe("1 PLACE");
    expect(statusLabel(3)).toBe("3 PLACES");
    expect(statusLabel(4)).toBe("4 PLACES");
    expect(statusLabel(5)).toBe("DISPO");
    expect(statusLabel(20)).toBe("DISPO");
  });
});

describe("classColorMap", () => {
  it("assigns one stable color per class name", () => {
    const map = classColorMap(base.classes);
    expect(map.get("Reformer")).toBeTruthy();
    expect(map.get("Aquabike")).toBeTruthy();
    expect(map.get("Reformer")).not.toBe(map.get("Aquabike"));
    // same name repeated keeps the same color
    const dup = classColorMap([...base.classes, cls("Reformer", "Yass", [["19H15", 0, 6]])]);
    expect(dup.get("Reformer")).toBe(map.get("Reformer"));
  });

  it("always gives aquatic classes the blue, never the rotation", () => {
    const map = classColorMap([
      cls("Reformer", "Yass", [["08H15", 2, 6]]),
      cls("Bébé Nageur", "Thierno", [["10H00", 2, 10]]),
      cls("Natation Enfant", "Thierno", [["11H00", 2, 10]]),
      cls("Yoga", "Awa", [["12H00", 2, 10]]),
    ]);
    expect(map.get("Bébé Nageur")).toBe("#5157a8");
    expect(map.get("Natation Enfant")).toBe("#5157a8");
    expect(map.get("Reformer")).not.toBe("#5157a8");
    expect(map.get("Yoga")).not.toBe("#5157a8");
  });
});

describe("renderStoryImage", () => {
  it("renders a 1080×1920 PNG with the right signature", () => {
    const buf = renderStoryImage(base);
    expect(buf.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    expect(pngWidth(buf)).toBe(1080);
    expect(pngHeight(buf)).toBe(1920);
    expect(buf.length).toBeGreaterThan(1000);
  });

  it("throws when there are no classes", () => {
    expect(() => renderStoryImage({ ...base, classes: [] })).toThrow(/empty/i);
  });

  it("keeps a fixed canvas with a busy day (8 slots) and null coach", () => {
    const busy: StoryData = {
      ...base,
      classes: [
        cls(
          "Reformer",
          null,
          Array.from({ length: 8 }, (_, i) => [`${String(8 + i).padStart(2, "0")}H15`, i % 3, 6] as [string, number, number]),
        ),
        cls("BÉBÉS NAGEURS & NATATION ENFANTS", "Thierno", [["16H15", 4, 10]]),
      ],
    };
    const buf = renderStoryImage(busy);
    expect(pngWidth(buf)).toBe(1080);
    expect(pngHeight(buf)).toBe(1920);
  });
});
