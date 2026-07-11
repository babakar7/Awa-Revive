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
        `with the email you used: I'll send you a verification code and link your account right away. ` +
        `If not, you can ignore this!`
      );
    case "wo":
      return (
        `Benn laaj 😊 su fekkee am nga woon compte ci Revive (site web walla studio bi), ` +
        `bindal ma fii sa email: dinaa la yónnee benn code, takk sa compte ci saa si. Su amul, bul ci topp!`
      );
    default:
      return (
        `Au fait 😊 si tu avais déjà un compte chez Revive (site web ou au studio), ` +
        `réponds-moi juste ici avec l'email que tu utilisais : je t'envoie un code de vérification ` +
        `et je relie ton compte tout de suite. Sinon, ignore ce message !`
      );
  }
}
