/**
 * Bulk-merge the duplicate contact groups that pile up in /admin/crm, in one
 * pass, with the SAME safety rule as the one-click merge (planMerge): a site
 * member or an active-plan holder is never a merge source, and a group where
 * nothing can be safely merged is skipped. Wix DELETES the sources — this is
 * IRREVERSIBLE.
 *
 * Usage:
 *   npm run crm:merge -- --dry    # report only, no writes (default if no --go)
 *   npm run crm:merge -- --go     # actually merge
 *
 * Reuses the exact production pipeline (src/lib/crmAudit.ts + src/lib/wix.ts).
 */
import {
  auditContacts,
  fetchAllContacts,
  planMerge,
  type DuplicateGroup,
} from "../src/lib/crmAudit.js";
import { listAllActiveOrders, findMemberContactIds, mergeContacts } from "../src/lib/wix.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function planHoldersForOrders(): Promise<Set<string>> {
  const holders = new Set<string>();
  for (const o of await listAllActiveOrders()) {
    const cid = (o as any)?.buyer?.contactId;
    if (cid) holders.add(cid);
  }
  return holders;
}

async function main() {
  const go = process.argv.includes("--go");
  const mode = go ? "EXECUTE" : "DRY-RUN";
  console.log(`\n=== Bulk merge duplicates — ${mode} ===\n`);

  const [rawContacts, planHolders] = await Promise.all([
    fetchAllContacts(),
    planHoldersForOrders(),
  ]);
  const audit = auditContacts(rawContacts);
  const groups = audit.duplicates;
  console.log(`${audit.total} contacts, ${groups.length} duplicate group(s).\n`);

  // Member status across every contact in every group, one batched lookup.
  const allDupIds = [...new Set(groups.flatMap((g) => g.contacts.map((c) => c.id)))];
  const memberIds = await findMemberContactIds(allDupIds);

  let merged = 0;
  let skipped = 0;
  let failed = 0;
  const nameOf = (g: DuplicateGroup, id: string) =>
    g.contacts.find((c) => c.id === id)?.name ?? id;

  for (const g of groups) {
    const groupPlanHolders = new Set(g.contacts.map((c) => c.id).filter((id) => planHolders.has(id)));
    const plan = planMerge(
      g.contacts.map((c) => ({ id: c.id, hasE164: c.hasE164, createdDate: c.createdDate })),
      groupPlanHolders,
      memberIds,
    );
    if (!plan) {
      skipped++;
      console.log(`SKIP  …${g.key}  [${g.contacts.map((c) => c.name).join(" / ")}] — nothing safe to merge`);
      continue;
    }
    const desc =
      `keep ${nameOf(g, plan.targetId)} (${plan.targetId}) ` +
      `<- absorb ${plan.sourceIds.map((id) => nameOf(g, id)).join(", ")}` +
      (plan.leftoverIds.length ? ` | leftover(protected): ${plan.leftoverIds.length}` : "");
    if (!go) {
      console.log(`PLAN  …${g.key}  ${desc}`);
      merged++; // counts as "would merge"
      continue;
    }
    try {
      await mergeContacts(plan.targetId, plan.sourceIds);
      merged++;
      console.log(`OK    …${g.key}  ${desc}`);
    } catch (e) {
      failed++;
      console.error(`FAIL  …${g.key}  ${desc}\n        ${String((e as Error).message).slice(0, 200)}`);
    }
    await sleep(1500); // space out writes to dodge Wix throttling
  }

  console.log(
    `\n=== ${mode} done: ${go ? merged + " merged" : merged + " would merge"}, ` +
      `${skipped} skipped (protected), ${failed} failed ===\n`,
  );
  if (!go) console.log("Re-run with --go to execute.\n");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
