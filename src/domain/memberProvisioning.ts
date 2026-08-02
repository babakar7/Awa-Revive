import type { LinkRequest } from "./linkRequests.js";

export const MEMBER_VERIFICATION_WINDOW_MINUTES = 60;

type VerificationSnapshot = Pick<
  LinkRequest,
  | "status"
  | "claimed_email"
  | "linked_contact_id"
  | "code_expires_at"
  | "updated_at"
>;

export type MemberProvisioningDecision =
  | {
      action: "use_member";
      contactId: string;
      memberId: string;
    }
  | {
      action: "require_verification";
      contactId: string | null;
      codeAlreadySent: boolean;
    }
  | {
      action: "create_member";
      contactId: string;
      /** Email to open the Wix member with. May be null on an admin LINKED
       *  proof carrying no email — provisionWixMember then falls back to the
       *  fiche's primary email, or asks for verification if there is none. */
      verifiedEmail: string | null;
    };

/** Durable proof that the client owns a fiche: a VERIFIED/LINKED link_request
 *  of ANY age. Distinct from a recent proof — see decideMemberProvisioning. */
export interface DurableProof {
  linkedContactId: string | null;
  claimedEmail: string | null;
}

/** A verification currently in progress (open request), for codeAlreadySent. */
export interface PendingVerificationSnapshot {
  status: string;
  codeExpiresAt: Date | string | null;
}

export interface DecideMemberProvisioningArgs {
  /** Contact resolved from the WhatsApp phone index, if it is unambiguous. */
  phoneContactId: string | null;
  /** Member resolved for the effective contact (the proven contact wins). */
  memberId: string | null;
  /** Proof resolved WITHIN the 60-min window — arbitrates the proven fiche vs
   *  the eventually-consistent phone index right after a code. NOTHING else. */
  recentProof: VerificationSnapshot | null;
  /** Proof of ANY age — authorizes creating the member for the phone's OWN
   *  fiche (never as a freshness signal; see the linked_contact_id guard). */
  durableProof: DurableProof | null;
  /** Open verification in progress — used ONLY to compute codeAlreadySent. */
  pendingVerification: PendingVerificationSnapshot | null;
  now: Date;
}

function codeStillActive(
  pending: PendingVerificationSnapshot | null,
  now: Date,
): boolean {
  if (pending?.status !== "AWAITING_CODE") return false;
  const expiresAt = pending.codeExpiresAt ? new Date(pending.codeExpiresAt).getTime() : Number.NaN;
  return Number.isFinite(expiresAt) && expiresAt > now.getTime();
}

function isRecentlyVerified(
  verification: VerificationSnapshot | null,
  now: Date,
): verification is VerificationSnapshot {
  if (!verification || !["VERIFIED", "LINKED"].includes(verification.status)) return false;
  const updatedAt = new Date(verification.updated_at).getTime();
  return (
    Number.isFinite(updatedAt) &&
    updatedAt >= now.getTime() - MEMBER_VERIFICATION_WINDOW_MINUTES * 60_000
  );
}

/**
 * The email-proven fiche is authoritative over the eventually-consistent phone
 * index. This avoids attaching a plan to a stale/duplicate phone match just
 * after submit_verification_code updated Wix.
 */
export function effectiveMemberContactId(
  phoneContactId: string | null,
  verification: VerificationSnapshot | null,
  now: Date,
): string | null {
  if (isRecentlyVerified(verification, now) && verification.linked_contact_id) {
    return verification.linked_contact_id;
  }
  return phoneContactId;
}

function normalizeEmail(email: string | null): string | null {
  const trimmed = email?.trim().toLowerCase();
  return trimmed ? trimmed : null;
}

/** Pure, side-effect-free decision. Member creation is deliberately separate. */
export function decideMemberProvisioning(
  args: DecideMemberProvisioningArgs,
): MemberProvisioningDecision {
  // Freshness arbitrates the proven fiche vs the lagging phone index — and
  // ONLY that. It is NOT an authorization TTL (the bug that trapped a client
  // verified >1h earlier with no member yet: Lisa Coulaud 28/07→02/08).
  const contactId = effectiveMemberContactId(
    args.phoneContactId,
    args.recentProof,
    args.now,
  );

  if (contactId && args.memberId) {
    return { action: "use_member", contactId, memberId: args.memberId };
  }

  // Path A — a RECENT proof: trust the proof over the (possibly lagging) phone
  // index and create the member on the effective (proven) contact.
  if (contactId && isRecentlyVerified(args.recentProof, args.now)) {
    return {
      action: "create_member",
      contactId,
      verifiedEmail: normalizeEmail(args.recentProof.claimed_email),
    };
  }

  const codeAlreadySent = codeStillActive(args.pendingVerification, args.now);

  // Path B — a DURABLE proof (any age): create the member ONLY when the phone
  // unambiguously resolves to the SAME fiche the proof points to. An active
  // code in flight wins first (the client may be verifying another account).
  if (
    !codeAlreadySent &&
    args.phoneContactId &&
    args.durableProof &&
    args.durableProof.linkedContactId === args.phoneContactId
  ) {
    return {
      action: "create_member",
      contactId: args.phoneContactId,
      verifiedEmail: normalizeEmail(args.durableProof.claimedEmail),
    };
  }

  return { action: "require_verification", contactId, codeAlreadySent };
}

export function memberAttachmentMismatch(
  expectedContactId: string,
  createdContactId: string | null,
): boolean {
  return createdContactId !== null && createdContactId !== expectedContactId;
}

/** Prefer the login email designated by Wix on the proven fiche. */
export function primaryContactEmail(contact: any): string | null {
  const primaryInfo = String(contact?.primaryInfo?.email ?? "").trim().toLowerCase();
  if (primaryInfo) return primaryInfo;
  const items: any[] = Array.isArray(contact?.info?.emails?.items)
    ? contact.info.emails.items
    : [];
  const selected =
    items.find(
      (item) =>
        item?.primary === true || String(item?.tag ?? "").toUpperCase() === "MAIN",
    ) ??
    items[0] ??
    null;
  const email = String(selected?.email ?? "").trim().toLowerCase();
  return email || null;
}

export type MemberProvisioningFailure =
  | "contact_mismatch"
  | "email_conflict"
  | "wix_error";

export type MemberProvisioningResult =
  | {
      status: "ready";
      memberId: string;
      contactId: string;
      created: boolean;
    }
  | {
      status: "verification_required";
      contactId: string | null;
      codeAlreadySent: boolean;
    }
  | {
      status: "failed";
      contactId: string;
      reason: MemberProvisioningFailure;
      error: string;
    };

export interface MemberProvisioningDeps {
  getContact(contactId: string): Promise<any | null>;
  findMemberId(contactId: string): Promise<string | null>;
  createMember(email: string): Promise<{ id: string; contactId: string | null }>;
  notifyFailure(
    reason: MemberProvisioningFailure,
    detail: string,
  ): Promise<void> | void;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function isMemberEmailConflict(error: unknown): boolean {
  return /\b409\b|already exists|already.*member|email.*(?:used|taken|conflict)/i.test(
    errorText(error),
  );
}

/**
 * Testable Wix orchestrator. Call this only after plan/catalog/eligibility/
 * renewal/payment-method guards have passed, immediately before draft creation.
 */
export async function provisionWixMember(
  decision: MemberProvisioningDecision,
  deps: MemberProvisioningDeps,
): Promise<MemberProvisioningResult> {
  if (decision.action === "use_member") {
    return {
      status: "ready",
      contactId: decision.contactId,
      memberId: decision.memberId,
      created: false,
    };
  }
  if (decision.action === "require_verification") {
    return {
      status: "verification_required",
      contactId: decision.contactId,
      codeAlreadySent: decision.codeAlreadySent,
    };
  }

  try {
    const contact = await deps.getContact(decision.contactId);
    if (!contact) throw new Error(`Wix contact ${decision.contactId} not found`);
    const email = primaryContactEmail(contact) ?? decision.verifiedEmail;
    if (!email) {
      // Durable proof authorized a member, but neither the fiche nor the proof
      // carries an email (e.g. an admin LINKED with no email). Fall back to a
      // real verification rather than opening a member with no login email.
      return {
        status: "verification_required",
        contactId: decision.contactId,
        codeAlreadySent: false,
      };
    }
    const created = await deps.createMember(email);
    if (memberAttachmentMismatch(decision.contactId, created.contactId)) {
      const detail =
        `created member ${created.id} attached to ${created.contactId}, ` +
        `expected ${decision.contactId}`;
      await deps.notifyFailure("contact_mismatch", detail);
      return {
        status: "failed",
        contactId: decision.contactId,
        reason: "contact_mismatch",
        error: detail,
      };
    }
    return {
      status: "ready",
      contactId: decision.contactId,
      memberId: created.id,
      created: true,
    };
  } catch (error) {
    // A timeout/409 may happen after Wix committed the member. Resolve once
    // before declaring failure so retries never create or notify twice.
    const existing = await deps.findMemberId(decision.contactId).catch(() => null);
    if (existing) {
      return {
        status: "ready",
        contactId: decision.contactId,
        memberId: existing,
        created: false,
      };
    }
    const reason: MemberProvisioningFailure = isMemberEmailConflict(error)
      ? "email_conflict"
      : "wix_error";
    const detail = errorText(error);
    await deps.notifyFailure(reason, detail);
    return {
      status: "failed",
      contactId: decision.contactId,
      reason,
      error: detail,
    };
  }
}
