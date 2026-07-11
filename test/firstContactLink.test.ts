import { describe, expect, it } from "vitest";
import { dynamicContext } from "../src/agent/systemPrompt.js";

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

const FIRST_CONTACT_MARKER = "FIRST CONTACT and this WhatsApp number matches no Revive account";

describe("dynamicContext — first-contact account linking invitation", () => {
  it("injects the ignorable email invitation when firstContactUnlinked is true", () => {
    const ctx = dynamicContext({ ...base, firstContactUnlinked: true });
    expect(ctx).toContain(FIRST_CONTACT_MARKER);
    // It must be framed as ignorable / at-most-once, and route replies to verification.
    expect(ctx).toContain("request_email_verification");
    expect(ctx.toLowerCase()).toContain("ignore");
  });

  it("does NOT inject it when firstContactUnlinked is false/absent", () => {
    expect(dynamicContext({ ...base, firstContactUnlinked: false })).not.toContain(
      FIRST_CONTACT_MARKER,
    );
    expect(dynamicContext({ ...base })).not.toContain(FIRST_CONTACT_MARKER);
  });

  it("never invites when the client already has an active abonnement (matched account)", () => {
    const ctx = dynamicContext({
      ...base,
      memberships: [{ plan: "Illimité", covers: null, remaining: 5 }] as never,
      // Even if the flag were somehow set, an active plan means they're matched;
      // the caller (index.ts) only sets the flag when !linked, so this is belt-and-braces.
      firstContactUnlinked: false,
    });
    expect(ctx).not.toContain(FIRST_CONTACT_MARKER);
    expect(ctx).toContain("ACTIVE abonnement");
  });
});
