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

  it("keeps transfers self-service under the original booking name", () => {
    const transferSection = systemPrompt().match(
      /# Transfer a session to another person([\s\S]*?)# Linking accounts/,
    )?.[1];

    expect(transferSection).toBeTruthy();
    expect(transferSection).toMatch(/including less than 16h/i);
    expect(transferSection).toMatch(/do NOT call handoff_to_human/);
    expect(transferSection).toMatch(/do NOT involve reception/);
    expect(transferSection).toMatch(/do NOT change anything in Wix/);
    expect(transferSection).toMatch(/ORIGINAL BOOKING NAME/);
    expect(transferSection).toMatch(/Never cancel or reschedule/);

    const handoffTool = TOOL_DEFINITIONS.find(
      (candidate) => candidate.name === "handoff_to_human",
    );
    expect(handoffTool?.description).not.toMatch(/session transfers/);
  });

  it("routes an exceptional <16h cancellation to the gérant, not reception", () => {
    const cancellationSection = systemPrompt().match(
      /# Cancellations \(cancel_booking\)([\s\S]*?)# Rescheduling/,
    )?.[1];
    expect(cancellationSection).toMatch(/exceptional_cancellation:true/);
    expect(cancellationSection).toMatch(/g[ée]rant/i);

    const handoffTool = TOOL_DEFINITIONS.find((c) => c.name === "handoff_to_human");
    expect(handoffTool?.input_schema).toMatchObject({
      properties: { exceptional_cancellation: { type: "boolean" } },
    });
    expect(handoffTool?.description).toMatch(/exceptional cancellation/i);
  });

  it("keeps <16h reschedules on the reception handoff, not the gérant", () => {
    const reschedule = systemPrompt().match(
      /# Rescheduling([\s\S]*?)# Transfer a session/,
    )?.[1];
    expect(reschedule).toBeTruthy();
    expect(reschedule).not.toMatch(/g[ée]rant/i);
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
