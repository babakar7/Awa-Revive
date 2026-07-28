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
  for (const [key, ts] of orderWindows) {
    const fresh = ts.filter((t) => now - t < ORDER_WINDOW_MS);
    if (fresh.length === 0) orderWindows.delete(key);
    else orderWindows.set(key, fresh);
  }
}, 5 * 60 * 1000).unref();

// ── Public /commander order endpoint (unauthenticated) ──
// Tighter, longer window than the WhatsApp limiter: a handful of order attempts
// per key over 15 min. Call once per IP and once per phone so neither a shared IP
// nor a spoofed phone alone can flood order/payment creation.
const ORDER_WINDOW_MS = 15 * 60 * 1000;
const ORDER_MAX = 5;
const orderWindows = new Map<string, number[]>();

/** Whether a public order attempt is allowed for this key (an IP or a phone). */
export function allowPublicOrder(key: string): boolean {
  const now = Date.now();
  const ts = (orderWindows.get(key) ?? []).filter((t) => now - t < ORDER_WINDOW_MS);
  if (ts.length >= ORDER_MAX) {
    orderWindows.set(key, ts);
    return false;
  }
  ts.push(now);
  orderWindows.set(key, ts);
  return true;
}

/** Test-only: clear the public-order windows so cases don't leak the shared-IP
 *  budget into one another. Never called in production. */
export function __resetPublicOrderLimiter(): void {
  orderWindows.clear();
}
