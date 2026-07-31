const TECHNICAL_ERROR_CODES = new Set([
  "tool_failed",
]);

const PRIMARY_RESOURCE_FIELDS = [
  "event_id",
  "choice_id",
  "booking_id",
  "delivery_id",
  "commitment_item_id",
  "plan_id",
  "order_id",
] as const;

const FALLBACK_RESOURCE_FIELDS = [
  "service_id",
  "date",
  "date_from",
] as const;

export function toolErrorCode(result: string): string | null {
  const code = toolResultError(result);
  return code && TECHNICAL_ERROR_CODES.has(code) ? code : null;
}

export function toolResultError(result: string): string | null {
  try {
    const parsed = JSON.parse(result) as { error?: unknown };
    return typeof parsed?.error === "string" ? parsed.error : null;
  } catch {
    return null;
  }
}

/**
 * Stable enough to identify the same attempted action while excluding names,
 * notes and other free text. event_id/booking_id win; service/date are the
 * conservative fallback for tools without a cache-backed choice.
 */
export function toolResourceKey(input: Record<string, unknown>): string {
  const selected: Record<string, unknown> = {};
  for (const field of PRIMARY_RESOURCE_FIELDS) {
    const value = input[field];
    if (typeof value === "string" || typeof value === "number") selected[field] = value;
  }
  if (Array.isArray(input.event_ids)) selected.event_ids = input.event_ids.map(String).sort();
  if (Array.isArray(input.slots)) {
    selected.slots = input.slots
      .map((item) => String((item as Record<string, unknown>)?.event_id ?? ""))
      .filter(Boolean)
      .sort();
  }
  if (Array.isArray(input.items)) {
    selected.items = input.items.map((item) => {
      const row = item as Record<string, unknown>;
      return {
        event_id: row?.event_id ?? null,
        choice_id: row?.choice_id ?? null,
      };
    });
  }
  if (Object.keys(selected).length > 0) return JSON.stringify(selected);
  for (const field of FALLBACK_RESOURCE_FIELDS) {
    const value = input[field];
    if (typeof value === "string" || typeof value === "number") selected[field] = value;
  }
  return JSON.stringify(selected);
}

export function circuitBreakerReply(formal: boolean): string {
  return formal
    ? "Désolée, le même problème technique vient de se reproduire. J’ai transmis votre demande à l’équipe Revive et mis mes réponses en pause pour éviter de vous faire tourner en rond. La réception vous répondra ici."
    : "Désolée, le même problème technique vient de se reproduire. J’ai transmis ta demande à l’équipe Revive et mis mes réponses en pause pour éviter de te faire tourner en rond. La réception te répondra ici.";
}
