import { describe, expect, it } from "vitest";
import { systemPrompt } from "../src/agent/systemPrompt.js";
import { TOOL_DEFINITIONS } from "../src/agent/tools.js";

describe("plan-member prompt contract", () => {
  it("enforces name, then email verification, then payment method", () => {
    const prompt = systemPrompt();
    expect(prompt).toMatch(
      /get their first name.*email verification.*only then ask the payment method/is,
    );
    expect(prompt).toMatch(/Never ask the payment method before a required email verification/i);
  });

  it("passes the known name on the first verification call without double confirmation", () => {
    const prompt = systemPrompt();
    const requestTool = TOOL_DEFINITIONS.find((tool) => tool.name === "request_email_verification");
    expect(prompt).toMatch(/client_name on that FIRST call/i);
    expect(prompt).toMatch(/Do not ask for an extra confirmation/i);
    expect(requestTool?.description).toMatch(/already-known client_name on the first call/i);
  });

  it("announces the optional Wix email and documents the manual fallback", () => {
    const prompt = systemPrompt();
    expect(prompt).toMatch(/optional welcome\/set-password email/i);
    expect(prompt).toMatch(/no password is required/i);
    expect(prompt).toMatch(/refuses verification or cannot access the inbox/i);
    expect(prompt).toMatch(/manual after payment/i);
  });

  it("allows email collection specifically during a plan purchase", () => {
    expect(systemPrompt()).toMatch(/OR during an agreed plan purchase/i);
    const requestTool = TOOL_DEFINITIONS.find((tool) => tool.name === "request_email_verification");
    expect(requestTool?.description).toMatch(/explicitly allowed during a plan purchase/i);
  });
});
