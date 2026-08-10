/**
 * Read-only live probe for Wix accounting response shapes.
 * Writes a gitignored local snapshot; it never mutates Wix.
 */
import "dotenv/config";
import { mkdir, writeFile } from "node:fs/promises";
import {
  getOrderTransactions,
  getPricingPlanOrdersProbePage,
  searchEcomOrdersByUpdatedDate,
} from "../src/lib/wix.js";

const days = Math.max(1, Number(process.argv[2] ?? 90));
const since = new Date(Date.now() - days * 86400_000);
const orders: any[] = [];
let cursor: string | undefined;
for (let pageNo = 0; pageNo < 5; pageNo += 1) {
  const page = await searchEcomOrdersByUpdatedDate({ updatedAfter: since, cursor });
  orders.push(...page.orders);
  if (!page.nextCursor) break;
  cursor = page.nextCursor;
}

const candidates = [
  ...orders.filter((o) => o?.channelInfo?.externalOrderId).slice(0, 5),
  ...orders.filter((o) => !o?.channelInfo?.externalOrderId && o?.channelInfo?.type === "WEB").slice(0, 10),
  ...orders.filter((o) => !o?.channelInfo?.externalOrderId && o?.channelInfo?.type === "BACKOFFICE_MERCHANT").slice(0, 20),
  ...orders.filter((o) => !o?.channelInfo?.externalOrderId && o?.channelInfo?.type === "WIX_APP_STORE").slice(0, 5),
].filter((o, i, all) => all.findIndex((x) => x?.id === o?.id) === i);

const transactionSamples = [];
for (const order of candidates) {
  transactionSamples.push({ order, transactions: await getOrderTransactions(String(order.id)) });
}
const planPage = await getPricingPlanOrdersProbePage();
const snapshot = {
  probedAt: new Date().toISOString(),
  since: since.toISOString(),
  orderCount: orders.length,
  orderShapeSamples: orders.slice(0, 10),
  transactionSamples,
  planOrders: planPage,
};
await mkdir(".probe", { recursive: true });
const path = `.probe/wix-payments-${new Date().toISOString().replaceAll(":", "-")}.json`;
await writeFile(path, JSON.stringify(snapshot, null, 2), { mode: 0o600 });

const methods = new Set<string>();
const statuses = new Set<string>();
let payments = 0;
let refunds = 0;
let noId = 0;
for (const sample of transactionSamples) {
  payments += sample.transactions.payments.length;
  refunds += sample.transactions.refunds.length;
  for (const entry of [...sample.transactions.payments, ...sample.transactions.refunds]) {
    const details = entry?.regularPaymentDetails ?? entry?.regularRefundDetails ?? entry;
    methods.add(String(details?.paymentMethod ?? "<empty>"));
    statuses.add(String(details?.status ?? entry?.status ?? "<empty>"));
    if (!(entry?.id ?? entry?.paymentId ?? entry?.refundId)) noId += 1;
  }
}
const plans = planPage?.orders ?? planPage?.planOrders ?? [];
console.log(JSON.stringify({
  path, orders: orders.length, sampledOrders: transactionSamples.length,
  payments, refunds, noId, methods: [...methods], statuses: [...statuses],
  planOrderCount: Array.isArray(plans) ? plans.length : null,
  planWixPayOrderIds: Array.isArray(plans) ? plans.filter((p: any) => p?.wixPayOrderId).length : null,
}, null, 2));
