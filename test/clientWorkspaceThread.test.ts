import { describe, expect, it } from "vitest";
import { renderThread, threadSignature } from "../src/admin/clientWorkspacePage.js";
import type { AdminTurn } from "../src/admin/queries.js";

const turn = (over: Partial<AdminTurn> = {}): AdminTurn => ({
  role: "user",
  content: "Bonjour",
  created_at: new Date("2026-07-20T10:00:00Z"),
  source: "awa",
  delivery_status: "sent",
  ...over,
});

describe("threadSignature", () => {
  it("is stable for the same turns", () => {
    const turns = [turn(), turn({ role: "assistant", created_at: new Date("2026-07-20T10:01:00Z") })];
    expect(threadSignature(turns)).toBe(threadSignature(turns.map((t) => ({ ...t }))));
  });

  it("changes when a turn is added", () => {
    const turns = [turn()];
    const more = [...turns, turn({ created_at: new Date("2026-07-20T10:05:00Z") })];
    expect(threadSignature(more)).not.toBe(threadSignature(turns));
  });

  it("changes when a delivery status flips", () => {
    const pending = [turn({ source: "admin", delivery_status: "pending" })];
    const sent = [turn({ source: "admin", delivery_status: "sent" })];
    expect(threadSignature(pending)).not.toBe(threadSignature(sent));
  });
});

describe("renderThread", () => {
  it("renders bubbles for user and assistant turns", () => {
    const html = renderThread(
      [turn(), turn({ role: "assistant", content: "Bienvenue chez Revive", created_at: new Date("2026-07-20T10:01:00Z") })],
      "client-1",
      false,
    );
    expect(html).toContain('class="turnrow user"');
    expect(html).toContain('class="turnrow assistant"');
    expect(html).toContain("Bienvenue chez Revive");
  });

  it("renders the empty state when there are no turns", () => {
    expect(renderThread([], "client-1", false)).toContain("aucun message");
  });
});
