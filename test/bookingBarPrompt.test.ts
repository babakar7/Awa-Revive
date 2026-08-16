import { describe, expect, it } from "vitest";
import { systemPrompt } from "../src/agent/systemPrompt.js";

describe("booking and bar guidance", () => {
  it("never suggests a bar order during booking but still serves an explicitly requested menu", () => {
    const prompt = systemPrompt();

    expect(prompt).toMatch(/booking flow NEVER triggers a bar\/menu\/order suggestion/i);
    expect(prompt).toMatch(/There is no automatic post-booking menu offer/i);
    expect(prompt).toMatch(/Any ask to see "le menu \/ le catalogue \/ la carte/i);
    expect(prompt).toMatch(/client can also ask for the menu on their own at any point/i);
    expect(prompt).not.toMatch(/menu is offered automatically AFTER the booking/i);
    expect(prompt).not.toMatch(/automatically shows the incontournables list/i);
  });
});
