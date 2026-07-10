/**
 * Wave webhook simulator (SPEC §10 test setup).
 *
 * Usage:
 *   npm run simulate:wave -- <pending_booking_id> [--url http://localhost:3000/webhooks/wave] [--bad-signature]
 *
 * Posts a signed `checkout.session.completed` event for the given
 * client_reference, exactly like Wave would. Run it twice to test idempotency
 * (each run gets a fresh event id — pass --event-id X to reuse one).
 */
import "dotenv/config";
import crypto from "node:crypto";
import { signWavePayload } from "../src/lib/wave.js";

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const clientReference = process.argv[2];
if (!clientReference || clientReference.startsWith("--")) {
  console.error("Usage: npm run simulate:wave -- <pending_booking_id> [--url <url>] [--bad-signature] [--event-id <id>]");
  process.exit(1);
}

const url = arg("--url") ?? "http://localhost:3000/webhooks/wave";
const eventId = arg("--event-id") ?? `EV_sim_${crypto.randomBytes(8).toString("hex")}`;
const badSignature = process.argv.includes("--bad-signature");

const secret = process.env.WAVE_WEBHOOK_SECRET;
if (!secret) {
  console.error("WAVE_WEBHOOK_SECRET is not set in .env");
  process.exit(1);
}

const payload = JSON.stringify({
  id: eventId,
  type: "checkout.session.completed",
  data: {
    id: `cos-sim-${crypto.randomBytes(6).toString("hex")}`,
    amount: "100",
    currency: "XOF",
    client_reference: clientReference,
    payment_status: "succeeded",
    checkout_status: "complete",
    mobile: "+221770000000",
    when_completed: new Date().toISOString(),
  },
});

const signature = badSignature
  ? "t=1234567890,v1=deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef"
  : signWavePayload(payload, secret);

const res = await fetch(url, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "Wave-Signature": signature,
  },
  body: payload,
});

console.log(`POST ${url}`);
console.log(`event id:        ${eventId}`);
console.log(`client_reference:${clientReference}`);
console.log(`signature:       ${badSignature ? "INVALID (test)" : "valid"}`);
console.log(`response:        ${res.status} ${await res.text()}`);
