import { describe, expect, it } from "vitest";
import { shouldRetryToolSyntaxWithTools } from "../src/agent/index.js";
import { containsToolSyntax, lintOutboundReply } from "../src/agent/outboundLint.js";

// Prod regression, 18/08 (Mariama Baldé): after paying her plan, her "Oui stp"
// to book the 11:15 Foundation produced a draft containing ⟦trace⟧ instead of
// a real book_with_membership call. The outbound lint blocked it, but its
// corrective retry runs WITHOUT tools, so the booking could never happen — the
// paid client got the technical fallback. While the turn is side-effect free,
// the loop must instead retry once WITH tools so the action actually runs.

const TRACE_DRAFT =
  "⟦trace⟧ book_with_membership({\"service_id\":\"5dd2\",\"event_id\":\"slot_x\"}) -> booked";

describe("containsToolSyntax", () => {
  it("detects the internal trace marker and prose tool calls", () => {
    expect(containsToolSyntax(TRACE_DRAFT)).toBe(true);
    expect(containsToolSyntax("Je lance book_with_membership(...) tout de suite")).toBe(true);
    expect(containsToolSyntax("[outil] check_availability -> ...")).toBe(true);
  });

  it("passes normal client messages, parentheses included", () => {
    expect(containsToolSyntax("Ta séance Foundation (12 000 F) est confirmée ✅")).toBe(false);
    expect(containsToolSyntax("Mercredi 19 août à 11h15 avec Yass — je réserve ?")).toBe(false);
  });
});

describe("tool-syntax retry with tools", () => {
  it("re-enters the tool loop for Mariama's stranded booking turn", () => {
    expect(
      shouldRetryToolSyntaxWithTools({
        replyText: TRACE_DRAFT,
        interactiveSent: false,
        toolExecuted: false,
        alreadyRetried: false,
      }),
    ).toBe(true);
  });

  it("never re-enables tools after an action or more than once", () => {
    expect(
      shouldRetryToolSyntaxWithTools({
        replyText: TRACE_DRAFT,
        interactiveSent: false,
        toolExecuted: true,
        alreadyRetried: false,
      }),
    ).toBe(false);
    expect(
      shouldRetryToolSyntaxWithTools({
        replyText: TRACE_DRAFT,
        interactiveSent: true,
        toolExecuted: false,
        alreadyRetried: false,
      }),
    ).toBe(false);
    expect(
      shouldRetryToolSyntaxWithTools({
        replyText: TRACE_DRAFT,
        interactiveSent: false,
        toolExecuted: false,
        alreadyRetried: true,
      }),
    ).toBe(false);
  });

  it("does not trigger on clean or empty replies", () => {
    expect(
      shouldRetryToolSyntaxWithTools({
        replyText: "C'est confirmé pour mercredi 11h15 ✅",
        interactiveSent: false,
        toolExecuted: false,
        alreadyRetried: false,
      }),
    ).toBe(false);
    expect(
      shouldRetryToolSyntaxWithTools({
        replyText: null,
        interactiveSent: false,
        toolExecuted: false,
        alreadyRetried: false,
      }),
    ).toBe(false);
  });

  it("keeps the outbound lint as the unchanged last gate", () => {
    const lint = lintOutboundReply(TRACE_DRAFT, []);
    expect(lint.ok).toBe(false);
    expect(lint.reason).toBe("tool_syntax");
  });
});
