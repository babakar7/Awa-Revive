import type pg from "pg";

/**
 * SPEC §5 state machine for pending_bookings.status
 *
 * DRAFT ──payment link created──► AWAITING_PAYMENT
 * AWAITING_PAYMENT ──TTL passed──────────────► EXPIRED
 * AWAITING_PAYMENT ──valid Wave/OM webhook───► PAID
 * PAID ──slot still free, Wix booking OK─────► BOOKED
 * PAID ──slot gone or Wix error──────────────► REFUND_NEEDED
 *
 * Plus (spec edge cases):
 * EXPIRED ──late Wave/OM webhook─────────────► PAID  (money taken; honor it)
 * DRAFT ──superseded / session create failed─► EXPIRED
 * DRAFT ──client paid before setAwaiting─────► PAID  (orphan draft: session
 *   existed with clientReference=draft.id; webhook-verified money wins)
 * BOOKED ──cancelled in Wix (reception)──────► CANCELLED  (synced lazily)
 * BOOKED ──voluntary cancellation by client──► CANCELLED  (never refunded)
 * REFUND_NEEDED ──manual refund done in Wave─► REFUNDED   (npm run refund:done)
 */
export type BookingStatus =
  | "DRAFT"
  | "AWAITING_PAYMENT"
  | "PAID"
  | "BOOKED"
  | "EXPIRED"
  | "REFUND_NEEDED"
  | "REFUNDED"
  | "CANCELLED";

export const TRANSITIONS: Record<BookingStatus, BookingStatus[]> = {
  // DRAFT→PAID: verified payment landed while the row was still DRAFT (crash
  // between Wave/OM session create and setAwaitingPayment). Money wins.
  DRAFT: ["AWAITING_PAYMENT", "EXPIRED", "PAID"],
  AWAITING_PAYMENT: ["PAID", "EXPIRED"],
  EXPIRED: ["PAID"], // late payment after TTL — honor it
  PAID: ["BOOKED", "REFUND_NEEDED"],
  // Once fulfilled, a voluntary cancellation can only release the seat. A
  // refund is reserved for a PAID booking Revive could not fulfill.
  BOOKED: ["CANCELLED"],
  REFUND_NEEDED: ["REFUNDED"], // manual refund processed in the Wave portal
  REFUNDED: [],
  CANCELLED: [],
};

export function canTransition(from: BookingStatus, to: BookingStatus): boolean {
  return TRANSITIONS[from]?.includes(to) ?? false;
}

/**
 * Atomic conditional transition. Returns the updated row, or null if the
 * booking was not in an allowed source state (e.g. a duplicate Wave webhook
 * racing us). This single UPDATE ... WHERE status = ANY(...) is what makes
 * duplicate-webhook handling and the last-spot race safe.
 */
export async function transition(
  db: pg.Pool | pg.PoolClient,
  bookingId: string,
  to: BookingStatus,
  extra: Record<string, unknown> = {},
): Promise<Record<string, unknown> | null> {
  const validSources = (Object.keys(TRANSITIONS) as BookingStatus[]).filter((s) =>
    canTransition(s, to),
  );
  if (validSources.length === 0) return null;

  const extraKeys = Object.keys(extra);
  const setClauses = ["status = $2", "updated_at = now()"];
  const params: unknown[] = [bookingId, to, validSources];
  extraKeys.forEach((k, i) => {
    setClauses.push(`${k} = $${4 + i}`);
    params.push(extra[k]);
  });

  const res = await db.query(
    `update pending_bookings
        set ${setClauses.join(", ")}
      where id = $1 and status = any($3)
      returning *`,
    params,
  );
  return res.rows[0] ?? null;
}
