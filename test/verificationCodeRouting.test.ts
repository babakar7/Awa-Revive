import { describe, expect, it, vi } from "vitest";
import type { Client } from "../src/domain/repo.js";
import {
  maybeHandleVerificationCode,
  verificationCodeReplyText,
  type VerificationCodeRoutingDeps,
} from "../src/agent/index.js";

function client(overrides: Partial<Client> = {}): Client {
  return {
    id: "client-1",
    wa_phone: "2203644575",
    name: "Oumie",
    language: "fr",
    email_prompted_at: null,
    claimed_email: "oum@example.com",
    capability_menu_at: null,
    fr_register: null,
    is_test: false,
    human_takeover_until: null,
    human_takeover_by: null,
    human_takeover_at: null,
    awa_disengaged_until: null,
    awa_disengaged_at: null,
    awa_disengaged_reason: null,
    awa_disengaged_kind: null,
    awa_no_intent_streak: 0,
    awa_no_intent_last_at: null,
    ...overrides,
  };
}

function deps(result: Record<string, unknown>): VerificationCodeRoutingDeps & {
  execute: ReturnType<typeof vi.fn>;
  send: ReturnType<typeof vi.fn>;
  addTurn: ReturnType<typeof vi.fn>;
} {
  return {
    getOpen: vi.fn(async () => ({
      id: "request-1",
      client_id: "client-1",
      claimed_email: "oum@example.com",
      claimed_name: null,
      wix_contact_id: "wix-contact-1",
      code_hash: "hash",
      code_expires_at: new Date(Date.now() + 60_000),
      attempts: 0,
      emails_sent: 1,
      status: "AWAITING_CODE" as const,
      detail: null,
      linked_contact_id: null,
      reception_notified_at: null,
      created_at: new Date(),
      updated_at: new Date(),
    })),
    execute: vi.fn(async () => JSON.stringify(result)),
    send: vi.fn(async () => "wamid.success"),
    addTurn: vi.fn(async () => undefined),
    technicalFailure: vi.fn(async () => undefined),
  } as unknown as VerificationCodeRoutingDeps & {
    execute: ReturnType<typeof vi.fn>;
    send: ReturnType<typeof vi.fn>;
    addTurn: ReturnType<typeof vi.fn>;
  };
}

describe("deterministic verification-code routing", () => {
  it("sends a fresh six-digit code directly to the server tool and confirms success", async () => {
    const d = deps({ status: "verified", active_plans: [] });

    expect(await maybeHandleVerificationCode(client(), "839214", "wamid.in", d)).toBe(true);

    expect(d.execute).toHaveBeenCalledWith(
      expect.objectContaining({ id: "client-1" }),
      "submit_verification_code",
      { code: "839214" },
    );
    expect(d.send).toHaveBeenCalledWith(
      "2203644575",
      expect.stringContaining("maintenant relié"),
    );
    expect(d.addTurn).toHaveBeenCalledWith(
      "client-1",
      "tool",
      expect.stringContaining("submit_verification_code"),
    );
    expect(d.addTurn).toHaveBeenLastCalledWith(
      "client-1",
      "assistant",
      expect.stringContaining("maintenant relié"),
      "wamid.success",
    );
  });

  it("does not intercept unrelated six-digit text without a pending verification", async () => {
    const d = deps({ status: "verified" });
    d.getOpen = vi.fn(async () => null);

    expect(await maybeHandleVerificationCode(client(), "839214", "wamid.in", d)).toBe(false);
    expect(d.execute).not.toHaveBeenCalled();
    expect(d.send).not.toHaveBeenCalled();
  });

  it("keeps wrong-code protection and reports the remaining attempts", async () => {
    const d = deps({ status: "wrong_code", attempts_left: 3 });

    expect(await maybeHandleVerificationCode(client(), "000000", "wamid.in", d)).toBe(true);
    expect(d.send).toHaveBeenCalledWith(
      "2203644575",
      expect.stringMatching(/ne correspond pas.*3 essais restants/),
    );
  });
});

describe("verificationCodeReplyText", () => {
  it("uses the requested account-created confirmation", () => {
    expect(verificationCodeReplyText(client(), { status: "account_created" })).toContain(
      "créé avec succès",
    );
  });

  it("honours the formal French register", () => {
    expect(
      verificationCodeReplyText(client({ fr_register: "vous" }), { status: "expired" }),
    ).toContain("Envoyez-moi votre email");
  });
});
