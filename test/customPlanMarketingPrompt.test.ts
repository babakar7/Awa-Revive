import { describe, expect, it } from "vitest";
import { systemPrompt } from "../src/agent/systemPrompt.js";

describe("custom plan marketing guidance", () => {
  it("presents mixed-class plans through included value without a negative bonus disclaimer", () => {
    const prompt = systemPrompt();

    expect(prompt).toMatch(/CUSTOM \/ MIXED-CLASS PLANS/);
    expect(prompt).toMatch(/present the offer through what the client GETS/i);
    expect(prompt).toMatch(/NEVER write “pas de cours en plus”/);
    expect(prompt).toMatch(/classes are directly included in their sessions/i);
    expect(prompt).toMatch(
      /Market the non-Reformer classes positively as directly included in the covered sessions/i,
    );
    // All bespoke plans are named, never proposed spontaneously.
    expect(prompt).toMatch(/1x Reformer 1x Mat 1x Step/);
    expect(prompt).toMatch(/2x Reformer 1x Yoga 1x Step/);
    expect(prompt).toMatch(/2x Reformer 1x Step/);
    expect(prompt).not.toMatch(/sur-mesure plan has NO bonus/i);
    expect(prompt).not.toMatch(/grants no “cours en plus”/i);
  });

  it("does not turn a future class into a reschedule without an identified source booking", () => {
    const prompt = systemPrompt();
    expect(prompt).toMatch(/future slot.*NEW booking/i);
    expect(prompt).toMatch(/explicitly identified a confirmed, upcoming source booking/i);
  });

  it("keeps unmarked attendance distinct from an absence", () => {
    const prompt = systemPrompt();
    expect(prompt).toMatch(/get_session_history/);
    expect(prompt).toMatch(/unmarked.*NEVER call it an absence\/no-show/i);
  });
});
