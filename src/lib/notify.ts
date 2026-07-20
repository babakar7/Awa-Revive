import { config } from "../config.js";
import { sendTemplate, sendText } from "./whatsapp.js";
import { recordNewChatLog, recordReceptionLog } from "../domain/notificationRepo.js";
import { STAFF_FOOTER } from "../domain/notificationRules.js";

/**
 * Automatic notifications to the reception team — handoffs, refunds,
 * unlinked clients. Replaces "hope someone runs the daily summary".
 *
 * Two channels, each independent (one failing never blocks the other):
 *  - Email via the Brevo HTTP API (SMTP egress is blocked on Railway, which
 *    made every nodemailer send time out — see the switch of July 2026).
 *    Activates only when BREVO_API_KEY is set.
 *  - WhatsApp to RECEPTION_PHONE via the Cloud API (since the Meta business
 *    verification was approved, July 2026). Free-form sends only work inside
 *    a 24h customer-service window — reception must have messaged Awa in the
 *    last 24h, otherwise Meta rejects with error 131047. When that happens and
 *    WA_RECEPTION_TEMPLATE is set, we retry with the approved Utility template
 *    (templates go through outside the window, billed per message).
 */

const BREVO_ENDPOINT = "https://api.brevo.com/v3/smtp/email";

/** Parse `Name <email>` (or a bare address) into Brevo's sender shape. */
function parseSender(from: string): { name?: string; email: string } {
  const m = from.match(/^(.*)<([^>]+)>\s*$/);
  if (m) return { name: m[1].trim().replace(/^"|"$/g, "") || undefined, email: m[2].trim() };
  return { email: from.trim() };
}

export function emailNotificationsEnabled(): boolean {
  return config.BREVO_API_KEY !== "";
}

export interface EmailAttachment {
  name: string;
  content: Buffer | string;
}

/** Send one email to any recipient via the Brevo HTTP API. Throws on failure. */
export async function sendEmail(
  toEmail: string,
  subject: string,
  body: string,
  attachments: EmailAttachment[] = [],
): Promise<void> {
  if (!emailNotificationsEnabled()) throw new Error("BREVO_API_KEY non configurée");
  const res = await fetch(BREVO_ENDPOINT, {
    method: "POST",
    headers: {
      "api-key": config.BREVO_API_KEY,
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify({
      sender: parseSender(config.EMAIL_FROM),
      to: [{ email: toEmail }],
      subject,
      textContent: body,
      ...(attachments.length > 0
        ? {
            attachment: attachments.map((a) => ({
              name: a.name,
              content: Buffer.isBuffer(a.content)
                ? a.content.toString("base64")
                : Buffer.from(a.content, "utf8").toString("base64"),
            })),
          }
        : {}),
    }),
    // Never let a slow API hang a send for minutes.
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Brevo ${res.status}: ${detail.slice(0, 300)}`);
  }
}

/**
 * Send one email to reception and resolve true on success, false on failure.
 * Exported for the test script; app code should use notifyReception().
 */
export async function sendReceptionEmail(subject: string, body: string): Promise<boolean> {
  await sendEmail(
    config.RECEPTION_EMAIL,
    `[Awa] ${subject}`,
    `${body}\n\n—\nEnvoyé automatiquement par Awa (bot de réservation WhatsApp).`,
  );
  return true;
}

/**
 * The account-linking verification code, sent to the email carried by the
 * client's Wix fiche. This inbox is the ONLY channel the code travels
 * through: Awa never sees it (it is absent from every tool result), so the
 * model can't leak it — the client proves ownership by reading their mail.
 */
export async function sendVerificationCodeEmail(toEmail: string, code: string): Promise<void> {
  await sendEmail(
    toEmail,
    "[Revive] Votre code de vérification",
    `Bonjour,\n\n` +
      `Votre code de vérification Revive : ${code}\n\n` +
      `Recopiez-le dans la conversation WhatsApp avec Awa pour relier votre numéro ` +
      `à votre compte. Il est valable 10 minutes.\n\n` +
      `Si vous n'êtes pas à l'origine de cette demande, ignorez cet email — ` +
      `rien ne sera modifié sur votre compte.\n\n` +
      `À bientôt au studio,\nRevive Dakar`,
  );
}

/**
 * Flatten arbitrary notification text into a valid template parameter:
 * Meta rejects params containing newlines, tabs, or 4+ consecutive spaces,
 * and the whole rendered message is capped at 1024 chars.
 */
export function toTemplateParam(text: string, maxLength = 550): string {
  const flat = text
    .replace(/\s*\n+\s*/g, " | ")
    .replace(/\s{2,}/g, " ")
    .trim();
  return flat.length > maxLength ? `${flat.slice(0, maxLength - 1)}…` : flat;
}

/** Which delivery path a WhatsApp notification took (for the admin log). */
export type WhatsAppSendPath = "sent" | "sent_template";

/**
 * Drop the staff free-text footer before injecting a body into the Utility
 * template: the template's FIXED text already ends with its own « message
 * automatique — merci de ne pas répondre » signature, so keeping the footer
 * doubles the mention (seen on the test button, 15/07). Free-text sends keep
 * the footer — they have no template signature. Pure, exported for tests.
 */
export function stripStaffFooter(body: string): string {
  const stripped = body.replace(STAFF_FOOTER, "").trim();
  return stripped || body;
}

/**
 * Send one WhatsApp notification to an arbitrary number. Free-form text first
 * (full detail, free); if the 24h window is closed (Meta error 131047) and the
 * reception Utility template is configured, fall back to it so the message
 * still lands (billed per message). Any other error propagates. Returns which
 * path won so the caller can log "sent" vs "sent_template".
 */
export async function sendWhatsAppNotification(
  toPhone: string,
  subject: string,
  body: string,
  opts: { preferTemplate?: boolean } = {},
): Promise<WhatsAppSendPath> {
  // The Cloud API expects a wa_id-style number (digits only, no "+").
  const to = toPhone.replace(/\D/g, "");
  const templateParams = () =>
    sendTemplate(to, config.WA_RECEPTION_TEMPLATE, config.WA_RECEPTION_TEMPLATE_LANG, [
      toTemplateParam(subject, 120),
      toTemplateParam(stripStaffFooter(body)),
    ]);
  // Staff recipients (coach/guardian/kitchen/test) almost never have an open
  // 24h window, and free-text out-of-window can be accepted (200) then dropped
  // asynchronously — an invisible miss. For them we send the template FIRST;
  // only if it fails do we try free-text (window might actually be open).
  if (opts.preferTemplate && config.WA_RECEPTION_TEMPLATE) {
    try {
      await templateParams();
      return "sent_template";
    } catch (err) {
      console.warn(`[notify] template-first failed for ${to}, trying free-text:`, err);
    }
  }
  try {
    await sendText(to, `🔔 *[Awa] ${subject}*\n\n${body}`);
    return "sent";
  } catch (err) {
    if (!config.WA_RECEPTION_TEMPLATE || !String(err).includes("131047")) throw err;
    console.warn(
      `[notify] 24h window closed for ${to} — falling back to template "${config.WA_RECEPTION_TEMPLATE}"`,
    );
    await templateParams();
    return "sent_template";
  }
}

/**
 * Send one WhatsApp message to reception. Exported for the test script; app
 * code should use notifyReception().
 */
export async function sendReceptionWhatsApp(
  subject: string,
  body: string,
): Promise<WhatsAppSendPath> {
  return sendWhatsAppNotification(config.RECEPTION_PHONE, subject, body);
}

/**
 * Fire-and-forget WhatsApp ping when someone STARTS a conversation with Awa.
 * Goes to NEW_CHAT_NOTIFY_PHONE (empty = feature off). Never awaited by the
 * caller and never throws — a notification hiccup must not affect the client.
 */
export function notifyNewConversation(args: {
  displayName: string;
  waPhone: string;
  preview: string;
}): void {
  if (config.NEW_CHAT_NOTIFY_PHONE === "") return;
  const cleanPhone = args.waPhone.replace(/^\+/, "");
  const subject = "Nouvelle conversation";
  const body =
    `${args.displayName} (+${cleanPhone}) vient de démarrer une conversation avec Awa.\n` +
    `Premier message : « ${args.preview} »\n` +
    `Ouvrir : https://wa.me/${cleanPhone}`;
  // The notify number (Babakar) almost never messages Awa → its 24h window is
  // ~always closed, and free-text out-of-window can be accepted (200) then
  // dropped asynchronously — a silent miss. Template-first, like the other staff
  // pings (test button, rule reminders). Journaled as source='new_chat' (owner
  // only — not reception) so the admin log doesn't mislabel it.
  const logBody = `${subject}\n${body}`;
  sendWhatsAppNotification(config.NEW_CHAT_NOTIFY_PHONE, subject, body, { preferTemplate: true })
    .then((path) => {
      console.log(`[notify] New-conversation ping (${path}) for +${cleanPhone}`);
      void recordNewChatLog(config.NEW_CHAT_NOTIFY_PHONE, logBody, path, null);
    })
    .catch((err) => {
      console.error(`[notify] Failed to send new-conversation ping for +${cleanPhone}:`, err);
      void recordNewChatLog(config.NEW_CHAT_NOTIFY_PHONE, logBody, "failed", String(err).slice(0, 300));
    });
}

export interface NotifyReceptionOpts {
  /**
   * Café/bar orders: reception lives on WhatsApp, so make WhatsApp the primary
   * channel and only fall back to email if the WhatsApp send ultimately fails.
   * Left off (default) for money/escalation paths (refunds, handoffs, crash
   * alerts), which keep the belt-and-braces dual-channel send — email is still
   * the reliable channel there while the reception template is pending.
   */
  whatsappFirst?: boolean;
}

/**
 * Fire-and-forget notification to reception. Returns immediately — the sends
 * happen in the background so they can never delay a reply to the client (an
 * awaited send once blocked a WhatsApp answer for 2 minutes). Every WhatsApp
 * attempt is journaled to notification_log so it shows on /admin/notifications.
 */
export function notifyReception(
  subject: string,
  body: string,
  opts: NotifyReceptionOpts = {},
): void {
  const logBody = `${subject}\n${body}`;

  if (opts.whatsappFirst) {
    // WhatsApp primary; email only as a safety net if WhatsApp fails.
    sendReceptionWhatsApp(subject, body)
      .then((path) => {
        console.log(`[notify] Reception notified on WhatsApp (${path}): ${subject}`);
        void recordReceptionLog(config.RECEPTION_PHONE, logBody, path, null);
      })
      .catch((err) => {
        console.error(`[notify] Café WhatsApp to reception failed (${subject}):`, err);
        void recordReceptionLog(config.RECEPTION_PHONE, logBody, "failed", String(err).slice(0, 300));
        if (emailNotificationsEnabled()) {
          sendReceptionEmail(subject, body)
            .then(() => console.log(`[notify] Reception emailed (WhatsApp fallback): ${subject}`))
            .catch((e) => console.error(`[notify] Email fallback also failed (${subject}):`, e));
        } else {
          console.warn(`[notify] BREVO_API_KEY not set — no email fallback for: ${subject}`);
        }
      });
    return;
  }

  // Default: independent dual-channel (email is the reliable leg for critical paths).
  if (!emailNotificationsEnabled()) {
    console.warn(`[notify] BREVO_API_KEY not set — reception NOT emailed: ${subject}`);
  } else {
    sendReceptionEmail(subject, body)
      .then(() => console.log(`[notify] Reception emailed: ${subject}`))
      .catch((err) => console.error(`[notify] Failed to email reception (${subject}):`, err));
  }

  sendReceptionWhatsApp(subject, body)
    .then((path) => {
      console.log(`[notify] Reception notified on WhatsApp (${path}): ${subject}`);
      void recordReceptionLog(config.RECEPTION_PHONE, logBody, path, null);
    })
    .catch((err) => {
      console.error(
        `[notify] Failed to WhatsApp reception (${subject}) — if the error is 131047, ` +
          `reception hasn't messaged Awa in 24h (window closed):`,
        err,
      );
      void recordReceptionLog(config.RECEPTION_PHONE, logBody, "failed", String(err).slice(0, 300));
    });
}
