/**
 * Create an Orange Money / Max It payment session and print deep links.
 *
 * Usage:
 *   npm run om:create-link -- [amount_xof] [--order <pending_id>] [--ttl <minutes>]
 *
 * Examples:
 *   npm run om:create-link -- 100
 *   npm run om:create-link -- 100 --order 550e8400-e29b-41d4-a716-446655440000
 *
 * Opens the printed HTTPS link on a phone → Orange Money or Max It app.
 * X-Callback-Url points at Awa's webhook (BASE_URL/webhooks/orange-money).
 * For a full fulfill test, pass a real pending_bookings (or plan/cafe) id as --order.
 */
import "dotenv/config";
import { config } from "../src/config.js";
import * as om from "../src/lib/orangeMoney.js";

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const amountArg = process.argv[2];
const amountXof = amountArg && !amountArg.startsWith("--") ? parseInt(amountArg, 10) : 100;
if (!Number.isFinite(amountXof) || amountXof < 1) {
  console.error("Usage: npm run om:create-link -- [amount_xof] [--order <id>] [--ttl <minutes>]");
  process.exit(1);
}

const orderId = arg("--order") ?? `manual-${Date.now()}`;
const ttl = parseInt(arg("--ttl") ?? String(config.PAYMENT_LINK_TTL_MINUTES || 20), 10);

if (!om.isOmEnabled()) {
  console.error(
    "Orange Money is not configured. Set OM_CLIENT_ID, OM_CLIENT_SECRET, OM_MERCHANT_CODE in .env",
  );
  process.exit(1);
}

const base = config.BASE_URL.replace(/\/$/, "");
const callbackUrl = `${base}/webhooks/orange-money`;

console.log("Creating OM session…");
console.log(`  amount:     ${amountXof} XOF`);
console.log(`  order id:   ${orderId}`);
console.log(`  merchant:   ${config.OM_MERCHANT_CODE}`);
console.log(`  callback:   ${callbackUrl}`);
console.log(`  validity:   ${ttl} min (request body; check validFor in response)`);
console.log("");

try {
  const session = await om.createQrPayment({
    amountXof,
    clientReference: orderId,
    name: "Awa test",
    validityMinutes: ttl,
    callbackUrl,
    successUrl: `${base}/payment/success`,
    cancelUrl: `${base}/payment/error`,
  });

  const omLink = om.pickDeepLink("orange_money", session.deepLink, session.deepLinks);
  const maxitLink = om.pickDeepLink("maxit", session.deepLink, session.deepLinks);

  console.log("✅ Session created");
  console.log(`  qrId:       ${session.qrId}`);
  if (session.validUntil) {
    console.log(`  valid until: ${session.validUntil.toISOString()}`);
  }
  console.log("");
  console.log("Open on your phone (tap or paste into Safari):");
  console.log("");
  console.log("  Orange Money:");
  console.log(`  ${omLink}`);
  console.log("");
  console.log("  Max It:");
  console.log(`  ${maxitLink}`);
  console.log("");
  if (orderId.startsWith("manual-")) {
    console.log(
      "Note: order id is a test placeholder — webhook will log but not fulfill a booking.\n" +
        "For a real fulfill test: create a pending booking (or pass --order <uuid> of an AWAITING_PAYMENT row).",
    );
  } else {
    console.log(
      "After you pay, Awa should receive the webhook and (if order id matches a pending row) fulfill.",
    );
  }
} catch (err) {
  console.error("Failed:", err instanceof Error ? err.message : err);
  process.exit(1);
}
