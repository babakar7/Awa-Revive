import crypto from "node:crypto";
import type pg from "pg";
import { config } from "../config.js";
import { pool } from "../db/index.js";
import {
  getContactById,
  getOrderTransactions,
  searchEcomOrdersByUpdatedDate,
  wixContactFullName,
  wixDeliveryClientFromContact,
} from "../lib/wix.js";
import type { LedgerPaymentMethod, LedgerMovementType } from "./paymentsLedger.js";

type Log = {
  info?: (obj: unknown, message?: string) => void;
  warn?: (obj: unknown, message?: string) => void;
};

export interface NormalizedWixMethod {
  method: LedgerPaymentMethod | null;
  rawMethod: string;
  providerStatus: string;
  offline: boolean;
}

export interface WixPaymentSyncState {
  lastStartedAt: Date | null;
  lastSucceededAt: Date | null;
  lastUpdatedDateSeen: Date | null;
  lastFullReconciledAt: Date | null;
  lastError: string | null;
  recordCount: number;
}

export async function wixPaymentSyncState(): Promise<WixPaymentSyncState> {
  const res = await pool.query(`select * from wix_payment_sync_state where singleton=true`);
  const row = res.rows[0] ?? {};
  return {
    lastStartedAt: row.last_started_at ?? null,
    lastSucceededAt: row.last_succeeded_at ?? null,
    lastUpdatedDateSeen: row.last_updated_date_seen ?? null,
    lastFullReconciledAt: row.last_full_reconciled_at ?? null,
    lastError: row.last_error ?? null,
    recordCount: Number(row.record_count ?? 0),
  };
}

export function normalizeWixProviderMethod(entry: any): NormalizedWixMethod {
  const details = entry?.regularPaymentDetails ?? entry?.regularRefundDetails ?? entry ?? {};
  const wixLabel = String(details?.paymentMethod ?? entry?.paymentMethod ?? "").trim();
  const customLabel = String(details?.paymentMethodName?.userDefinedName?.custom ?? "").trim();
  const rawMethod = customLabel ? `${wixLabel} | ${customLabel}` : wixLabel;
  const key = (customLabel || wixLabel).toLowerCase().replace(/[\s_-]+/g, "");
  let method: LedgerPaymentMethod | null = null;
  if (key.includes("wave")) method = "wave";
  else if (key.includes("maxit") || key.includes("maxitmoney")) method = "maxit";
  else if (key === "om" || key.includes("orangemoney") || key.includes("orange")) method = "orange_money";
  else if (key.includes("cash") || key.includes("esp") || key.includes("offline")) method = "cash";
  else if (key.includes("card") || key.includes("credit") || key.includes("stripe")) method = "card";
  const offline = Boolean(details?.offlinePayment ?? entry?.offlinePayment) || /offline|manual|person/i.test(wixLabel);
  // An unrecognised offline label is exactly what reception must qualify.
  if (offline && !customLabel && !/cash|esp/i.test(wixLabel)) method = null;
  return {
    method,
    rawMethod,
    providerStatus: String(details?.status ?? entry?.status ?? "UNKNOWN").toUpperCase(),
    offline,
  };
}

interface StagedMovement {
  wixOrderId: string;
  movementType: LedgerMovementType;
  wixEntryId: string;
  providerStatus: string;
  occurredAt: Date;
  amountXof: number;
  currency: string;
  buyerName: string | null;
  buyerPhone: string | null;
  buyerContactId: string | null;
  buyerIdentitySyncedAt: Date | null;
  label: string;
  providerMethod: LedgerPaymentMethod | null;
  rawMethod: string;
  offline: boolean;
  raw: unknown;
}

function entryId(entry: any): string {
  return String(entry?.id ?? entry?.paymentId ?? entry?.refundId ?? "").trim();
}

function entryDate(entry: any, order: any): Date {
  for (const candidate of [entry?.createdDate, entry?.createdAt, entry?.updatedDate, order?.updatedDate, order?.createdDate]) {
    const date = new Date(String(candidate ?? ""));
    if (!Number.isNaN(date.getTime())) return date;
  }
  return new Date(0);
}

function amount(entry: any, orderCurrency: unknown): { amount: number; currency: string } {
  const money = entry?.amount ?? entry?.paymentAmount ?? entry?.refundAmount ?? {};
  const rawAmount = typeof money === "string" || typeof money === "number"
    ? money
    : money?.amount ?? money?.value ??
      entry?.summary?.refunded?.amount ?? entry?.summary?.refundedAmount?.amount ??
      entry?.summary?.total?.amount ?? 0;
  return {
    amount: Math.round(Number(rawAmount)),
    currency: String(money?.currency ?? entry?.currency ?? orderCurrency ?? "").toUpperCase(),
  };
}

function refundStatus(entry: any): string | null {
  const statuses = (Array.isArray(entry?.transactions) ? entry.transactions : [])
    .map((transaction: any) => String(transaction?.refundStatus ?? "").toUpperCase())
    .filter(Boolean);
  if (!statuses.length) return null;
  return statuses.every((status: string) => status === "SUCCEEDED") ? "SUCCEEDED" : statuses[0];
}

interface WixBuyerIdentity {
  name: string | null;
  phone: string | null;
  contactId: string | null;
  lookupCompleted: boolean;
}

function cleanIdentityValue(value: unknown): string | null {
  const cleaned = String(value ?? "").trim();
  return cleaned || null;
}

/** Identity embedded directly in an eCommerce order, without a Contacts call. */
export function wixOrderBuyer(order: any): Omit<WixBuyerIdentity, "lookupCompleted"> {
  const billing = order?.billingInfo?.contactDetails ?? {};
  const buyerInfo = order?.buyerInfo ?? {};
  const billingName = [billing?.firstName, billing?.lastName]
    .map(cleanIdentityValue)
    .filter(Boolean)
    .join(" ")
    .trim();
  const buyerName = [buyerInfo?.firstName, buyerInfo?.lastName]
    .map(cleanIdentityValue)
    .filter(Boolean)
    .join(" ")
    .trim();
  return {
    name: cleanIdentityValue(billingName || billing?.name || buyerName || buyerInfo?.name),
    phone: cleanIdentityValue(billing?.phone || buyerInfo?.phone),
    contactId: cleanIdentityValue(buyerInfo?.contactId),
  };
}

async function enrichedBuyer(
  order: any,
  contactCache: Map<string, Promise<any | null>>,
  log: Log,
): Promise<WixBuyerIdentity> {
  const embedded = wixOrderBuyer(order);
  if ((embedded.name && embedded.phone) || !embedded.contactId) {
    return { ...embedded, lookupCompleted: true };
  }

  try {
    let pending = contactCache.get(embedded.contactId);
    if (!pending) {
      pending = getContactById(embedded.contactId);
      contactCache.set(embedded.contactId, pending);
    }
    const contact = await pending;
    const snapshot = wixDeliveryClientFromContact(contact);
    return {
      name: embedded.name || wixContactFullName(contact),
      phone: embedded.phone || snapshot?.phone || null,
      contactId: embedded.contactId,
      lookupCompleted: true,
    };
  } catch (error) {
    // Identity enrichment must never prevent an authoritative monetary entry
    // from reaching the ledger. A null timestamp makes the next sync retry a
    // full pass instead of permanently accepting the missing identity.
    contactCache.delete(embedded.contactId);
    log.warn?.({ orderId: order?.id, contactId: embedded.contactId, error },
      "Wix payment buyer contact lookup failed; payment kept for retry");
    return { ...embedded, lookupCompleted: false };
  }
}

function label(order: any): string {
  const names = (Array.isArray(order?.lineItems) ? order.lineItems : [])
    .map((line: any) => line?.productName?.translated ?? line?.productName?.original ?? line?.name)
    .filter(Boolean).map(String);
  return names.join(" + ") || `Commande Wix ${String(order?.number ?? order?.id ?? "")}`;
}

async function localIdentitySets(): Promise<{ external: Set<string>; wix: Set<string> }> {
  const [external, wix] = await Promise.all([
    pool.query(`select id::text id from pending_bookings union select id::text from pending_plan_orders`),
    pool.query(`select wix_order_id id from pending_bookings where wix_order_id is not null
                union select wix_order_id from pending_plan_orders where wix_order_id is not null`),
  ]);
  return {
    external: new Set(external.rows.map((r) => String(r.id))),
    wix: new Set(wix.rows.map((r) => String(r.id))),
  };
}

async function acquire(force: boolean): Promise<boolean> {
  const res = await pool.query(
    `update wix_payment_sync_state
        set last_started_at=now(), last_error=null
      where singleton=true and ($1::boolean or last_started_at is null
        or last_started_at < now()-interval '1 hour') returning singleton`,
    [force],
  );
  return Boolean(res.rowCount);
}

async function commitSuccessfulScan(args: {
  staged: StagedMovement[];
  diagnostics: Array<{ fingerprint: string; kind: string; orderId: string; payload: unknown }>;
  watermark: Date;
  full: boolean;
  startedAt: Date;
}): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    for (const m of args.staged) {
      await client.query(
        `insert into wix_payment_movements
          (wix_order_id,source,movement_type,wix_entry_id,provider_status,occurred_at,
           amount_xof,currency,buyer_name,buyer_phone,buyer_contact_id,buyer_identity_synced_at,
           label,provider_method,raw_method,offline,raw,synced_at,last_seen_at,invalidated_at)
         values ($1,'ecom',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,now(),now(),null)
         on conflict (wix_order_id,movement_type,wix_entry_id) do update set
           provider_status=excluded.provider_status,occurred_at=excluded.occurred_at,
           amount_xof=excluded.amount_xof,currency=excluded.currency,
           buyer_name=coalesce(nullif(excluded.buyer_name,''),wix_payment_movements.buyer_name),
           buyer_phone=coalesce(nullif(excluded.buyer_phone,''),wix_payment_movements.buyer_phone),
           buyer_contact_id=coalesce(excluded.buyer_contact_id,wix_payment_movements.buyer_contact_id),
           buyer_identity_synced_at=coalesce(excluded.buyer_identity_synced_at,wix_payment_movements.buyer_identity_synced_at),
           label=excluded.label,
           provider_method=excluded.provider_method,raw_method=excluded.raw_method,
           offline=excluded.offline,raw=excluded.raw,synced_at=now(),last_seen_at=now(),
           invalidated_at=null`,
        [m.wixOrderId,m.movementType,m.wixEntryId,m.providerStatus,m.occurredAt,
         m.amountXof,m.currency,m.buyerName,m.buyerPhone,m.buyerContactId,
         m.buyerIdentitySyncedAt,m.label,m.providerMethod,m.rawMethod,m.offline,
         JSON.stringify(m.raw)],
      );
    }
    for (const d of args.diagnostics) {
      await client.query(
        `insert into wix_payment_sync_diagnostics(fingerprint,kind,wix_order_id,payload)
         values ($1,$2,$3,$4)
         on conflict (fingerprint) do update set last_seen_at=now(),
           occurrences=wix_payment_sync_diagnostics.occurrences+1,payload=excluded.payload`,
        [d.fingerprint,d.kind,d.orderId,JSON.stringify(d.payload)],
      );
    }
    if (args.full) {
      const seen = args.staged.map((m) => `${m.wixOrderId}\u001f${m.movementType}\u001f${m.wixEntryId}`);
      await client.query(
        `update wix_payment_movements w set invalidated_at=now()
          where w.occurred_at >= $1 and w.invalidated_at is null
            and not ((w.wix_order_id||chr(31)||w.movement_type||chr(31)||w.wix_entry_id)=any($2::text[]))`,
        [new Date(`${config.PAYMENTS_LEDGER_START_DATE}T00:00:00Z`), seen],
      );
    }
    await client.query(
      `update wix_payment_sync_state set last_succeeded_at=now(),
         last_updated_date_seen=$1,last_full_reconciled_at=case when $2 then now() else last_full_reconciled_at end,
         last_error=null,record_count=(select count(*) from wix_payment_movements)
       where singleton=true`,
      [args.watermark, args.full],
    );
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

export async function syncWixPayments(log: Log = {}, force = false): Promise<{ ran: boolean; recordCount: number; full: boolean }> {
  if (!(await acquire(force))) return { ran: false, recordCount: 0, full: false };
  const startedAt = new Date();
  try {
    const state = await pool.query(`select * from wix_payment_sync_state where singleton=true`);
    const row = state.rows[0] ?? {};
    const identityBackfill = await pool.query(
      `select exists(select 1 from wix_payment_movements
        where invalidated_at is null and buyer_identity_synced_at is null) needed`,
    );
    const full = force || Boolean(identityBackfill.rows[0]?.needed) || !row.last_full_reconciled_at ||
      new Date(row.last_full_reconciled_at).getTime() < Date.now() - 7 * 86400_000;
    const ledgerStart = new Date(`${config.PAYMENTS_LEDGER_START_DATE}T00:00:00Z`);
    const last = row.last_updated_date_seen ? new Date(row.last_updated_date_seen) : ledgerStart;
    const updatedAfter = full ? ledgerStart : new Date(Math.max(ledgerStart.getTime(), last.getTime() - 3600_000));
    const ids = await localIdentitySets();
    const staged: StagedMovement[] = [];
    const diagnostics: Array<{ fingerprint: string; kind: string; orderId: string; payload: unknown }> = [];
    let cursor: string | undefined;
    let watermark = last;
    const seenCursors = new Set<string>();
    const contactCache = new Map<string, Promise<any | null>>();
    for (;;) {
      const page = await searchEcomOrdersByUpdatedDate({ updatedAfter, cursor });
      for (const order of page.orders) {
        const orderId = String(order?.id ?? "").trim();
        if (!orderId) continue;
        const updated = new Date(String(order?.updatedDate ?? order?.createdDate ?? ""));
        if (!Number.isNaN(updated.getTime()) && updated > watermark) watermark = updated;
        const externalId = String(order?.channelInfo?.externalOrderId ?? "").trim();
        if ((externalId && ids.external.has(externalId)) || ids.wix.has(orderId)) continue;
        const tx = await getOrderTransactions(orderId);
        const hasMonetaryEntry = tx.payments.some((entry: any) => !entry?.membershipPaymentDetails) ||
          tx.refunds.length > 0;
        if (!hasMonetaryEntry) continue;
        const contact = await enrichedBuyer(order, contactCache, log);
        for (const [movementType, entries] of [["payment", tx.payments], ["refund", tx.refunds]] as const) {
          for (const entry of entries) {
            // Wix also exposes plan-session redemptions as "payments". They
            // are consumption of an existing membership, not money received.
            if (movementType === "payment" && entry?.membershipPaymentDetails) continue;
            const wixEntryId = entryId(entry);
            if (!wixEntryId) {
              const payload = { orderId, movementType, entry };
              const fingerprint = crypto.createHash("sha256").update(JSON.stringify(payload)).digest("hex");
              diagnostics.push({ fingerprint, kind: "NO_ID", orderId, payload });
              log.warn?.({ orderId, movementType, fingerprint }, "Wix payment entry has no id; diagnostic only");
              continue;
            }
            const money = amount(entry, order?.currency);
            const provider = normalizeWixProviderMethod(entry);
            if (movementType === "refund") {
              const linkedPaymentIds = (Array.isArray(entry?.transactions) ? entry.transactions : [])
                .map((transaction: any) => String(transaction?.paymentId ?? "")).filter(Boolean);
              const linked = tx.payments.filter((payment: any) =>
                linkedPaymentIds.includes(entryId(payment)) && !payment?.membershipPaymentDetails);
              if (!provider.method && linked.length === 1) {
                const originalProvider = normalizeWixProviderMethod(linked[0]);
                provider.method = originalProvider.method;
                provider.rawMethod = originalProvider.rawMethod;
                provider.offline = originalProvider.offline;
              }
              provider.providerStatus = refundStatus(entry) ?? provider.providerStatus;
              if (!Number.isFinite(money.amount) || money.amount <= 0) {
                if (linked.length === 1 && String(order?.paymentStatus).toUpperCase() === "FULLY_REFUNDED") {
                  money.amount = amount(linked[0], order?.currency).amount;
                } else {
                  const payload = { orderId, movementType, reason: "REFUND_AMOUNT_MISSING", entry };
                  const fingerprint = crypto.createHash("sha256").update(JSON.stringify(payload)).digest("hex");
                  diagnostics.push({ fingerprint, kind: "REFUND_AMOUNT_MISSING", orderId, payload });
                  log.warn?.({ orderId, wixEntryId, fingerprint }, "Wix refund has no authoritative amount; diagnostic only");
                  continue;
                }
              }
            } else if (!Number.isFinite(money.amount) || money.amount <= 0) {
              const payload = { orderId, movementType, reason: "PAYMENT_AMOUNT_INVALID", entry };
              const fingerprint = crypto.createHash("sha256").update(JSON.stringify(payload)).digest("hex");
              diagnostics.push({ fingerprint, kind: "PAYMENT_AMOUNT_INVALID", orderId, payload });
              log.warn?.({ orderId, wixEntryId, fingerprint }, "Wix payment has no positive authoritative amount; diagnostic only");
              continue;
            }
            staged.push({
              wixOrderId: orderId, movementType, wixEntryId,
              providerStatus: provider.providerStatus, occurredAt: entryDate(entry, order),
              amountXof: movementType === "refund" ? -Math.abs(money.amount) : Math.abs(money.amount),
              currency: money.currency, buyerName: contact.name, buyerPhone: contact.phone,
              buyerContactId: contact.contactId,
              buyerIdentitySyncedAt: contact.lookupCompleted ? startedAt : null,
              label: label(order), providerMethod: provider.method, rawMethod: provider.rawMethod,
              offline: provider.offline, raw: entry,
            });
          }
        }
      }
      if (!page.nextCursor || seenCursors.has(page.nextCursor)) break;
      seenCursors.add(page.nextCursor);
      cursor = page.nextCursor;
    }
    // Network work is complete. Only now may a short DB transaction advance
    // the watermark or invalidate anything.
    await commitSuccessfulScan({ staged, diagnostics, watermark, full, startedAt });
    log.info?.({ recordCount: staged.length, full }, "Wix payments synced");
    return { ran: true, recordCount: staged.length, full };
  } catch (error) {
    await pool.query(`update wix_payment_sync_state set last_error=$1 where singleton=true`, [String(error).slice(0, 2000)]).catch(() => undefined);
    throw error;
  }
}
