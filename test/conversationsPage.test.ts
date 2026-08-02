import { describe, expect, it } from "vitest";
import { renderConversationResults, renderConversationsPage } from "../src/admin/conversationsPage.js";
import type { AdminClientRow, PageResult } from "../src/admin/queries.js";

const row: AdminClientRow = {
  id: "client-1",
  wa_phone: "221771234567",
  name: "Aminata",
  language: "fr",
  claimed_email: null,
  last_message_at: new Date("2026-07-31T10:00:00Z"),
  last_message: "Bonjour",
  message_count: 2,
  is_test: false,
  human_takeover_until: null,
  human_takeover_by: null,
  awa_disengaged_until: null,
  awa_disengaged_kind: null,
  matched_message: "Remboursement confirmé",
  matched_at: new Date("2026-07-31T10:00:00Z"),
  matched_source: "team",
};

const result: PageResult<AdminClientRow> = {
  rows: [row],
  page: 1,
  pageSize: 30,
  total: 1,
  pages: 1,
};

describe("conversation list renderer", () => {
  it("composes the full SSR page from the exact live-results renderer", () => {
    const filters = { search: "remboursement", period: "7" as const, page: 1 };
    const fragment = renderConversationResults(result, filters);
    const page = renderConversationsPage(result, filters);
    expect(page).toContain(fragment);
    expect(page).toContain('class="act conversation-submit"');
    expect(page).toContain("form.classList.add('is-live')");
    expect(page).toContain("350");
    const script = page.match(/<script>([\s\S]+)<\/script>/)?.[1];
    expect(script).toBeTruthy();
    expect(() => new Function(script)).not.toThrow();
  });

  it("escapes the query in fragment attributes and summaries", () => {
    const fragment = renderConversationResults(result, {
      search: '"><img src=x onerror="bad">',
      period: "all",
      page: 1,
    });
    expect(fragment).toContain('data-query="&quot;&gt;&lt;img src=x onerror=&quot;bad&quot;&gt;"');
    expect(fragment).not.toContain("<img src=x");
  });
});
