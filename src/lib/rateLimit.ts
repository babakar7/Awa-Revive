/**
 * In-memory sliding-window rate limiter per phone number (SPEC §9:
 * bound API spend, e.g. 20 msgs/min). In-memory is acceptable — losing the
 * window on restart only briefly relaxes the limit.
 */
const WINDOW_MS = 60 * 1000;
const MAX_PER_WINDOW = 20;

const windows = new Map<string, number[]>();
/** Last time we sent a throttle notice to a phone — at most one per window. */
const notified = new Map<string, number>();

export interface RateDecision {
  /** Whether this message may be processed. */
  allowed: boolean;
  /** True once per window on the first drop, so the caller can warn the client
   * a single time instead of spamming (or staying silent). */
  notifyThrottle: boolean;
}

export function allowMessage(phone: string): RateDecision {
  const now = Date.now();
  const timestamps = (windows.get(phone) ?? []).filter((t) => now - t < WINDOW_MS);
  if (timestamps.length >= MAX_PER_WINDOW) {
    windows.set(phone, timestamps);
    const lastNotice = notified.get(phone) ?? 0;
    const notifyThrottle = now - lastNotice >= WINDOW_MS;
    if (notifyThrottle) notified.set(phone, now);
    return { allowed: false, notifyThrottle };
  }
  timestamps.push(now);
  windows.set(phone, timestamps);
  return { allowed: true, notifyThrottle: false };
}

// Periodic cleanup so the maps don't grow unbounded.
setInterval(() => {
  const now = Date.now();
  for (const [phone, timestamps] of windows) {
    const fresh = timestamps.filter((t) => now - t < WINDOW_MS);
    if (fresh.length === 0) windows.delete(phone);
    else windows.set(phone, fresh);
  }
  for (const [phone, at] of notified) {
    if (now - at >= WINDOW_MS) notified.delete(phone);
  }
}, 5 * 60 * 1000).unref();
