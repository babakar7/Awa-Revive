import { config } from "../config.js";
import { sendWhatsAppNotification } from "../lib/notify.js";
import * as wix from "../lib/wix.js";
import * as acrepo from "./autoCancelRepo.js";
import * as nrepo from "./notificationRepo.js";
import { phoneDigits } from "./notificationRepo.js";
import {
  cancelConfigAlertDedupKey,
  cancelNotifyDedupKey,
  isEmpty,
  isEmptyLongEnough,
  isMorningClass,
  isWithinWindow,
  matchesRule,
  nextEmptyTimer,
  type AutoCancelRule,
} from "./autoCancelRules.js";

/**
 * Empty-class auto-cancellation engine (runs in the 60s loop, its own guarded
 * section). Reads enabled rules, finds occurrences inside their cancellation
 * window on FRESH Wix data (its own availability call — never the notification
 * 5-min cache), and cancels an occurrence that has been continuously empty for
 * 15 min via Calendar V3 (AUTO-CANCEL-EMPTY-CLASSES-PLAN.md). Fail-closed
 * everywhere: capacity unknown, a resolvable-recipient gap, or any Wix read
 * failure means we do NOT cancel.
 *
 * Server decides everything; the model is never involved. No class name is
 * hardcoded — rules target an exact Wix service id typed into /admin/notifications.
 */

interface SweepLog {
  info: (o: unknown, m?: string) => void;
  warn: (o: unknown, m?: string) => void;
  error: (o: unknown, m?: string) => void;
}

/** How far ahead to look for in-window occurrences. Morning classes become
 *  eligible at 23:00 the previous day (start up to ~9h ahead at that moment);
 *  12h is a safe horizon covering every in-window case. */
const HORIZON_MS = 12 * 60 * 60 * 1000;

interface Candidate {
  eventId: string; // short Calendar V3 id (cancellation key)
  sessionId: string; // long availability session id (lock key)
  serviceId: string;
  startIso: string;
  coach: string | null;
  coachId: string | null;
}

// ---------- recipient resolution ----------

interface Recipient {
  role: "coach" | "owner" | "manager" | "opening";
  name: string;
  phone: string;
}

/** Resolve the optional « accueil / ouverture » recipient — only for a morning
 *  (≤09:15) occurrence, only if the rule set one and it's active. Never blocks.
 *  Exported for unit tests (morning-gating is time-of-day dependent). */
export async function openingRecipientFor(
  rule: acrepo.AutoCancelRuleRow,
  candidate: { startIso: string },
): Promise<{ role: "opening"; name: string; phone: string } | null> {
  if (!isMorningClass(candidate.startIso)) return null;
  const c = await acrepo.openingContactForRule(rule);
  if (!c || c.muted || phoneDigits(c.phone).length < 8) return null;
  return { role: "opening", name: c.name, phone: c.phone };
}

async function resolveCoachPhone(
  coachId: string | null,
  coachName: string | null,
): Promise<{ name: string; phone: string } | null> {
  if (!coachId && !coachName) return null;
  // Wix is the directory of record; a staff_contacts row (same name) may
  // override the phone or mute the coach.
  const staffContact = await nrepo.findStaffByName(coachName);
  if (staffContact?.muted) return null;
  if (staffContact?.phone && phoneDigits(staffContact.phone).length >= 8) {
    return { name: staffContact.name, phone: staffContact.phone };
  }
  const resources = await wix.listStaffResources();
  const norm = (s: string) => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();
  const match =
    (coachId ? resources.find((r) => r.id === coachId) : undefined) ??
    (coachName ? resources.find((r) => norm(r.name) === norm(coachName)) : undefined);
  if (match?.phone && phoneDigits(match.phone).length >= 8) {
    return { name: match.name || coachName || "coach", phone: match.phone };
  }
  return null;
}

/**
 * All cancellation-notice recipients (coach + the two fixed contacts), or null
 * when a REQUIRED one can't be resolved — in which case the caller must NOT
 * cancel and instead fire one config alert to whoever IS resolvable.
 */
async function resolveRecipients(
  rule: acrepo.AutoCancelRuleRow,
  candidate: Candidate,
): Promise<{ recipients: Recipient[] } | { missing: string; resolvable: Recipient[] }> {
  const coach = await resolveCoachPhone(candidate.coachId, candidate.coach);
  // Owner is always the studio owner (config.OWNER_PHONE) — not a per-rule pick.
  const owner = acrepo.ownerRecipient();
  const manager = await acrepo.managerContactForRule(rule);
  const resolvable: Recipient[] = [];
  if (owner) resolvable.push({ role: "owner", name: owner.name, phone: owner.phone });
  if (manager && !manager.muted && phoneDigits(manager.phone).length >= 8) {
    resolvable.push({ role: "manager", name: manager.name, phone: manager.phone });
  }
  // Optional opening/reception recipient — morning cancellations only, never required.
  const opening = await openingRecipientFor(rule, candidate);
  if (opening) resolvable.push(opening);
  if (!coach) return { missing: `coach "${candidate.coach ?? "?"}"`, resolvable };
  if (!owner) return { missing: "propriétaire (OWNER_PHONE)", resolvable };
  if (!manager || manager.muted) return { missing: "manager", resolvable };
  return { recipients: [{ role: "coach", ...coach }, ...resolvable] };
}

// ---------- notifications ----------

function fmtDay(iso: string): string {
  return new Date(iso).toLocaleDateString("fr-FR", {
    timeZone: config.TIMEZONE,
    weekday: "long",
    day: "numeric",
    month: "long",
  });
}
function fmtTime(iso: string): string {
  return new Date(iso).toLocaleTimeString("fr-FR", {
    timeZone: config.TIMEZONE,
    hour: "2-digit",
    minute: "2-digit",
  });
}

function cancelMessage(
  serviceName: string,
  candidate: Candidate,
  ruleLabel: string,
  role?: Recipient["role"],
): string {
  // The opening/reception recipient gets an extra line about coming in later.
  const openingLine =
    role === "opening"
      ? `\n👉 Ouverture : si aucun autre cours tôt n'est prévu, tu peux venir plus tard.`
      : "";
  return (
    `Cours annulé automatiquement (personne d'inscrit).\n` +
    `• ${serviceName}\n` +
    `• ${fmtDay(candidate.startIso)} à ${fmtTime(candidate.startIso)}\n` +
    `• Coach : ${candidate.coach ?? "—"}\n` +
    `• Règle : ${ruleLabel}${openingLine}\n\n` +
    `Message automatique d'Awa — merci de ne pas répondre.`
  );
}

/** Deliver one recipient's cancellation notice (idempotent via dedup key). */
async function deliverNotice(
  eventId: string,
  recipient: Recipient,
  subject: string,
  body: string,
  log: SweepLog,
): Promise<void> {
  const dedupKey = cancelNotifyDedupKey(eventId, phoneDigits(recipient.phone));
  if (!(await nrepo.claimOrReclaim(dedupKey, null, null, "auto_cancel"))) return;
  try {
    const path = await sendWhatsAppNotification(recipient.phone, subject, body, {
      preferTemplate: true,
    });
    await nrepo.finishLog(dedupKey, path, { recipientPhone: recipient.phone, body });
  } catch (err) {
    const msg = String(err).slice(0, 300);
    if (msg.includes("131047")) {
      await nrepo.finishLog(dedupKey, "failed", { recipientPhone: recipient.phone, body, error: msg });
    } else {
      await nrepo.markRetryable(dedupKey, msg); // transient → reclaimed after 2 min
    }
    log.error({ err, dedupKey }, "autocancel: notice send failed");
  }
}

/** One deduplicated config alert (per occurrence) when recipients can't be resolved. */
async function alertConfigProblem(
  eventId: string,
  resolvable: Recipient[],
  missing: string,
  candidate: Candidate,
  ruleLabel: string,
  log: SweepLog,
): Promise<void> {
  const dedupKey = cancelConfigAlertDedupKey(eventId);
  if (!(await nrepo.claimOrReclaim(dedupKey, null, null, "auto_cancel"))) return;
  const body =
    `⚠️ Annulation auto impossible : destinataire manquant (${missing}).\n` +
    `• ${fmtDay(candidate.startIso)} à ${fmtTime(candidate.startIso)} — ${ruleLabel}\n` +
    `Le cours n'a PAS été annulé. Vérifie le répertoire dans /admin/notifications.`;
  if (resolvable.length === 0) {
    await nrepo.finishLog(dedupKey, "failed", { error: `aucun destinataire résoluble (${missing})`, body });
    log.warn({ eventId, missing }, "autocancel: no resolvable recipient for config alert");
    return;
  }
  let anySent = false;
  for (const r of resolvable) {
    try {
      await sendWhatsAppNotification(r.phone, "Annulation auto impossible", body, {
        preferTemplate: true,
      });
      anySent = true;
    } catch (err) {
      log.error({ err, phone: r.phone }, "autocancel: config alert send failed");
    }
  }
  await nrepo.finishLog(dedupKey, anySent ? "sent" : "failed", {
    recipientPhone: resolvable[0]?.phone ?? null,
    body,
    error: anySent ? null : "envoi échoué",
  });
}

// ---------- cancellation critical section ----------

/**
 * Two-phase cancel for one candidate.
 *
 * Phase A (under the occurrence lock, try-mode → a booking in flight skips this
 * tick): re-verify preconditions on fresh Wix data and mark the ledger
 * CANCELLING, then COMMIT. Committing CANCELLING releases the lock but the
 * booking-path guard now rejects on CANCELLING, so it covers the Wix-call window
 * that follows without the lock (and the pooled connection) being held across
 * HTTP.
 *
 * Phase B (no lock): call Wix Cancel Event, confirm CANCELLED, then finalize the
 * ledger to CANCELLED. A crash/transient error here leaves the row CANCELLING;
 * the stale-CANCELLING recovery pass re-checks Wix and finalizes or reverts.
 * We never markFailed on a transient cancel error.
 *
 * Returns true iff the occurrence was confirmed CANCELLED this tick.
 */
async function performCancellation(candidate: Candidate, log: SweepLog): Promise<boolean> {
  const claim = await acrepo.withOccurrenceLock(
    candidate.sessionId,
    async (client) => {
      const fresh = await wix.getCalendarOccurrence(candidate.eventId);
      if (fresh.status !== "CONFIRMED") return false; // already cancelled/other → abort
      if (fresh.participantCount !== 0) return false; // someone booked during the grace period
      if (await acrepo.hasActivePaymentForSession(candidate.sessionId)) return false;
      const ledger = await acrepo.getLedgerTx(client, candidate.eventId);
      if (!ledger || ledger.state !== "OBSERVING") return false;
      if (!ledger.first_empty_at || !ledger.last_observed_at) return false;
      const now = Date.now();
      if (now - new Date(ledger.last_observed_at).getTime() > 2 * 60_000) return false;
      if (now - new Date(ledger.first_empty_at).getTime() < 15 * 60_000) return false;
      await acrepo.markCancellingTx(client, candidate.eventId); // committed on lock release
      return true;
    },
    "try",
  );
  if (!claim.acquired) {
    log.info({ eventId: candidate.eventId }, "autocancel: occurrence locked (booking in flight) — skip");
    return false;
  }
  if (!claim.value) return false;

  // Phase B — ledger is CANCELLING (committed); the booking guard rejects meanwhile.
  try {
    const res = await wix.cancelClassOccurrence(candidate.eventId);
    let cancelled = res.status === "CANCELLED";
    if (!cancelled) {
      const verify = await wix.getCalendarOccurrence(candidate.eventId);
      cancelled = verify.status === "CANCELLED";
    }
    if (!cancelled) throw new Error(`Wix did not confirm CANCELLED for ${candidate.eventId}`);
    await acrepo.markCancelledByEvent(candidate.eventId);
    return true;
  } catch (err) {
    // Leave the row CANCELLING: the recovery pass re-checks Wix next ticks and
    // either finalizes (Wix did cancel) or reverts to OBSERVING (it did not).
    log.error({ err, eventId: candidate.eventId }, "autocancel: Wix cancel unconfirmed — left CANCELLING for recovery");
    return false;
  }
}

/**
 * Recover CANCELLING rows stuck > 2 min (crash/deploy between marking CANCELLING
 * and confirming, or an unconfirmed Wix cancel): re-fetch Wix. CANCELLED → finalize
 * + notify (the occurrence is gone from availability, so this is the ONLY place
 * a crash-after-Wix-cancel gets its notices). Still CONFIRMED → revert to
 * OBSERVING with a restarted timer. A row bloqué ne rend jamais un cours encore
 * réservable définitivement irréservable.
 */
async function recoverStaleCancelling(log: SweepLog): Promise<void> {
  const stale = await acrepo.staleCancellingRows(2 * 60_000);
  for (const row of stale) {
    try {
      const occ = await wix.getCalendarOccurrence(row.event_id);
      if (occ.status === "CANCELLED") {
        await acrepo.markCancelledByEvent(row.event_id);
        await acrepo.purgeSlotCacheForSession(row.session_id).catch(() => undefined);
        await deliverNoticesForRow(row, log);
        log.info({ eventId: row.event_id }, "autocancel: recovered stuck CANCELLING → CANCELLED");
      } else if (occ.status === "CONFIRMED") {
        await acrepo.revertToObserving(row.event_id, new Date());
        log.info({ eventId: row.event_id }, "autocancel: reverted stuck CANCELLING → OBSERVING");
      }
    } catch (err) {
      log.error({ err, eventId: row.event_id }, "autocancel: stale CANCELLING recovery failed");
    }
  }
}

// ---------- candidate discovery ----------

async function gatherCandidates(
  rules: acrepo.AutoCancelRuleRow[],
  now: Date,
  log: SweepLog,
): Promise<Array<{ rule: acrepo.AutoCancelRuleRow; candidate: Candidate }>> {
  const serviceIds = [...new Set(rules.flatMap((r) => r.service_ids))];
  const from = now.toISOString();
  const to = new Date(now.getTime() + HORIZON_MS).toISOString();
  const slots = await wix.queryAvailabilityMulti(serviceIds, from, to);
  const out: Array<{ rule: acrepo.AutoCancelRuleRow; candidate: Candidate }> = [];
  for (const slot of slots) {
    // Cancel key is the SHORT Calendar id; an occurrence Wix didn't expose one
    // for can never be cancelled — log and skip (fail-closed).
    const eventId = slot.rescheduleEventId?.trim();
    if (!eventId) {
      log.warn({ sessionId: slot.eventId, serviceId: slot.serviceId }, "autocancel: slot has no Calendar event id — skipped");
      continue;
    }
    for (const rule of rules) {
      const occ = { serviceId: slot.serviceId, startIso: slot.startDate };
      if (!matchesRule(ruleToPure(rule), occ)) continue;
      if (!isWithinWindow(slot.startDate, now, config.AUTO_CANCEL_MIN_NOTICE_MINUTES)) continue;
      out.push({
        rule,
        candidate: {
          eventId,
          sessionId: slot.eventId,
          serviceId: slot.serviceId,
          startIso: slot.startDate,
          coach: slot.coach,
          coachId: slot.coachId,
        },
      });
      break; // one rule per occurrence is enough (global ledger dedups anyway)
    }
  }
  return out;
}

function ruleToPure(r: acrepo.AutoCancelRuleRow): AutoCancelRule {
  return {
    id: r.id,
    label: r.label,
    enabled: r.enabled,
    service_ids: r.service_ids,
    weekdays: r.weekdays,
    start_min_from: r.start_min_from,
    start_min_to: r.start_min_to,
    opening_contact_id: r.opening_contact_id,
  };
}

// ---------- entry point ----------

export async function sweepAutoCancellations(log: SweepLog): Promise<number> {
  if (await acrepo.isAutoCancelPaused()) return 0;
  // Recover any occurrence stuck mid-cancellation first (crash/deploy) — this
  // runs even with no enabled rules so a stuck row can never wedge forever.
  await recoverStaleCancelling(log).catch((err) =>
    log.error({ err }, "autocancel: recovery pass failed"),
  );
  const allEnabled = await acrepo.listEnabledRules();
  // An enabled rule with a broken recipient config never cancels (fail-closed);
  // the admin page surfaces the error separately.
  const rules: acrepo.AutoCancelRuleRow[] = [];
  for (const r of allEnabled) {
    if ((await acrepo.ruleActivationError(r)) == null) rules.push(r);
  }
  if (rules.length === 0) return 0;

  let candidates: Array<{ rule: acrepo.AutoCancelRuleRow; candidate: Candidate }>;
  try {
    candidates = await gatherCandidates(rules, new Date(), log);
  } catch (err) {
    log.error({ err }, "autocancel: availability query failed — skipping tick");
    return 0;
  }

  let cancelled = 0;
  for (const { rule, candidate } of candidates) {
    try {
      cancelled += await evaluateCandidate(rule, candidate, log);
    } catch (err) {
      log.error({ err, eventId: candidate.eventId }, "autocancel: candidate evaluation failed");
      await acrepo.markFailed(candidate.eventId, String(err)).catch(() => undefined);
    }
  }
  return cancelled;
}

async function evaluateCandidate(
  rule: acrepo.AutoCancelRuleRow,
  candidate: Candidate,
  log: SweepLog,
): Promise<number> {
  const now = new Date();

  // Authoritative capacity/status from Calendar V3 (fresh read, not availability).
  const occ = await wix.getCalendarOccurrence(candidate.eventId);

  // A candidate only ever comes from availability, which excludes cancelled
  // occurrences — so a non-CONFIRMED status here means it was cancelled
  // elsewhere (reception) between the availability read and this fetch. Leave it.
  // The crash-after-our-Wix-cancel case is handled by recoverStaleCancelling.
  if (occ.status !== "CONFIRMED") return 0;

  const empty = isEmpty(occ);
  const hasActivePayment = await acrepo.hasActivePaymentForSession(candidate.sessionId);
  const led = await acrepo.getLedger(candidate.eventId);
  const priorFirstEmptyAt = led?.first_empty_at ? new Date(led.first_empty_at) : null;
  const priorLastObservedAt = led?.last_observed_at ? new Date(led.last_observed_at) : null;
  const firstEmptyAt = nextEmptyTimer({
    now,
    isCurrentlyEmpty: empty,
    hasActivePayment,
    priorFirstEmptyAt,
    priorLastObservedAt,
  });

  await acrepo.recordObservation({
    eventId: candidate.eventId,
    sessionId: candidate.sessionId,
    ruleId: rule.id,
    serviceId: candidate.serviceId,
    startAt: candidate.startIso,
    firstEmptyAt,
    now,
  });

  if (!empty || hasActivePayment) return 0;
  if (!isEmptyLongEnough(firstEmptyAt, now)) return 0;

  // Resolve recipients BEFORE mutating Wix; a gap blocks the cancel (fail-closed).
  const resolved = await resolveRecipients(rule, candidate);
  if ("missing" in resolved) {
    await alertConfigProblem(candidate.eventId, resolved.resolvable, resolved.missing, candidate, rule.label, log);
    return 0;
  }

  const didCancel = await performCancellation(candidate, log);
  if (!didCancel) return 0;

  await finalizeCancellation(rule, candidate, log, resolved.recipients);
  log.info({ eventId: candidate.eventId, service: occ.serviceName }, "autocancel: occurrence cancelled");
  return 1;
}

/**
 * Post-cancellation side effects, kept OUTSIDE the Wix mutation lock and idempotent
 * (notice dedup keys) so a retry can never repeat the cancellation: purge the slot
 * cache and deliver one WhatsApp notice per distinct recipient.
 */
async function finalizeCancellation(
  rule: acrepo.AutoCancelRuleRow,
  candidate: Candidate,
  log: SweepLog,
  known?: Recipient[],
): Promise<void> {
  await acrepo.purgeSlotCacheForSession(candidate.sessionId).catch(() => undefined);
  let recipients = known;
  if (!recipients) {
    const resolved = await resolveRecipients(rule, candidate);
    recipients = "recipients" in resolved ? resolved.recipients : resolved.resolvable;
  }
  const serviceName = (await wix.getCalendarOccurrence(candidate.eventId).catch(() => null))?.serviceName
    ?? "le cours";
  const subject = "Cours annulé (vide)";
  const seen = new Set<string>();
  for (const r of recipients) {
    const key = phoneDigits(r.phone);
    if (seen.has(key)) continue; // owner == coach etc. → one notice
    seen.add(key);
    await deliverNotice(candidate.eventId, r, subject, cancelMessage(serviceName, candidate, rule.label, r.role), log);
  }
}

/**
 * Deliver cancellation notices for a ledger row (the recovery path, where we
 * only have the row — no live Candidate). Rebuilds recipients from the rule's
 * fixed contacts + the occurrence's coach resource. Idempotent (notice dedup
 * keys), so re-running after a crash never double-sends.
 */
async function deliverNoticesForRow(row: acrepo.LedgerRow, log: SweepLog): Promise<void> {
  const occ = await wix.getCalendarOccurrence(row.event_id).catch(() => null);
  const rule = row.rule_id ? await acrepo.getRule(row.rule_id) : null;
  const coachResource = occ?.resources?.[0] ?? null;
  const candidate: Candidate = {
    eventId: row.event_id,
    sessionId: row.session_id,
    serviceId: row.service_id ?? "",
    startIso: occ?.startDate ?? row.start_at ?? new Date().toISOString(),
    coach: coachResource?.name ?? null,
    coachId: coachResource?.id ?? null,
  };
  const recipients: Recipient[] = [];
  const coach = await resolveCoachPhone(candidate.coachId, candidate.coach);
  if (coach) recipients.push({ role: "coach", ...coach });
  const owner = acrepo.ownerRecipient();
  if (owner) recipients.push({ role: "owner", name: owner.name, phone: owner.phone });
  if (rule) {
    const manager = await acrepo.managerContactForRule(rule);
    if (manager && !manager.muted && phoneDigits(manager.phone).length >= 8) {
      recipients.push({ role: "manager", name: manager.name, phone: manager.phone });
    }
    const opening = await openingRecipientFor(rule, candidate);
    if (opening) recipients.push(opening);
  }
  const serviceName = occ?.serviceName ?? "le cours";
  const ruleLabel = rule?.label ?? "annulation auto";
  const seen = new Set<string>();
  for (const r of recipients) {
    const key = phoneDigits(r.phone);
    if (seen.has(key)) continue;
    seen.add(key);
    await deliverNotice(candidate.eventId, r, "Cours annulé (vide)", cancelMessage(serviceName, candidate, ruleLabel, r.role), log);
  }
}
