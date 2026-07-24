import { config } from "../config.js";
import * as wave from "../lib/wave.js";
import * as om from "../lib/orangeMoney.js";
import { withTransientRetry } from "../lib/retry.js";

export type MobilePaymentMethod = "wave" | "orange_money" | "maxit";

export interface ClientPaymentSession {
  sessionId: string;
  paymentLink: string;
  expiresAt: Date;
  method: MobilePaymentMethod;
}

/** Shared Wave / Orange Money session creation for every payable order kind. */
export async function createClientPaymentSession(args: {
  method: MobilePaymentMethod;
  amountXof: number;
  clientReference: string;
  name: string;
}): Promise<ClientPaymentSession> {
  const ttlMin = config.PAYMENT_LINK_TTL_MINUTES;
  const t0 = Date.now();
  if (args.method === "wave") {
    // One retry on a transient provider hiccup (5xx/429/network): a payment
    // session is safe to recreate — a failed first attempt returns no link, so
    // the orphaned session is never shown or paid. Avoids the "service
    // temporarily unavailable" → immediate handoff we saw strand a client.
    const session = await withTransientRetry(
      () => wave.createCheckoutSession({ amountXof: args.amountXof, clientReference: args.clientReference }),
      { label: "wave.createCheckoutSession" },
    );
    console.log(`[pay] wave checkout ${Date.now() - t0}ms`);
    return {
      sessionId: session.id,
      paymentLink: session.wave_launch_url,
      expiresAt: new Date(Date.now() + ttlMin * 60_000),
      method: "wave",
    };
  }

  const qr = await withTransientRetry(
    () =>
      om.createQrPayment({
        amountXof: args.amountXof,
        clientReference: args.clientReference,
        name: args.name,
        validityMinutes: ttlMin,
        callbackUrl: `${config.BASE_URL}/webhooks/orange-money`,
        successUrl: `${config.BASE_URL}/payment/success`,
        cancelUrl: `${config.BASE_URL}/payment/error`,
      }),
    { label: "om.createQrPayment" },
  );
  const link = om.pickDeepLink(args.method, qr.deepLink, qr.deepLinks);
  const expiresAt =
    qr.validUntil && qr.validUntil.getTime() > Date.now()
      ? new Date(Math.min(qr.validUntil.getTime(), Date.now() + ttlMin * 60_000))
      : new Date(Date.now() + ttlMin * 60_000);
  console.log(`[pay] om/${args.method} session ${Date.now() - t0}ms qrId=${qr.qrId}`);
  return { sessionId: qr.qrId, paymentLink: link, expiresAt, method: args.method };
}
