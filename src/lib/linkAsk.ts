import type { MembershipLookup } from "./membershipContext.js";

/**
 * The one-time, ignorable "do you already have a Revive account?" invitation.
 * Sent by the SERVER (never left to the model), in two situations that share
 * the same one-shot guard (clients.email_prompted_at):
 *   - an unlinked number that matches no unique Wix contact, at any message
 *     where it hasn't been asked yet (src/agent/index.ts), and
 *   - right after a first Wave payment by an unlinked number
 *     (src/webhooks/wave.ts, maybeHandleUnlinkedClient).
 * It offers BOTH paths: link an existing account by email, OR — for a genuine
 * newcomer — have Awa create a Revive account on the spot (name + email, email
 * verified by code before the fiche is created — see tools.ts).
 * Lives in its own module so both the agent and the Wave webhook can import it
 * without a circular dependency.
 */
export function emailAskMessage(lang: string): string {
  switch (lang) {
    case "en":
      return (
        `By the way 😊 if you already had a Revive account (website or studio), just reply here ` +
        `with the email you used and I'll link it right away. ` +
        `No account yet? Send me your name and email and I'll create one for you!`
      );
    case "wo":
      return (
        `Benn laaj 😊 su fekkee am nga woon compte ci Revive (site web walla studio bi), ` +
        `bindal ma fii sa email, dinaa ko takk ci saa si. ` +
        `Amuloo compte? Yónnee ma sa tur ak sa email, dinaa la defal benn!`
      );
    default:
      return (
        `Au fait 😊 si tu avais déjà un compte chez Revive (site web ou au studio), ` +
        `réponds-moi juste ici avec l'email que tu utilisais et je le relie tout de suite. ` +
        `Pas encore de compte ? Envoie-moi ton nom et ton email et je t'en crée un !`
      );
  }
}

/**
 * Should the server append the account-linking invitation this turn?
 * True when the live Wix lookup succeeded, the number matches no unique
 * contact, and the one-shot flag hasn't been armed yet (armed only AFTER a
 * successful send, so a failed delivery or a technical-fallback turn keeps the
 * single chance and it retries on the next message). memberships === null =
 * lookup FAILED → treat as unknown → never ask (never tell a client they have
 * no account because Wix errored).
 */
export function shouldOfferLinking(
  memberships: MembershipLookup | null,
  client: { email_prompted_at: Date | null; claimed_email: string | null },
): boolean {
  return (
    memberships !== null &&
    !memberships.linked &&
    !client.email_prompted_at &&
    !client.claimed_email
  );
}
