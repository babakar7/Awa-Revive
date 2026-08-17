import * as acrepo from "./autoCancelRepo.js";

/**
 * Booking-path protection for the empty-class auto-cancellation engine. Every
 * local Wix class-booking path wraps its final availability check + create-call
 * in `guardBooking()`, which holds the SAME occurrence advisory lock the cancel
 * engine uses (keyed by the availability session id) and rejects an occurrence
 * whose ledger says CANCELLING/CANCELLED. Result: a cancel-in-flight blocks the
 * booking cleanly (typed error → existing slot-unavailable / refund path)
 * instead of racing into a raw Wix 428.
 */

export class OccurrenceCancelledError extends Error {
  constructor(public readonly sessionId: string) {
    super(`occurrence ${sessionId} was auto-cancelled (empty class)`);
    this.name = "OccurrenceCancelledError";
  }
}

/**
 * Run `create` (the final Wix check + booking creation) under the occurrence
 * lock. Throws OccurrenceCancelledError if the ledger already marks this session
 * CANCELLING/CANCELLED — the caller maps that to its slot-unavailable flow.
 *
 * `sessionId` is `booking.event_id` / `order.event_id` / the tool's eventId —
 * i.e. the availability session id, the canonical lock key.
 */
export async function guardBooking<T>(
  sessionId: string,
  create: () => Promise<T>,
): Promise<T> {
  const outcome = await acrepo.withOccurrenceLock(sessionId, async (client) => {
    const ledger = await acrepo.getLedgerBySessionTx(client, sessionId);
    if (ledger && (ledger.state === "CANCELLED" || ledger.state === "CANCELLING")) {
      throw new OccurrenceCancelledError(sessionId);
    }
    return create();
  });
  // withOccurrenceLock only returns { acquired:false } in "try" mode; the
  // default blocking mode always resolves with a value.
  if (!outcome.acquired) throw new OccurrenceCancelledError(sessionId);
  return outcome.value;
}

/**
 * Was this availability session auto-cancelled? Cheap read (no lock) for callers
 * that want to short-circuit before doing work — the authoritative guard is
 * still guardBooking() around the create itself.
 */
export async function isSessionAutoCancelled(sessionId: string): Promise<boolean> {
  const ledger = await acrepo.getLedgerBySession(sessionId);
  return !!ledger && (ledger.state === "CANCELLED" || ledger.state === "CANCELLING");
}
