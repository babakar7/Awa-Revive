import { describe, expect, it } from "vitest";
import { systemPrompt } from "../src/agent/systemPrompt.js";
import { TOOL_DEFINITIONS } from "../src/agent/tools.js";

describe("Awa cancellation policy", () => {
  it("offers a same-class move or transfer and never promises a voluntary refund", () => {
    const prompt = systemPrompt();
    const cancellationSection = prompt.match(
      /# Cancellations \(cancel_booking\)([\s\S]*?)# Rescheduling/,
    )?.[1];

    expect(cancellationSection).toBeTruthy();
    expect(cancellationSection).toMatch(/reschedule_booking/);
    expect(cancellationSection).toMatch(/transfer.*another person/i);
    expect(cancellationSection).toMatch(/does NOT refund|non-refundable/i);
    expect(cancellationSection).toMatch(/acknowledge_no_refund:true/);
    expect(cancellationSection).not.toMatch(/refund.*24h|24h.*refund/i);
  });

  it("keeps transfers human-handled without cancelling the existing booking", () => {
    expect(systemPrompt()).toMatch(
      /Transfer a session to another person[\s\S]*handoff_to_human[\s\S]*Never cancel or reschedule the booking/,
    );
  });

  it("requires explicit no-refund acceptance in the cancellation tool contract", () => {
    const tool = TOOL_DEFINITIONS.find((candidate) => candidate.name === "cancel_booking");

    expect(tool?.description).toMatch(/NON-REFUNDABLE/);
    expect(tool?.input_schema).toMatchObject({
      properties: {
        acknowledge_no_refund: { type: "boolean" },
      },
      required: ["booking_id"],
    });
  });
});
