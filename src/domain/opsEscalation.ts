import type { FastifyBaseLogger } from "fastify";
import { pool } from "../db/index.js";
import { config } from "../config.js";
import { sendWhatsAppNotificationDetailed } from "../lib/notify.js";
import {
  claimStaleServeEscalations,
  kitchenTicketView,
} from "./kitchenTicketRepo.js";
import { ticketItemsSummary } from "./kitchenTicketRules.js";

/**
 * Owner escalation for the room: when a TABLE order has been READY but nobody
 * took it to serve within OPS_SERVE_ESCALATE_SECONDS, WhatsApp the owner so it's
 * never forgotten. The reception phones are alerted first (push + the live board);
 * this is the last-resort net. The claim is atomic (serve_escalated_at), so a
 * ticket escalates exactly once. Owner's 24h window is ~always closed → template-
 * first send. Best-effort logging to notification_log (source 'ops_ticket').
 */

async function logOps(phone: string, body: string, status: string, error: string | null, wamid: string | null): Promise<void> {
  try {
    await pool.query(
      `insert into notification_log (source, recipient_phone, body, status, error, wa_message_id)
       values ('ops_ticket', $1, $2, $3, $4, $5)`,
      [phone, body, status, error, wamid],
    );
  } catch {
    /* logging must never break the sweep */
  }
}

/** One sweep pass. Returns how many tickets were escalated. */
export async function sweepServeEscalations(log: FastifyBaseLogger): Promise<number> {
  const threshold = config.OPS_SERVE_ESCALATE_SECONDS;
  const owner = config.OWNER_PHONE;
  if (!owner) return 0;
  const tickets = await claimStaleServeEscalations(threshold);
  if (tickets.length === 0) return 0;
  const mins = Math.max(1, Math.round(threshold / 60));
  for (const t of tickets) {
    const view = kitchenTicketView(t);
    const subject = "Commande salle prête non servie";
    const body = `${view.heading} — ${ticketItemsSummary(view)}\n\nPrête depuis plus de ${mins} min et personne ne l'a prise. Merci de vérifier la salle.`;
    try {
      const { path, waMessageId } = await sendWhatsAppNotificationDetailed(owner, subject, body, {
        preferTemplate: true,
      });
      await logOps(owner, body, path, null, waMessageId);
    } catch (err) {
      await logOps(owner, body, "failed", String(err).slice(0, 300), null);
      log.error({ err, ticket: t.id }, "Serve escalation to owner failed");
    }
  }
  return tickets.length;
}
