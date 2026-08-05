import { afterEach, describe, expect, it, vi } from "vitest";

const requiredBase = {
  NODE_ENV: "production",
  WA_PHONE_NUMBER_ID: "test-phone",
  WA_ACCESS_TOKEN: "test-token",
  WA_APP_SECRET: "test-app-secret",
  WA_VERIFY_TOKEN: "test-verify-token",
  WIX_API_KEY: "test-wix-key",
  WIX_SITE_ID: "test-wix-site",
  WAVE_API_KEY: "test-wave-key",
  WAVE_WEBHOOK_SECRET: "test-wave-webhook",
  ANTHROPIC_API_KEY: "test-anthropic-key",
  DATABASE_URL: "postgres://test:test@localhost/test",
  BASE_URL: "https://example.test",
  AWA_SELLABLE_PLAN_IDS: "legacy-plan-only",
  KEYS_AUTOMATION_ENABLED: "true",
  INVITEE_PLAN_ID: "invitee",
  INVITEE_BONUS_PLAN_ID: "invitee-bonus",
  HABITUEE_PLAN_ID: "habituee",
  HABITUEE_BONUS_PLAN_ID: "habituee-bonus",
  RESIDENTE_PLAN_ID: "residente",
  RESIDENTE_BONUS_PLAN_ID: "residente-bonus",
  INVITATION_PLAN_ID: "invitation",
  KEY_REFORMER_SERVICE_IDS: "reformer",
  KEY_BONUS_SERVICE_IDS: "yoga",
  LEGACY_REFORMER_PLAN_IDS: "legacy-reformer",
  INVITEE_HISTORY_PLAN_IDS: "old-discovery,invitee",
  WIX_WEBHOOK_PUBLIC_KEY: "test-public-key",
};

async function loadConfig(overrides: Record<string, string> = {}) {
  for (const [name, value] of Object.entries({ ...requiredBase, ...overrides })) {
    vi.stubEnv(name, value);
  }
  vi.resetModules();
  return import("../src/config.js");
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("Clés production preflight", () => {
  it("allows masked provisioning while paid Keys stay outside Awa's allowlist and templates stay dark", async () => {
    const { assertConfig } = await loadConfig({
      WA_KEY_INVITEE_J5_TEMPLATE: "",
      WA_KEY_THIRD_SESSION_TEMPLATE: "",
      WA_KEY_MEMBER_J5_TEMPLATE: "",
      WA_KEY_INVITATION_J10_TEMPLATE: "",
      WA_KEY_MEMBER_J5_INVITATION_TEMPLATE: "",
      WA_KEY_FINISHED_TEMPLATE: "",
      WA_LEGACY_KEY_CONVERSION_TEMPLATE: "",
    });

    expect(() => assertConfig()).not.toThrow();
  });

  it("still rejects missing core provisioning mappings", async () => {
    const { assertConfig } = await loadConfig({ HABITUEE_BONUS_PLAN_ID: "" });

    expect(() => assertConfig()).toThrow(/HABITUEE_BONUS_PLAN_ID/);
  });

  it("never prevents the bot from booting for an invalid optional ads mapping", async () => {
    const { assertConfig } = await loadConfig({ AD_CAMPAIGN_MAP: "not-a-campaign-map" });
    expect(() => assertConfig()).not.toThrow();
  });

  it("boots with the Aquabike/sur-mesure vars unset (they are never required)", async () => {
    const { assertConfig } = await loadConfig();
    // requiredBase never sets SUR_MESURE_/AQUABIKE_* — boot must still succeed.
    expect(() => assertConfig()).not.toThrow();
  });

  it("keeps a partially-configured Aquabike plan dark (no mapping, no automation)", async () => {
    const mod = await loadConfig({
      AQUABIKE_ABO_PLAN_ID: "aquabike-abo",
      // bonus, invitation and services intentionally left unset
    });
    const { configuredKeyMappings, keyMappingForPlan } = await import(
      "../src/domain/keyRules.js"
    );
    expect(keyMappingForPlan("aquabike-abo")).toBeNull();
    expect(configuredKeyMappings().some((m) => m.type === "AQUABIKE")).toBe(false);
    // The three Clés remain configured.
    expect(configuredKeyMappings().map((m) => m.type).sort()).toEqual([
      "HABITUEE",
      "INVITEE",
      "RESIDENTE",
    ]);
    void mod;
  });

  it("brings the Aquabike + sur-mesure plans alive once fully configured", async () => {
    await loadConfig({
      AQUABIKE_ABO_PLAN_ID: "aquabike-abo",
      AQUABIKE_BONUS_PLAN_ID: "aquabike-bonus",
      AQUABIKE_INVITATION_PLAN_ID: "aquabike-invitation",
      AQUABIKE_SERVICE_IDS: "svc-aquabike",
      SUR_MESURE_PLAN_ID: "sur-mesure",
    });
    const { keyMappingForPlan } = await import("../src/domain/keyRules.js");
    const aqua = keyMappingForPlan("aquabike-abo");
    expect(aqua).toMatchObject({ type: "AQUABIKE", family: "AQUABIKE", baseInvitations: 1 });
    expect(aqua?.invitation.slotRule).toBe("ANY_WEEKDAY_HOUR");
    expect(aqua?.invitation.friendRule).toBe("NEVER_AQUABIKE");
    const sur = keyMappingForPlan("sur-mesure");
    expect(sur).toMatchObject({ type: "SUR_MESURE", family: "REFORMER", bonus: null });
  });

  it("supports several sur-mesure plans and merges the legacy singular var", async () => {
    await loadConfig({
      SUR_MESURE_PLAN_ID: "sur-mesure-legacy",
      SUR_MESURE_PLAN_IDS: "sur-mesure-legacy, sur-mesure-2",
    });
    const { configuredKeyMappings, keyMappingForPlan, keyMappingForType } = await import(
      "../src/domain/keyRules.js"
    );
    // The overlapping id is deduped: exactly one mapping per plan.
    const surMesure = configuredKeyMappings().filter((m) => m.type === "SUR_MESURE");
    expect(surMesure.map((m) => m.planId).sort()).toEqual([
      "sur-mesure-2",
      "sur-mesure-legacy",
    ]);
    expect(keyMappingForPlan("sur-mesure-2")).toMatchObject({
      type: "SUR_MESURE",
      family: "REFORMER",
      durationDays: 30,
      baseInvitations: 1,
      bonus: null,
    });
    // Type lookup stays safe: every SUR_MESURE mapping carries identical rules.
    expect(keyMappingForType("SUR_MESURE")?.invitation.slotRule).toBe("CALM_SLOT_1230");
  });
});
