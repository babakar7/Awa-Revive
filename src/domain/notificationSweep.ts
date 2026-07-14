import { config } from "../config.js";
import { sendWhatsAppNotification } from "../lib/notify.js";
import * as wix from "../lib/wix.js";
import * as nrepo from "./notificationRepo.js";
import {
  buildChain,
  classDedupKey,
  dakarDateStr,
  dueClassReminders,
  fixedDedupKey,
  isFixedScheduleDue,
  normalizeName,
  renderMessage,
  STAFF_FOOTER,
  type NotificationRule,
  type SlotWithName,
} from "./notificationRules.js";

/**
 * Staff-notification sweep (runs in the 60s loop). Reads the enabled rules,
 * evaluates each against the Wix schedule / the clock, and sends the due
 * reminders once (claim-before-send, ops-hardened with a 2-min bail). All
 * decisions are server-side; the LLM agent is never involved. No class name or
 * phone is hardcoded — patterns and contacts come from DB rows the owner types
 * in /admin/notifications.
 *
 * 15-min-before precision needs ≤1-min granularity, hence the 60s loop rather
 * than the 5-min one. Wix is only hit every 5 min (schedule cache below).
 */

interface SweepLog {
  info: (o: unknown, m?: string) => void;
  error: (o: unknown, m?: string) => void;
}

// ---------- schedule cache (one Wix call / 5 min, shared by every rule) ----------

const SCHEDULE_TTL_MS = 5 * 60 * 1000;
let scheduleCache: {
  at: number;
  slots: SlotWithName[];
  coachById: Map<string, wix.WixStaffResource>;
  coachByName: Map<string, wix.WixStaffResource>;
} | null = null;

/**
 * Upcoming class sessions enriched with their service name. Cached 5 min; on a
 * refresh failure the last-good cache is served (a Wix hiccup must not blind
 * the sweep). The −6h lookback lets back-to-back suppression see a session that
 * already started.
 */
async function getSchedule(log: SweepLog): Promise<SlotWithName[]> {
  if (scheduleCache && Date.now() - scheduleCache.at < SCHEDULE_TTL_MS) {
    return scheduleCache.slots;
  }
  try {
    const [services, staff] = await Promise.all([wix.listServices(), wix.listStaffResources()]);
    const nameById = new Map(services.map((s) => [s.id, s.name]));
    const typeById = new Map(services.map((s) => [s.id, s.type]));
    const now = Date.now();
    const from = new Date(now - 6 * 60 * 60 * 1000).toISOString();
    const to = new Date(now + 26 * 60 * 60 * 1000).toISOString();
    const slots = await wix.queryAvailabilityMulti([...nameById.keys()], from, to);
    const enriched: SlotWithName[] = slots.map((s) => ({
      eventId: s.eventId,
      serviceId: s.serviceId,
      serviceName: nameById.get(s.serviceId) ?? "",
      startDate: s.startDate,
      endDate: s.endDate,
      openSpots: s.openSpots,
      totalSpots: s.totalSpots,
      coach: s.coach,
      coachId: s.coachId,
      // Only an explicit APPOINTMENT is non-group; unknown types stay group so
      // a group_only rule never silently drops everything on a Wix schema tweak.
      isGroup: (typeById.get(s.serviceId) ?? "") !== "APPOINTMENT",
    }));
    const coachById = new Map(staff.map((r) => [r.id, r]));
    const coachByName = new Map(staff.map((r) => [normalizeName(r.name), r]));
    scheduleCache = { at: Date.now(), slots: enriched, coachById, coachByName };
    return enriched;
  } catch (err) {
    if (scheduleCache) {
      log.error({ err }, "notif: schedule refresh failed — serving stale cache");
      return scheduleCache.slots;
    }
    throw err;
  }
}

/**
 * Coach phone straight from Wix (resource id first, then name) — the directory
 * of record. An admin staff_contacts entry can still override the phone or mute.
 */
function wixCoachPhone(slot: SlotWithName): string | null {
  if (!scheduleCache) return null;
  const byId = slot.coachId ? scheduleCache.coachById.get(slot.coachId) : undefined;
  const byName = slot.coach ? scheduleCache.coachByName.get(normalizeName(slot.coach)) : undefined;
  return byId?.phone ?? byName?.phone ?? null;
}

/** Distinct coach names in the current schedule cache — an admin-page hint. */
export function cachedCoachNames(): string[] {
  if (!scheduleCache) return [];
  return [...new Set(scheduleCache.slots.map((s) => s.coach).filter((c): c is string => !!c))].sort();
}

// ---------- rendering ----------

function fmtTime(iso: string): string {
  return new Date(iso).toLocaleTimeString("fr-FR", {
    timeZone: config.TIMEZONE,
    hour: "2-digit",
    minute: "2-digit",
  });
}

function fmtDay(iso: string): string {
  return new Date(iso).toLocaleDateString("fr-FR", {
    timeZone: config.TIMEZONE,
    weekday: "long",
    day: "numeric",
    month: "long",
  });
}

function bookedCount(slot: SlotWithName): string {
  return slot.totalSpots > 0 ? String(slot.totalSpots - slot.openSpots) : "?";
}

/** One line per class for the {classes} placeholder of a chained reminder. */
function classesList(chain: SlotWithName[]): string {
  return chain
    .map((s) => `• ${s.serviceName || "cours"} à ${fmtTime(s.startDate)} — ${bookedCount(s)} inscrit(s)`)
    .join("\n");
}

/**
 * Placeholders for a reminder. Single-class fields ({class_name}, {start_time},
 * {booked_count}…) reflect the FIRST class of the chain (backward-compatible);
 * {classes} lists every class in a back-to-back block, so one message can cover
 * them all instead of pinging once per class.
 */
function classVars(chain: SlotWithName[]): Record<string, string> {
  const slot = chain[0];
  return {
    class_name: slot.serviceName || "le cours",
    date: fmtDay(slot.startDate),
    start_time: fmtTime(slot.startDate),
    end_time: fmtTime(slot.endDate),
    coach: slot.coach ?? "",
    booked_count: bookedCount(slot),
    open_spots: String(slot.openSpots),
    total_spots: slot.totalSpots > 0 ? String(slot.totalSpots) : "?",
    classes: classesList(chain),
  };
}

function withFooter(body: string): string {
  return `${body}\n\n${STAFF_FOOTER}`;
}

// ---------- send + finalize one claimed occurrence ----------

async function deliver(
  dedupKey: string,
  phone: string,
  subject: string,
  body: string,
  log: SweepLog,
): Promise<boolean> {
  try {
    const path = await sendWhatsAppNotification(phone, subject, body);
    await nrepo.finishLog(dedupKey, path, { recipientPhone: phone, body });
    return true;
  } catch (err) {
    const msg = String(err).slice(0, 300);
    if (msg.includes("131047")) {
      // Window closed and no template lands it — hard failure, no retry (visible in log).
      await nrepo.finishLog(dedupKey, "failed", { recipientPhone: phone, body, error: msg });
    } else {
      // Transient (network / 5xx) — leave it claimed so the 2-min bail retries.
      await nrepo.markRetryable(dedupKey, msg);
    }
    log.error({ err, dedupKey }, "notif: send failed");
    return false;
  }
}

// ---------- rule runners ----------

async function runClassRule(
  rule: NotificationRule,
  slots: SlotWithName[],
  now: Date,
  log: SweepLog,
): Promise<number> {
  const priorEnds = await nrepo.recentRuleEventEnds(rule.id);
  const due = dueClassReminders(rule, slots, now, priorEnds);
  let sent = 0;

  for (const { slot, suppressed, suppressReason } of due) {
    const dedupKey = classDedupKey(rule.id, slot.eventId);
    if (!(await nrepo.claimOrReclaim(dedupKey, rule.id, slot))) continue;

    if (suppressed) {
      await nrepo.finishLog(dedupKey, "suppressed", { body: suppressReason });
      continue;
    }

    // Resolve the recipient.
    let phone: string | null = null;
    if (rule.recipient_kind === "coach") {
      // Wix is the directory of record; an admin staff_contacts entry (same
      // name) can mute the coach or override the phone.
      const contact = await nrepo.findStaffByName(slot.coach);
      if (contact?.muted) {
        await nrepo.finishLog(dedupKey, "suppressed", { body: `coach muet : ${contact.name}` });
        continue;
      }
      phone = contact?.phone ?? wixCoachPhone(slot);
      if (!phone) {
        await nrepo.finishLog(dedupKey, "failed", {
          error: `aucun numéro pour le coach "${slot.coach ?? "?"}" (ni Wix ni répertoire)`,
        });
        continue;
      }
    } else {
      phone = rule.recipient_phone;
      if (!phone) {
        await nrepo.finishLog(dedupKey, "failed", { error: "règle sans numéro destinataire" });
        continue;
      }
      if (await nrepo.isMutedPhone(phone)) {
        await nrepo.finishLog(dedupKey, "suppressed", { body: "destinataire muet" });
        continue;
      }
    }

    // This is a chain-start (a preceding same-recipient class within the gap
    // would have been suppressed above); cover the whole back-to-back block in
    // one message via {classes}.
    const chain = buildChain(rule, slots, slot);
    const body = withFooter(renderMessage(rule.message_template, classVars(chain)));
    if (await deliver(dedupKey, phone, rule.label, body, log)) sent++;
  }
  return sent;
}

async function runFixedRule(rule: NotificationRule, now: Date, log: SweepLog): Promise<number> {
  if (!isFixedScheduleDue(rule, now)) return 0;
  const dedupKey = fixedDedupKey(rule.id, dakarDateStr(now));
  if (!(await nrepo.claimOrReclaim(dedupKey, rule.id, null))) return 0;

  const phone = rule.recipient_phone;
  if (!phone) {
    await nrepo.finishLog(dedupKey, "failed", { error: "règle sans numéro destinataire" });
    return 0;
  }
  if (await nrepo.isMutedPhone(phone)) {
    await nrepo.finishLog(dedupKey, "suppressed", { body: "destinataire muet" });
    return 0;
  }
  const body = withFooter(renderMessage(rule.message_template, {}));
  return (await deliver(dedupKey, phone, rule.label, body, log)) ? 1 : 0;
}

// ---------- entry point (called from the 60s loop) ----------

export async function sweepStaffNotifications(log: SweepLog): Promise<number> {
  const rules = await nrepo.listEnabledRules();
  if (rules.length === 0) return 0;

  const now = new Date();
  const needsSchedule = rules.some((r) => r.kind === "class_reminder");
  let slots: SlotWithName[] = [];
  if (needsSchedule) {
    try {
      slots = await getSchedule(log);
    } catch (err) {
      // No schedule this tick → skip class rules, still run fixed_schedule rules.
      log.error({ err }, "notif: no schedule available this tick");
    }
  }

  let sent = 0;
  for (const rule of rules) {
    try {
      if (rule.kind === "class_reminder") {
        if (slots.length > 0) sent += await runClassRule(rule, slots, now, log);
      } else if (rule.kind === "fixed_schedule") {
        sent += await runFixedRule(rule, now, log);
      }
    } catch (err) {
      log.error({ err, ruleId: rule.id }, "notif: rule evaluation failed");
    }
  }
  return sent;
}
