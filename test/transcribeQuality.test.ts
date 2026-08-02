import { afterEach, describe, expect, it, vi } from "vitest";
import { transcribeAudio } from "../src/lib/transcribe.js";
import { TRANSCRIPTION_CONTEXT_PROMPT } from "../src/domain/noIntentGuard.js";

afterEach(() => vi.unstubAllGlobals());

describe("voice transcription quality gate", () => {
  it("rejects a transcription that merely echoes the context prompt", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ text: TRANSCRIPTION_CONTEXT_PROMPT }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );

    await expect(transcribeAudio(Buffer.from("audio"), "audio/ogg")).rejects.toThrow(
      "context prompt echo",
    );
  });
});
