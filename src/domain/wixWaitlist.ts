import * as wix from "../lib/wix.js";
import * as repo from "./repo.js";

type WaitlistClient = Pick<
  repo.Client,
  "id" | "wa_phone" | "name" | "claimed_email"
>;

export interface WixWaitlistMirrorResult {
  mirrored: boolean;
  registrationId?: string;
  error?: string;
}

/**
 * Best-effort native mirror. Failure never breaks Awa's durable local
 * waitlist: the internal sweep remains the fallback for this registration.
 */
export async function mirrorWaitlistInWix(
  entry: repo.WaitlistEntry,
  client: WaitlistClient,
): Promise<WixWaitlistMirrorResult> {
  if (entry.wix_registration_id && !entry.wix_left_at) {
    return { mirrored: true, registrationId: entry.wix_registration_id };
  }

  try {
    const phone = client.wa_phone.startsWith("+") ? client.wa_phone : `+${client.wa_phone}`;
    const match = await wix.findContactByPhone(phone, client.name ?? undefined);
    const rawContact = match ? await wix.getContactById(match.id).catch(() => null) : null;
    const snapshot = rawContact ? wix.wixDeliveryClientFromContact(rawContact) : null;
    const displayName = snapshot?.name || match?.fullName || client.name || "Client Revive";
    const name = wix.splitContactName(displayName);
    const registration = await wix.registerToWaitlist({
      waitingResource: entry.event_id,
      contactDetails: {
        ...(match?.id ? { contactId: match.id } : {}),
        ...name,
        ...(snapshot?.email || client.claimed_email
          ? { email: snapshot?.email || client.claimed_email! }
          : {}),
        phone: snapshot?.phone || phone,
      },
    });

    const attached = await repo.attachWixWaitlistRegistration(
      entry.id,
      registration.id,
      registration.bookingId,
    );
    if (!attached) {
      // The client may have asked to leave while Wix was answering. Never
      // strand the just-created native registration in that race.
      await wix.leaveNativeWaitlist(registration.id, entry.event_id).catch(() => undefined);
      return { mirrored: false, error: "local_waitlist_no_longer_waiting" };
    }
    return { mirrored: true, registrationId: registration.id };
  } catch (error) {
    await repo.recordWixWaitlistSyncError(entry.id, error).catch(() => undefined);
    return { mirrored: false, error: String(error) };
  }
}

/** Remove the native pending booking/registration, retryable by the sweep. */
export async function cleanupNativeWaitlistEntry(
  entry: repo.WaitlistEntry,
): Promise<boolean> {
  if (!entry.wix_registration_id || entry.wix_left_at) return true;
  try {
    await wix.leaveNativeWaitlist(entry.wix_registration_id, entry.event_id);
    await repo.markWixWaitlistLeft(entry.id);
    return true;
  } catch (error) {
    await repo.recordWixWaitlistSyncError(entry.id, error).catch(() => undefined);
    return false;
  }
}

/** Retry cleanup after NOTIFIED/CANCELLED/EXPIRED transitions or an outage. */
export async function cleanupClosedNativeWaitlists(): Promise<number> {
  const entries = await repo.wixWaitlistCleanupEntries();
  let cleaned = 0;
  for (const entry of entries) {
    if (await cleanupNativeWaitlistEntry(entry)) cleaned++;
  }
  return cleaned;
}
