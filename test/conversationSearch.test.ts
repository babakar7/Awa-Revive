import { describe, expect, it } from "vitest";
import {
  MAX_CONVERSATION_SEARCH_TERM_LENGTH,
  MAX_CONVERSATION_SEARCH_TERMS,
  highlightedConversationExcerpt,
  isConversationLiveSearchReady,
  normalizeConversationSearch,
  plainConversationExcerpt,
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

  it("starts live name searches at two useful characters and digit-only searches at four", () => {
    expect(isConversationLiveSearchReady("é")).toBe(false);
    expect(isConversationLiveSearchReady("Él")).toBe(true);
    expect(isConversationLiveSearchReady("77")).toBe(false);
    expect(isConversationLiveSearchReady("77 12")).toBe(true);
    expect(isConversationLiveSearchReady("%_?!")).toBe(false);
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

  it("returns a relevant plain-text excerpt for JSON suggestions", () => {
    const excerpt = plainConversationExcerpt(`${"début ".repeat(35)}remboursement confirmé`, ["remboursement"], 70);
    expect(excerpt).toContain("remboursement");
    expect(excerpt.startsWith("…")).toBe(true);
    expect(excerpt).not.toContain("<mark>");
  });
});
