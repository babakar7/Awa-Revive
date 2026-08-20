import { afterEach, describe, expect, it, vi } from "vitest";
import { systemPrompt } from "../src/agent/systemPrompt.js";
import { TOOL_DEFINITIONS } from "../src/agent/tools.js";

describe("membership balance semantics", () => {
  afterEach(() => vi.restoreAllMocks());

  it("requires future membership bookings to be checked before resolving a dispute", () => {
    const prompt = systemPrompt();
    expect(prompt).toMatch(/future membership bookings already reserved/i);
    expect(prompt).toMatch(/Never call a future booking a séance .*effectuée/i);
    expect(prompt).toMatch(/cancelled, refunded and directly paid bookings/i);
  });

  it("documents available-after-confirmed-bookings in check_membership", () => {
    const tool = TOOL_DEFINITIONS.find((entry) => entry.name === "check_membership");
    expect(tool?.description).toMatch(/available for a NEW booking after confirmed future membership bookings/i);
  });
});
