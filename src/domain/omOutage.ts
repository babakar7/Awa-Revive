import { pool } from "../db/index.js";

/**
 * Mode « panne Orange Money / Max It » — activé à la main par le propriétaire
 * (bouton sur /admin/paiements-om) quand les callbacks Sonatel ne sont plus
 * délivrés (panne réelle depuis le 31/07/2026, marchand 553651).
 *
 * Effet quand actif :
 *  - Awa ne dit JAMAIS qu'un paiement OM/Max It « n'a pas été reçu » — la
 *    transaction peut être réelle avec une notification perdue. Elle rassure
 *    (vérification manuelle temporaire), alerte l'équipe (handoff), et promet
 *    la confirmation automatique après réconciliation.
 *  - Les nudges d'expiration OM/Max It adoptent la même posture et rappellent
 *    à l'équipe le chemin /admin/paiements-om.
 * Wave n'est pas concerné.
 */

const KEY = "om_outage_mode";

export async function isOmOutageActive(): Promise<boolean> {
  const res = await pool.query(`select value from app_state where key = $1`, [KEY]);
  return res.rows[0]?.value === "on";
}

export async function setOmOutageMode(on: boolean): Promise<void> {
  await pool.query(
    `insert into app_state (key, value) values ($1, $2)
     on conflict (key) do update set value = excluded.value, updated_at = now()`,
    [KEY, on ? "on" : "off"],
  );
}
