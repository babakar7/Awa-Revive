import { pool } from "../db/index.js";
import { notifyOwner } from "../lib/notify.js";

/**
 * Surveillance des réservations parties sans fiche contact Wix
 * (WIX-ORPHAN-BOOKINGS-PLAN.md §7).
 *
 * Le flux de paiement crée désormais la fiche manquante, mais il reste deux
 * cas qu'il refuse volontairement de trancher — plusieurs fiches sur le même
 * numéro (`ambiguous`, fusionner d'abord) et nom inexploitable (`bad_name`) —
 * plus les pannes (`lookup_failed`, `create_failed`). Sans compteur, ces
 * réservations redeviennent invisibles, ce qui est exactement le problème
 * d'origine : Penda a réservé et payé le 17/08 sans que rien ne le signale.
 *
 * Une passe par jour, seuil bas, message court. Le détail se lit sur /admin/crm.
 */

const STATE_KEY = "booking_contact_gap_alert";
const LOOKBACK_DAYS = 7;

/** Au-delà, on alerte le gérant. En deçà, la page CRM suffit. */
export const ALERT_THRESHOLD = 3;

export interface ContactGapCount {
  total: number;
  byGap: Record<string, number>;
}

/** Réservations confirmées des 7 derniers jours parties sans fiche. */
export async function countRecentContactGaps(): Promise<ContactGapCount> {
  const { rows } = await pool.query<{ contact_gap: string; n: string }>(
    `select contact_gap, count(*)::text n
       from pending_bookings
      where contact_gap is not null
        and status = 'BOOKED'
        and created_at > now() - interval '${LOOKBACK_DAYS} days'
      group by contact_gap`,
  );
  const byGap: Record<string, number> = {};
  let total = 0;
  for (const r of rows) {
    const n = Number(r.n);
    byGap[r.contact_gap] = n;
    total += n;
  }
  return { total, byGap };
}

const GAP_LABELS: Record<string, string> = {
  ambiguous: "plusieurs fiches sur le numéro",
  bad_name: "nom inexploitable",
  lookup_failed: "lecture Wix en échec",
  create_failed: "création de fiche refusée",
};

export function gapLabel(gap: string): string {
  return GAP_LABELS[gap] ?? gap;
}

/**
 * Une alerte par jour maximum (garde `app_state` atomique, même principe que la
 * story quotidienne). Renvoie le nombre alerté, ou 0 si rien à dire.
 */
export async function sweepContactGapAlert(now: Date = new Date()): Promise<number> {
  const counts = await countRecentContactGaps();
  if (counts.total < ALERT_THRESHOLD) return 0;

  // Dakar == UTC (cf. dailyStory) : la date ISO fait office de jour local.
  const today = now.toISOString().slice(0, 10);
  const claimed = await pool.query(
    `insert into app_state (key, value) values ($1, $2)
     on conflict (key) do update set value = $2, updated_at = now()
       where app_state.value <> $2`,
    [STATE_KEY, today],
  );
  if ((claimed.rowCount ?? 0) === 0) return 0; // déjà alerté aujourd'hui

  const detail = Object.entries(counts.byGap)
    .map(([gap, n]) => `${n} × ${gapLabel(gap)}`)
    .join(", ");
  notifyOwner(
    "Réservations sans fiche client",
    `${counts.total} réservation(s) des 7 derniers jours sont dans Wix sans fiche contact (${detail}).\n\n` +
      `Ces clientes n'ont pas d'historique et peuvent être confondues avec une homonyme. ` +
      `Détail et réparation en un clic : /admin/crm`,
  );
  return counts.total;
}
