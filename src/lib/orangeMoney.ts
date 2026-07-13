/**
 * Orange Money / Max It (Sonatel) — QR merchant payments.
 *
 * Proven shapes from the live website (orangecheckout.jsw) + our probes:
 *  - OAuth: form-urlencoded client_id + client_secret + grant_type
 *  - QR: POST /api/eWallet/v4/qrcode with X-Callback-Url header (per-request
 *    notification target — no merchant-level registration needed)
 *  - merchant code is a number; metadata echoed on the payment webhook
 *
 * Payment-first: this module only creates sessions and verifies transactions.
 * Fulfillment always goes through domain/fulfillment after verify-by-lookup.
 */

import { config } from "../config.js";

const HTTP_TIMEOUT_MS = 15_000;

export type OmPaymentMethod = "orange_money" | "maxit";

export interface OmQrSession {
  qrId: string;
  deepLink: string;
  deepLinks: { OM?: string; MAXIT?: string };
  /** Absolute expiry from the API when present. */
  validUntil: Date | null;
  raw: unknown;
}

export interface OmTransaction {
  transactionId: string;
  status: string;
  amountValue: number;
  partnerId: string | null;
  metadata: Record<string, unknown>;
  customerId: string | null;
  raw: unknown;
}

let cachedToken: { token: string; expiresAtMs: number } | null = null;
/** Coalesce concurrent token fetches (avoid N cold OAuth waits on one deploy). */
let tokenInflight: Promise<string> | null = null;
let keepAliveTimer: ReturnType<typeof setInterval> | null = null;

/** True when prod OM credentials are configured (feature flag for tools). */
export function isOmEnabled(): boolean {
  return !!(config.OM_CLIENT_ID && config.OM_CLIENT_SECRET && config.OM_MERCHANT_CODE);
}

/**
 * Fetch/cache OAuth token. Single-flight + in-memory cache (~5 min bearer).
 * First call after deploy is the slow one (Sonatel OAuth); later calls are free.
 */
export async function getAccessToken(): Promise<string> {
  if (!isOmEnabled()) throw new Error("Orange Money is not configured");
  const now = Date.now();
  // Refresh 45s before expiry so a payment never waits on a dying token.
  if (cachedToken && cachedToken.expiresAtMs > now + 45_000) {
    return cachedToken.token;
  }
  if (tokenInflight) return tokenInflight;

  tokenInflight = (async () => {
    const t0 = Date.now();
    const body = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: config.OM_CLIENT_ID,
      client_secret: config.OM_CLIENT_SECRET,
    });
    const res = await fetch(`${config.OM_API_BASE}/oauth/token`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body,
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
    if (!res.ok) {
      throw new Error(`OM token failed (${res.status}): ${await res.text()}`);
    }
    const data: any = await res.json();
    if (!data?.access_token) {
      throw new Error(`OM token response missing access_token: ${JSON.stringify(data)}`);
    }
    const expiresIn = Number(data.expires_in) || 300;
    cachedToken = {
      token: data.access_token,
      expiresAtMs: Date.now() + expiresIn * 1000,
    };
    console.log(`[om] token fetched in ${Date.now() - t0}ms (expires_in=${expiresIn}s)`);
    return cachedToken.token;
  })().finally(() => {
    tokenInflight = null;
  });

  return tokenInflight;
}

/**
 * Warm the token at boot / on a timer so the first client payment is not
 * blocked by OAuth. Safe to call when OM is disabled (no-op).
 */
export async function warmOmToken(): Promise<void> {
  if (!isOmEnabled()) return;
  try {
    await getAccessToken();
  } catch (err) {
    console.warn("[om] token warm failed (will retry on next payment):", err);
  }
}

/** Keep the bearer hot (prod token ~5 min). Call once at boot. */
export function startOmTokenKeepAlive(): void {
  if (!isOmEnabled() || keepAliveTimer) return;
  // Refresh every 3 min while token lives ~5 min.
  keepAliveTimer = setInterval(() => {
    void warmOmToken();
  }, 3 * 60_000);
  keepAliveTimer.unref?.();
  void warmOmToken();
}

/** Pure: pick the deep link for the client's app choice. */
export function pickDeepLink(
  method: OmPaymentMethod,
  deepLink: string,
  deepLinks?: { OM?: string; MAXIT?: string } | null,
): string {
  if (method === "maxit") {
    return deepLinks?.MAXIT || deepLink;
  }
  return deepLinks?.OM || deepLink;
}

/**
 * Create a merchant QR session. `clientReference` is our pending row id
 * (booking / plan / cafe) — echoed as metadata.order on the webhook.
 */
export async function createQrPayment(args: {
  amountXof: number;
  clientReference: string;
  name: string;
  /** Validity window in minutes (aligned with PAYMENT_LINK_TTL_MINUTES).
   *  Sonatel API expects **seconds** in the body (probe: validity 120 → 2 min). */
  validityMinutes: number;
  callbackUrl: string;
  successUrl: string;
  cancelUrl: string;
}): Promise<OmQrSession> {
  const t0 = Date.now();
  const token = await getAccessToken();
  const tToken = Date.now() - t0;
  const merchantCode = Number(config.OM_MERCHANT_CODE);
  if (!Number.isFinite(merchantCode)) {
    throw new Error(`OM_MERCHANT_CODE must be numeric, got ${config.OM_MERCHANT_CODE}`);
  }
  const validitySeconds = Math.max(60, Math.round(args.validityMinutes * 60));
  const body = {
    amount: { unit: "XOF", value: Math.round(args.amountXof) },
    callbackSuccessUrl: args.successUrl,
    callbackCancelUrl: args.cancelUrl,
    code: merchantCode,
    metadata: { order: args.clientReference, channel: "awa" },
    name: args.name.slice(0, 80) || "Revive",
    validity: validitySeconds,
  };
  const tQr0 = Date.now();
  const res = await fetch(`${config.OM_API_BASE}/api/eWallet/v4/qrcode`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json",
      // Per-request notification target (website uses the same header pattern).
      "X-Callback-Url": args.callbackUrl,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`OM QR create failed (${res.status}): ${await res.text()}`);
  }
  console.log(
    `[om] createQrPayment token=${tToken}ms qr=${Date.now() - tQr0}ms total=${Date.now() - t0}ms`,
  );
  const data: any = await res.json();
  if (!data?.qrId || !(data?.deepLink || data?.deepLinks)) {
    throw new Error(`OM QR response missing qrId/deepLink: ${JSON.stringify(data)}`);
  }
  let validUntil: Date | null = null;
  const end = data?.validFor?.endDateTime;
  if (end) {
    const d = new Date(end);
    if (!Number.isNaN(d.getTime())) validUntil = d;
  }
  return {
    qrId: String(data.qrId),
    deepLink: String(data.deepLink ?? data.deepLinks?.OM ?? data.deepLinks?.MAXIT ?? ""),
    deepLinks: {
      OM: data.deepLinks?.OM ? String(data.deepLinks.OM) : undefined,
      MAXIT: data.deepLinks?.MAXIT ? String(data.deepLinks.MAXIT) : undefined,
    },
    validUntil,
    raw: data,
  };
}

/**
 * Verify a payment via the authenticated transactions API (source of truth).
 * Webhooks are only a trigger — never fulfill on the callback body alone.
 */
export async function lookupSuccessfulTransaction(
  transactionId: string,
): Promise<OmTransaction | null> {
  const token = await getAccessToken();
  const url = new URL(`${config.OM_API_BASE}/api/eWallet/v1/transactions`);
  url.searchParams.set("transactionId", transactionId);
  const res = await fetch(url.toString(), {
    method: "GET",
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`OM transaction lookup failed (${res.status}): ${await res.text()}`);
  }
  const data: any = await res.json();
  // Response shape may be a list or a single object — normalize.
  const items: any[] = Array.isArray(data)
    ? data
    : Array.isArray(data?.data)
      ? data.data
      : Array.isArray(data?.content)
        ? data.content
        : data?.transactionId
          ? [data]
          : [];
  const hit =
    items.find(
      (t) =>
        String(t?.transactionId ?? t?.id ?? "") === transactionId &&
        String(t?.status ?? "").toUpperCase() === "SUCCESS",
    ) ?? null;
  if (!hit) return null;
  const amountRaw = hit.amount?.value ?? hit.amount ?? hit.value;
  const amountValue = typeof amountRaw === "number" ? amountRaw : Number(amountRaw);
  return {
    transactionId: String(hit.transactionId ?? hit.id ?? transactionId),
    status: String(hit.status ?? ""),
    amountValue: Number.isFinite(amountValue) ? amountValue : 0,
    partnerId: hit.partner?.id != null ? String(hit.partner.id) : null,
    metadata: (hit.metadata && typeof hit.metadata === "object" ? hit.metadata : {}) as Record<
      string,
      unknown
    >,
    customerId: hit.customer?.id != null ? String(hit.customer.id) : null,
    raw: hit,
  };
}

/** Pure checks used after lookup (unit-tested). */
export function transactionMatchesPending(
  tx: OmTransaction,
  args: { amountXof: number; merchantCode: string; orderId: string },
): { ok: true } | { ok: false; reason: string } {
  if (String(tx.status).toUpperCase() !== "SUCCESS") {
    return { ok: false, reason: `status_${tx.status}` };
  }
  if (tx.partnerId && String(tx.partnerId) !== String(args.merchantCode)) {
    return { ok: false, reason: "partner_mismatch" };
  }
  // Amounts may arrive as 100 or 100.0 — require at least the pending amount.
  if (tx.amountValue + 0.001 < args.amountXof) {
    return { ok: false, reason: "amount_too_low" };
  }
  const order = tx.metadata?.order != null ? String(tx.metadata.order) : "";
  if (order && order !== args.orderId) {
    return { ok: false, reason: "order_mismatch" };
  }
  return { ok: true };
}

/** Reset token cache (tests). */
export function _resetOmTokenCacheForTests(): void {
  cachedToken = null;
}
