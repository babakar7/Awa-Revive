import { describe, expect, it } from "vitest";
import { systemPrompt } from "../src/agent/systemPrompt.js";

describe("Reformer first-session level defaults to Foundation", () => {
  const prompt = systemPrompt();

  it("assumes a new client and proposes Foundation by default (no bare level menu)", () => {
    expect(prompt).toMatch(/FIRST-SESSION LEVEL DEFAULT/);
    expect(prompt).toMatch(/assume the client is new to Pilates and propose Foundation/i);
    expect(prompt).toMatch(/do NOT present a bare Foundation\/Sculpt\/Intense menu/i);
  });

  it("switches to Sculpt only when the client signals prior experience", () => {
    expect(prompt).toMatch(/Switch to Sculpt as soon as she signals she has already practised/i);
  });

  it("does not surface Intense at a first session", () => {
    expect(prompt).toMatch(/Never surface Intense yourself/i);
  });

  it("carves the first Reformer session out of the generic 'ask which variant' rule", () => {
    expect(prompt).toMatch(/EXCEPTION — a first Reformer session: do NOT present the Foundation\/Sculpt\/Intense menu/i);
  });

  it("keeps the eligibility question and the never-force-Foundation protection intact", () => {
    // Eligibility question is unchanged and stays about Revive, not the level.
    expect(prompt).toMatch(/As-tu déjà pratiqué le Pilates Reformer chez Revive/);
    // An experienced client is still never forced to Foundation and Sculpt never
    // affects L'Invitée eligibility.
    expect(prompt).toMatch(/never route her to Foundation because of it/);
  });
});
