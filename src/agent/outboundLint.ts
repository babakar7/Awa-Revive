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

// The model imitating its own tool history: the internal marker, the legacy
// "[outil]" marker (kept so an older cached history can't slip through), or a
// bare tool-call written as prose. None of these belong in a client message.
const TOOL_SYNTAX_RE =
  /⟦trace⟧|\[outil\]|\b(?:create_(?:payment|plan_payment|cafe_payment|delivery_payment)_link|refresh_expired_plan_payment_link|add_spots_to_booking|book_with_membership|check_availability|present_options|list_classes|list_plans|request_email_verification|submit_verification_code|create_plan_payment_link)\s*\(/i;

const ACTIVE_LINK_CLAIM_RE =
  /\b(?:ton|votre|le|ce|the|your)\s+lien(?:\s+de\s+paiement|\s+payment)?\s+(?:est|reste|is|remains)\s+(?:encore\s+)?(?:actif|active|valide|valid)|\blien\s+(?:est\s+)?toujours\s+valide\b/i;

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
  reason?: "tool_syntax" | "unapproved_payment_url" | "unbacked_active_link_claim";
  detail?: string;
}

/**
 * @param reply         the model-authored message about to be sent
 * @param approvedUrls  exact payment URLs issued by a real tool this turn or
 *                      loaded from an active DB payment record
 */
export function lintOutboundReply(
  reply: string,
  approvedUrls: Iterable<string>,
): OutboundLintResult {
  const text = reply ?? "";
  if (TOOL_SYNTAX_RE.test(text)) {
    return { ok: false, reason: "tool_syntax", detail: text.match(TOOL_SYNTAX_RE)?.[0] };
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
  return { ok: true };
}

/**
 * The system note appended to the no-tools corrective retry. It must preserve a
 * legitimate same-turn link while removing an invented one — never instruct the
 * model to promise a link it cannot produce (that would strand the client).
 */
export function correctiveLintInstruction(approvedUrls: Iterable<string>): string {
  const urls = Array.from(new Set(Array.from(approvedUrls, normalizeUrl)));
  const allow =
    urls.length > 0
      ? `You may include ONLY these exact server-approved URLs, verbatim: ${urls.join(" , ")}.`
      : `There is NO server-issued payment link this turn. Do NOT include any payment link and do NOT claim a link was sent or created — if the client needs to pay, tell them you are preparing it.`;
  return (
    `Your previous draft was blocked: it contained a payment link or a tool-call written as text that the server did not issue. ` +
    `Rewrite the reply as a normal WhatsApp message with no tool-call syntax. ${allow}`
  );
}
