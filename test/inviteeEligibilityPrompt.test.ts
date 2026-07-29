import { describe, expect, it } from "vitest";
import { systemPrompt } from "../src/agent/systemPrompt.js";

describe("L'Invitée eligibility contract", () => {
  it("scopes the qualification question to Revive, not to Pilates in general", () => {
    const prompt = systemPrompt();

    expect(prompt).toMatch(/As-tu déjà pratiqué le Pilates Reformer chez Revive/);
    expect(prompt).toMatch(/the question is ALWAYS about Revive, never about Pilates in general/i);
  });

  it("states that Pilates practised elsewhere never disqualifies", () => {
    const prompt = systemPrompt();

    expect(prompt).toMatch(/L'INVITÉE ELIGIBILITY/);
    expect(prompt).toMatch(/NEVER disqualifies and is NEVER a reason to refuse L'Invitée/i);
    expect(prompt).toMatch(/it does NOT mean zero Pilates experience/i);
  });

  it("limits refusal to an explicit Revive statement or the server verdict", () => {
    const prompt = systemPrompt();

    expect(prompt).toMatch(/explicitly says she already did Pilates\/Reformer at Revive/i);
    expect(prompt).toMatch(/create_plan_payment_link returns invitee_not_eligible/);
    expect(prompt).toMatch(/ambiguous “j'ai déjà fait du Pilates” is NOT a refusal/i);
  });

  it("does not downgrade an experienced client to Foundation or to a bigger Key", () => {
    const prompt = systemPrompt();

    expect(prompt).toMatch(/may take L'Invitée AND book a Sculpt class directly/i);
    expect(prompt).toMatch(/never as a replacement/i);
  });

  it("keeps the business info source of truth aligned with the Revive-only rule", () => {
    const prompt = systemPrompt();

    expect(prompt).toMatch(/Éligibilité L'Invitée/);
    expect(prompt).toMatch(/ne\s+disqualifie \*\*JAMAIS\*\*/);
    expect(prompt).toMatch(/invitee_not_eligible/);
  });
});
