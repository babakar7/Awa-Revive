import { describe, expect, it } from "vitest";
import {
  bounceClientMessage,
  classifyBounce,
  parseBounceEvent,
} from "../src/domain/emailBounce.js";

// Payload réel observé sur le rebond kaeva18@ du 07/08 (boîte Gmail pleine),
// forme webhook (snake_case) — l'API statistiques renvoie "softBounces".
const GMAIL_FULL_REASON =
  "452-4.2.2 The recipient's inbox is out of storage space. Please direct the\n" +
  "   452-4.2.2 recipient to\n" +
  "   452 4.2.2  https://support.google.com/mail/?p=OverQuotaTemp";

describe("parseBounceEvent", () => {
  it("accepts webhook snake_case bounce events", () => {
    const evt = parseBounceEvent({
      event: "soft_bounce",
      email: "Kaeva18@Gmail.com",
      reason: GMAIL_FULL_REASON,
      "message-id": "<202608070838.61532599416@smtp-relay.mailin.fr>",
    });
    expect(evt).not.toBeNull();
    expect(evt!.email).toBe("kaeva18@gmail.com");
    expect(evt!.dedupKey).toBe(
      "brevo:soft_bounce:<202608070838.61532599416@smtp-relay.mailin.fr>",
    );
  });

  it.each(["hard_bounce", "hardBounces", "blocked", "invalid_email", "error", "softBounce"])(
    "accepts the %s event across Brevo spellings",
    (event) => {
      expect(parseBounceEvent({ event, email: "a@b.co" })).not.toBeNull();
    },
  );

  it.each(["delivered", "opened", "request", "click", "deferred", ""])(
    "ignores non-bounce event %s",
    (event) => {
      expect(parseBounceEvent({ event, email: "a@b.co" })).toBeNull();
    },
  );

  it("ignores malformed items instead of throwing (Brevo disables failing webhooks)", () => {
    expect(parseBounceEvent(null)).toBeNull();
    expect(parseBounceEvent("soft_bounce")).toBeNull();
    expect(parseBounceEvent({ event: "soft_bounce" })).toBeNull();
    expect(parseBounceEvent({ event: "soft_bounce", email: "not-an-email" })).toBeNull();
  });

  it("falls back to email+timestamp when message-id is missing", () => {
    const evt = parseBounceEvent({ event: "blocked", email: "a@b.co", ts_event: 1754555934 });
    expect(evt!.dedupKey).toBe("brevo:blocked:a@b.co:1754555934");
  });
});

describe("classifyBounce", () => {
  it("spots the Gmail full-mailbox soft bounce (the real kaeva18@ case)", () => {
    expect(classifyBounce("soft_bounce", GMAIL_FULL_REASON)).toBe("inbox_full");
  });

  it("treats hard bounces and unknown-user rejections as invalid addresses", () => {
    expect(classifyBounce("hard_bounce", null)).toBe("invalid_address");
    expect(classifyBounce("invalid_email", null)).toBe("invalid_address");
    expect(classifyBounce("blocked", "550 5.1.1 user unknown")).toBe("invalid_address");
  });

  it("defaults to other for anything else", () => {
    expect(classifyBounce("soft_bounce", "451 greylisted, try later")).toBe("other");
    expect(classifyBounce("error", null)).toBe("other");
  });
});

describe("bounceClientMessage", () => {
  it("always offers the three ways out, no-verification last", () => {
    for (const kind of ["inbox_full", "invalid_address", "other"] as const) {
      const fr = bounceClientMessage(kind, "a@b.co", "fr");
      expect(fr).toContain("a@b.co");
      expect(fr).toContain("autre adresse email");
      expect(fr).toContain("sans la vérification email");
      const en = bounceClientMessage(kind, "a@b.co", "en");
      expect(en).toContain("another email address");
      expect(en).toContain("without the email check");
    }
  });

  it("explains the full mailbox specifically", () => {
    expect(bounceClientMessage("inbox_full", "a@b.co", "fr")).toContain("pleine");
    expect(bounceClientMessage("inbox_full", "a@b.co", "en")).toContain("full");
  });
});
