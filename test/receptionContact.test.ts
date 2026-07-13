import { describe, expect, it } from "vitest";
import {
  receptionHandoffMessage,
  receptionLinkInstruction,
  receptionWhatsAppLink,
  whatsappClickToChatUrl,
} from "../src/lib/receptionContact.js";
import { technicalFallbackMessage } from "../src/agent/index.js";
import { planConfirmationMessage } from "../src/domain/fulfillment.js";

describe("WhatsApp reception contact", () => {
  it("normalizes the phone and URL-encodes the prefilled message", () => {
    const url = whatsappClickToChatUrl(
      "+221 78 464 43 29",
      "Bonjour, j'ai une question sur l'abonnement Découverte.",
    );
    const parsed = new URL(url);

    expect(parsed.origin + parsed.pathname).toBe("https://wa.me/221784644329");
    expect(parsed.searchParams.get("text")).toBe(
      "Bonjour, j'ai une question sur l'abonnement Découverte.",
    );
  });

  it("builds a short contextual message and removes control whitespace", () => {
    const longReason = `une question\n\tconcernant ${"x".repeat(250)}`;
    const { url, message } = receptionWhatsAppLink(
      "+221784644329",
      "  Awa\nNdiaye  ",
      longReason,
    );

    expect(message).toContain("Bonjour, je suis Awa Ndiaye.");
    expect(message).toContain("une question concernant");
    expect(message).not.toContain("\n");
    expect(new URL(url).searchParams.get("text")).toBe(message);
    expect(message.length).toBeLessThan(300);
  });

  it("falls back safely when the name and reason are missing", () => {
    expect(receptionHandoffMessage(null, "")).toBe(
      "Bonjour. Awa m'oriente vers vous concernant : une demande d'aide.",
    );
    expect(receptionHandoffMessage(null, "...?")).toContain("une demande d'aide");
  });

  it("explains in all supported languages that the final Send tap remains", () => {
    const url = "https://wa.me/221784644329?text=Bonjour";
    for (const lang of ["fr", "en", "wo"]) {
      const instruction = receptionLinkInstruction(lang, url);
      expect(instruction).toContain(url);
      expect(instruction).toMatch(/Envoyer|Send/);
    }
  });

  it("puts a named prefilled link in the deterministic technical fallback", () => {
    const message = technicalFallbackMessage("Fatou");
    const url = message.match(/https:\/\/wa\.me\/[^\s]+/)?.[0];

    expect(url).toBeTruthy();
    expect(new URL(url!).searchParams.get("text")).toContain("je suis Fatou");
    expect(message).toContain("appuie sur Envoyer");
  });

  it("adds the contact link only when a paid plan needs manual activation", () => {
    const pending = planConfirmationMessage("fr", "Pilates 10", false, null, "Aïda");
    const active = planConfirmationMessage("fr", "Pilates 10", true, null, "Aïda");

    expect(pending).toContain("https://wa.me/221784644329?text=");
    expect(decodeURIComponent(pending)).toContain("je suis Aïda");
    expect(decodeURIComponent(pending)).toContain("activation de mon abonnement");
    expect(active).not.toContain("wa.me");
  });
});
