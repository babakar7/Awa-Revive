import { describe, expect, it } from "vitest";
import { invalidSlotOptionIds, CANONICAL_SLOT_ID } from "../src/agent/slotOptions.js";

const REAL = "slot_" + "a".repeat(32);
const REAL2 = "slot_" + "b".repeat(32);

// A resolver that only knows REAL and REAL2 are live in the cache.
const resolve = async (id: string) => (id === REAL || id === REAL2 ? { event_id: "e" } : null);

describe("invalidSlotOptionIds", () => {
  it("accepts a cached, canonical slot id", async () => {
    expect(await invalidSlotOptionIds([REAL], resolve)).toEqual([]);
  });

  it("rejects an invented placeholder id", async () => {
    expect(await invalidSlotOptionIds([REAL, "slot_placeholder2"], resolve)).toEqual([
      "slot_placeholder2",
    ]);
  });

  it("rejects a canonical-shaped id that is not in the cache (expired)", async () => {
    const expired = "slot_" + "c".repeat(32);
    expect(await invalidSlotOptionIds([expired], resolve)).toEqual([expired]);
  });

  it("ignores non-slot ids (menu, payment buttons, capability menu)", async () => {
    expect(
      await invalidSlotOptionIds(["pay_wave", "MATCHA_VANILLE", "cap_book"], resolve),
    ).toEqual([]);
  });

  it("does not touch the cache when a shape is malformed", async () => {
    let calls = 0;
    const counting = async (id: string) => {
      calls++;
      return resolve(id);
    };
    await invalidSlotOptionIds(["slot_bad", REAL], counting);
    expect(calls).toBe(0);
  });

  it("canonical regex matches slotChoiceKey output shape", () => {
    expect(CANONICAL_SLOT_ID.test(REAL)).toBe(true);
    expect(CANONICAL_SLOT_ID.test("slot_ABC")).toBe(false);
  });
});
