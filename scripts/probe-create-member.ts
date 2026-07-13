/**
 * ONE-OFF PROBE (ops) — can we CREATE a Wix member so a pricing plan
 * auto-activates for a brand-new client? RESULT (13/07, closed): technically
 * YES, but it's a NO-GO for us.
 *   - POST /members/v1/members → 200; createOfflinePlanOrder with that member
 *     id then activates the plan (ACTIVE even when member.status is PENDING).
 *   - BUT Wix emails the client a Wix invite / set-password / welcome mail —
 *     unacceptable in a silent WhatsApp payment flow.
 * Decision: Awa does NOT create members. It auto-activates only when a member
 * already exists; otherwise the manual reception path (dashboard, where the
 * client email is optional). See PLAN-PACK-DECOUVERTE-ACTIVATION.md.
 *
 * Kept only to RE-VALIDATE if Wix later lets us suppress the invite email
 * site-wide — do NOT wire member creation into production fulfillment.
 *
 * ⚠️ Hits LIVE Wix and creates a REAL member (and emails a real address).
 *    Use a disposable email you control. Clean up with --delete afterwards.
 *
 * Usage:
 *   npm run wix:probe-member -- <test-email>                 # create + report
 *   npm run wix:probe-member -- --activate <planId> <memberId>  # test activation
 *   npm run wix:probe-member -- --delete <memberId>          # cleanup
 *
 * A safe, valid pricing planId for --activate can be read from `npm run summary`
 * or the Wix dashboard; pick a FREE / cheapest plan to avoid side effects.
 */
import "dotenv/config";
import { config } from "../src/config.js";

const WIX_API = "https://www.wixapis.com";

function headers(): Record<string, string> {
  return {
    Authorization: config.WIX_API_KEY,
    "wix-site-id": config.WIX_SITE_ID,
    "Content-Type": "application/json",
    "User-Agent": "resabot/1.0",
  };
}

async function wix(method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(`${WIX_API}${path}`, {
    method,
    headers: headers(),
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  const text = await res.text();
  let json: any;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = text;
  }
  return { status: res.status, json };
}

function show(label: string, v: unknown): void {
  console.log(`\n=== ${label} ===`);
  console.log(typeof v === "string" ? v : JSON.stringify(v, null, 2));
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);

  if (argv[0] === "--delete") {
    const memberId = argv[1];
    if (!memberId) throw new Error("Usage: --delete <memberId>");
    const { status, json } = await wix("DELETE", `/members/v1/members/${memberId}`);
    show(`DELETE member ${memberId} → HTTP ${status}`, json);
    return;
  }

  if (argv[0] === "--activate") {
    const [, planId, memberId] = argv;
    if (!planId || !memberId) throw new Error("Usage: --activate <planId> <memberId>");
    const { status, json } = await wix("POST", "/pricing-plans/v2/checkout/orders/offline", {
      planId,
      memberId,
      paid: true,
    });
    show(`createOfflinePlanOrder(plan=${planId}, member=${memberId}) → HTTP ${status}`, json);
    console.log(
      status < 300
        ? "\n✅ Activation works with a freshly created member id → étape 2b viable."
        : "\n❌ Activation failed with this member id — inspect the error above.",
    );
    return;
  }

  const email = argv[0];
  if (!email || !email.includes("@")) {
    throw new Error("Usage: npm run wix:probe-member -- <test-email> (use a disposable inbox you own)");
  }

  console.log(`Probing Wix member creation for ${email}`);
  console.log("⚠️  This creates a REAL member on the live site and MAY email that address.");
  console.log("    Watch the inbox, then clean up with --delete <memberId>.\n");

  // 1. Auth sanity: query members (read-only).
  const q = await wix("POST", "/members/v1/members/query", { query: { paging: { limit: 1 } } });
  show(`members/query (auth check) → HTTP ${q.status}`, q.status < 300 ? `ok (${q.json?.members?.length ?? 0} row shown)` : q.json);
  if (q.status >= 300) {
    console.log("\n❌ Auth/read failed — fix credentials before probing creation.");
    return;
  }

  // 2. Create the member. The Members API shape: { member: { loginEmail } }.
  const create = await wix("POST", "/members/v1/members", { member: { loginEmail: email } });
  show(`POST /members/v1/members → HTTP ${create.status}`, create.json);

  const member = create.json?.member;
  if (create.status >= 300 || !member?.id) {
    console.log("\n❌ Member creation did not return a usable member — likely a no-go; keep the manual fallback.");
    return;
  }

  console.log("\n--- READ THIS ---");
  console.log(`member.id       : ${member.id}`);
  console.log(`member.status   : ${member.status ?? "(none)"}  ← APPROVED = usable now; PENDING = probably a no-go`);
  console.log(`contactId       : ${member.contactId ?? "(none)"}  ← should match the existing fiche for this email`);
  console.log(`loginEmail      : ${member?.loginEmail ?? member?.profile?.loginEmail ?? "(none)"}`);
  console.log("\n👉 NOW CHECK THE TEST INBOX: did Wix send an invite / set-password / welcome email?");
  console.log("   An email to the client = the strongest reason NOT to auto-create members silently.");
  console.log(`\n🧹 Cleanup when done:\n   npm run wix:probe-member -- --delete ${member.id}`);
  console.log(`\n▶️  Optional activation test (pick a cheap/free planId):\n   npm run wix:probe-member -- --activate <planId> ${member.id}`);
}

main().catch((err) => {
  console.error("Probe failed:", err);
  process.exit(1);
});
