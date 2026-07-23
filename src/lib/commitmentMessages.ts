import { sendInteractive, sendText, type InteractiveOption } from "./whatsapp.js";
import * as repo from "../domain/repo.js";

/**
 * Post-payment messaging for multi-session commitments. Sent by the SERVER from
 * fulfillment.ts after a session reaches BOOKED — the client always answers the
 * new question first, and this resumes the plan deterministically. The progress
 * message REPLACES the café offer while the plan is incomplete, and (for an
 * unlinked client) integrates the account-linking invitation as a third button
 * so a client who stops early still receives it.
 *
 * Button ids are stable and server-routed (src/agent/index.ts intercepts ms_*):
 *   ms_continue:<id> · ms_later:<id> · ms_link:<id>
 */

export interface CommitmentProgressCopy {
  body: string;
  continueLabel: string;
  laterLabel: string;
  linkLabel: string;
}

export function commitmentProgressCopy(
  lang: string,
  serviceName: string,
  booked: number,
  requested: number,
): CommitmentProgressCopy {
  switch (lang) {
    case "en":
      return {
        body: `✅ Session ${booked}/${requested} confirmed for ${serviceName}! Want to book the next one now?`,
        continueLabel: "Continue",
        laterLabel: "Later",
        linkLabel: "Link my account",
      };
    case "wo":
      return {
        body: `✅ Séance ${booked}/${requested} dëgg na ci ${serviceName}! Ndax nga bëgg book bi ci topp léegi?`,
        continueLabel: "Kontine",
        laterLabel: "Ci kanam",
        linkLabel: "Takk sama compte",
      };
    default:
      return {
        body: `✅ Séance ${booked}/${requested} confirmée pour ${serviceName} ! On réserve la suivante maintenant ?`,
        continueLabel: "Continuer",
        laterLabel: "Plus tard",
        linkLabel: "Relier mon compte",
      };
  }
}

/** Acknowledgement when the client taps "Later" on a progress message. */
export function commitmentLaterAck(lang: string): string {
  switch (lang) {
    case "en":
      return "No problem 😊 just message me here whenever you'd like to book the next session.";
    case "wo":
      return "Baax na 😊 bindal ma fii saa su la neexee ngir book séance bi ci topp.";
    default:
      return "Pas de souci 😊 écris-moi ici quand tu veux réserver la prochaine séance.";
  }
}

export function commitmentCompleteMessage(
  lang: string,
  serviceName: string,
  requested: number,
): string {
  switch (lang) {
    case "en":
      return `🎉 That's all ${requested} sessions of ${serviceName} booked and paid — you're all set! See you soon 💪🏾`;
    case "wo":
      return `🎉 Séance yépp (${requested}) ci ${serviceName} book nañu te fey nañu — pare nga! Ba beneen yoon 💪🏾`;
    default:
      return `🎉 Tes ${requested} séances de ${serviceName} sont toutes réservées et payées — tout est bon ! À très vite 💪🏾`;
  }
}

/**
 * Send the "session X/N confirmed — continue?" message with reply buttons.
 * `showLink` adds the third "link my account" button for an unlinked client
 * (WhatsApp caps reply buttons at 3). Non-blocking: a failure here must never
 * break an already-confirmed booking.
 */
export async function sendCommitmentProgress(args: {
  waPhone: string;
  clientId: string;
  commitmentId: string;
  lang: string;
  serviceName: string;
  booked: number;
  requested: number;
  showLink: boolean;
  log?: { error: (obj: unknown, msg: string) => void };
}): Promise<void> {
  try {
    const copy = commitmentProgressCopy(args.lang, args.serviceName, args.booked, args.requested);
    const options: InteractiveOption[] = [
      { id: `ms_continue:${args.commitmentId}`, title: copy.continueLabel },
      { id: `ms_later:${args.commitmentId}`, title: copy.laterLabel },
    ];
    if (args.showLink) {
      options.push({ id: `ms_link:${args.commitmentId}`, title: copy.linkLabel });
    }
    const kind = await sendInteractive(args.waPhone, copy.body, "", options);
    await repo.addTurn(
      args.clientId,
      "assistant",
      `${copy.body}\n[message interactif ${kind} — options : ${options.map((o) => o.title).join(" · ")}]`,
    );
  } catch (err) {
    if (args.log) args.log.error({ err, clientId: args.clientId }, "Commitment progress send failed (non-blocking)");
    else console.error(`Commitment progress send failed for client ${args.clientId} (non-blocking):`, err);
  }
}

/** Send the "all N sessions booked" completion message. Non-blocking. */
export async function sendCommitmentComplete(args: {
  waPhone: string;
  clientId: string;
  lang: string;
  serviceName: string;
  requested: number;
  log?: { error: (obj: unknown, msg: string) => void };
}): Promise<void> {
  try {
    const msg = commitmentCompleteMessage(args.lang, args.serviceName, args.requested);
    await sendText(args.waPhone, msg);
    await repo.addTurn(args.clientId, "assistant", msg);
  } catch (err) {
    if (args.log) args.log.error({ err, clientId: args.clientId }, "Commitment completion send failed (non-blocking)");
    else console.error(`Commitment completion send failed for client ${args.clientId} (non-blocking):`, err);
  }
}
