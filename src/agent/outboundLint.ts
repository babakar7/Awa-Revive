/**
 * Outbound reply guard (server decides — trust-critical).
 *
 * Prod 25/07: the model emitted a fabricated Wave link inside an imitation
 * "[outil] create_payment_link(...) -> {...}" trace instead of actually calling
 * the tool. The client got a dead link. Payment links must ONLY reach a client
 * when they were produced by a real payment-creation tool THIS turn or already
 * live on an active DB payment record — never composed by the model.
 *
 * This module is pure and exhaustively unit-tested; it is the last gate before
 * every model-authored message is sent.
 */

/** Internal replay marker for tool turns — the model must NEVER emit it. */
export const TOOL_TRACE_MARKER = "⟦trace⟧";

/**
 * Server tools whose successful JSON result may mint or return a payment URL.
 * Keep this explicit: trusting every tool result would weaken the last outbound
 * guard, while relying on a naming convention missed refresh/add-spots tools.
 */
const PAYMENT_LINK_RESULT_TOOLS = new Set([
  "create_payment_link",
  "create_plan_payment_link",
  "create_cafe_payment_link",
  "create_delivery_payment_link",
  "refresh_expired_plan_payment_link",
  "add_spots_to_booking",
]);

export function canToolResultApprovePaymentUrl(toolName: string): boolean {
  return PAYMENT_LINK_RESULT_TOOLS.has(toolName);
}

/**
 * Slot-time guard (prod 11/08): the model promised "samedi 11h15", then called
 * create_payment_link with the 10:15 slot's event_id and STILL wrote "11h15"
 * next to the link — the client paid for the wrong class time. The slot_cache
 * check cannot catch this (10:15 was legitimately offered too), so the last
 * outbound gate must: any time/date the reply states after a slot-locking tool
 * succeeded must match that tool's server-computed Dakar slot facts.
 */

/** Tools whose SUCCESS locks money or a seat to one specific slot. A reply
 *  sent after one of these announces THE booked time — activate the guard. */
const SLOT_LOCKING_TOOLS = new Set([
  "create_payment_link",
  "add_spots_to_booking",
  "book_with_membership",
  "book_key_bonus",
  "book_key_invitation",
  "reschedule_booking",
]);

/** Tools whose results also carry server-true slot times (approve-only: they
 *  vouch for times but never activate the guard by themselves). */
const SLOT_VOUCHING_TOOLS = new Set([
  ...SLOT_LOCKING_TOOLS,
  "get_my_bookings",
  "cancel_booking",
  "join_waitlist",
]);

export interface SlotTimeGuard {
  /** True once a slot-locking tool succeeded this turn. */
  active: boolean;
  /** Normalized "HH:MM" times the server vouched for this turn. */
  times: Set<string>;
  /** Normalized "day-monthIndex" dates the server vouched for this turn. */
  dates: Set<string>;
  /** Raw Dakar strings ("samedi 15 août à 10:15") — for corrective copy. */
  facts: string[];
}

export function createSlotTimeGuard(): SlotTimeGuard {
  return { active: false, times: new Set(), dates: new Set(), facts: [] };
}

const MONTH_INDEX: Record<string, number> = {
  janvier: 0, january: 0,
  février: 1, fevrier: 1, february: 1,
  mars: 2, march: 2,
  avril: 3, april: 3,
  mai: 4, may: 4,
  juin: 5, june: 5,
  juillet: 6, july: 6,
  août: 7, aout: 7, august: 7,
  septembre: 8, september: 8,
  octobre: 9, october: 9,
  novembre: 10, november: 10,
  décembre: 11, decembre: 11, december: 11,
};
const MONTH_ALT = Object.keys(MONTH_INDEX).join("|");

// "11h15", "11:15", "11H 15", "à 11 h 15", "11:15 pm". Requires explicit
// minutes so durations and deadlines ("16h avant", "20 minutes", "12 000 F")
// never match. am/pm folded to 24h. A token followed by avant/before is a
// cancellation-window phrase, not a class time.
const TIME_TOKEN_RE = /\b(\d{1,2})\s*(?:h|:)\s*([0-5]\d)(?:\s*(am|pm))?\b(?!\s*(?:avant|before))/gi;
// "15 août" / "1er août" / "August 15" / "15 August".
const DATE_TOKEN_RE = new RegExp(
  `\\b(?:(\\d{1,2})(?:er)?\\s+(${MONTH_ALT})|(${MONTH_ALT})\\s+(\\d{1,2}))\\b`,
  "gi",
);

function normalizeTimeToken(hour: number, minute: number, meridiem?: string): string | null {
  let h = hour;
  if (meridiem?.toLowerCase() === "pm" && h < 12) h += 12;
  if (meridiem?.toLowerCase() === "am" && h === 12) h = 0;
  if (h > 23) return null;
  return `${String(h).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

export function extractTimeTokens(text: string): string[] {
  const tokens: string[] = [];
  for (const m of text.matchAll(TIME_TOKEN_RE)) {
    const normalized = normalizeTimeToken(Number(m[1]), Number(m[2]), m[3]);
    if (normalized) tokens.push(normalized);
  }
  return tokens;
}

export function extractDateTokens(text: string): string[] {
  const tokens: string[] = [];
  for (const m of text.matchAll(DATE_TOKEN_RE)) {
    const day = Number(m[1] ?? m[4]);
    const month = MONTH_INDEX[(m[2] ?? m[3]).toLowerCase()];
    if (day >= 1 && day <= 31 && month !== undefined) tokens.push(`${day}-${month}`);
  }
  return tokens;
}

/** Deep-walk a parsed tool result for string values under keys ending in
 *  `_dakar` — the server-formatted "samedi 15 août à 10:15" slot facts. */
function collectDakarStrings(value: unknown, out: string[]): void {
  if (Array.isArray(value)) {
    for (const item of value) collectDakarStrings(item, out);
    return;
  }
  if (value === null || typeof value !== "object") return;
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v === "string" && key.endsWith("_dakar")) out.push(v);
    else if (typeof v === "object") collectDakarStrings(v, out);
  }
}

/**
 * Absorb one successful tool result into the guard. Error results are ignored
 * (an error locks nothing — its alternatives list wrong times on purpose).
 * check_availability is deliberately NOT vouching: "also available" is exactly
 * what must not legitimize a time that differs from the booked slot.
 */
export function absorbSlotTimeFacts(guard: SlotTimeGuard, toolName: string, rawResult: string): void {
  if (!SLOT_VOUCHING_TOOLS.has(toolName)) return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawResult);
  } catch {
    return;
  }
  if (parsed === null || typeof parsed !== "object" || "error" in (parsed as object)) return;
  const dakarStrings: string[] = [];
  collectDakarStrings(parsed, dakarStrings);
  for (const fact of dakarStrings) {
    for (const time of extractTimeTokens(fact)) guard.times.add(time);
    for (const date of extractDateTokens(fact)) guard.dates.add(date);
    guard.facts.push(fact);
  }
  if (SLOT_LOCKING_TOOLS.has(toolName) && dakarStrings.length > 0) guard.active = true;
}

export interface SlotTimeLintFailure {
  kind: "time" | "date";
  token: string;
}

/** Pure check: every time/date the reply states must be server-vouched. */
export function findSlotTimeMismatch(reply: string, guard: SlotTimeGuard): SlotTimeLintFailure | null {
  if (!guard.active) return null;
  if (guard.times.size > 0) {
    for (const m of reply.matchAll(TIME_TOKEN_RE)) {
      const normalized = normalizeTimeToken(Number(m[1]), Number(m[2]), m[3]);
      if (normalized && !guard.times.has(normalized)) return { kind: "time", token: m[0] };
    }
  }
  if (guard.dates.size > 0) {
    for (const token of extractDateTokens(reply)) {
      if (!guard.dates.has(token)) return { kind: "date", token };
    }
  }
  return null;
}

// The model imitating its own tool history: the internal marker, the legacy
// "[outil]" marker (kept so an older cached history can't slip through), or a
// bare tool-call written as prose. None of these belong in a client message.
const TOOL_SYNTAX_RE =
  /⟦trace⟧|\[outil\]|\b(?:create_(?:payment|plan_payment|cafe_payment|delivery_payment)_link|refresh_expired_plan_payment_link|add_spots_to_booking|book_with_membership|check_availability|present_options|list_classes|list_plans|request_email_verification|submit_verification_code|create_plan_payment_link)\s*\(/i;

const ACTIVE_LINK_CLAIM_RE =
  /\b(?:ton|votre|le|ce|the|your)\s+lien(?:\s+de\s+paiement|\s+payment)?\s+(?:est|reste|is|remains)\s+(?:encore\s+)?(?:actif|active|valide|valid)|\blien\s+(?:est\s+)?toujours\s+valide\b/i;

// The internal silence sentinel. It is valid only as the WHOLE model reply and
// is stripped before send in index.ts; this last-gate check catches any variant
// that slips through so the raw token can never reach a client (prod 01/08:
// Gogo Ibrahim received "<NO_REPLY>\n\nPour répondre...").
const LEAKED_SENTINEL_RE = /<NO_REPLY>/i;

// Hosts that carry money. A URL on one of these must be an exact server-issued
// link, never anything the model wrote.
const PAYMENT_HOST_RE =
  /(?:^|\.)(?:wave\.com|orange-sonatel\.com|orange\.sn|sonatel\.sn|maxit\.sn)$/i;
// Fallback for money URLs whose host we can't parse (deep links, shorteners).
const PAYMENT_URL_HINT_RE = /(?:pay\.wave|sugu\.|orange-sonatel|\/checkout|\/mp\/)/i;

const URL_RE = /https?:\/\/[^\s<>()\[\]]+/gi;

/** Strip trailing punctuation a URL commonly picks up in prose. */
export function normalizeUrl(raw: string): string {
  return raw.trim().replace(/[)\].,;:!?»"'…]+$/, "");
}

export function extractUrls(text: string): string[] {
  return (text.match(URL_RE) ?? []).map(normalizeUrl);
}

export function isPaymentUrl(url: string): boolean {
  try {
    if (PAYMENT_HOST_RE.test(new URL(url).host.toLowerCase())) return true;
  } catch {
    /* unparseable — fall through to the hint check */
  }
  return PAYMENT_URL_HINT_RE.test(url);
}

export interface OutboundLintResult {
  ok: boolean;
  reason?:
    | "tool_syntax"
    | "unapproved_payment_url"
    | "unbacked_active_link_claim"
    | "leaked_sentinel"
    | "slot_time_mismatch";
  detail?: string;
}

/**
 * @param reply         the model-authored message about to be sent
 * @param approvedUrls  exact payment URLs issued by a real tool this turn or
 *                      loaded from an active DB payment record
 * @param slotGuard     server-vouched slot times of this turn; when a
 *                      slot-locking tool ran, the reply may not state others
 */
export function lintOutboundReply(
  reply: string,
  approvedUrls: Iterable<string>,
  slotGuard?: SlotTimeGuard,
): OutboundLintResult {
  const text = reply ?? "";
  if (TOOL_SYNTAX_RE.test(text)) {
    return { ok: false, reason: "tool_syntax", detail: text.match(TOOL_SYNTAX_RE)?.[0] };
  }
  if (LEAKED_SENTINEL_RE.test(text)) {
    return { ok: false, reason: "leaked_sentinel", detail: text.match(LEAKED_SENTINEL_RE)?.[0] };
  }
  const approved = new Set<string>();
  for (const u of approvedUrls) approved.add(normalizeUrl(u));
  if (approved.size === 0 && ACTIVE_LINK_CLAIM_RE.test(text)) {
    return { ok: false, reason: "unbacked_active_link_claim", detail: text.match(ACTIVE_LINK_CLAIM_RE)?.[0] };
  }
  for (const url of extractUrls(text)) {
    if (isPaymentUrl(url) && !approved.has(url)) {
      return { ok: false, reason: "unapproved_payment_url", detail: url };
    }
  }
  if (slotGuard) {
    const mismatch = findSlotTimeMismatch(text, slotGuard);
    if (mismatch) {
      return { ok: false, reason: "slot_time_mismatch", detail: `${mismatch.kind}:${mismatch.token}` };
    }
  }
  return { ok: true };
}

/**
 * The system note appended to the no-tools corrective retry. It must preserve a
 * legitimate same-turn link while removing an invented one — never instruct the
 * model to promise a link it cannot produce (that would strand the client).
 */
export function correctiveLintInstruction(
  approvedUrls: Iterable<string>,
  slotGuard?: SlotTimeGuard,
): string {
  const urls = Array.from(new Set(Array.from(approvedUrls, normalizeUrl)));
  const allow =
    urls.length > 0
      ? `You may include ONLY these exact server-approved URLs, verbatim: ${urls.join(" , ")}.`
      : `There is NO server-issued payment link this turn. Do NOT include any payment link and do NOT claim a link was sent or created — if the client needs to pay, tell them you are preparing it.`;
  const slotFacts =
    slotGuard?.active && slotGuard.facts.length > 0
      ? ` The ONLY class date/time the server actually booked or linked this turn: ${Array.from(new Set(slotGuard.facts)).map((f) => `« ${f} »`).join(" and ")} (Dakar time, relay verbatim). If your draft stated any other time or date, that was WRONG — restate exactly this one; if the client asked for a different time, this slot is NOT it: do not send a payment link, apologize and re-run availability instead.`
      : "";
  return (
    `Your previous draft was blocked: it contained a payment link, a tool-call written as text, or a class time/date that the server did not issue. ` +
    `Rewrite the reply as a normal WhatsApp message with no tool-call syntax. ${allow}${slotFacts}`
  );
}
