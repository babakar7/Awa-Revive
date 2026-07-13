import { describe, expect, it } from "vitest";
import { extractText } from "../src/agent/index.js";

// Minimal shims — only the fields extractText reads.
const msg = (content: any[]): any => ({ content });

describe("extractText", () => {
  it("joins multiple text blocks and trims", () => {
    expect(extractText(msg([{ type: "text", text: " line 1 " }, { type: "text", text: "line 2 " }]))).toBe(
      "line 1 \nline 2",
    );
  });

  it("ignores non-text blocks (tool_use)", () => {
    expect(
      extractText(
        msg([
          { type: "text", text: "voici" },
          { type: "tool_use", id: "t1", name: "x", input: {} },
        ]),
      ),
    ).toBe("voici");
  });

  it("returns empty string when there is no text block (e.g. pure tool_use)", () => {
    expect(extractText(msg([{ type: "tool_use", id: "t1", name: "x", input: {} }]))).toBe("");
  });
});
