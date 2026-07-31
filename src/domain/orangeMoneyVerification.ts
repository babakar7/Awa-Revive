import { config } from "../config.js";
import { pool } from "../db/index.js";
import {
  lookupSuccessfulTransaction,
  transactionMatchesPending,
  type OmTransaction,
} from "../lib/orangeMoney.js";
import { notifyReception } from "../lib/notify.js";
import { recordBookingFunnelEvent } from "./bookingFunnel.js";
import { findDeliveryPaymentAttemptById } from "./deliveryRepo.js";
import { processPayment, type PaymentLog } from "./fulfillment.js";
import * as repo from "./repo.js";

const LEASE_MS = 2 * 60_000;
const ALERT_AFTER_MS = 2 * 60_000;
const GIVE_UP_AFTER_MS = 7 * 24 * 60 * 60_000;
const RETRY_DELAYS_MS = [
  5_000,
  15_000,
  30_000,
  60_000,
  2 * 60_000,
  5 * 60_000,
  10 * 60_000,
  20 * 60_000,
  60 * 60_000,
];

export interface OmVerification {
  transaction_id: string;
  order_id: string;
  amount_xof: number;
  customer_id: string | null;
  status: "PENDING" | "SUCCEEDED" | "FAILED";
  attempts: number;
  next_attempt_at: Date;
  lease_until: Date | null;
  last_error: string | null;
  alerted_at: Date | null;
  completed_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export type OmVerificationOutcome =
  | "not_due"
  | "retry_scheduled"
  | "succeeded"
  | "failed";

export function omRetryDelayMs(attempts: number): number {
  const index = Math.max(0, Math.min(RETRY_DELAYS_MS.length - 1, attempts - 1));
  return RETRY_DELAYS_MS[index];
}

export async function findPendingOmOrder(
  orderId: string,
): Promise<{ amount_xof: number } | null> {
  const booking = await repo.findBookingById(orderId).catch(() => null);
  if (booking) return booking;
  const plan = await repo.findPlanOrderById(orderId).catch(() => null);
  if (plan) return plan;
  const cafe = await repo.findCafeOrderById(orderId).catch(() => null);
  if (cafe) return cafe;
  return findDeliveryPaymentAttemptById(orderId).catch(() => null);
}

/**
 * Durable receipt of an OM callback. A previously exhausted verification is
 * reopened by a fresh callback, but a transaction id can never be reassigned
 * to a different local order.
 */
export async function enqueueOmVerification(args: {
  transactionId: string;
  orderId: string;
  amountXof: number;
  customerId?: string | null;
}): Promise<OmVerification | null> {
  const res = await pool.query<OmVerification>(
    `insert into orange_money_verifications
       (transaction_id, order_id, amount_xof, customer_id)
     values ($1,$2,$3,$4)
     on conflict (transaction_id) do update
       set customer_id=coalesce(excluded.customer_id,orange_money_verifications.customer_id),
           status=case when orange_money_verifications.status='FAILED' then 'PENDING'
                       else orange_money_verifications.status end,
           attempts=case when orange_money_verifications.status='FAILED' then 0
                         else orange_money_verifications.attempts end,
           next_attempt_at=case when orange_money_verifications.status='FAILED' then now()
                                else orange_money_verifications.next_attempt_at end,
           lease_until=case when orange_money_verifications.status='FAILED' then null
                            else orange_money_verifications.lease_until end,
           last_error=case when orange_money_verifications.status='FAILED' then null
                           else orange_money_verifications.last_error end,
           alerted_at=case when orange_money_verifications.status='FAILED' then null
                           else orange_money_verifications.alerted_at end,
           completed_at=case when orange_money_verifications.status='FAILED' then null
                             else orange_money_verifications.completed_at end,
           created_at=case when orange_money_verifications.status='FAILED' then now()
                           else orange_money_verifications.created_at end,
           updated_at=now()
     where orange_money_verifications.order_id=excluded.order_id
     returning *`,
    [args.transactionId, args.orderId, args.amountXof, args.customerId ?? null],
  );
  return res.rows[0] ?? null;
}

async function claimVerification(transactionId: string): Promise<OmVerification | null> {
  const res = await pool.query<OmVerification>(
    `update orange_money_verifications
        set attempts=attempts+1,
            lease_until=$2,
            updated_at=now()
      where transaction_id=$1 and status='PENDING'
        and next_attempt_at <= now()
        and (lease_until is null or lease_until < now())
      returning *`,
    [transactionId, new Date(Date.now() + LEASE_MS)],
  );
  return res.rows[0] ?? null;
}

async function dueTransactionIds(limit: number): Promise<string[]> {
  const res = await pool.query<{ transaction_id: string }>(
    `select transaction_id
       from orange_money_verifications
      where status='PENDING' and next_attempt_at <= now()
        and (lease_until is null or lease_until < now())
      order by next_attempt_at, created_at
      limit $1`,
    [limit],
  );
  return res.rows.map((row) => row.transaction_id);
}

async function recordClassVerificationFailure(
  row: OmVerification,
  reason: string,
  log: PaymentLog,
): Promise<void> {
  const booking = await repo.findBookingById(row.order_id).catch(() => null);
  if (!booking) return;
  await recordBookingFunnelEvent({
    clientId: booking.client_id,
    bookingId: booking.id,
    stage: "technical_failure",
    paymentMethod: booking.payment_method,
    failureCode: "payment_verification_failed",
    idempotencyKey: `booking:${booking.id}:om-verification:${row.transaction_id}:${reason}`,
    metadata: { operation: "payment_verification", reason },
  }).catch((err) =>
    log.error({ err, bookingId: booking.id }, "OM verification funnel event failed"),
  );
}

async function reschedule(row: OmVerification, reason: string): Promise<void> {
  const nextAttempt = new Date(Date.now() + omRetryDelayMs(row.attempts));
  await pool.query(
    `update orange_money_verifications
        set next_attempt_at=$2, lease_until=null, last_error=$3, updated_at=now()
      where transaction_id=$1 and status='PENDING'`,
    [row.transaction_id, nextAttempt, reason.slice(0, 800)],
  );
}

async function markAlerted(row: OmVerification): Promise<boolean> {
  const res = await pool.query(
    `update orange_money_verifications
        set alerted_at=now(), updated_at=now()
      where transaction_id=$1 and status='PENDING' and alerted_at is null
      returning transaction_id`,
    [row.transaction_id],
  );
  return (res.rowCount ?? 0) > 0;
}

async function finish(
  row: OmVerification,
  status: "SUCCEEDED" | "FAILED",
  error: string | null,
): Promise<void> {
  const db = await pool.connect();
  try {
    await db.query("begin");
    await db.query(
      `update orange_money_verifications
          set status=$2, completed_at=now(), lease_until=null,
              last_error=$3, updated_at=now()
        where transaction_id=$1`,
      [row.transaction_id, status, error?.slice(0, 800) ?? null],
    );
    await db.query(
      `insert into processed_webhooks (id,source) values ($1,'orange_money')
       on conflict (id) do nothing`,
      [`om:${row.transaction_id}`],
    );
    await db.query("commit");
  } catch (err) {
    await db.query("rollback").catch(() => undefined);
    throw err;
  } finally {
    db.release();
  }
}

async function abandon(row: OmVerification, reason: string): Promise<void> {
  const res = await pool.query(
    `update orange_money_verifications
        set status='FAILED', completed_at=now(), lease_until=null,
            last_error=$2, updated_at=now()
      where transaction_id=$1 and status='PENDING'`,
    [row.transaction_id, reason.slice(0, 800)],
  );
  if ((res.rowCount ?? 0) > 0) {
    notifyReception(
      "⚠️ Paiement OM toujours non vérifié",
      `La vérification automatique est arrêtée après 7 jours. Order=${row.order_id}, ` +
        `transactionId=${row.transaction_id}. Vérifier la transaction dans le portail OM avant toute action.`,
    );
  }
}

async function retryLater(
  row: OmVerification,
  reason: string,
  log: PaymentLog,
  funnelReason = reason,
): Promise<OmVerificationOutcome> {
  const elapsedMs = Date.now() - new Date(row.created_at).getTime();
  if (elapsedMs >= GIVE_UP_AFTER_MS) {
    await recordClassVerificationFailure(row, funnelReason, log);
    await abandon(row, reason);
    return "failed";
  }
  await reschedule(row, reason);
  if (
    !row.alerted_at &&
    elapsedMs >= ALERT_AFTER_MS &&
    (await markAlerted(row))
  ) {
    // Short provider propagation delays are normal; only count this as a
    // technical funnel failure once it has become an actionable delay.
    await recordClassVerificationFailure(row, funnelReason, log);
    notifyReception(
      "⚠️ Paiement OM — confirmation retardée",
      `Callback reçu pour order=${row.order_id}, transactionId=${row.transaction_id}, ` +
        `mais l'API Orange ne confirme toujours pas SUCCESS. Awa continue les vérifications automatiquement.`,
    );
  }
  return "retry_scheduled";
}

async function processClaimed(
  row: OmVerification,
  log: PaymentLog,
): Promise<OmVerificationOutcome> {
  let tx: OmTransaction | null;
  try {
    tx = await lookupSuccessfulTransaction(row.transaction_id);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ err, transactionId: row.transaction_id }, "OM lookup failed — retry scheduled");
    return retryLater(row, `lookup_failed: ${message}`, log, "lookup_failed");
  }

  if (!tx) {
    log.warn(
      { transactionId: row.transaction_id, attempt: row.attempts },
      "OM lookup has no SUCCESS transaction yet — retry scheduled",
    );
    return retryLater(row, "not_successful", log);
  }

  const match = transactionMatchesPending(tx, {
    amountXof: row.amount_xof,
    merchantCode: config.OM_MERCHANT_CODE,
    orderId: row.order_id,
  });
  if (!match.ok) {
    log.warn(
      { reason: match.reason, transactionId: row.transaction_id, orderId: row.order_id },
      "OM verify-by-lookup mismatch — permanently rejected",
    );
    await recordClassVerificationFailure(row, match.reason, log);
    await finish(row, "FAILED", match.reason);
    notifyReception(
      "⚠️ Paiement OM — mismatch vérif",
      `Callback order=${row.order_id} transactionId=${row.transaction_id} rejeté: ${match.reason}. ` +
        `Montant attendu ${row.amount_xof} FCFA. Pas de réservation créée.`,
    );
    return "failed";
  }

  const payerPhone = row.customer_id
    ? String(row.customer_id).replace(/\D/g, "")
    : tx.customerId
      ? String(tx.customerId).replace(/\D/g, "")
      : null;
  await processPayment(row.order_id, { payerPhone }, log);
  await finish(row, "SUCCEEDED", null);
  return "succeeded";
}

/** Process one transaction now if it is due. Safe under concurrent callbacks. */
export async function verifyQueuedOmTransaction(
  transactionId: string,
  log: PaymentLog,
): Promise<OmVerificationOutcome> {
  const row = await claimVerification(transactionId);
  if (!row) return "not_due";
  try {
    return await processClaimed(row, log);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ err, transactionId, orderId: row.order_id }, "OM verification processing failed");
    await reschedule(row, `processing_failed: ${message}`).catch((releaseErr) =>
      log.error({ err: releaseErr, transactionId }, "OM verification lease release failed"),
    );
    return "retry_scheduled";
  }
}

/** Startup/periodic recovery for callbacks interrupted by process restarts. */
export async function sweepOmVerifications(log: PaymentLog, limit = 10): Promise<number> {
  const ids = await dueTransactionIds(limit);
  let handled = 0;
  for (const transactionId of ids) {
    const outcome = await verifyQueuedOmTransaction(transactionId, log);
    if (outcome !== "not_due") handled += 1;
  }
  return handled;
}
