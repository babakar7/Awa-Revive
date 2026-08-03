import { config } from "../config.js";
import { sendText } from "../lib/whatsapp.js";
import * as repo from "./repo.js";
import { PACK_DISCOVERY_CAMPAIGN } from "./packDiscoveryCampaign.js";
import {
  claimManualLeadNudge,
  dismissSilentLead,
  completeOutboundNudge,
  silentLeadDedupKey,
} from "./leadNudgeRepo.js";

/**
 * Manual relance A — reception reviews silent Pack Découverte ad leads in
 * /admin/relances and sends (or skips) one follow-up per lead. This module owns
 * the copy and the send orchestration; selection + the atomic claim live in
 * leadNudgeRepo. See LEAD-FOLLOWUP-PLAN.md.
 */

export type ManualNudgeResult =
  | { status: "sent"; waMessageId: string | null }
  | { status: "skipped" } // reception dismissed the lead
  | { status: "gone" }; // no longer a valid candidate (replied / paid / window closed)

/**
 * Short, one closed question, no re-pitch (the full pitch is already in the
 * history), signed Awa de Revive, and NO booking promise — payment-first means
 * Awa only helps find a spot, she doesn't hold one.
 */
export function silentLeadNudgeMessage(lang: string | null, name: string | null): string {
  const trimmed = name?.trim();
  const suffix = trimmed ? `, ${trimmed}` : "";
  if (lang === "en") {
    return (
      `Hi${suffix}! Awa from Revive again 😊 You messaged me about the L'Invitée Key ` +
      `(3 Reformer sessions + pool access + 1 bonus class, 30 000 F) — I can help you ` +
      `find a spot this week if you'd like 🙂 Do mornings or evenings work better for you?`
    );
  }
  return (
    `Coucou${suffix} 👋🏾 C'est encore Awa, de Revive. Tu m'avais écrit pour la Clé L'Invitée ` +
    `(3 séances de Pilates Reformer + piscine + 1 cours bonus, 30 000 F) — je peux t'aider à ` +
    `trouver une place cette semaine si tu veux 🙂 Tu préfères plutôt matin ou soir ?`
  );
}

/**
 * Send one manual nudge. Claims atomically (re-validating reply/payment/
 * takeover/handoff and the 24h window), then sends and journals the turn so Awa
 * has context when the lead answers. Returns "gone" when the claim is refused —
 * the lead is no longer a valid candidate.
 */
export async function sendManualLeadNudge(
  clientId: string,
  by: string,
  log: { info: (o: unknown, m?: string) => void; error: (o: unknown, m?: string) => void },
): Promise<ManualNudgeResult> {
  const contact = await claimManualLeadNudge({
    clientId,
    campaignKey: PACK_DISCOVERY_CAMPAIGN,
    by,
    delayMinutes: config.LEAD_NUDGE_DELAY_MINUTES,
    maxAgeHours: config.LEAD_NUDGE_MAX_AGE_HOURS,
  });
  if (!contact) return { status: "gone" };

  const dedupKey = silentLeadDedupKey(clientId);
  try {
    const msg = silentLeadNudgeMessage(contact.language, contact.name);
    const wamid = await sendText(contact.wa_phone, msg);
    await repo.addTurn(clientId, "assistant", msg, wamid ?? undefined);
    await completeOutboundNudge({ dedupKey, outcome: "SENT", waMessageId: wamid });
    log.info({ clientId, by }, "Manual silent-lead nudge sent");
    return { status: "sent", waMessageId: wamid };
  } catch (err) {
    await completeOutboundNudge({ dedupKey, outcome: "FAILED", detail: String(err) });
    log.error({ err, clientId, by }, "Manual silent-lead nudge failed");
    throw err;
  }
}

/** Reception dismissed the lead — one-shot, drops it off the list. */
export async function skipLeadNudge(clientId: string, by: string): Promise<ManualNudgeResult> {
  const recorded = await dismissSilentLead({
    clientId,
    campaignKey: PACK_DISCOVERY_CAMPAIGN,
    by,
  });
  return recorded ? { status: "skipped" } : { status: "gone" };
}
