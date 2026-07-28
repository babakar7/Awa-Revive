import { describe, expect, it } from "vitest";
import {
  circuitBreakerReply,
  toolErrorCode,
  toolResourceKey,
} from "../src/agent/toolCircuitBreaker.js";

describe("tool circuit breaker", () => {
  it("counts only technical/invariant errors", () => {
    expect(toolErrorCode('{"error":"unknown_slot"}')).toBe("unknown_slot");
    expect(toolErrorCode('{"error":"not_enough_spots"}')).toBeNull();
    expect(toolErrorCode("not json")).toBeNull();
  });

  it("builds a stable resource key without free text", () => {
    expect(toolResourceKey({ service_id: "alias", event_id: "ev_1", name: "Fatou" }))
      .toBe('{"event_id":"ev_1"}');
  });

  it("uses the latched French register in the deterministic reply", () => {
    expect(circuitBreakerReply(true)).toContain("votre demande");
    expect(circuitBreakerReply(false)).toContain("ta demande");
  });
});
