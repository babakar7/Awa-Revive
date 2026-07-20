import { pool } from "../db/index.js";
import * as wix from "../lib/wix.js";

/**
 * Backfill des contacts sur les réservations Wix (cas « A », PROGRESS §6.6bis).
 *
 * Une réservation payée AVANT que le client n'ait de fiche contact Wix part
 * avec le seul nom disponible (souvent le nom de profil WhatsApp, ex. « A »)
 * et sans contactId — elle reste orpheline dans Wix même quand la fiche est
 * créée deux minutes plus tard. Dès qu'une fiche prouvée existe (compte lié /
 * créé par code email, ou contact retrouvé lors d'une résa suivante), on
 * rattache les réservations récentes du client et on aligne leur libellé sur
 * le nom canonique de la fiche.
 *
 * Tout est volontairement non fatal : le PATCH Wix utilisé est non documenté
 * et une réservation mal libellée reste une réservation valide.
 */

const LOOKBACK_DAYS = 60;
const MAX_BOOKINGS = 25;

export interface BookingContactRepair {
  bookingId: string;
  revision: string;
  firstName: string;
  lastName?: string;
}

/** Décision pure : quelles réservations rattacher/renommer (testée unitairement). */
export function planBookingContactRepairs(
  snapshots: wix.BookingContactSnapshot[],
  contactId: string,
  canonicalName: string,
): BookingContactRepair[] {
  const target = wix.splitContactName(canonicalName);
  return snapshots
    .filter(
      (s) =>
        s.contactId !== contactId ||
        s.firstName !== target.firstName ||
        (s.lastName ?? undefined) !== target.lastName,
    )
    .map((s) => ({
      bookingId: s.bookingId,
      revision: s.revision,
      firstName: target.firstName,
      ...(target.lastName ? { lastName: target.lastName } : {}),
    }));
}

export interface BackfillResult {
  checked: number;
  repaired: number;
  failed: number;
}

type BackfillLog = {
  info: (o: unknown, m?: string) => void;
  error: (o: unknown, m?: string) => void;
};

/**
 * Rattache les réservations BOOKED récentes du client à sa fiche contact
 * prouvée. Ne lève JAMAIS (appelable en fire-and-forget depuis les chemins
 * post-paiement et post-vérification, qui ne doivent pas casser pour un
 * libellé).
 */
export async function backfillBookingContacts(
  args: { clientId: string; phone: string; contactId: string },
  log: BackfillLog = console,
): Promise<BackfillResult> {
  const result: BackfillResult = { checked: 0, repaired: 0, failed: 0 };
  try {
    const contact = await wix.getContactById(args.contactId);
    const canonicalName = wix.wixContactFullName(contact);
    if (!canonicalName) return result; // pas de nom canonique → rien à écrire

    const { rows } = await pool.query(
      `select wix_booking_id from pending_bookings
        where client_id = $1
          and status = 'BOOKED'
          and wix_booking_id is not null
          and created_at > now() - interval '${LOOKBACK_DAYS} days'
        order by created_at desc
        limit ${MAX_BOOKINGS}`,
      [args.clientId],
    );
    const bookingIds = rows.map((r) => String(r.wix_booking_id));
    if (bookingIds.length === 0) return result;

    const snapshots = await wix.getBookingContactSnapshots(bookingIds);
    result.checked = snapshots.length;
    const repairs = planBookingContactRepairs(snapshots, args.contactId, canonicalName);

    for (const repair of repairs) {
      try {
        await wix.updateBookingContactDetails({
          bookingId: repair.bookingId,
          revision: repair.revision,
          contactId: args.contactId,
          firstName: repair.firstName,
          lastName: repair.lastName,
          phone: args.phone,
        });
        result.repaired += 1;
        log.info(
          { bookingId: repair.bookingId, contactId: args.contactId },
          "Booking contact backfilled",
        );
      } catch (err) {
        // Endpoint non documenté : si Wix le retire un jour, on le verra ici
        // sans rien casser d'autre.
        result.failed += 1;
        log.error({ err, bookingId: repair.bookingId }, "Booking contact backfill failed");
      }
    }
  } catch (err) {
    log.error({ err, clientId: args.clientId }, "Booking contact backfill aborted");
  }
  return result;
}
