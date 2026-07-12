import { describe, expect, it } from "vitest";
import { dynamicContext } from "../src/agent/systemPrompt.js";
import { emailAskMessage, shouldOfferLinking } from "../src/lib/linkAsk.js";

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

const UNLINKED_MARKER = "UNLINKED NUMBER";

describe("emailAskMessage — the one-time ignorable linking invitation", () => {
  it("offers BOTH linking an existing account and creating a new one, in each language", () => {
    for (const lang of ["fr", "en", "wo"]) {
      const msg = emailAskMessage(lang).toLowerCase();
      expect(msg).toMatch(/email/); // asks for the account email
      expect(msg).toMatch(/cr[ée]|create|defal/); // offers to create one for newcomers
    }
  });

  it("defaults to French for an unknown language", () => {
    expect(emailAskMessage("es")).toBe(emailAskMessage("fr"));
  });
});

describe("shouldOfferLinking — server decides when to append the invitation", () => {
  const client = { email_prompted_at: null, claimed_email: null };

  it("offers when the lookup succeeded, number is unlinked, and never asked", () => {
    expect(shouldOfferLinking({ linked: false, plans: [] }, client)).toBe(true);
  });

  it("NEVER offers when the lookup FAILED (null) — unknown, don't presume no account", () => {
    expect(shouldOfferLinking(null, client)).toBe(false);
  });

  it("does not offer when the number is already linked to a unique contact", () => {
    expect(shouldOfferLinking({ linked: true, plans: [] }, client)).toBe(false);
  });

  it("does not offer once the one-shot flag is armed, or an email was claimed", () => {
    const unlinked = { linked: false, plans: [] };
    expect(shouldOfferLinking(unlinked, { email_prompted_at: new Date(), claimed_email: null })).toBe(false);
    expect(shouldOfferLinking(unlinked, { email_prompted_at: null, claimed_email: "a@b.co" })).toBe(false);
  });

  it("still offers even when the client already has assistant history (regression: the old first-conversation guard burned the chance)", () => {
    // shouldOfferLinking is intentionally NOT gated on conversation history —
    // a technical-fallback turn or a failed send used to permanently block it.
    expect(shouldOfferLinking({ linked: false, plans: [] }, client)).toBe(true);
  });
});

describe("dynamicContext — unlinked-number note (server sends the ask, not Awa)", () => {
  it("flags the unlinked number and tells the model NOT to write the invitation itself", () => {
    const ctx = dynamicContext({ ...base, unlinkedNeverAsked: true });
    expect(ctx).toContain(UNLINKED_MARKER);
    expect(ctx).toMatch(/do NOT write|automatically/i);
    expect(ctx).toContain("request_email_verification");
    // The model must know it can create an account (verified by code first).
    expect(ctx).toMatch(/create_account/);
  });

  it("does NOT add the note when unlinkedNeverAsked is false/absent", () => {
    expect(dynamicContext({ ...base, unlinkedNeverAsked: false })).not.toContain(UNLINKED_MARKER);
    expect(dynamicContext({ ...base })).not.toContain(UNLINKED_MARKER);
  });

  it("never flags the note when the client already has an active abonnement", () => {
    const ctx = dynamicContext({
      ...base,
      memberships: [{ plan: "Illimité", covers: null, remaining: 5 }] as never,
      unlinkedNeverAsked: false,
    });
    expect(ctx).not.toContain(UNLINKED_MARKER);
    expect(ctx).toContain("ACTIVE abonnement");
  });
});
