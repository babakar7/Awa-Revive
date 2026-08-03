import { config } from "../config.js";
import { sendText } from "../lib/whatsapp.js";
import * as repo from "./repo.js";
import { PACK_DISCOVERY_CAMPAIGN } from "./packDiscoveryCampaign.js";
import {
  silentLeadCandidates,
  claimSilentLeadNudge,
  completeOutboundNudge,
  silentLeadDedupKey,
  type NudgeArm,
} from "./leadNudgeRepo.js";

/**
 * Relance A — one free-text follow-up to a Pack Découverte ad lead who clicked,
 * got Awa's pitch, and never replied. See LEAD-FOLLOWUP-PLAN.md. Selection +
 * atomic claim live in leadNudgeRepo; this module owns the copy, the
 * deterministic holdout, the quiet-hours gate, and the sweep.
 */

/**
 * FNV-1a over the client id, 32-bit. Math.imul + `>>> 0` give real 32-bit
 * unsigned arithmetic — a plain `hash * prime` overflows into floats past 2^53
 * and silently drops the low bits FNV depends on. TS-only and version-stable
 * (unlike Postgres hashtext()), so the holdout assignment can't drift.
 */
export function fnv1aMod(input: string, mod: number): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash % mod;
}

/** Deterministic control-group assignment. mod <= 0 disables the holdout. */
export function isHoldout(clientId: string, mod: number): boolean {
  return mod > 0 && fnv1aMod(clientId, mod) === 0;
}

/**
 * Dakar quiet window (Dakar == UTC, no DST). Wraps midnight when start > end:
 * with defaults 21→9, quiet is [21,24) ∪ [0,9), so sends land 09:00–20:59.
 */
export function isQuietHour(hour: number, quietStart: number, quietEnd: number): boolean {
  if (quietStart === quietEnd) return false;
  if (quietStart < quietEnd) return hour >= quietStart && hour < quietEnd;
  return hour >= quietStart || hour < quietEnd;
}

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

/** Sweep candidates, claim atomically, send to the treatment arm. Returns sent count. */
export async function sweepSilentLeadNudges(log: {
  info: (o: unknown, m?: string) => void;
  error: (o: unknown, m?: string) => void;
}): Promise<number> {
  if (!config.LEAD_NUDGE_ENABLED) return 0;

  const dakarHour = new Date().getUTCHours(); // Dakar == UTC
  if (isQuietHour(dakarHour, config.LEAD_NUDGE_QUIET_START, config.LEAD_NUDGE_QUIET_END)) {
    return 0;
  }

  const candidates = await silentLeadCandidates({
    campaignKey: PACK_DISCOVERY_CAMPAIGN,
    delayMinutes: config.LEAD_NUDGE_DELAY_MINUTES,
    maxAgeHours: config.LEAD_NUDGE_MAX_AGE_HOURS,
  });

  let sent = 0;
  for (const c of candidates) {
    const arm: NudgeArm = isHoldout(c.client_id, config.LEAD_NUDGE_HOLDOUT_MOD)
      ? "HOLDOUT"
      : "TREATMENT";

    // Same atomic guard for both arms — a reply/payment/takeover between
    // selection and here cancels the claim (returns false).
    const claimed = await claimSilentLeadNudge({
      clientId: c.client_id,
      campaignKey: c.campaign_key,
      arm,
      delayMinutes: config.LEAD_NUDGE_DELAY_MINUTES,
      maxAgeHours: config.LEAD_NUDGE_MAX_AGE_HOURS,
    });
    if (!claimed) continue;
    if (arm === "HOLDOUT") continue; // control: assigned + SUPPRESSED, never sent

    const dedupKey = silentLeadDedupKey(c.client_id);
    try {
      const msg = silentLeadNudgeMessage(c.language, c.name);
      const wamid = await sendText(c.wa_phone, msg);
      await repo.addTurn(c.client_id, "assistant", msg, wamid ?? undefined);
      await completeOutboundNudge({ dedupKey, outcome: "SENT", waMessageId: wamid });
      sent++;
      log.info({ clientId: c.client_id }, "Silent-lead nudge sent");
    } catch (err) {
      await completeOutboundNudge({ dedupKey, outcome: "FAILED", detail: String(err) });
      log.error({ err, clientId: c.client_id }, "Silent-lead nudge failed");
    }
  }
  return sent;
}
