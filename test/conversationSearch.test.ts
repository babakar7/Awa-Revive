import { describe, expect, it } from "vitest";
import {
  MAX_CONVERSATION_SEARCH_TERM_LENGTH,
  MAX_CONVERSATION_SEARCH_TERMS,
  highlightedConversationExcerpt,
  normalizeConversationSearch,
} from "../src/admin/conversationSearch.js";

describe("conversation search normalization", () => {
  it("folds case and accents, removes punctuation and deduplicates terms", () => {
    expect(normalizeConversationSearch("  RÉSERVATION, réservation / CAFÉ  ")).toEqual(["reservation", "cafe"]);
  });

  it("treats SQL wildcard and other punctuation characters as text separators", () => {
    expect(normalizeConversationSearch("promo%_ Pilates? [mat]")).toEqual(["promo", "pilates", "mat"]);
    expect(normalizeConversationSearch("%_?!")).toEqual([]);
  });

  it("caps the number and size of terms", () => {
    const terms = normalizeConversationSearch(`${"x".repeat(100)} a b c d e f g h i j k`);
    expect(terms).toHaveLength(MAX_CONVERSATION_SEARCH_TERMS);
    expect(terms[0]).toHaveLength(MAX_CONVERSATION_SEARCH_TERM_LENGTH);
  });
});

describe("conversation search excerpts", () => {
  it("centers the excerpt on the match and highlights case/accent-insensitively", () => {
    const html = highlightedConversationExcerpt(
      `${"début ".repeat(35)}La RÉSERVATION au café est confirmée`,
      ["reservation", "cafe"],
      90,
    );
    expect(html).toContain("…");
    expect(html).toContain("<mark>RÉSERVATION</mark>");
    expect(html).toContain("<mark>café</mark>");
  });

  it("escapes hostile message HTML before adding its own mark elements", () => {
    const html = highlightedConversationExcerpt(`<img src=x onerror="alert(1)"> remboursement`, ["remboursement"]);
    expect(html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
    expect(html).toContain("<mark>remboursement</mark>");
    expect(html).not.toContain("<img");
  });
});
