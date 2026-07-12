import { config } from "../config.js";
import { sendTemplate } from "../lib/whatsapp.js";
import { toTemplateParam } from "../lib/notify.js";
import * as wix from "../lib/wix.js";
import * as repo from "./repo.js";

/**
 * Proactive renewal nudge: a few days before an abonnement ends, Awa reaches
 * out ("your plan ends soon — reply to renew"). This is by definition OUTSIDE
 * WhatsApp's 24h window (the client hasn't necessarily written recently), so it
 * MUST go through an approved Meta template (WA_RENEWAL_TEMPLATE) — a free-text
 * send would fail with 131047. When the template isn't configured the whole
 * sweep is a no-op, so the feature stays dark until Meta approves it.
 *
 * One-shot per Wix order (renewal_nudges table): a renewal creates a NEW Wix
 * order, hence a fresh right to nudge next period. Claimed BEFORE sending (a
 * lost nudge is a minor miss, a double nudge is spam), same stance as the
 * expiry nudge.
 */

/** A plan order that ends within the nudge window. */
export interface RenewalCandidate {
  orderId: string;
  contactId: string;
  planName: string;
  endDate: string; // ISO
}

/**
 * Pure filter (unit-tested): ACTIVE plan orders whose endDate falls in
 * [now, now + days]. Orders without a readable future endDate are skipped
 * (valid-until-cancelled plans never expire, so they never need a renewal
 * nudge). `orders` is the raw Wix order list (listAllActiveOrders).
 */
export function renewalNudgeCandidates(
  orders: any[],
  now: Date,
  days: number,
): RenewalCandidate[] {
  const horizon = now.getTime() + days * 86_400_000;
  const out: RenewalCandidate[] = [];
  for (const o of orders) {
    const contactId = o?.buyer?.contactId;
    const endDate = o?.endDate;
    const orderId = o?.id;
    if (!contactId || !endDate || !orderId) continue;
    const t = new Date(endDate).getTime();
    if (Number.isNaN(t)) continue;
    if (t >= now.getTime() && t <= horizon) {
      out.push({ orderId, contactId, planName: o.planName ?? "ton abonnement", endDate });
    }
  }
  return out;
}

/** Every spelling stored on a Wix contact, for matching a local client. */
function contactPhones(contact: any): string[] {
  const items: any[] = contact?.info?.phones?.items ?? [];
  return items.map((p) => String(p?.e164Phone ?? p?.phone ?? "")).filter(Boolean);
}

/** Send the due renewal nudges. Returns how many were sent. */
export async function sweepRenewalNudges(log: {
  info: (o: unknown, m?: string) => void;
  error: (o: unknown, m?: string) => void;
}): Promise<number> {
  if (!config.WA_RENEWAL_TEMPLATE) return 0; // feature off until Meta approves it

  const orders = await wix.listAllActiveOrders();
  const candidates = renewalNudgeCandidates(orders, new Date(), config.RENEWAL_NUDGE_DAYS);
  let sent = 0;
  for (const c of candidates) {
    let client;
    try {
      const contact = await wix.getContactById(c.contactId);
      if (!contact) continue;
      client = await repo.findClientByPhone(contactPhones(contact));
    } catch (err) {
      log.error({ err, orderId: c.orderId }, "Renewal nudge: contact/client lookup failed");
      continue;
    }
    // Never messaged Awa → no WhatsApp thread to nudge (reception handles those).
    if (!client) continue;

    // Claim BEFORE sending: one nudge per plan period, no double-send.
    if (!(await repo.claimRenewalNudge(c.orderId, client.id))) continue;
    try {
      const name = client.name || "toi";
      const endLabel = new Date(c.endDate).toLocaleDateString("fr-FR", {
        timeZone: config.TIMEZONE,
        day: "numeric",
        month: "long",
      });
      await sendTemplate(
        client.wa_phone,
        config.WA_RENEWAL_TEMPLATE,
        config.WA_RENEWAL_TEMPLATE_LANG,
        [toTemplateParam(name, 60), toTemplateParam(c.planName, 60), toTemplateParam(endLabel, 40)],
      );
      // Persist an assistant turn so Awa has the context when the client replies.
      await repo.addTurn(
        client.id,
        "assistant",
        `[relance renouvellement] Ton abonnement "${c.planName}" se termine le ${endLabel} — réponds pour le renouveler.`,
      );
      sent++;
      log.info({ orderId: c.orderId, clientId: client.id }, "Renewal nudge sent");
    } catch (err) {
      log.error({ err, orderId: c.orderId }, "Renewal nudge send failed");
    }
  }
  return sent;
}
