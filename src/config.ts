import "dotenv/config";

function required(name: string): string {
  const v = process.env[name];
  if (!v || v.trim() === "") {
    missing.push(name);
    return "";
  }
  return v.trim();
}

function optional(name: string, fallback: string): string {
  const v = process.env[name];
  return v && v.trim() !== "" ? v.trim() : fallback;
}

const missing: string[] = [];

export const config = {
  // Meta / WhatsApp Cloud API
  WA_PHONE_NUMBER_ID: required("WA_PHONE_NUMBER_ID"),
  WA_ACCESS_TOKEN: required("WA_ACCESS_TOKEN"),
  WA_APP_SECRET: required("WA_APP_SECRET"),
  WA_VERIFY_TOKEN: required("WA_VERIFY_TOKEN"),
  // Approved Utility template used to notify reception when the 24h window is
  // closed (free-form text then fails with error 131047). Empty = no fallback.
  // Must have exactly 2 body variables: {{1}} subject, {{2}} flattened detail.
  WA_RECEPTION_TEMPLATE: optional("WA_RECEPTION_TEMPLATE", ""),
  WA_RECEPTION_TEMPLATE_LANG: optional("WA_RECEPTION_TEMPLATE_LANG", "fr"),
  // Approved CLIENT-facing template for the pre-expiry renewal nudge (sent
  // outside the 24h window, so a free-text send would fail with 131047). Empty
  // = the renewal push is disabled (the in-conversation offer still works).
  // 3 body variables: {{1}} first name, {{2}} plan name, {{3}} end date.
  WA_RENEWAL_TEMPLATE: optional("WA_RENEWAL_TEMPLATE", ""),
  WA_RENEWAL_TEMPLATE_LANG: optional("WA_RENEWAL_TEMPLATE_LANG", "fr"),
  // Days before a plan's end date to send the renewal nudge.
  RENEWAL_NUDGE_DAYS: parseInt(optional("RENEWAL_NUDGE_DAYS", "3"), 10),
  // Approved CLIENT-facing Utility template when a waitlisted spot frees up
  // OUTSIDE the 24h free-text window (Meta 131047). Empty = free-text only
  // (NOTIFY_FAILED outside the window). 2 body variables: {{1}} class name,
  // {{2}} date/time. Free text is tried first; template only on 131047.
  // Language code must match Meta exactly (en, en_US, fr, …).
  WA_WAITLIST_TEMPLATE: optional("WA_WAITLIST_TEMPLATE", ""),
  WA_WAITLIST_TEMPLATE_LANG: optional("WA_WAITLIST_TEMPLATE_LANG", "en"),
  // Meta App ID — only needed for the resumable upload flow used to change
  // the WhatsApp Business profile photo. Empty = photo edit disabled in
  // /admin/profile; description/address/hours still work.
  WA_APP_ID: optional("WA_APP_ID", ""),

  // Wix
  WIX_API_KEY: required("WIX_API_KEY"),
  WIX_SITE_ID: required("WIX_SITE_ID"),

  // Wave
  WAVE_API_KEY: required("WAVE_API_KEY"),
  WAVE_WEBHOOK_SECRET: required("WAVE_WEBHOOK_SECRET"),
  // Request-signing secret (wave_sn_AKS_...). If the Wave account has request
  // signing enforced, outbound API calls must carry a Wave-Signature header.
  WAVE_SIGNING_SECRET: optional("WAVE_SIGNING_SECRET", ""),

  // Orange Money / Max It (Sonatel). All three must be set to enable the rails;
  // empty = Wave-only (today's behaviour). Merchant code is 6 digits.
  OM_CLIENT_ID: optional("OM_CLIENT_ID", ""),
  OM_CLIENT_SECRET: optional("OM_CLIENT_SECRET", ""),
  OM_MERCHANT_CODE: optional("OM_MERCHANT_CODE", ""),
  OM_API_BASE: optional("OM_API_BASE", "https://api.orange-sonatel.com"),

  // Anthropic (the SDK also reads ANTHROPIC_API_KEY itself)
  ANTHROPIC_API_KEY: required("ANTHROPIC_API_KEY"),
  CLAUDE_MODEL: optional("CLAUDE_MODEL", "claude-sonnet-5"),

  // Voice-note transcription via OpenAI (optional — without the key, voice
  // notes get the polite "text only" reply, as before).
  OPENAI_API_KEY: optional("OPENAI_API_KEY", ""),
  TRANSCRIPTION_MODEL: optional("TRANSCRIPTION_MODEL", "gpt-4o-mini-transcribe"),

  // Email notifications to reception (optional — logged as warnings when unset).
  // Brevo HTTP API: Railway blocks outbound SMTP, so plain SMTP times out there.
  // The sender must be verified in the Brevo dashboard (Senders & Domains).
  BREVO_API_KEY: optional("BREVO_API_KEY", ""),
  EMAIL_FROM: optional("EMAIL_FROM", "Awa - Revive <support@revive.sn>"),
  RECEPTION_EMAIL: optional("RECEPTION_EMAIL", "support@revive.sn"),

  // Admin dashboard (optional — /admin answers 503 until this is set).
  // Format: "user1:password1,user2:password2"
  ADMIN_USERS: optional("ADMIN_USERS", ""),

  // App
  DATABASE_URL: required("DATABASE_URL"),
  BASE_URL: required("BASE_URL"),
  RECEPTION_PHONE: optional("RECEPTION_PHONE", "+221784644329"),
  // WhatsApp number to ping whenever someone STARTS a conversation with Awa
  // (a new lead, or a returning client after a quiet gap). Empty = disabled.
  // Free-text lands only inside the 24h window; outside it we fall back to the
  // reception Utility template (WA_RECEPTION_TEMPLATE) so it still arrives.
  NEW_CHAT_NOTIFY_PHONE: optional("NEW_CHAT_NOTIFY_PHONE", "+221774982711"),
  // A message counts as a NEW conversation when the client had no activity in
  // the last N hours (so a back-and-forth within one session pings only once).
  NEW_CHAT_NOTIFY_GAP_HOURS: parseInt(optional("NEW_CHAT_NOTIFY_GAP_HOURS", "6"), 10),
  PAYMENT_LINK_TTL_MINUTES: parseInt(optional("PAYMENT_LINK_TTL_MINUTES", "20"), 10),
  STUDIO_ADDRESS: optional("STUDIO_ADDRESS", "Revive Pilates, Almadies, Dakar"),
  PORT: parseInt(optional("PORT", "3000"), 10),
  TIMEZONE: "Africa/Dakar",
};

/**
 * Call at boot. Throws with the full list of missing vars so setup problems
 * surface once, clearly, instead of as scattered runtime failures.
 */
export function assertConfig(): void {
  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variables:\n  - ${missing.join("\n  - ")}\n` +
        `Fill them in .env (see .env.example). Use placeholder values only for ` +
        `integrations you are not exercising locally.`,
    );
  }
}
