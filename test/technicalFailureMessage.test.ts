import { describe, expect, it } from "vitest";
import { technicalClientMessage } from "../src/domain/technicalFailure.js";

describe("terminal technical client copy", () => {
  it.each([
    ["fr", false],
    ["fr", true],
    ["en", false],
    ["wo", false],
  ])("is actionless and link-free in %s", (language, formal) => {
    const message = technicalClientMessage(language, formal);
    expect(message).not.toMatch(/https?:\/\/|wa\.me|\+221|réessa|retry|call|appelle|écris|write/i);
    expect(message).toMatch(/ici|here|fii/i);
  });
});
