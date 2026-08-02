import { describe, expect, it, vi } from "vitest";
import {
  decideMemberProvisioning,
  effectiveMemberContactId,
  memberAttachmentMismatch,
  primaryContactEmail,
  provisionWixMember,
} from "../src/domain/memberProvisioning.js";
import type { LinkRequest } from "../src/domain/linkRequests.js";

const NOW = new Date("2026-07-28T12:00:00Z");

function verification(
  overrides: Partial<LinkRequest> = {},
): LinkRequest {
  return {
    id: "request-1",
    client_id: "client-1",
    claimed_email: "zeinasengold@gmail.com",
    claimed_name: "Zeina",
    wix_contact_id: "contact-proven",
    linked_contact_id: "contact-proven",
    code_hash: null,
    code_expires_at: null,
    attempts: 0,
    emails_sent: 1,
    status: "VERIFIED",
    detail: null,
    reception_notified_at: null,
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  };
}

const args = (o: Partial<Parameters<typeof decideMemberProvisioning>[0]> = {}) => ({
  phoneContactId: null,
  memberId: null,
  recentProof: null,
  durableProof: null,
  pendingVerification: null,
  now: NOW,
  ...o,
});

describe("decideMemberProvisioning", () => {
  it("uses an existing member", () => {
    expect(decideMemberProvisioning(args({ phoneContactId: "contact-phone", memberId: "member-1" }))).toEqual({
      action: "use_member",
      contactId: "contact-phone",
      memberId: "member-1",
    });
  });

  it("requires verification when nothing is proven", () => {
    expect(decideMemberProvisioning(args({ phoneContactId: "contact-phone" }))).toEqual({
      action: "require_verification",
      contactId: "contact-phone",
      codeAlreadySent: false,
    });
  });

  it("reports only a still-valid pending code as already sent", () => {
    expect(
      decideMemberProvisioning(
        args({ pendingVerification: { status: "AWAITING_CODE", codeExpiresAt: new Date(NOW.getTime() + 60_000) } }),
      ),
    ).toMatchObject({ action: "require_verification", codeAlreadySent: true });
    expect(
      decideMemberProvisioning(
        args({ pendingVerification: { status: "AWAITING_CODE", codeExpiresAt: new Date(NOW.getTime() - 60_000) } }),
      ),
    ).toMatchObject({ action: "require_verification", codeAlreadySent: false });
  });

  // Path A — a recent proof trumps a lagging/divergent phone index.
  it("creates the member on the proven fiche for a RECENT proof (Zeina)", () => {
    expect(
      decideMemberProvisioning(args({ phoneContactId: "contact-phone-stale", recentProof: verification() })),
    ).toEqual({
      action: "create_member",
      contactId: "contact-proven",
      verifiedEmail: "zeinasengold@gmail.com",
    });
  });

  // Path B — the Lisa case: proof is OLD (no recentProof), but the phone
  // unambiguously resolves to the same fiche the durable proof points to.
  it("creates the member from a DURABLE proof when the phone matches its fiche (Lisa)", () => {
    expect(
      decideMemberProvisioning(
        args({
          phoneContactId: "contact-lisa",
          durableProof: { linkedContactId: "contact-lisa", claimedEmail: "coulaud.lisa1@gmail.com" },
        }),
      ),
    ).toEqual({
      action: "create_member",
      contactId: "contact-lisa",
      verifiedEmail: "coulaud.lisa1@gmail.com",
    });
  });

  it("passes verifiedEmail null when a durable LINKED proof carries no email", () => {
    expect(
      decideMemberProvisioning(
        args({
          phoneContactId: "contact-lisa",
          durableProof: { linkedContactId: "contact-lisa", claimedEmail: null },
        }),
      ),
    ).toMatchObject({ action: "create_member", contactId: "contact-lisa", verifiedEmail: null });
  });

  it("does NOT create from a durable proof pointing to a DIFFERENT fiche (anti-hijack)", () => {
    expect(
      decideMemberProvisioning(
        args({
          phoneContactId: "contact-phone",
          durableProof: { linkedContactId: "contact-other", claimedEmail: "x@y.com" },
        }),
      ).action,
    ).toBe("require_verification");
  });

  it("does NOT create from a durable proof when the phone is ambiguous/null", () => {
    expect(
      decideMemberProvisioning(
        args({ phoneContactId: null, durableProof: { linkedContactId: "contact-x", claimedEmail: "x@y.com" } }),
      ).action,
    ).toBe("require_verification");
  });

  it("lets an active code win over a durable proof (verification in progress)", () => {
    expect(
      decideMemberProvisioning(
        args({
          phoneContactId: "contact-lisa",
          durableProof: { linkedContactId: "contact-lisa", claimedEmail: "l@x.com" },
          pendingVerification: { status: "AWAITING_CODE", codeExpiresAt: new Date(NOW.getTime() + 60_000) },
        }),
      ),
    ).toMatchObject({ action: "require_verification", codeAlreadySent: true });
  });

  it("lets the proven fiche win over a divergent phone-index contact for 60 minutes", () => {
    expect(effectiveMemberContactId("contact-phone-stale", verification(), NOW)).toBe("contact-proven");
    expect(
      effectiveMemberContactId(
        "contact-phone-stale",
        verification({ updated_at: new Date(NOW.getTime() - 61 * 60_000) }),
        NOW,
      ),
    ).toBe("contact-phone-stale");
  });
});

describe("member provisioning helpers", () => {
  it("uses the primary email of the linked fiche", () => {
    expect(
      primaryContactEmail({
        info: {
          emails: {
            items: [
              { email: "secondary@example.com" },
              { email: "PRIMARY@example.com", primary: true },
            ],
          },
        },
      }),
    ).toBe("primary@example.com");
  });

  it("detects only a divergent non-null attachment", () => {
    expect(memberAttachmentMismatch("contact-1", "contact-2")).toBe(true);
    expect(memberAttachmentMismatch("contact-1", "contact-1")).toBe(false);
    expect(memberAttachmentMismatch("contact-1", null)).toBe(false);
  });
});

describe("provisionWixMember", () => {
  function deps(overrides: Record<string, unknown> = {}) {
    return {
      getContact: vi.fn(async () => ({
        primaryInfo: { email: "primary@example.com" },
      })),
      findMemberId: vi.fn(async () => null),
      createMember: vi.fn(async () => ({
        id: "member-created",
        contactId: "contact-proven",
      })),
      notifyFailure: vi.fn(async () => undefined),
      ...overrides,
    };
  }

  const decision = {
    action: "create_member" as const,
    contactId: "contact-proven",
    verifiedEmail: "verified@example.com",
  };

  it("creates a member successfully with the fiche's primary email", async () => {
    const d = deps();
    await expect(provisionWixMember(decision, d)).resolves.toEqual({
      status: "ready",
      contactId: "contact-proven",
      memberId: "member-created",
      created: true,
    });
    expect(d.createMember).toHaveBeenCalledWith("primary@example.com");
    expect(d.notifyFailure).not.toHaveBeenCalled();
  });

  it("refuses a divergent attachment and notifies once", async () => {
    const d = deps({
      createMember: vi.fn(async () => ({
        id: "member-created",
        contactId: "other-contact",
      })),
    });
    await expect(provisionWixMember(decision, d)).resolves.toMatchObject({
      status: "failed",
      reason: "contact_mismatch",
    });
    expect(d.notifyFailure).toHaveBeenCalledTimes(1);
  });

  it("classifies an email conflict and a generic Wix error", async () => {
    for (const [message, reason] of [
      ["Wix create member failed (409): email already exists", "email_conflict"],
      ["Wix create member failed (500): unavailable", "wix_error"],
    ] as const) {
      const d = deps({
        createMember: vi.fn(async () => {
          throw new Error(message);
        }),
      });
      await expect(provisionWixMember(decision, d)).resolves.toMatchObject({
        status: "failed",
        reason,
      });
      expect(d.notifyFailure).toHaveBeenCalledTimes(1);
    }
  });

  it("falls back to verification when neither the fiche nor the proof has an email", async () => {
    const d = deps({ getContact: vi.fn(async () => ({ info: {} })) });
    await expect(
      provisionWixMember(
        { action: "create_member", contactId: "contact-proven", verifiedEmail: null },
        d,
      ),
    ).resolves.toMatchObject({ status: "verification_required", codeAlreadySent: false });
    expect(d.createMember).not.toHaveBeenCalled();
    expect(d.notifyFailure).not.toHaveBeenCalled();
  });

  it("resolves a committed createMember response before notifying", async () => {
    const d = deps({
      createMember: vi.fn(async () => {
        throw new Error("timeout");
      }),
      findMemberId: vi.fn(async () => "member-eventually-visible"),
    });
    await expect(provisionWixMember(decision, d)).resolves.toMatchObject({
      status: "ready",
      memberId: "member-eventually-visible",
      created: false,
    });
    expect(d.notifyFailure).not.toHaveBeenCalled();
  });
});
