import { pool } from "../db/index.js";

/**
 * SQL for paired ops devices (cuisine iPad, reception phones, owner). A device
 * is created in a PENDING state carrying a hashed, short-lived pairing code; the
 * device redeems that code to receive a hashed session token (the real, long-
 * lived credential). Revocation is a durable flag — the whole point of a
 * server-side session vs. the stateless admin cookie. Only hashes are stored.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type OpsDeviceRole = "cuisine" | "accueil" | "owner";

export interface OpsDevice {
  id: string;
  label: string;
  role: OpsDeviceRole;
  paired_at: Date | null;
  revoked_at: Date | null;
  last_seen_at: Date | null;
  created_at: Date;
}

const PUBLIC_COLS =
  "id, label, role, paired_at, revoked_at, last_seen_at, created_at";

/** Create a device row holding a hashed pairing code (not yet paired). */
export async function createPairingDevice(
  label: string,
  role: OpsDeviceRole,
  pairCodeHash: string,
  pairExpiresAt: Date,
): Promise<OpsDevice> {
  const res = await pool.query(
    `insert into ops_devices (label, role, pair_code_hash, pair_expires_at)
     values ($1, $2, $3, $4)
     returning ${PUBLIC_COLS}`,
    [label.trim() || role, role, pairCodeHash, pairExpiresAt],
  );
  return res.rows[0] as OpsDevice;
}

/**
 * Redeem a pairing code: bind the session token hash to the device, clear the
 * (single-use) pairing code, stamp paired_at. Atomic and one-shot — the WHERE
 * consumes the code so a replay finds nothing. Returns the paired device or null
 * (unknown/expired/revoked code).
 */
export async function redeemPairing(
  pairCodeHash: string,
  sessionTokenHash: string,
): Promise<OpsDevice | null> {
  const res = await pool.query(
    `update ops_devices
        set session_token_hash = $2, paired_at = now(),
            last_seen_at = now(), pair_code_hash = null, pair_expires_at = null
      where pair_code_hash = $1 and pair_expires_at > now() and revoked_at is null
      returning ${PUBLIC_COLS}`,
    [pairCodeHash, sessionTokenHash],
  );
  return (res.rows[0] as OpsDevice) ?? null;
}

/**
 * Resolve a device by its session token hash. Optionally require a role (a
 * cuisine session can't reach accueil routes). Touches last_seen_at (heartbeat
 * for the admin supervision view). Returns null if unknown or revoked.
 */
export async function verifyDeviceSession(
  sessionTokenHash: string,
  requiredRole?: OpsDeviceRole,
): Promise<OpsDevice | null> {
  const res = await pool.query(
    `update ops_devices set last_seen_at = now()
      where session_token_hash = $1 and revoked_at is null
        and ($2::text is null or role = $2)
      returning ${PUBLIC_COLS}`,
    [sessionTokenHash, requiredRole ?? null],
  );
  return (res.rows[0] as OpsDevice) ?? null;
}

export async function listOpsDevices(): Promise<OpsDevice[]> {
  const res = await pool.query(
    `select ${PUBLIC_COLS} from ops_devices order by revoked_at nulls first, created_at desc`,
  );
  return res.rows as OpsDevice[];
}

/** Revoke a device (durable): its session stops resolving immediately. */
export async function revokeOpsDevice(id: string): Promise<boolean> {
  if (!UUID_RE.test(String(id))) return false;
  const res = await pool.query(
    `update ops_devices
        set revoked_at = now(), session_token_hash = null,
            pair_code_hash = null, pair_expires_at = null
      where id = $1 and revoked_at is null`,
    [id],
  );
  return (res.rowCount ?? 0) > 0;
}

/**
 * DEV ONLY (behind OPS_DEV_AUTOPAIR): bind a session token to a single reusable
 * "Aperçu (dev)" cuisine device so the kiosque can be tried without an iPad and
 * without entering a pairing code. Reuses one row (rotating its token) so it
 * never litters the device list. Callers MUST gate this on the dev flag — it is
 * an intentional auth bypass and must never run in production.
 */
export async function provisionDevCuisineDevice(sessionTokenHash: string): Promise<void> {
  const updated = await pool.query(
    `update ops_devices
        set session_token_hash = $1, paired_at = coalesce(paired_at, now()),
            last_seen_at = now(), revoked_at = null
      where label = 'Aperçu (dev)' and role = 'cuisine'`,
    [sessionTokenHash],
  );
  if ((updated.rowCount ?? 0) > 0) return;
  await pool.query(
    `insert into ops_devices (label, role, session_token_hash, paired_at, last_seen_at)
     values ('Aperçu (dev)', 'cuisine', $1, now(), now())`,
    [sessionTokenHash],
  );
}

/**
 * DEV ONLY (behind OPS_DEV_AUTOPAIR): same as provisionDevCuisineDevice but for a
 * reusable "Aperçu accueil (dev)" reception device, so the service PWA can be
 * tried without pairing a phone. MUST be gated on the dev flag — an auth bypass.
 */
export async function provisionDevAccueilDevice(sessionTokenHash: string): Promise<void> {
  const updated = await pool.query(
    `update ops_devices
        set session_token_hash = $1, paired_at = coalesce(paired_at, now()),
            last_seen_at = now(), revoked_at = null
      where label = 'Aperçu accueil (dev)' and role = 'accueil'`,
    [sessionTokenHash],
  );
  if ((updated.rowCount ?? 0) > 0) return;
  await pool.query(
    `insert into ops_devices (label, role, session_token_hash, paired_at, last_seen_at)
     values ('Aperçu accueil (dev)', 'accueil', $1, now(), now())`,
    [sessionTokenHash],
  );
}

/** Delete a device row entirely (admin cleanup of a revoked/never-paired row). */
export async function deleteOpsDevice(id: string): Promise<boolean> {
  if (!UUID_RE.test(String(id))) return false;
  const res = await pool.query(`delete from ops_devices where id = $1`, [id]);
  return (res.rowCount ?? 0) > 0;
}
