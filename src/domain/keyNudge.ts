import { config } from "../config.js";
import { sendTemplate } from "../lib/whatsapp.js";
import { toTemplateParam } from "../lib/notify.js";
import * as wix from "../lib/wix.js";
import * as repo from "./repo.js";
import * as keyRepo from "./keyRepo.js";
import { dakarDateKey, type KeyType } from "./keyRules.js";

export type KeyNudgeKind =
  | "INVITEE_J5"
  | "INVITEE_THIRD_24H"
  | "MEMBER_J5"
  | "REFORMER_FINISHED";

export function isCalendarDaysBefore(date: Date, now: Date, days: number): boolean {
  return dakarDateKey(new Date(date.getTime() - days * 86_400_000)) === dakarDateKey(now);
}

export function thirdSessionDueWithin24h(
  sessions: Array<{ slot_start: Date }>,
  now: Date,
): Date | null {
  if (sessions.length < 3) return null;
  const third = sessions[2].slot_start;
  const delta = third.getTime() - now.getTime();
  return delta > 0 && delta <= 86_400_000 ? third : null;
}

function keyLabel(type: KeyType): string {
  if (type === "INVITEE") return "L'Invitée — Clé 3 séances";
  if (type === "HABITUEE") return "L'Habituée — Clé 6 séances";
  return "La Résidente — Clé 12 séances";
}

function dateLabel(date: Date): string {
  return date.toLocaleDateString("fr-FR", {
    timeZone: config.TIMEZONE,
    day: "numeric",
    month: "long",
  });
}

function dateTimeLabel(date: Date): string {
  return date.toLocaleString("fr-FR", {
    timeZone: config.TIMEZONE,
    weekday: "long",
    day: "numeric",
    month: "long",
    hour: "2-digit",
    minute: "2-digit",
  });
}

async function sendClaimed(args: {
  dedupKey: string;
  keyId: string;
  clientId: string;
  phone: string;
  template: string;
  language: string;
  params: string[];
  transcript: string;
  log: { info: (o: unknown, m?: string) => void; error: (o: unknown, m?: string) => void };
}): Promise<boolean> {
  if (!args.template) return false;
  if (
    !(await keyRepo.claimKeyNudge({
      dedupKey: args.dedupKey,
      keyId: args.keyId,
      clientId: args.clientId,
    }))
  ) {
    return false;
  }
  try {
    await sendTemplate(args.phone, args.template, args.language, args.params);
    await keyRepo.completeKeyNudge(args.dedupKey, "SENT", args.transcript);
    await repo.addTurn(args.clientId, "assistant", args.transcript);
    args.log.info({ dedupKey: args.dedupKey }, "Key lifecycle nudge sent");
    return true;
  } catch (error) {
    await keyRepo.completeKeyNudge(args.dedupKey, "FAILED", String(error));
    args.log.error({ error, dedupKey: args.dedupKey }, "Key lifecycle nudge failed");
    return false;
  }
}

export async function sweepKeyNudges(log: {
  info: (o: unknown, m?: string) => void;
  error: (o: unknown, m?: string) => void;
}): Promise<number> {
  if (
    !config.KEYS_AUTOMATION_ENABLED ||
    ![
      config.WA_KEY_INVITEE_J5_TEMPLATE,
      config.WA_KEY_THIRD_SESSION_TEMPLATE,
      config.WA_KEY_MEMBER_J5_TEMPLATE,
      config.WA_KEY_FINISHED_TEMPLATE,
    ].some(Boolean)
  ) {
    return 0;
  }

  const now = new Date();
  const keys = await keyRepo.listActiveKeysForNudges();
  let sent = 0;
  for (const key of keys) {
    const name = key.client_name || "toi";
    const label = keyLabel(key.key_type);
    let remaining: number | null;
    try {
      remaining = await wix.planRemainingSessions(
        key.wix_contact_id!,
        key.plan_id,
        label,
        key.paid_order_id,
      );
    } catch (error) {
      log.error({ error, keyId: key.id }, "Key nudge balance lookup failed");
      continue;
    }
    if (remaining === null) continue;
    const facts = await keyRepo.inviteeGuaranteeFacts(key.id);

    if (
      key.key_type === "INVITEE" &&
      remaining > 0 &&
      facts.reformerBookings.length < 3 &&
      isCalendarDaysBefore(key.effective_ends_at, now, 5)
    ) {
      const transcript =
        `[relance Clé Invitée J-5] Il reste ${remaining} séance(s), expiration le ` +
        `${dateLabel(key.effective_ends_at)}.`;
      if (
        await sendClaimed({
          dedupKey: `INVITEE_J5:${key.id}`,
          keyId: key.id,
          clientId: key.client_id!,
          phone: key.wa_phone,
          template: config.WA_KEY_INVITEE_J5_TEMPLATE,
          language: config.WA_KEY_INVITEE_J5_TEMPLATE_LANG,
          params: [
            toTemplateParam(name, 60),
            String(remaining),
            toTemplateParam(dateLabel(key.effective_ends_at), 40),
          ],
          transcript,
          log,
        })
      ) sent += 1;
    }

    if (key.key_type === "INVITEE") {
      const third = thirdSessionDueWithin24h(facts.reformerBookings, now);
      if (third) {
        const transcript =
          `[relance avant 3e séance] Ta troisième séance est prévue le ${dateTimeLabel(third)}.`;
        if (
          await sendClaimed({
            dedupKey: `INVITEE_THIRD_24H:${key.id}`,
            keyId: key.id,
            clientId: key.client_id!,
            phone: key.wa_phone,
            template: config.WA_KEY_THIRD_SESSION_TEMPLATE,
            language: config.WA_KEY_THIRD_SESSION_TEMPLATE_LANG,
            params: [toTemplateParam(name, 60), toTemplateParam(dateTimeLabel(third), 80)],
            transcript,
            log,
          })
        ) sent += 1;
      }
    }

    if (
      key.key_type !== "INVITEE" &&
      remaining > 0 &&
      isCalendarDaysBefore(key.effective_ends_at, now, 5)
    ) {
      const transcript =
        `[relance Clé J-5] ${label} : ${remaining} séance(s), expiration le ` +
        `${dateLabel(key.effective_ends_at)}.`;
      if (
        await sendClaimed({
          dedupKey: `MEMBER_J5:${key.id}`,
          keyId: key.id,
          clientId: key.client_id!,
          phone: key.wa_phone,
          template: config.WA_KEY_MEMBER_J5_TEMPLATE,
          language: config.WA_KEY_MEMBER_J5_TEMPLATE_LANG,
          params: [
            toTemplateParam(name, 60),
            toTemplateParam(label, 80),
            String(remaining),
            toTemplateParam(dateLabel(key.effective_ends_at), 40),
          ],
          transcript,
          log,
        })
      ) sent += 1;
    }

    const lastBooked = facts.reformerBookings.at(-1)?.slot_start;
    if (remaining === 0 && lastBooked && lastBooked.getTime() <= now.getTime()) {
      const transcript =
        `[fin des séances Reformer] ${label} terminée — proposition L'Habituée ou La Résidente.`;
      if (
        await sendClaimed({
          dedupKey: `REFORMER_FINISHED:${key.id}`,
          keyId: key.id,
          clientId: key.client_id!,
          phone: key.wa_phone,
          template: config.WA_KEY_FINISHED_TEMPLATE,
          language: config.WA_KEY_FINISHED_TEMPLATE_LANG,
          params: [toTemplateParam(name, 60), toTemplateParam(label, 80)],
          transcript,
          log,
        })
      ) sent += 1;
    }
  }
  return sent;
}
