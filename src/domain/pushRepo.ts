import { pool } from "../db/index.js";
import type { OpsDeviceRole } from "./opsDeviceRepo.js";

/**
 * SQL for Web Push subscriptions (one or more per paired ops device). A device
 * subscribes from the PWA; the endpoint is the unique key (a device that
 * re-subscribes updates its row). Subscriptions of revoked devices are excluded
 * from sends and cleaned up on a 410 Gone from the push service.
 */

export interface PushSubscription {
  endpoint: string;
  p256dh: string;
  auth: string;
}

/** Upsert a device's push subscription (endpoint is the natural key). */
export async function savePushSubscription(
  deviceId: string,
  sub: PushSubscription,
): Promise<void> {
  await pool.query(
    `insert into push_subscriptions (device_id, endpoint, p256dh, auth)
     values ($1, $2, $3, $4)
     on conflict (endpoint) do update
       set device_id = excluded.device_id, p256dh = excluded.p256dh, auth = excluded.auth`,
    [deviceId, sub.endpoint, sub.p256dh, sub.auth],
  );
}

/** Remove a subscription (called on 410/404 Gone from the push service). */
export async function deletePushSubscription(endpoint: string): Promise<void> {
  await pool.query(`delete from push_subscriptions where endpoint = $1`, [endpoint]);
}

/** Active subscriptions for a role — only devices that are paired and not revoked. */
export async function listPushSubscriptionsForRole(
  role: OpsDeviceRole,
): Promise<PushSubscription[]> {
  const res = await pool.query(
    `select s.endpoint, s.p256dh, s.auth
       from push_subscriptions s
       join ops_devices d on d.id = s.device_id
      where d.role = $1 and d.revoked_at is null`,
    [role],
  );
  return res.rows as PushSubscription[];
}
