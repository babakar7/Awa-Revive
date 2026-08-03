import { describe, expect, it } from "vitest";
import { systemPrompt } from "../src/agent/systemPrompt.js";

describe("custom plan marketing guidance", () => {
  it("presents mixed-class plans through included value without a negative bonus disclaimer", () => {
    const prompt = systemPrompt();

    expect(prompt).toMatch(/CUSTOM \/ MIXED-CLASS PLANS/);
    expect(prompt).toMatch(/present the offer through what the client GETS/i);
    expect(prompt).toMatch(/NEVER write “pas de cours en plus”/);
    expect(prompt).toMatch(/classes are directly included in their sessions/i);
    expect(prompt).toMatch(/Market Mat and Step positively as directly included in the 12 covered sessions/i);
    expect(prompt).not.toMatch(/sur-mesure plan has NO bonus/i);
    expect(prompt).not.toMatch(/grants no “cours en plus”/i);
  });
});
