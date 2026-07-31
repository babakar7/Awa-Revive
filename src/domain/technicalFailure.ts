import { config } from "../config.js";
import {
  sendWhatsAppNotificationDetailed,
} from "../lib/notify.js";
import { sendText } from "../lib/whatsapp.js";
import { applyFrenchRegister } from "../lib/frenchRegister.js";
import * as notifications from "./notificationRepo.js";
import * as repo from "./repo.js";

export type TechnicalFailureStage = string;

export interface TechnicalFailureArgs {
  client: repo.Client;
  stage: TechnicalFailureStage;
  cause: unknown;
  /** Conversation incidents use the inbound WhatsApp id. */
  waMessageId?: string | null;
  /** Async incidents use a stable order kind + id. */
  kind?: string | null;
  orderId?: string | null;
  sendClient?: boolean;
}

function compactCause(cause: unknown): string {
  const status = (cause as { status?: number })?.status;
  const raw = cause instanceof Error ? cause.message : typeof cause === "string" ? cause : JSON.stringify(cause);
  const text = String(raw ?? "erreur inconnue").replace(/\s+/g, " ").trim().slice(0, 300);
  return status ? `${status} — ${text}` : text;
}

export function technicalClientMessage(
  language: string | null | undefined,
  formal = false,
): string {
  if (language === "en") {
    return "Sorry, a technical issue is preventing me from completing this. The Revive team will contact you here. You don’t need to do anything.";
  }
  if (language === "wo") {
    return "Baal ma, jafe-jafe bu teknig moo tax mënuma jeexal lii. Ekipu Revive dina la jokkoo fii. Amul loo war a def.";
  }
  return applyFrenchRegister(
    "Désolée, un problème technique m’empêche de terminer. L’équipe Revive te contactera ici. Tu n’as rien à faire.",
    formal,
  );
}

function incidentPrefix(args: TechnicalFailureArgs): string {
  if (args.kind && args.orderId) {
    return `technical:${args.kind}:${args.orderId}:${args.stage}`;
  }
  return `technical:${args.client.id}:${args.waMessageId ?? "unknown"}:${args.stage}`;
}

async function claimedSend(args: {
  dedupKey: string;
  recipient: string;
  subject: string;
  body: string;
  owner?: boolean;
}): Promise<void> {
  if (!args.recipient) return;
  const claimed = await notifications.claimOrReclaim(args.dedupKey, null, null, "technical");
  if (!claimed) return;
  try {
    const result = await sendWhatsAppNotificationDetailed(args.recipient, args.subject, args.body, {
      preferTemplate: true,
      ...(args.owner
        ? { template: config.WA_OWNER_ALERT_TEMPLATE, templateLang: config.WA_OWNER_ALERT_TEMPLATE_LANG }
        : {}),
    });
    await notifications.finishLog(args.dedupKey, result.path, {
      recipientPhone: args.recipient,
      body: `${args.subject}\n${args.body}`,
      waMessageId: result.waMessageId,
    });
  } catch (error) {
    await notifications.finishLog(args.dedupKey, "failed", {
      recipientPhone: args.recipient,
      body: `${args.subject}\n${args.body}`,
      error: compactCause(error),
    });
  }
}

/**
 * Single terminal-failure entry point. It owns the 12h pause, open task,
 * per-event notification claims and deterministic no-action client copy.
 */
export async function handleTechnicalFailure(args: TechnicalFailureArgs): Promise<void> {
  const cause = compactCause(args.cause);
  const prefix = incidentPrefix(args);
  const conversationUrl = `${config.BASE_URL.replace(/\/+$/, "")}/admin/conversations/${args.client.id}`;
  const subject = "⚠️ Relais technique Awa";
  const body =
    `Cause : ${args.stage} — ${cause}\n` +
    `Cliente : ${args.client.name ?? "?"} (+${args.client.wa_phone.replace(/^\+/, "")})\n` +
    `Conversation équipe → cliente : ${conversationUrl}`;

  const setup = await Promise.allSettled([
    repo.pauseAwaForTechnicalHandoff(args.client.id, 12),
    repo.ensureOpenTechnicalHandoff(args.client.id, args.stage, cause),
  ]);
  for (const result of setup) {
    if (result.status === "rejected") {
      console.error("Technical handoff setup failed:", result.reason);
    }
  }

  const staffSends: Promise<void>[] = [
    claimedSend({
      dedupKey: `${prefix}:reception`,
      recipient: config.RECEPTION_PHONE,
      subject,
      body,
    }),
  ];
  if (
    config.OWNER_PHONE &&
    notifications.phoneDigits(config.OWNER_PHONE) !== notifications.phoneDigits(config.RECEPTION_PHONE)
  ) {
    staffSends.push(
      claimedSend({
        dedupKey: `${prefix}:owner`,
        recipient: config.OWNER_PHONE,
        subject: `🚨 INTERVENTION — ${subject}`,
        body,
        owner: true,
      }),
    );
  }
  void Promise.all(staffSends).catch((error) =>
    console.error("Technical staff notification failed:", error),
  );

  if (args.sendClient === false) return;
  const clientKey = `${prefix}:client`;
  let clientClaimed = true;
  try {
    clientClaimed = await notifications.claimOrReclaim(clientKey, null, null, "technical");
  } catch (error) {
    // If Postgres itself is the incident, the client still gets the safe fixed
    // copy. We prefer a possible duplicate on webhook replay to silent loss.
    console.error("Technical client notification claim failed:", error);
  }
  if (!clientClaimed) return;
  const message = technicalClientMessage(
    args.client.language,
    args.client.fr_register === "vous",
  );
  try {
    const waMessageId = await sendText(args.client.wa_phone, message);
    await repo.addTurn(args.client.id, "assistant", message, waMessageId ?? undefined);
    await notifications.finishLog(clientKey, "sent", {
      recipientPhone: args.client.wa_phone,
      body: message,
      waMessageId,
    }).catch((error) => console.error("Technical client log finalization failed:", error));
  } catch (error) {
    await notifications.finishLog(clientKey, "failed", {
      recipientPhone: args.client.wa_phone,
      body: message,
      error: compactCause(error),
    }).catch((finishError) => console.error("Technical client failure log failed:", finishError));
  }
}
