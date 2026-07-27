/**
 * Was this error a TRANSIENT hiccup worth one more try? Provider 5xx, rate-limit
 * (429), or a low-level network drop (fetch/socket). A 4xx (bad request, auth)
 * is NOT transient — retrying it just wastes time and repeats the same failure.
 */
export function isTransientError(err: unknown): boolean {
  const status = (err as { status?: number; statusCode?: number })?.status
    ?? (err as { statusCode?: number })?.statusCode;
  if (typeof status === "number") return status === 429 || status >= 500;
  const msg = (err instanceof Error ? err.message : String(err ?? "")).toLowerCase();
  // Also catch our HTTP wrappers that fold the status into the message, e.g.
  // Wix's `... failed (503): ...` and AbortSignal.timeout's "aborted".
  if (/\((?:429|5\d\d)\)/.test(msg)) return true;
  return /econnreset|etimedout|econnrefused|enotfound|socket hang up|network|fetch failed|timeout|aborted|temporarily/.test(msg);
}

/**
 * Run `fn`, and on a transient failure (see isTransientError) retry it up to
 * `retries` more times, pausing `delayMs` between attempts. A non-transient
 * error, or exhausting the retries, rethrows the last error. Use ONLY for
 * idempotent-enough work (reads, or creating a fresh payment session where an
 * orphaned first attempt is harmless) — never where a retry could double a
 * side effect. delayMs is injectable so tests can pass 0.
 */
export async function withTransientRetry<T>(
  fn: () => Promise<T>,
  opts: { retries?: number; delayMs?: number; label?: string } = {},
): Promise<T> {
  const retries = opts.retries ?? 1;
  const delayMs = opts.delayMs ?? 1500;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt === retries || !isTransientError(err)) throw err;
      if (opts.label) console.warn(`[retry] ${opts.label} transient failure, attempt ${attempt + 1}/${retries + 1}:`, err);
      if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw lastErr;
}
