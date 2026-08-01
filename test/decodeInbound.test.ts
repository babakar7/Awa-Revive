import { describe, expect, it, vi } from "vitest";
import { decodePercentEncodedMessage } from "../src/lib/whatsapp.js";

// Prod 31/07 (Amicolle): a wa.me deep link double-encoded its pre-filled body,
// so Awa received "Bonjour%2C%20je%20souhaite%20r%C3%A9server%20un%20cours".
// Decode only an unambiguously encoded phrase; never mangle a legit message.
describe("decodePercentEncodedMessage", () => {
  it("decodes a fully percent-encoded phrase", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(
      decodePercentEncodedMessage("Bonjour%2C%20je%20souhaite%20r%C3%A9server%20un%20cours"),
    ).toBe("Bonjour, je souhaite réserver un cours");
  });

  it("decodes a short accented phrase with a single encoded space", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(decodePercentEncodedMessage("r%C3%A9server%20maintenant")).toBe(
      "réserver maintenant",
    );
  });

  it("leaves a normal message untouched", () => {
    expect(decodePercentEncodedMessage("Bonjour, je veux réserver un cours")).toBe(
      "Bonjour, je veux réserver un cours",
    );
    expect(decodePercentEncodedMessage("Salut 👋")).toBe("Salut 👋");
  });

  it("leaves a lone percent or a percentage untouched (malformed escape)", () => {
    expect(decodePercentEncodedMessage("50% off aujourd'hui")).toBe("50% off aujourd'hui");
    expect(decodePercentEncodedMessage("c'est 100% sûr")).toBe("c'est 100% sûr");
  });

  it("leaves a pasted URL untouched even if it carries %XX", () => {
    const url = "https://revive.sn/planning?q=a%20b";
    expect(decodePercentEncodedMessage(url)).toBe(url);
  });

  it("does not fire on a single encoded space without an accent", () => {
    // "a%20b" is only one encoded space and no accent — too weak a signal.
    expect(decodePercentEncodedMessage("a%20b")).toBe("a%20b");
  });

  it("leaves a malformed percent sequence untouched", () => {
    expect(decodePercentEncodedMessage("cours%20%ZZ%20test")).toBe("cours%20%ZZ%20test");
  });
});
