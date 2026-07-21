/**
 * One-time backfill: name the clients who show as "(sans nom)" in the admin
 * even though a matching Wix contact exists. Mirrors the passive enrichment on
 * inbound (src/agent/index.ts): for each nameless local client, look up the Wix
 * fiche by phone and copy the canonical name — but ONLY on a UNIQUE match
 * (findContactByPhone returns null on zero OR ambiguous matches), so we never
 * guess a name onto the wrong person.
 *
 * Idempotent: once a client is named it no longer qualifies, so re-running is
 * safe. Wix calls are paced to stay polite with the contacts API.
 *
 * Usage: railway run npx tsx scripts/backfill-client-names.ts --dry   (preview)
 *        railway run npx tsx scripts/backfill-client-names.ts         (apply)
 *
 * `railway run` provides the Wix credentials but injects the INTERNAL database
 * URL (unreachable from a laptop), so — like scripts/dev-prod-db.ts — we pull the
 * Postgres service's public URL via the Railway CLI and use that. If the CLI is
 * unavailable (e.g. running on the server), the injected DATABASE_URL is kept.
 */
import { execFileSync } from "node:child_process";

try {
  const out = execFileSync("railway", ["variables", "--service", "Postgres", "--json"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const publicUrl = JSON.parse(out)?.DATABASE_PUBLIC_URL;
  if (typeof publicUrl === "string" && /^postgres(?:ql)?:\/\//.test(publicUrl)) {
    process.env.DATABASE_URL = publicUrl;
  }
} catch {
  // No Railway CLI (server run) — keep the DATABASE_URL already in the env.
}

const DRY = process.argv.includes("--dry");
const PACE_MS = 400;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const { pool, closeDb } = await import("../src/db/index.js");
  const { findContactByPhone } = await import("../src/lib/wix.js");

  const { rows } = await pool.query<{ id: string; wa_phone: string; is_test: boolean }>(
    `select id, wa_phone, is_test from clients
      where (name is null or btrim(name) = '')
      order by created_at asc`,
  );

  console.log(
    `${rows.length} client(s) sans nom à examiner${DRY ? " (DRY RUN — aucune écriture)" : ""}.`,
  );

  let named = 0;
  let noMatch = 0;
  let failed = 0;

  for (const [i, client] of rows.entries()) {
    const tag = client.is_test ? " [test]" : "";
    try {
      const contact = await findContactByPhone(client.wa_phone);
      const fullName = contact?.fullName?.trim();
      if (!fullName) {
        noMatch++;
        console.log(`· +${client.wa_phone}${tag} → aucune fiche unique`);
      } else {
        if (!DRY) await pool.query(
          `update clients set name = $2, updated_at = now()
            where id = $1 and (name is null or name <> $2)`,
          [client.id, fullName],
        );
        named++;
        console.log(`✓ +${client.wa_phone}${tag} → « ${fullName} »${DRY ? " (à écrire)" : ""}`);
      }
    } catch (err) {
      failed++;
      console.error(`✗ +${client.wa_phone}${tag} → erreur:`, (err as Error).message);
    }
    if (i < rows.length - 1) await sleep(PACE_MS);
  }

  console.log(
    `\nTerminé : ${named} nommé(s), ${noMatch} sans fiche unique, ${failed} en erreur.`,
  );
  await closeDb();
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
