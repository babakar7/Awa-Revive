import * as repo from "./repo.js";
import * as wix from "../lib/wix.js";

/**
 * Cancellation sweep — silent DB sync.
 *
 * Every few minutes: compare all upcoming BOOKED rows against live Wix
 * statuses and mark locally-cancelled the ones reception cancelled in the
 * Wix dashboard, so Awa's view of the client's bookings stays accurate.
 *
 * The client is NOT messaged here: reception ticks "notify client" in Wix
 * when cancelling, and Wix sends the official notification. (Awa used to
 * send a WhatsApp too — removed as redundant.)
 */
export async function syncCancellations(log: {
  info: (o: unknown, m?: string) => void;
  error: (o: unknown, m?: string) => void;
}): Promise<number> {
  const upcoming = await repo.allUpcomingBooked();
  if (upcoming.length === 0) return 0;

  const ids = upcoming.map((b) => b.wix_booking_id!).filter(Boolean);
  const statuses = await wix.getBookingStatuses(ids);

  let cancelled = 0;
  for (const b of upcoming) {
    const status = statuses[b.wix_booking_id!];
    if (status !== "CANCELED" && status !== "DECLINED") continue;

    await repo.markCancelled(b.id);
    cancelled++;
    log.info({ bookingId: b.id, wixBookingId: b.wix_booking_id }, "Booking cancelled in Wix — synced");
  }
  return cancelled;
}
