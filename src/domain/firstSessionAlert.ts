import { config } from "../config.js";
import { sendWhatsAppNotification } from "../lib/notify.js";
import * as nrepo from "./notificationRepo.js";
import { listStaffContacts, phoneDigits } from "./notificationRepo.js";
import { normalizeName, type SlotWithName } from "./notificationRules.js";
import { getSchedule } from "./notificationSweep.js";
import { onShiftStaffIds } from "./staffPlanningRepo.js";
import { planningNowSlot } from "./staffPlanningRules.js";
import * as keyRepo from "./keyRepo.js";
import {
  assembleFirstSessionRecipients,
  buildFirstSessionMessage,
  firstSessionDedupKey,
  isFirstSessionAlertDue,
  type AlertRecipient,
} from "./firstSessionAlertRules.js";

/**
 * « 1re séance L'Invitée » sweep (60s loop): ~1 h before a class that contains
 * a client on the first of their 3 Clé L'Invitée sessions, ping the owner and
 * every accueil on shift at class time so the welcome matcha is offered without
 * the client asking. All server-side (key_reformer_bookings ⋈ pending_bookings
 * ⋈ key_registry) — the LLM agent is never involved. Claim-before-send in
 * notification_log (template-first, 131047-hardened, 2-min bail), one send per
 * (occurrence, recipient).
 */

interface SweepLog {
  info: (o: unknown, m?: string) => void;
  error: (o: unknown, m?: string) => void;
}

/**
 * Accueil on shift when the class STARTS (not when the alert fires — the user
 * rule: the alert targets whoever will be there in an hour). Dakar == UTC
 * year-round, so planningNowSlot on the class start instant yields the grid
 * coordinates directly. No published planning (null) → every reachable accueil.
 */
async function onShiftAccueil(slot: SlotWithName): Promise<AlertRecipient[]> {
  const reachable = (await listStaffContacts()).filter(
    (c) => normalizeName(c.role) === "accueil" && !c.muted && phoneDigits(c.phone).length >= 8,
  );
  const coords = planningNowSlot(new Date(slot.startDate));
  const onShift = await onShiftStaffIds(coords.weekday, coords.minute);
  const present = onShift === null ? reachable : reachable.filter((c) => onShift.has(c.id));
  return present.map((c) => ({ name: c.name, phone: c.phone }));
}

async function deliver(
  slot: SlotWithName,
  recipient: AlertRecipient,
  subject: string,
  body: string,
  log: SweepLog,
): Promise<boolean> {
  const dedupKey = firstSessionDedupKey(slot.eventId, phoneDigits(recipient.phone));
  const claimed = await nrepo.claimOrReclaim(
    dedupKey,
    null,
    { startDate: slot.startDate, endDate: slot.endDate },
    "invitee_first_session",
  );
  if (!claimed) return false;
  try {
    const path = await sendWhatsAppNotification(recipient.phone, subject, body, {
      preferTemplate: true,
    });
    await nrepo.finishLog(dedupKey, path, { recipientPhone: recipient.phone, body });
    return true;
  } catch (err) {
    const msg = String(err).slice(0, 300);
    if (msg.includes("131047")) {
      await nrepo.finishLog(dedupKey, "failed", { recipientPhone: recipient.phone, body, error: msg });
    } else {
      await nrepo.markRetryable(dedupKey, msg); // transient → reclaimed after 2 min
    }
    log.error({ err, dedupKey }, "first-session: alert send failed");
    return false;
  }
}

/** Returns the number of alerts sent this tick. */
export async function sweepFirstSessionAlerts(log: SweepLog): Promise<number> {
  if (!config.INVITEE_FIRST_SESSION_ALERT_ENABLED) return 0;
  const now = new Date();
  const slots = await getSchedule(log);
  const due = slots.filter((s) => isFirstSessionAlertDue(s.startDate, now));
  let sent = 0;
  for (const slot of due) {
    const attendees = await keyRepo.firstInviteeSessionAttendees(slot.eventId);
    if (attendees.length === 0) continue;
    const recipients = assembleFirstSessionRecipients({
      onShiftAccueil: await onShiftAccueil(slot),
      ownerPhone: config.OWNER_PHONE,
      receptionPhone: config.RECEPTION_PHONE,
      phoneDigits,
    });
    const { subject, body } = buildFirstSessionMessage(slot, attendees);
    for (const recipient of recipients) {
      if (await deliver(slot, recipient, subject, body, log)) sent++;
    }
  }
  return sent;
}
