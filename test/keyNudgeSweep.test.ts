import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  sendTemplate: vi.fn(),
  planRemainingSessions: vi.fn(),
  listActiveKeysForNudges: vi.fn(),
  claimKeyNudge: vi.fn(),
  completeKeyNudge: vi.fn(),
  inviteeGuaranteeFacts: vi.fn(),
  hasNextKeyCommitment: vi.fn(),
  addTurn: vi.fn(),
}));

const mockedConfig = vi.hoisted(() => ({
  KEYS_AUTOMATION_ENABLED: true,
  TIMEZONE: "Africa/Dakar",
  WA_KEY_INVITEE_J5_TEMPLATE: "",
  WA_KEY_INVITEE_J5_TEMPLATE_LANG: "fr",
  WA_KEY_THIRD_SESSION_TEMPLATE: "",
  WA_KEY_THIRD_SESSION_TEMPLATE_LANG: "fr",
  WA_KEY_MEMBER_J5_TEMPLATE: "",
  WA_KEY_MEMBER_J5_TEMPLATE_LANG: "fr",
  WA_KEY_INVITATION_J10_TEMPLATE: "awa_key_invitation_j10_v1",
  WA_KEY_INVITATION_J10_TEMPLATE_LANG: "en",
  WA_KEY_MEMBER_J5_INVITATION_TEMPLATE: "",
  WA_KEY_MEMBER_J5_INVITATION_TEMPLATE_LANG: "en",
  WA_KEY_FINISHED_TEMPLATE: "",
  WA_KEY_FINISHED_TEMPLATE_LANG: "fr",
}));

vi.mock("../src/config.js", () => ({ config: mockedConfig }));
vi.mock("../src/lib/whatsapp.js", () => ({ sendTemplate: mocks.sendTemplate }));
vi.mock("../src/lib/notify.js", () => ({
  toTemplateParam: (value: string) => value,
}));
vi.mock("../src/lib/wix.js", () => ({
  planRemainingSessions: mocks.planRemainingSessions,
}));
vi.mock("../src/domain/repo.js", () => ({ addTurn: mocks.addTurn }));
vi.mock("../src/domain/keyRepo.js", () => ({
  listActiveKeysForNudges: mocks.listActiveKeysForNudges,
  claimKeyNudge: mocks.claimKeyNudge,
  completeKeyNudge: mocks.completeKeyNudge,
  inviteeGuaranteeFacts: mocks.inviteeGuaranteeFacts,
  hasNextKeyCommitment: mocks.hasNextKeyCommitment,
}));

import { sweepKeyNudges } from "../src/domain/keyNudge.js";

const log = { info: vi.fn(), error: vi.fn() };

function activeKey(overrides: Record<string, unknown> = {}) {
  return {
    id: "key-1",
    paid_order_id: "paid-1",
    client_id: "client-1",
    client_name: "Aïda",
    wa_phone: "221770000001",
    wix_contact_id: "contact-1",
    key_type: "RESIDENTE",
    family: "REFORMER",
    plan_id: "resident-plan",
    starts_at: new Date("2026-07-22T08:00:00Z"),
    effective_ends_at: new Date("2026-09-20T08:00:00Z"),
    available_invitations: 1,
    ...overrides,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-08-01T12:00:00Z"));
  vi.clearAllMocks();
  mockedConfig.WA_KEY_MEMBER_J5_TEMPLATE = "";
  mockedConfig.WA_KEY_MEMBER_J5_INVITATION_TEMPLATE = "";
  mockedConfig.WA_KEY_FINISHED_TEMPLATE = "";
  mocks.claimKeyNudge.mockResolvedValue(true);
  mocks.completeKeyNudge.mockResolvedValue(undefined);
  mocks.addTurn.mockResolvedValue(undefined);
  mocks.sendTemplate.mockResolvedValue("wamid-1");
  mocks.inviteeGuaranteeFacts.mockResolvedValue({ reformerBookings: [], bonusBookings: 0 });
  mocks.hasNextKeyCommitment.mockResolvedValue(false);
});

describe("Key invitation reminder sweep", () => {
  it("sends the local J+10 reminder without requiring a Wix contact or balance", async () => {
    mocks.listActiveKeysForNudges.mockResolvedValue([
      activeKey({ wix_contact_id: null }),
    ]);
    mocks.planRemainingSessions.mockRejectedValue(new Error("Wix unavailable"));

    await expect(sweepKeyNudges(log)).resolves.toBe(1);

    expect(mocks.sendTemplate).toHaveBeenCalledWith(
      "221770000001",
      "awa_key_invitation_j10_v1",
      "en",
      ["Aïda", "1", "La Résidente — Clé 12 séances", "20 septembre"],
    );
    expect(mocks.claimKeyNudge).toHaveBeenCalledWith({
      dedupKey: "INVITATION_J10:key-1",
      keyId: "key-1",
      clientId: "client-1",
    });
    expect(mocks.planRemainingSessions).not.toHaveBeenCalled();
  });

  it("sends NO Reformer-worded lifecycle nudge to an Aquabike key", async () => {
    // The lifecycle templates are Reformer/Clé-worded; the Aquabike family must
    // never receive them (it awaits its own templates).
    mocks.listActiveKeysForNudges.mockResolvedValue([
      activeKey({ key_type: "AQUABIKE", family: "AQUABIKE", available_invitations: 1 }),
    ]);
    mocks.planRemainingSessions.mockResolvedValue(0);

    await expect(sweepKeyNudges(log)).resolves.toBe(0);
    expect(mocks.sendTemplate).not.toHaveBeenCalled();
    expect(mocks.claimKeyNudge).not.toHaveBeenCalled();
  });

  it("keeps the J+10 send when the later Wix balance lookup fails", async () => {
    mocks.listActiveKeysForNudges.mockResolvedValue([activeKey()]);
    mocks.planRemainingSessions.mockRejectedValue(new Error("Wix unavailable"));

    await expect(sweepKeyNudges(log)).resolves.toBe(1);

    expect(mocks.sendTemplate).toHaveBeenCalledOnce();
    expect(mocks.planRemainingSessions).toHaveBeenCalledOnce();
    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({ keyId: "key-1" }),
      "Key nudge balance lookup failed",
    );
  });

  it("uses the invitation-aware J-5 template with the existing MEMBER_J5 claim", async () => {
    mockedConfig.WA_KEY_MEMBER_J5_TEMPLATE = "awa_key_member_j5";
    mockedConfig.WA_KEY_MEMBER_J5_INVITATION_TEMPLATE =
      "awa_key_member_j5_invitation_v1";
    mocks.listActiveKeysForNudges.mockResolvedValue([
      activeKey({
        starts_at: new Date("2026-07-01T08:00:00Z"),
        effective_ends_at: new Date("2026-08-06T08:00:00Z"),
        available_invitations: 2,
      }),
    ]);
    mocks.planRemainingSessions.mockResolvedValue(4);

    await expect(sweepKeyNudges(log)).resolves.toBe(1);

    expect(mocks.sendTemplate).toHaveBeenCalledWith(
      "221770000001",
      "awa_key_member_j5_invitation_v1",
      "en",
      ["Aïda", "La Résidente — Clé 12 séances", "4", "6 août", "2"],
    );
    expect(mocks.claimKeyNudge).toHaveBeenCalledWith({
      dedupKey: "MEMBER_J5:key-1",
      keyId: "key-1",
      clientId: "client-1",
    });
  });

  it("falls back to the base J-5 template without creating another claim", async () => {
    mockedConfig.WA_KEY_MEMBER_J5_TEMPLATE = "awa_key_member_j5";
    mocks.listActiveKeysForNudges.mockResolvedValue([
      activeKey({
        starts_at: new Date("2026-07-01T08:00:00Z"),
        effective_ends_at: new Date("2026-08-06T08:00:00Z"),
      }),
    ]);
    mocks.planRemainingSessions.mockResolvedValue(4);

    await expect(sweepKeyNudges(log)).resolves.toBe(1);

    expect(mocks.sendTemplate).toHaveBeenCalledWith(
      "221770000001",
      "awa_key_member_j5",
      "fr",
      ["Aïda", "La Résidente — Clé 12 séances", "4", "6 août"],
    );
    expect(mocks.claimKeyNudge).toHaveBeenCalledTimes(1);
    expect(mocks.claimKeyNudge).toHaveBeenCalledWith(
      expect.objectContaining({ dedupKey: "MEMBER_J5:key-1" }),
    );
  });

  it("keeps the base J-5 template when the invitation-aware variant is configured but none is available", async () => {
    mockedConfig.WA_KEY_MEMBER_J5_TEMPLATE = "awa_key_member_j5";
    mockedConfig.WA_KEY_MEMBER_J5_INVITATION_TEMPLATE =
      "awa_key_member_j5_invitation_v1";
    mocks.listActiveKeysForNudges.mockResolvedValue([
      activeKey({
        starts_at: new Date("2026-07-01T08:00:00Z"),
        effective_ends_at: new Date("2026-08-06T08:00:00Z"),
        available_invitations: 0,
      }),
    ]);
    mocks.planRemainingSessions.mockResolvedValue(4);

    await expect(sweepKeyNudges(log)).resolves.toBe(1);

    expect(mocks.sendTemplate).toHaveBeenCalledWith(
      "221770000001",
      "awa_key_member_j5",
      "fr",
      ["Aïda", "La Résidente — Clé 12 séances", "4", "6 août"],
    );
    expect(mocks.claimKeyNudge).toHaveBeenCalledTimes(1);
  });

  it("records the approved L'Habituée-first copy when Reformer credits are finished", async () => {
    mockedConfig.WA_KEY_FINISHED_TEMPLATE = "_awa_key_reformer_finished_v2";
    mockedConfig.WA_KEY_FINISHED_TEMPLATE_LANG = "en";
    mocks.listActiveKeysForNudges.mockResolvedValue([
      activeKey({
        key_type: "INVITEE",
        plan_id: "invitee-plan",
        available_invitations: 0,
      }),
    ]);
    mocks.planRemainingSessions.mockResolvedValue(0);
    mocks.inviteeGuaranteeFacts.mockResolvedValue({
      reformerBookings: [{ slot_start: new Date("2026-07-31T12:30:00Z") }],
      bonusBookings: 0,
    });

    await expect(sweepKeyNudges(log)).resolves.toBe(1);

    expect(mocks.sendTemplate).toHaveBeenCalledWith(
      "221770000001",
      "_awa_key_reformer_finished_v2",
      "en",
      ["Aïda", "L'Invitée — Clé 3 séances"],
    );
    expect(mocks.addTurn).toHaveBeenCalledWith(
      "client-1",
      "assistant",
      expect.stringMatching(
        /je te conseille L’Habituée — Clé 6 séances[\s\S]*La Résidente propose 12 séances/,
      ),
    );
  });

  it("does not send the finished-credit offer when the next Key is already chosen or purchased", async () => {
    mockedConfig.WA_KEY_FINISHED_TEMPLATE = "_awa_key_reformer_finished_v2";
    mockedConfig.WA_KEY_FINISHED_TEMPLATE_LANG = "en";
    mocks.listActiveKeysForNudges.mockResolvedValue([
      activeKey({
        key_type: "INVITEE",
        plan_id: "invitee-plan",
        available_invitations: 0,
      }),
    ]);
    mocks.planRemainingSessions.mockResolvedValue(0);
    mocks.inviteeGuaranteeFacts.mockResolvedValue({
      reformerBookings: [{ slot_start: new Date("2026-07-31T12:30:00Z") }],
      bonusBookings: 0,
    });
    mocks.hasNextKeyCommitment.mockResolvedValue(true);

    await expect(sweepKeyNudges(log)).resolves.toBe(0);

    expect(mocks.hasNextKeyCommitment).toHaveBeenCalledWith({
      keyId: "key-1",
      clientId: "client-1",
      paidOrderId: "paid-1",
      family: "REFORMER",
    });
    expect(mocks.claimKeyNudge).not.toHaveBeenCalled();
    expect(mocks.sendTemplate).not.toHaveBeenCalled();
    expect(mocks.addTurn).not.toHaveBeenCalled();
  });
});
