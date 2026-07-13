/**
 * ONE-OFF LIVE PROBE — can we auto-activate a pricing plan for a CONTACT that
 * has no site member? RESULT (13/07, closed): NO.
 *   - offline order with the contactId in the memberId field → 400
 *     MEMBER_DOESNT_EXIST (a real member id is mandatory).
 *   - create member (POST /members/v1/members) then offline → 200 ACTIVE, BUT
 *     Wix emails the client a Wix invite / set-password mail.
 * Decision: Awa does NOT create members to activate plans (the client email is
 * unacceptable in a silent WhatsApp flow); it auto-activates only when a member
 * already exists, else the manual reception path (dashboard, email optional).
 * See PLAN-PACK-DECOUVERTE-ACTIVATION.md. Kept only to RE-VALIDATE if Wix ever
 * lets us suppress the invite email site-wide — do not wire into production.
 *
 * Usage:
 *   npm run wix:probe-contact-plan -- <email> [First Last]
 *
 * Steps:
 *   1. Find or create contact (email + name)
 *   2. Look up member for that contact
 *   3. List plans; pick free (0 F) if any, else cheapest
 *   4. Try createOfflineOrder with contactId in the memberId field
 *   5. If that fails and no member: create member, retry offline with memberId
 *
 * ⚠️ Hits LIVE Wix. Prefer free plans. Check the inbox if step 5 runs.
 * Cleanup: cancel the order in Wix dashboard; optional member delete via
 *   npm run wix:probe-member -- --delete <memberId>
 */
import "dotenv/config";

const WIX_API = "https://www.wixapis.com";
const email = process.argv[2];
const nameArg = process.argv.slice(3).join(" ").trim() || "Test Test";

if (!email || !email.includes("@")) {
  console.error("Usage: npx tsx scripts/probe-contact-plan.ts <email> [First Last]");
  process.exit(1);
}
if (!process.env.WIX_API_KEY || !process.env.WIX_SITE_ID) {
  console.error("Missing WIX_API_KEY / WIX_SITE_ID in env");
  process.exit(1);
}

function headers(): Record<string, string> {
  return {
    Authorization: process.env.WIX_API_KEY!,
    "wix-site-id": process.env.WIX_SITE_ID!,
    "Content-Type": "application/json",
    "User-Agent": "resabot/1.0",
  };
}

async function wix(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; json: any }> {
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
  const parts = nameArg.split(/\s+/);
  const first = parts[0] ?? "Test";
  const last = parts.slice(1).join(" ") || "Test";

  console.log(`Probe contact→plan for ${email} (${first} ${last})`);
  console.log("LIVE Wix — will create contact/order/member only as needed.\n");

  // 1. Find contact by email
  let find = await wix("POST", "/contacts/v4/contacts/query", {
    query: { filter: { "info.emails.email": { $eq: email } } },
  });
  show(`contacts/query by email → HTTP ${find.status}`, {
    count: find.json?.contacts?.length ?? 0,
    ids: (find.json?.contacts ?? []).map((c: any) => c.id),
  });
  if (find.status >= 300) {
    console.error("Contact query failed — abort");
    process.exit(1);
  }

  let contact = find.json?.contacts?.[0] ?? null;
  if (!contact) {
    const create = await wix("POST", "/contacts/v4/contacts", {
      info: {
        name: { first, last },
        emails: { items: [{ tag: "MAIN", email }] },
      },
    });
    show(`createContact → HTTP ${create.status}`, create.json);
    contact = create.json?.contact ?? null;
    if (!contact?.id) {
      console.error("Could not create contact — abort");
      process.exit(1);
    }
  } else {
    console.log(
      `\nUsing existing contact ${contact.id} ` +
        `(${contact?.info?.name?.first ?? "?"} ${contact?.info?.name?.last ?? ""})`,
    );
  }
  const contactId: string = contact.id;

  // 2. Member for this contact?
  const memQ = await wix("POST", "/members/v1/members/query", {
    query: { filter: { contactId } },
  });
  const members = memQ.json?.members ?? [];
  show(`members/query contactId=${contactId} → HTTP ${memQ.status}`, {
    count: members.length,
    members: members.map((m: any) => ({
      id: m.id,
      status: m.status,
      loginEmail: m.loginEmail ?? m.profile?.loginEmail,
      contactId: m.contactId,
    })),
  });
  const existingMemberId: string | null = members[0]?.id ?? null;

  // 3. Plans — prefer free
  const plansRes = await fetch(`${WIX_API}/pricing-plans/v2/plans?limit=100`, {
    headers: headers(),
    signal: AbortSignal.timeout(20_000),
  });
  const plansJson: any = await plansRes.json();
  const plans = (plansJson?.plans ?? [])
    .filter((p: any) => !p.archived && !p.hidden)
    .map((p: any) => ({
      id: p.id,
      name: p.name,
      price: Number(p?.pricing?.price?.value ?? 0),
    }))
    .sort((a: any, b: any) => a.price - b.price);

  console.log("\n=== sellable plans (cheapest first) ===");
  for (const p of plans.slice(0, 12)) {
    console.log(`  ${p.price} F  ${p.name}  ${p.id}`);
  }
  if (plans.length === 0) {
    console.error("No plans — abort");
    process.exit(1);
  }

  // Prefer free; otherwise do NOT auto-activate a paid plan without saying so.
  const free = plans.find((p: any) => p.price === 0);
  const plan = free ?? plans[0];
  if (!free) {
    console.log(
      `\n⚠️  No free plan. Will attempt offline order on cheapest: ` +
        `${plan.name} (${plan.price} F). Cancel in Wix if it activates.`,
    );
  } else {
    console.log(`\nUsing free plan: ${plan.name} (${plan.id})`);
  }

  // 4. Offline with contactId as memberId (the hypothesis)
  console.log(`\n--- Attempt A: offline order with contactId as memberId ---`);
  const offlineContact = await wix("POST", "/pricing-plans/v2/checkout/orders/offline", {
    planId: plan.id,
    memberId: contactId,
    paid: true,
  });
  show(`offline(contactId) → HTTP ${offlineContact.status}`, offlineContact.json);
  if (offlineContact.status < 300 && offlineContact.json?.order?.id) {
    console.log("\n✅ SUCCESS: contactId works as memberId for createOfflineOrder.");
    console.log(`   orderId: ${offlineContact.json.order.id}`);
    console.log(`   buyer: ${JSON.stringify(offlineContact.json.order.buyer)}`);
    console.log(`   status: ${offlineContact.json.order.status}`);
    console.log("\n👉 Check Wix dashboard: plan should be on this contact. Cancel if test junk.");
    return;
  }
  console.log("\n❌ contactId-as-memberId failed (expected if docs are strict).");

  // 5. If we already have a member, try with that
  if (existingMemberId) {
    console.log(`\n--- Attempt B: offline order with existing memberId ---`);
    const offlineMem = await wix("POST", "/pricing-plans/v2/checkout/orders/offline", {
      planId: plan.id,
      memberId: existingMemberId,
      paid: true,
    });
    show(`offline(memberId) → HTTP ${offlineMem.status}`, offlineMem.json);
    if (offlineMem.status < 300) {
      console.log("\n✅ Existing member activates plans. No create-member needed for this contact.");
    } else {
      console.log("\n❌ Even existing memberId failed — inspect error above.");
    }
    return;
  }

  // 6. Create member + retry (B2 probe)
  console.log(`\n--- Attempt C: create member for ${email}, then offline ---`);
  console.log("⚠️  This MAY email the address (invite / set-password). Watch the inbox.");
  const createMem = await wix("POST", "/members/v1/members", {
    member: { loginEmail: email },
  });
  show(`POST /members/v1/members → HTTP ${createMem.status}`, createMem.json);
  const member = createMem.json?.member;
  if (createMem.status >= 300 || !member?.id) {
    console.log("\n❌ Member creation failed — keep manual activation.");
    return;
  }
  console.log(`member.id=${member.id} status=${member.status} contactId=${member.contactId}`);
  console.log("👉 CHECK INBOX NOW for Wix invite/password email.");

  const offlineNew = await wix("POST", "/pricing-plans/v2/checkout/orders/offline", {
    planId: plan.id,
    memberId: member.id,
    paid: true,
  });
  show(`offline(newMemberId) → HTTP ${offlineNew.status}`, offlineNew.json);
  if (offlineNew.status < 300) {
    console.log("\n✅ B2 path works: createMember → createOfflineOrder.");
    console.log(`   orderId: ${offlineNew.json?.order?.id}`);
  } else {
    console.log("\n❌ Member created but offline order failed.");
  }
  console.log(`\n🧹 Cleanup member if needed:\n   npm run wix:probe-member -- --delete ${member.id}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
