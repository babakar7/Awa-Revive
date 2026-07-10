import { describe, it, expect } from "vitest";
import { detectLanguage } from "../src/agent/index.js";

describe("language detection for templated messages", () => {
  it("detects French even with franglais ('je book')", () => {
    expect(detectLanguage("Je book fusion vendredi pro pour 2 personnes")).toBe("fr");
  });

  it("detects French from short confirmations", () => {
    expect(detectLanguage("Je confirme. Mais ce lien n'avait pas expiré façon ?")).toBe("fr");
    expect(detectLanguage("Merci")).toBe("fr");
    expect(detectLanguage("oui")).toBe("fr");
  });

  it("detects English", () => {
    expect(detectLanguage("I want to book the test service")).toBe("en");
    expect(detectLanguage("how much is the pilates class?")).toBe("en");
  });

  it("detects Wolof", () => {
    expect(detectLanguage("waaw dama begg pilates")).toBe("wo");
    expect(detectLanguage("jerejef")).toBe("wo");
  });

  it("handles accents (réservé ≙ reserve)", () => {
    expect(detectLanguage("Je voudrais réserver une séance demain")).toBe("fr");
  });

  it("returns null when ambiguous or empty (keeps previous language)", () => {
    expect(detectLanguage("ok")).toBeNull();
    expect(detectLanguage("👍")).toBeNull();
    expect(detectLanguage("")).toBeNull();
  });
});
