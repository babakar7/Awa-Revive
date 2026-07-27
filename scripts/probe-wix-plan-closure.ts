import { assertConfig } from "../src/config.js";
import {
  getPlanV3,
  updatePlanAvailabilityV3,
} from "../src/lib/wix.js";

const planId = process.argv[process.argv.indexOf("--plan-id") + 1];
const apply = process.argv.includes("--apply");

if (!planId || planId.startsWith("--")) {
  throw new Error("Usage: npm run wix:probe-plan-closure -- --plan-id PLAN_ID [--apply]");
}
assertConfig();

const before = await getPlanV3(planId);
const snapshot = {
  planId,
  revision: String(before.revision ?? ""),
  visibility: String(before.visibility ?? ""),
  buyable: Boolean(before.buyable),
};
console.log(JSON.stringify({ mode: apply ? "probe-and-revert" : "read-only", before: snapshot }, null, 2));

if (!apply) process.exit(0);
if (!snapshot.revision) throw new Error("Plan has no revision; refusing to mutate");
if (!["PUBLIC", "PRIVATE"].includes(snapshot.visibility)) {
  throw new Error(`Unexpected visibility ${snapshot.visibility}; refusing to mutate`);
}

let changed = false;
try {
  // Set before the request: a network timeout can hide a successful mutation,
  // so the finally block must still re-read and restore.
  changed = true;
  const closed = await updatePlanAvailabilityV3({
    planId,
    revision: snapshot.revision,
    visibility: "PRIVATE",
    buyable: false,
  });
  const verified = await getPlanV3(planId);
  if (verified.visibility !== "PRIVATE" || verified.buyable !== false) {
    throw new Error("Wix accepted the patch but closure verification failed");
  }
  console.log(JSON.stringify({
    probe: "passed",
    closed: {
      revision: String(closed.revision ?? verified.revision ?? ""),
      visibility: verified.visibility,
      buyable: verified.buyable,
    },
  }, null, 2));
} finally {
  if (changed) {
    const current = await getPlanV3(planId);
    await updatePlanAvailabilityV3({
      planId,
      revision: String(current.revision),
      visibility: snapshot.visibility as "PUBLIC" | "PRIVATE",
      buyable: snapshot.buyable,
    });
    const restored = await getPlanV3(planId);
    if (
      restored.visibility !== snapshot.visibility ||
      Boolean(restored.buyable) !== snapshot.buyable
    ) {
      throw new Error("CRITICAL: probe ran but the original plan state was not restored");
    }
    console.log(JSON.stringify({ restored: snapshot }, null, 2));
  }
}
