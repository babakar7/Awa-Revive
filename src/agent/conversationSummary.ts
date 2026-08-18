import { normalizeInboundText } from "../lib/inboundText.js";

export interface PriorConversationSummary {
  /** Recent client messages, kept together so terse answers retain their meaning. */
  latestClientIntent: string;
  /** What Awa last told the client, with interactive choices and links removed. */
  lastAssistantOutcome: string | null;
}

const MAX_CLIENT_MESSAGES = 4;
const MAX_CLIENT_MESSAGE_CHARS = 260;
const MAX_INTENT_CHARS = 900;
const MAX_OUTCOME_CHARS = 360;

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/**
 * Keep the semantic words from an old turn while removing details that must
 * never be revived after a long gap (payment URLs, codes and interactive ids).
 */
function compactOldTurn(content: string, max: number): string {
  const decoded = normalizeInboundText(content);
  return truncate(
    decoded
      .replace(/\n?\[choix écrit résolu\][^\n]*/giu, "")
      .replace(/\n?\[message interactif[^\]]*\]/giu, "")
      .replace(/https?:\/\/\S+/giu, "[ancien lien retiré]")
      .replace(/\b\d{6}\b/gu, "[ancien code retiré]")
      .replace(/\s+/gu, " ")
      .trim(),
    max,
  );
}

/**
 * Build a small, extractive summary of the conversation immediately before a
 * long gap. Tool turns are deliberately excluded: their slot ids, prices and
 * action results are stale. Several recent client messages are retained so an
 * elliptical final answer such as "Reformer" or "oui" does not lose the
 * request it qualified.
 */
export function summarizePriorConversation(
  turns: readonly { role: string; content: string }[],
): PriorConversationSummary | null {
  const clientMessages = turns
    .filter((turn) => turn.role === "user")
    .map((turn) => compactOldTurn(turn.content, MAX_CLIENT_MESSAGE_CHARS))
    .filter(Boolean)
    .slice(-MAX_CLIENT_MESSAGES);

  if (clientMessages.length === 0) return null;

  const latestClientIntent = truncate(
    clientMessages.map((message) => `«${message}»`).join(" → "),
    MAX_INTENT_CHARS,
  );
  const lastAssistant = [...turns]
    .reverse()
    .find((turn) => turn.role === "assistant");
  const lastAssistantOutcome = lastAssistant
    ? compactOldTurn(lastAssistant.content, MAX_OUTCOME_CHARS) || null
    : null;

  return { latestClientIntent, lastAssistantOutcome };
}
