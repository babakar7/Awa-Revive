import { describe, expect, it } from "vitest";
import { dynamicContext } from "../src/agent/systemPrompt.js";
import { emailAskMessage } from "../src/lib/linkAsk.js";

const base = {
  clientName: null,
  clientLanguage: "fr" as string | null,
  activeBooking: null,
  activePlanOrder: null,
  activeCafeOrder: null,
  memberships: [] as never[],
  recentRefunds: [] as never[],
  habit: null,
};

const FIRST_CONTACT_MARKER = "FIRST CONTACT";

describe("emailAskMessage — the one-time ignorable linking invitation", () => {
  it("is ignorable and asks for the account email, in each language", () => {
    for (const lang of ["fr", "en", "wo"]) {
      const msg = emailAskMessage(lang);
      expect(msg.toLowerCase()).toMatch(/ignore|topp/); // "ignore" / wolof "bul ci topp"
      expect(msg.toLowerCase()).toMatch(/email|compte/);
    }
  });

  it("defaults to French for an unknown language", () => {
    expect(emailAskMessage("es")).toBe(emailAskMessage("fr"));
  });
});

describe("dynamicContext — first-contact note (server sends the ask, not Awa)", () => {
  it("flags first contact and tells the model NOT to write the invitation itself", () => {
    const ctx = dynamicContext({ ...base, firstContactUnlinked: true });
    expect(ctx).toContain(FIRST_CONTACT_MARKER);
    // The invitation is server-sent; the model must not write it.
    expect(ctx).toMatch(/do NOT write|not by you|automatically/i);
    expect(ctx).toContain("request_email_verification");
  });

  it("does NOT add the note when firstContactUnlinked is false/absent", () => {
    expect(dynamicContext({ ...base, firstContactUnlinked: false })).not.toContain(
      FIRST_CONTACT_MARKER,
    );
    expect(dynamicContext({ ...base })).not.toContain(FIRST_CONTACT_MARKER);
  });

  it("never flags first contact when the client already has an active abonnement", () => {
    const ctx = dynamicContext({
      ...base,
      memberships: [{ plan: "Illimité", covers: null, remaining: 5 }] as never,
      firstContactUnlinked: false,
    });
    expect(ctx).not.toContain(FIRST_CONTACT_MARKER);
    expect(ctx).toContain("ACTIVE abonnement");
  });
});
