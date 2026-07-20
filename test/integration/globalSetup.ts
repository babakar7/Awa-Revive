import { execSync } from "node:child_process";
import pg from "pg";

/**
 * Starts one throwaway Postgres container for the whole integration run and
 * exposes it via DATABASE_URL. Runs in the vitest main process BEFORE any
 * worker is spawned, so the env set here is inherited by the workers — which
 * matters because src/config.ts reads process.env at import time.
 *
 * Plain `docker` CLI instead of testcontainers: no dependency on undici/Node
 * version coupling, and the whole lifecycle is ~40 transparent lines. Port 0
 * lets Docker pick a free host port (no clashes with a local Postgres).
 *
 * All external-API credentials are dummies: every outbound HTTP call is
 * intercepted by the fetch mock in helpers.ts, and webhook signatures are
 * computed with these same dummy secrets. No real service is ever contacted.
 */

const CONTAINER = "resabot-integration-pg";

export async function setup(): Promise<void> {
  // Remove any leftover from a crashed previous run.
  try {
    execSync(`docker rm -f ${CONTAINER}`, { stdio: "ignore" });
  } catch {
    /* not running — fine */
  }

  execSync(
    `docker run -d --name ${CONTAINER} ` +
      `-e POSTGRES_PASSWORD=test -e POSTGRES_DB=resabot_test ` +
      `-p 127.0.0.1:0:5432 postgres:16-alpine`,
    { stdio: "ignore" },
  );
  const mapped = execSync(`docker port ${CONTAINER} 5432/tcp`).toString().trim();
  const port = mapped.split("\n")[0].split(":").pop();
  const url = `postgresql://postgres:test@127.0.0.1:${port}/resabot_test`;

  // Poll a real TCP connection from the host. (pg_isready inside the
  // container reports ready during the image's temporary init server, before
  // the final server is actually reachable from outside.)
  const deadline = Date.now() + 60_000;
  for (;;) {
    const client = new pg.Client({ connectionString: url });
    try {
      await client.connect();
      await client.query("select 1");
      await client.end();
      break;
    } catch {
      await client.end().catch(() => {});
      if (Date.now() > deadline) {
        throw new Error(`Postgres container did not become ready on ${url}`);
      }
      await new Promise((r) => setTimeout(r, 250));
    }
  }

  Object.assign(process.env, {
    DATABASE_URL: url,

    // Meta / WhatsApp
    WA_PHONE_NUMBER_ID: "test-phone-id",
    WA_ACCESS_TOKEN: "test-wa-token",
    WA_APP_SECRET: "test-app-secret",
    WA_VERIFY_TOKEN: "test-verify-token",

    // Wix
    WIX_API_KEY: "test-wix-key",
    WIX_SITE_ID: "test-site-id",

    // Wave
    WAVE_API_KEY: "test-wave-key",
    WAVE_WEBHOOK_SECRET: "test-wave-webhook-secret",

    // Orange Money / Max It — dummy credentials so isOmEnabled() is true and
    // verify-by-lookup can run; every OM HTTP call is intercepted by the
    // fetch mock (never hits Sonatel).
    OM_CLIENT_ID: "test-om-client",
    OM_CLIENT_SECRET: "test-om-secret",
    OM_MERCHANT_CODE: "553651",
    OM_API_BASE: "https://api.orange-sonatel.test",

    // Anthropic (never called in these tests)
    ANTHROPIC_API_KEY: "test-anthropic-key",

    // Notifications — key set so the email path is exercised (against the mock).
    // WA_RECEPTION_TEMPLATE pinned empty so the real .env (loaded by dotenv,
    // which never overrides existing vars) can't switch on the template
    // fallback and make tests environment-dependent.
    BREVO_API_KEY: "test-brevo-key",
    OWNER_PAYMENTS_PASSWORD: "test-owner-password",
    WA_RECEPTION_TEMPLATE: "",
    RECEPTION_EMAIL: "reception@test.local",
    RECEPTION_PHONE: "+221780000000",

    // App
    BASE_URL: "http://localhost:3000",
    PAYMENT_LINK_TTL_MINUTES: "20",
  });
}

export async function teardown(): Promise<void> {
  try {
    execSync(`docker rm -f ${CONTAINER}`, { stdio: "ignore" });
  } catch {
    /* already gone */
  }
}
