/**
 * The one-time, ignorable "do you already have a Revive account?" invitation.
 * Sent by the SERVER (never left to the model), in two situations that share
 * the same one-shot guard (clients.email_prompted_at):
 *   - first contact of a number that matches no unique Wix contact
 *     (src/agent/index.ts), and
 *   - right after a first Wave payment by an unlinked number
 *     (src/webhooks/wave.ts, maybeHandleUnlinkedClient).
 * Lives in its own module so both the agent and the Wave webhook can import it
 * without a circular dependency.
 */
export function emailAskMessage(lang: string): string {
  switch (lang) {
    case "en":
      return (
        `By the way 😊 if you already had a Revive account (website or studio), just reply here ` +
        `with the email you used and the team will link your booking history. If not, you can ignore this!`
      );
    case "wo":
      return (
        `Benn laaj 😊 su fekkee am nga woon compte ci Revive (site web walla studio bi), ` +
        `bindal ma fii sa email, ekib bi dina takk sa réservations yépp. Su amul, bul ci topp!`
      );
    default:
      return (
        `Au fait 😊 si tu avais déjà un compte chez Revive (site web ou au studio), ` +
        `réponds-moi juste ici avec l'email que tu utilisais et l'équipe reliera ton historique. ` +
        `Sinon, ignore ce message !`
      );
  }
}
