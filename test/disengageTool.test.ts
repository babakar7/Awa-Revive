import { describe, expect, it } from "vitest";
import { TOOL_DEFINITIONS } from "../src/agent/tools.js";

describe("disengage_conversation tool", () => {
  it("is registered with a required free-text reason", () => {
    const tool = TOOL_DEFINITIONS.find((t) => t.name === "disengage_conversation");
    expect(tool).toBeDefined();
    const schema = tool!.input_schema as {
      properties: Record<string, unknown>;
      required?: string[];
    };
    expect(schema.properties.reason).toBeDefined();
    expect(schema.required).toEqual(["reason"]);
  });
});
