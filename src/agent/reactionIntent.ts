/**
 * Whether a WhatsApp reaction should be treated as an affirmative answer to
 * Awa's last question.
 *
 * Prod: a client answered Awa's question with a 👍 reaction and the turn stalled
 * (reactions were logged but never entered the model loop). We route ONLY a
 * clear thumbs-up / OK family reaction, and ONLY when it targets Awa's most
 * recent message AND that message asked a question. A reaction is non-binding:
 * it can advance discovery but must never, on its own, authorize a payment,
 * cancellation, reschedule or other irreversible action — the model prompt
 * enforces that; here we only decide whether to nudge the conversation forward.
 */

// Thumbs-up / OK / done family, across skin-tone modifiers. Deliberately narrow:
// ❤️, 😍, 🙏, 😂 etc. are acknowledgements, not affirmations, and stay silent.
const AFFIRMATIVE = new Set(["👍", "👌", "✅", "☑️", "✔️", "🆗"]);

/** Strip skin-tone and variation modifiers so 👍🏾 matches 👍. */
function baseEmoji(emoji: string): string {
  return emoji.replace(/[\u{1F3FB}-\u{1F3FF}️‍]/gu, "");
}

export function isAffirmativeReaction(emoji: string | null | undefined): boolean {
  if (!emoji) return false; // empty = reaction removed
  return AFFIRMATIVE.has(baseEmoji(emoji.trim()));
}

/**
 * Decide whether a reaction should be routed into the model as an affirmative.
 * @param emoji          the reaction emoji (empty/undefined = removed → never route)
 * @param reactedToId    wamid of the message the client reacted to
 * @param lastAssistant  Awa's most recent assistant turn (content + its wamid), or null
 */
export function shouldRouteReactionAsReply(
  emoji: string | null | undefined,
  reactedToId: string | null | undefined,
  lastAssistant: { content: string; wa_message_id: string | null } | null,
): boolean {
  if (!isAffirmativeReaction(emoji)) return false;
  if (!reactedToId || !lastAssistant?.wa_message_id) return false;
  if (lastAssistant.wa_message_id !== reactedToId) return false; // stale/older target
  return /\?/.test(lastAssistant.content); // only when Awa actually asked something
}
