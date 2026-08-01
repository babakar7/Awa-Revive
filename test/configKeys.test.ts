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
});
