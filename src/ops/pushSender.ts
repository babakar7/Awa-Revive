import webpush from "web-push";
import { config } from "../config.js";
import type { OpsDeviceRole } from "../domain/opsDeviceRepo.js";
import {
  listPushSubscriptionsForRole,
  listPushSubscriptionsForDevice,
  deletePushSubscription,
  type PushSubscription,
} from "../domain/pushRepo.js";

/**
 * Web Push fan-out for the ops PWAs. Disabled (a no-op) unless a VAPID keypair is
 * configured — the PWAs still work, just without background lock-screen alerts.
 * A dead subscription (404/410 Gone) is pruned on send so the table self-cleans.
 */

let configured: boolean | null = null;

/** True once VAPID is set; memoized. Safe to call every send. */
export function pushEnabled(): boolean {
  if (configured !== null) return configured;
  if (config.VAPID_PUBLIC_KEY && config.VAPID_PRIVATE_KEY) {
    try {
      webpush.setVapidDetails(
        config.VAPID_SUBJECT || "mailto:support@revive.sn",
        config.VAPID_PUBLIC_KEY,
        config.VAPID_PRIVATE_KEY,
      );
      configured = true;
    } catch {
      configured = false;
    }
  } else {
    configured = false;
  }
  return configured;
}

export interface PushPayload {
  title: string;
  body: string;
  /** Where a tap should land (PWA path). */
  url?: string;
  /** Collapses/replaces a prior notification with the same tag. */
  tag?: string;
}

/**
 * Fan a payload out to a set of subscriptions. Never throws; prunes Gone (404/410)
 * subscriptions so the table self-cleans. Returns how many delivered without error.
 */
async function fanOut(subs: PushSubscription[], payload: PushPayload): Promise<number> {
  if (subs.length === 0) return 0;
  const body = JSON.stringify(payload);
  let delivered = 0;
  await Promise.all(
    subs.map(async (s) => {
      try {
        await webpush.sendNotification(
          { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
          body,
        );
        delivered++;
      } catch (err: any) {
        const code = err?.statusCode;
        if (code === 404 || code === 410) {
          await deletePushSubscription(s.endpoint).catch(() => {});
        }
      }
    }),
  );
  return delivered;
}

/**
 * Send a notification to every active subscription of a role (e.g. all reception
 * phones). Fire-and-forget friendly: never throws; prunes Gone subscriptions.
 * Returns how many were delivered without error.
 */
export async function pushToRole(role: OpsDeviceRole, payload: PushPayload): Promise<number> {
  if (!pushEnabled()) return 0;
  return fanOut(await listPushSubscriptionsForRole(role), payload);
}

/**
 * Send to a single device's subscriptions only — powers the in-app "Tester la
 * sonnerie" button so a phone can prove its lock-screen alert works.
 */
export async function pushToDevice(deviceId: string, payload: PushPayload): Promise<number> {
  if (!pushEnabled()) return 0;
  return fanOut(await listPushSubscriptionsForDevice(deviceId), payload);
}
