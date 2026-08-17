import Anthropic from "@anthropic-ai/sdk";
import { config } from "../config.js";
import { notifyReception, notifyNewConversation } from "../lib/notify.js";
import * as repo from "../domain/repo.js";
import { activeMemberships } from "../lib/membershipContext.js";
import { shouldOfferLinking } from "../lib/linkAsk.js";
import { sendText, sendTypingIndicator, type WhatsAppReferral } from "../lib/whatsapp.js";
import { findContactByPhone } from "../lib/wix.js";
import { getCafeMenu } from "../lib/cafeMenu.js";
import { systemPrompt, dynamicContext, businessMapsUrl } from "./systemPrompt.js";
import {
  lintOutboundReply,
  correctiveLintInstruction,
  canToolResultApprovePaymentUrl,
  createSlotTimeGuard,
  absorbSlotTimeFacts,
  extractTimeTokens,
  extractUrls,
  isPaymentUrl,
  normalizeUrl,
  TOOL_TRACE_MARKER,
} from "./outboundLint.js";
import { shouldRouteReactionAsReply } from "./reactionIntent.js";
import { capabilityMenuKind, isVagueOpener } from "../lib/capabilityMenu.js";
import { TOOL_DEFINITIONS, executeTool, NO_REPLY_SENTINEL } from "./tools.js";
import { isAwaDisengaged, isHumanTakeoverActive } from "../domain/adminOperations.js";
import * as deliveries from "../domain/deliveryRepo.js";
import * as commitments from "../domain/commitments.js";
import * as closuresRepo from "../domain/closuresRepo.js";
import * as faqRepo from "../domain/faqRepo.js";
import * as keyRepo from "../domain/keyRepo.js";
import * as links from "../domain/linkRequests.js";
import { emailAskMessage } from "../lib/linkAsk.js";
import { commitmentLaterAck } from "../lib/commitmentMessages.js";
import { PACK_DISCOVERY_CAMPAIGN, isPackDiscoveryCampaignEntry } from "../domain/packDiscoveryCampaign.js";
import { normalizeInboundText } from "../lib/inboundText.js";
import { applyFrenchRegister, detectFrenchRegister } from "../lib/frenchRegister.js";
import {
  circuitBreakerReply,
  toolErrorCode,
  toolResourceKey,
  toolResultError,
} from "./toolCircuitBreaker.js";
import { isInteractiveListTurn, resolveFreeTextChoice } from "./choiceMatcher.js";
import {
  handleTechnicalFailure,
  technicalClientMessage,
} from "../domain/technicalFailure.js";
import {
  classifyConversationSignal,
  noIntentClosingMessage,
} from "../domain/noIntentGuard.js";
import { isOmOutageActive } from "../domain/omOutage.js";
import {
  correctiveCoverageInstruction,
  deriveReplyRequirements,
  logOutboundIntroRepair,
  missingReplyRequirements,
  appendMissingCoverageInfo,
  repairFirstContactIntro,
  replyRequirementsInstruction,
  type IntroRepairResult,
} from "./replyCoverage.js";

// Explicit timeout + retries: without them the SDK default is a ~10 min per-request
// timeout, and since messages are serialized per client (see lib/serialize),
// one hung Anthropic call would block every later message from that client for
// minutes. 60s × 2 retries is plenty for `effort: low` replies.
const anthropic = new Anthropic({
  apiKey: config.ANTHROPIC_API_KEY,
  timeout: 60_000,
  maxRetries: 2,
});

// 529 "Overloaded" is a fast-fail transient spike on Anthropic's side: the
// SDK's own retries (2, sub-second backoff) are often too short to outlive it,
// and the loop then greeted a brand-new client with the technical fallback
// (real case 16/07, first message "Bonsoir"). These app-level waits are long
// enough to ride out a spike, and safe latency-wise: overloaded errors return
// instantly, so they never stack with the 60s per-attempt timeout above.
const OVERLOAD_RETRY_DELAYS_MS = [15_000, 30_000];

/** 529 / "overloaded_error" only — timeouts and 5xx must keep failing fast. */
export function isOverloadedError(err: unknown): boolean {
  const e = err as { status?: number; error?: { error?: { type?: string } } };
  return e?.status === 529 || e?.error?.error?.type === "overloaded_error";
}

/**
 * Transient network failure reaching Anthropic (APIConnectionError and its
 * APIConnectionTimeoutError subclass). The SDK's own maxRetries:2 fire first
 * with sub-second backoff; when a blip outlives those the loop used to greet
 * the client with the technical fallback on the FIRST message (real case: Tout
 * 01/08, "je veux réserver la Clé Invité" → "un problème technique"). A network
 * error carries no HTTP `status` — real API responses (4xx/5xx) are handled by
 * the overload check or fail fast, never here. The instanceof is primary; the
 * name/message fallback survives a duplicated SDK copy across module bounds.
 */
export function isConnectionError(err: unknown): boolean {
  if (err instanceof Anthropic.APIConnectionError) return true;
  const e = err as { status?: number; name?: string; message?: string };
  if (e?.status != null) return false;
  const name = String(e?.name ?? "");
  return (
    name === "APIConnectionError" ||
    name === "APIConnectionTimeoutError" ||
    /connection error/i.test(String(e?.message ?? ""))
  );
}

/**
 * Run an Anthropic call, sleeping through a transient spike before retrying:
 * a 529 overload OR a connection error. Both return without a usable reply, so
 * a short wait-and-retry beats failing the turn. Deterministic 4xx/5xx and
 * empty-reply errors still propagate immediately.
 */
export async function withOverloadRetry<T>(
  fn: () => Promise<T>,
  onRetry?: () => void,
  delaysMs: readonly number[] = OVERLOAD_RETRY_DELAYS_MS,
): Promise<T> {
  let attempt = 0;
  for (;;) {
    try {
      return await fn();
    } catch (err) {
      const retriable = isOverloadedError(err) || isConnectionError(err);
      if (attempt >= delaysMs.length || !retriable) throw err;
      const delay = delaysMs[attempt++];
      const kind = isOverloadedError(err) ? "overloaded" : "connection error";
      console.warn(`Anthropic ${kind} — waiting ${delay / 1000}s then retrying (${attempt}/${delaysMs.length})`);
      await new Promise((r) => setTimeout(r, delay));
      onRetry?.();
    }
  }
}

const MAX_TOOL_ITERATIONS = 8;
const REPLY_MAX_TOKENS = 2048;
// Retry budget when a reply is truncated (hit max_tokens) — big enough to fit
// a full multi-slot answer so we never ship a cut-off message or payment link.
const REPLY_MAX_TOKENS_RETRY = 4096;

// Per-tool-turn cap when replaying past tool activity into the model's context
// (see the history loop). Enough to carry a verification status or the key
// ids of a result, without replaying a full class list byte for byte.
const TOOL_REPLAY_MAXLEN = 700;
const HISTORY_CONTEXT_GAP_HOURS = 24;

// A past present_options result is replayed in conversation history. On a later
// turn, the model can occasionally carry the old "reply <NO_REPLY>" instruction
// forward even though no interactive message was sent in the CURRENT turn
// (prod 22/07: Modou answered "Ok merci" after an Aquabike slot list). This
// suffix is used for one no-tools recovery call. If the model still returns
// silence, the server sends a small deterministic acknowledgement: a valid API
// response containing only the stale sentinel is a model lapse, not an outage.
const UNEXPECTED_SILENCE_RECOVERY_INSTRUCTION =
  "Current-turn delivery guard: no interactive WhatsApp message was sent during this turn. " +
  "Respond now to the latest user with one natural, concise message. Do not output <NO_REPLY>. " +
  "If the latest message is only thanks or an acknowledgement, answer briefly and warmly. " +
  "Do not repeat an earlier list and do not invent information. Never quote or reproduce an " +
  `internal ${TOOL_TRACE_MARKER} trace line.`;

// If the first response is stale silence before Awa did anything in the current
// turn, retrying the normal agent loop is side-effect safe and preserves tools.
// That distinction matters for fresh dynamic questions (Coura 17/08: after two
// slot lists, "Jeudi ?" inherited an old present_options <NO_REPLY>; the old
// no-tools recovery could not check Thursday and copied an internal trace).
const UNEXPECTED_SILENCE_TOOL_RETRY_INSTRUCTION =
  UNEXPECTED_SILENCE_RECOVERY_INSTRUCTION +
  " Tools are available on this retry: when the latest request needs live information, call the " +
  "appropriate tool now and answer from its result.";

/** Concatenate the text blocks of a model response into the reply string. */
export function extractText(response: Anthropic.Message): string {
  return response.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
}

export type ReplyOutcome = "deliver" | "silent_after_interactive" | "recover";

/** Matches a leaked <NO_REPLY> control token plus any whitespace hugging it. */
const NO_REPLY_TOKEN_RE = /\s*<NO_REPLY>\s*/g;

/**
 * Remove any standalone <NO_REPLY> control token the model may have prepended to
 * otherwise-real text (prod 01/08: Gogo Ibrahim was sent "<NO_REPLY>\n\nPour
 * répondre..." because the token was mixed with a genuine answer). The token is
 * internal and must never reach the client. An empty result means the reply was
 * only the sentinel.
 */
export function stripNoReplySentinel(text: string | null | undefined): string {
  return (text ?? "").replace(NO_REPLY_TOKEN_RE, " ").trim();
}

/**
 * Decide whether the model produced a client reply, a valid current-turn
 * present_options sentinel, or an unexpected silence that deserves one retry.
 * `<NO_REPLY>` is valid ONLY when this turn actually delivered an interactive
 * message; a stale sentinel from history must never become a technical error.
 * The sentinel is stripped first so a reply that MIXES it with real text is
 * delivered (as that real text), never suppressed or leaked verbatim.
 */
export function classifyReplyOutcome(
  replyText: string | null,
  interactiveSent: boolean,
): ReplyOutcome {
  const text = stripNoReplySentinel(replyText);
  if (interactiveSent && text === "") return "silent_after_interactive";
  if (text === "") return "recover";
  return "deliver";
}

export function technicalFallbackMessage(
  _clientName?: string | null,
  formal = false,
): string {
  return technicalClientMessage("fr", formal);
}

/** A stale <NO_REPLY> is a model lapse, not a client-visible technical outage. */
export function modelSilenceFallbackMessage(
  language: string | null | undefined = "fr",
  formal = false,
): string {
  if (language === "en") return "No problem 😊 I’m here if you need anything.";
  if (language === "wo") return "Baax na 😊 maa ngi fii soo amee soxla.";
  return applyFrenchRegister(
    "Pas de souci 😊 Je suis là si tu as besoin.",
    formal,
  );
}

export interface SilenceRecoveryResolution {
  replyText: string;
  usedFallback: boolean;
}

/**
 * Settle the no-tools recovery response. This helper is deliberately used by
 * the live control flow so the regression test proves that a second sentinel
 * becomes client-safe text instead of an `agent_empty_reply` handoff.
 */
export function resolveSilenceRecovery(
  recoveredText: string | null,
  language: string | null | undefined,
  formal = false,
): SilenceRecoveryResolution {
  // A recovery model can echo one of the replay-only trace lines it just saw.
  // Drop those whole internal lines before the safety lint. Natural text on
  // other lines survives; a trace-only response becomes the deterministic
  // acknowledgement instead of a false technical outage + 12 h takeover.
  const cleaned = stripNoReplySentinel(recoveredText)
    .split(/\r?\n/)
    .filter((line) => !line.includes(TOOL_TRACE_MARKER))
    .join("\n")
    .trim();
  if (cleaned) return { replyText: cleaned, usedFallback: false };
  return {
    replyText: modelSilenceFallbackMessage(language, formal),
    usedFallback: true,
  };
}

/**
 * A stale silent response is safe to rerun with tools only before any tool or
 * interactive delivery happened in this inbound turn. Once an action ran, the
 * existing no-tools recovery remains the idempotent path.
 */
export function shouldRetryUnexpectedSilenceWithTools(args: {
  replyText: string | null;
  interactiveSent: boolean;
  toolExecuted: boolean;
  alreadyRetried: boolean;
}): boolean {
  return (
    !args.alreadyRetried &&
    !args.interactiveSent &&
    !args.toolExecuted &&
    classifyReplyOutcome(args.replyText, false) === "recover"
  );
}

/**
 * Turn stored conversation turns into the alternating user/assistant messages
 * the Messages API requires.
 *
 *  - 'tool' turns (Awa's own tool calls + results) are replayed as part of the
 *    assistant's actions, so the model SEES what it already did — the
 *    verification it just passed, the real ids it fetched, the buttons it
 *    already sent — instead of re-issuing them from an amnesiac view (prod
 *    13/07). Each is rendered as a compact [outil] line, capped so a long
 *    result can't blow up the replayed context.
 *  - Consecutive same-role turns are coalesced so roles strictly alternate.
 *    Without this, a failed WhatsApp send (assistant turn never persisted) or
 *    the tool→assistant folding above would leave two same-role messages in a
 *    row and 400 the next request.
 *  - The first message must be from the user; leading non-user turns are
 *    dropped.
 */
export function buildHistoryMessages(
  turns: { role: string; content: string }[],
  toolReplayMaxLen = TOOL_REPLAY_MAXLEN,
): Anthropic.MessageParam[] {
  const messages: Anthropic.MessageParam[] = [];
  for (const turn of turns) {
    const role: "user" | "assistant" = turn.role === "user" ? "user" : "assistant";
    const content =
      turn.role === "tool"
        ? `${TOOL_TRACE_MARKER} ${turn.content.slice(0, toolReplayMaxLen)}`
        : turn.content;
    if (messages.length === 0 && role !== "user") continue;
    const last = messages[messages.length - 1];
    if (last && last.role === role && typeof last.content === "string") {
      last.content += `\n${content}`;
      continue;
    }
    messages.push({ role, content });
  }
  return messages;
}

/**
 * Keep only the current conversation window when replaying turns to the model.
 * Long-silent threads often resume for an unrelated need; carrying the final
 * intent from weeks ago can then outweigh the live server context.
 *
 * The complete history remains stored and is still used for first-contact
 * detection. This only limits what is replayed into the next model call.
 */
export function turnsAfterConversationGap<T extends { created_at: Date | string }>(
  turns: readonly T[],
  gapHours = HISTORY_CONTEXT_GAP_HOURS,
): T[] {
  if (turns.length < 2) return [...turns];
  const gapMs = gapHours * 3_600_000;
  let start = 0;
  for (let i = 1; i < turns.length; i++) {
    const previous = new Date(turns[i - 1].created_at).getTime();
    const current = new Date(turns[i].created_at).getTime();
    if (Number.isFinite(previous) && Number.isFinite(current) && current - previous >= gapMs) {
      start = i;
    }
  }
  return turns.slice(start);
}

export type DeliveryReplyPaymentMethod = "wave" | "orange_money" | "maxit" | "cash";

/**
 * Recognize only self-contained payment-method replies. Deliberately reject
 * longer requests ("je veux payer mon cours par Wave"): this server shortcut
 * exists for the terse answer requested by the delivery confirmation, not for
 * interpreting general payment intent.
 */
export function deliveryPaymentMethodFromReply(
  text: string,
): DeliveryReplyPaymentMethod | null {
  const normalized = text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[’']/g, " ")
    .replace(/[.,!?;:()[\]{}]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  const aliases: Record<DeliveryReplyPaymentMethod, ReadonlySet<string>> = {
    wave: new Set([
      "wave",
      "par wave",
      "avec wave",
      "payer wave",
      "paiement wave",
      "paiement par wave",
      "wave svp",
      "par wave svp",
      "wave merci",
    ]),
    orange_money: new Set([
      "om",
      "orange money",
      "par om",
      "par orange money",
      "avec om",
      "avec orange money",
      "payer om",
      "payer orange money",
      "paiement om",
      "paiement orange money",
      "om svp",
      "orange money svp",
    ]),
    maxit: new Set([
      "maxit",
      "max it",
      "par maxit",
      "par max it",
      "avec maxit",
      "avec max it",
      "payer maxit",
      "payer max it",
      "paiement maxit",
      "paiement max it",
      "maxit svp",
      "max it svp",
    ]),
    cash: new Set([
      "cash",
      "especes",
      "en especes",
      "par cash",
      "par especes",
      "avec cash",
      "avec especes",
      "payer cash",
      "payer en especes",
      "paiement cash",
      "paiement en especes",
      "especes svp",
      "cash svp",
    ]),
  };

  for (const [method, values] of Object.entries(aliases) as [
    DeliveryReplyPaymentMethod,
    ReadonlySet<string>,
  ][]) {
    if (values.has(normalized)) return method;
  }
  return null;
}

/**
 * A message is a NEW conversation when the client has never messaged
 * (lastActivityAt null) or has been silent for at least gapHours. Pure so the
 * threshold logic is unit-tested independently of the DB/notify plumbing.
 */
export function isConversationStart(
  lastActivityAt: Date | null,
  now: number,
  gapHours: number,
): boolean {
  if (lastActivityAt === null) return true;
  return now - new Date(lastActivityAt).getTime() >= gapHours * 3_600_000;
}

/**
 * Ping the configured number when a client STARTS a conversation — a brand-new
 * person, or a returning one after a quiet gap. MUST be called BEFORE the
 * incoming message is persisted, so the gap query reflects prior activity only.
 * Fire-and-forget and swallow-safe: a notification hiccup never blocks the reply.
 */
async function maybeNotifyConversationStart(
  client: repo.Client,
  preview: string,
  profileName?: string,
): Promise<void> {
  if (config.NEW_CHAT_NOTIFY_PHONE === "") return;
  // Studio team/test numbers testing Awa are not leads — don't ping the owner.
  if (client.is_test) return;
  try {
    const last = await repo.lastConversationActivityAt(client.id);
    if (!isConversationStart(last, Date.now(), config.NEW_CHAT_NOTIFY_GAP_HOURS)) return;
    notifyNewConversation({
      clientId: client.id,
      displayName: client.name ?? profileName ?? "Client",
      waPhone: client.wa_phone,
      preview: preview.replace(/\s+/g, " ").trim().slice(0, 160),
    });
  } catch (err) {
    console.error("maybeNotifyConversationStart failed (non-blocking):", err);
  }
}

/**
 * Passive CRM name enrichment. A lead who only ever chats — browses the
 * schedule, asks a question, never books or gives a name — shows as "(sans nom)"
 * in the admin even when a Wix contact with a matching number already exists
 * (`clients.name` is only written on booking/payment/email-link, never on a plain
 * message). This copies the canonical Wix contact name onto the local row.
 *
 * Only a UNIQUE fiche match is used: `findContactByPhone` returns null on zero OR
 * ambiguous matches, so we never guess a name onto the wrong person. Gated on an
 * empty local name, so once it lands the lookup stops firing. Fire-and-forget and
 * swallow-safe — a Wix hiccup never blocks the reply; the name is there for the
 * admin and the next turn.
 */
async function maybeEnrichClientNameFromWix(client: repo.Client): Promise<void> {
  if (client.name && client.name.trim() !== "") return;
  try {
    const contact = await findContactByPhone(client.wa_phone);
    const fullName = contact?.fullName?.trim();
    if (!fullName) return;
    await repo.updateClientName(client.id, fullName);
    client.name = fullName;
  } catch (err) {
    console.error("maybeEnrichClientNameFromWix failed (non-blocking):", err);
  }
}

/**
 * The WhatsApp Cloud webhook supplies the display name that is already shown
 * in new-conversation alerts. Persist it as the immediate fallback so the
 * linked admin conversation has the same label. It intentionally only fills
 * an empty field: CRM, booking, and admin-supplied names remain authoritative.
 */
async function maybeStoreWhatsAppProfileName(client: repo.Client, profileName?: string): Promise<void> {
  const name = profileName?.trim();
  if (!name || (client.name && client.name.trim() !== "")) return;
  const stored = await repo.setClientNameIfMissing(client.id, name);
  if (stored) client.name = stored;
}

function notifyHumanTakeoverInbound(client: repo.Client, preview: string): void {
  notifyReception(
    "Nouveau message pendant un relais humain",
    `${client.name ?? "Client"} (+${client.wa_phone.replace(/^\+/, "")}) a répondu : « ${preview.replace(/\s+/g, " ").trim().slice(0, 180)} »\n` +
      `Ouvrir : ${config.BASE_URL.replace(/\/+$/, "")}/admin/conversations/${client.id}`,
    // During a takeover Awa is deliberately silent: the owner must know that
    // the client is waiting for the human who took over, even though generic
    // "relais humain" notifications are otherwise informational.
    { ownerAlert: true },
  );
}

/**
 * Turn whatever the agent loop threw (or the absence of a throw) into one short,
 * safe line for the reception alert + notification_log — enough to tell an API
 * hiccup (overload/timeout) from a real bug without dumping a stack. `null` =
 * the loop produced no reply without throwing (e.g. empty model output).
 */
export function describeLoopFailure(err: unknown): string {
  if (err == null) return "aucune réponse produite (pas d'exception)";
  const status = (err as { status?: number })?.status;
  const raw =
    err instanceof Error ? err.message : typeof err === "string" ? err : JSON.stringify(err);
  const msg = String(raw ?? "").replace(/\s+/g, " ").trim().slice(0, 200) || "erreur inconnue";
  return status ? `${status} — ${msg}` : msg;
}

async function tripToolCircuitBreaker(args: {
  client: repo.Client;
  toolName: string;
  errorCode: string;
  resourceKey: string;
  waMessageId: string;
}): Promise<void> {
  const claimed = await repo.markAgentToolFailureTripped({
    clientId: args.client.id,
    toolName: args.toolName,
    errorCode: args.errorCode,
    resourceKey: args.resourceKey,
  });
  if (!claimed) return;

  const reason =
    `Coupe-circuit agent: ${args.toolName}/${args.errorCode} répété ` +
    `(ressource ${args.resourceKey.slice(0, 240)})`;
  await handleTechnicalFailure({
    client: args.client,
    waMessageId: args.waMessageId,
    stage: `tool:${args.toolName}:${args.errorCode}`,
    cause: reason,
  });
}

/**
 * Language detection (fr | en | wo) by stopword scoring. Drives the language
 * of the templated messages (payment confirmation, refund notice) — the agent
 * itself mirrors the client's language natively. Returns null when there is
 * no clear winner, in which case the previously stored language is kept.
 */
const LANG_WORDS: Record<"fr" | "en" | "wo", Set<string>> = {
  fr: new Set(
    "bonjour salut merci oui non je tu vous le la les un une des du pour avec est et sont cours reserver reserve reservation seance seances svp combien prix demain apres aujourd hui vendredi samedi dimanche lundi mardi mercredi jeudi semaine prochaine personnes personne place places veux voudrais peux peut payer paiement paye lien quelle quel heure heures est-ce pas plus tot tard matin soir midi encore deja".split(" "),
  ),
  en: new Set(
    "hello hi thanks thank please yes i you the to for and is are was want need book booking class classes when what how much price tomorrow today monday tuesday wednesday thursday friday saturday sunday week people persons spot spots pay payment paid link time can could would morning evening next".split(" "),
  ),
  wo: new Set(
    "waaw deedeet jerejef nanga naka dama begg bugg naata suba leegi xaalis ndax jotna lekool ejjib gaaw yoon benn ñaar naar ñett fukk".split(" "),
  ),
};

export function detectLanguage(text: string): "fr" | "en" | "wo" | null {
  // Normalize: lowercase + strip accents so "réservé" matches "reserve".
  const tokens = text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .split(/[^a-z]+/)
    .filter(Boolean);

  const scores: Record<"fr" | "en" | "wo", number> = { fr: 0, en: 0, wo: 0 };
  for (const tok of tokens) {
    for (const lang of ["fr", "en", "wo"] as const) {
      if (LANG_WORDS[lang].has(tok)) scores[lang]++;
    }
  }
  const ranked = (Object.entries(scores) as ["fr" | "en" | "wo", number][]).sort(
    (a, b) => b[1] - a[1],
  );
  const [best, second] = ranked;
  // Require a clear winner with at least one hit.
  if (best[1] === 0 || best[1] === second[1]) return null;
  return best[0];
}

/**
 * Agent loop (SPEC §6): load history + client → Claude with tools → execute
 * tool calls → send final reply on WhatsApp. All turns persisted.
 */
/**
 * Server-side routing of multi-session commitment button taps (ms_*). Returns
 * true when the tap was fully handled here (no model turn needed):
 *  - ms_later → acknowledge; the plan resumes on the client's next message.
 *  - ms_link  → send the account-linking invitation (the ms_link button already
 *    armed the one-shot when it was shown); the client then replies with their
 *    email and the normal request_email_verification flow takes over.
 * ms_continue is intentionally NOT handled here (returns false) — it needs a
 * fresh check_availability (the stored slot's cache entry has a 2h TTL), which
 * is the model's job via the tools; the dynamicContext commitment line + prompt
 * rule tell it exactly which session and date to book next.
 */
async function maybeHandleCommitmentTap(
  client: repo.Client,
  text: string,
): Promise<boolean> {
  const m = text.match(/\(id:\s*(ms_[a-z]+):([0-9a-f-]+)\)\s*$/i);
  if (!m) return false;
  const action = m[1].toLowerCase();
  const lang = client.language ?? "fr";

  if (action === "ms_later") {
    const msg = commitmentLaterAck(lang);
    await sendText(client.wa_phone, msg);
    await repo.addTurn(client.id, "assistant", msg);
    return true;
  }
  if (action === "ms_link") {
    const msg = emailAskMessage(lang);
    await sendText(client.wa_phone, msg);
    await repo.addTurn(client.id, "assistant", msg);
    return true;
  }
  return false; // ms_continue → let the model run availability + link
}

function formatFcfa(amount: number): string {
  return Math.round(amount).toLocaleString("fr-FR").replace(/\u202f/g, " ");
}

function deliveryPaymentReplyText(
  client: repo.Client,
  result: Record<string, unknown>,
): string | null {
  const amount = Number(result.amount_fcfa);
  const amountText = Number.isFinite(amount) ? formatFcfa(amount) : null;
  const english = client.language === "en";

  if (result.cash_selected === true && amountText) {
    return english
      ? `Noted: ${amountText} FCFA in cash will be handed to the delivery person on arrival. 🙏🏾`
      : `C'est noté : ${amountText} FCFA en espèces seront à remettre au livreur à la livraison. 🙏🏾`;
  }

  const link = typeof result.payment_link === "string" ? result.payment_link : "";
  const app = typeof result.payment_app === "string" ? result.payment_app : "";
  const expires = Number(result.expires_in_minutes);
  if (!link || !app || !amountText) return null;
  const expiryText = Number.isFinite(expires) ? Math.max(1, Math.round(expires)) : null;
  return english
    ? `Here is your ${app} link to pay for the delivery 👇🏾\n${link}\n\nAmount: ${amountText} FCFA${expiryText ? ` — valid for ${expiryText} min` : ""}. Confirmation is automatic after payment.`
    : `Voici ton lien ${app} pour payer la livraison 👇🏾\n${link}\n\nMontant : ${amountText} FCFA${expiryText ? ` — valable ${expiryText} min` : ""}. La confirmation est automatique après paiement.`;
}

/**
 * Route the short answer requested by the delivery confirmation without asking
 * the language model to infer which product should be paid. The route is
 * intentionally narrow:
 *  - exactly one open delivery is waiting for a payment choice;
 *  - no class, plan, café order, or multi-session plan is concurrently active;
 *  - the entire inbound message is just a supported payment method.
 */
async function maybeHandleDeliveryPaymentReply(args: {
  client: repo.Client;
  text: string;
  waMessageId: string;
  deliveryOrders: deliveries.DeliveryOrder[];
  hasCompetingPaymentContext: boolean;
}): Promise<boolean> {
  if (args.hasCompetingPaymentContext) return false;
  const method = deliveryPaymentMethodFromReply(args.text);
  if (!method) return false;
  const payable = args.deliveryOrders.filter(
    (order) => order.payment_status === "PENDING_CHOICE",
  );
  if (payable.length !== 1) return false;

  const input = {
    delivery_order_id: payable[0].id,
    payment_method: method,
  };
  let resultText: string;
  try {
    resultText = await executeTool(args.client, "create_delivery_payment_link", input);
  } catch (err) {
    console.error("Deterministic delivery payment routing failed:", err);
    await repo.addTurn(
      args.client.id,
      "tool",
      `create_delivery_payment_link(${JSON.stringify(input)}) -> ${JSON.stringify({
        error: "tool_failed",
        message: describeLoopFailure(err),
      })}`,
    );
    await handleTechnicalFailure({
      client: args.client,
      waMessageId: args.waMessageId,
      stage: "delivery_payment_tool",
      cause: err,
    });
    return true;
  }

  await repo.addTurn(
    args.client.id,
    "tool",
    `create_delivery_payment_link(${JSON.stringify(input)}) -> ${resultText.slice(0, 2000)}`,
  );
  let result: Record<string, unknown>;
  try {
    result = JSON.parse(resultText) as Record<string, unknown>;
  } catch {
    result = {};
  }
  const reply = deliveryPaymentReplyText(args.client, result);
  if (!reply) {
    console.error("Deterministic delivery payment routing returned no usable confirmation:", result);
    await handleTechnicalFailure({
      client: args.client,
      waMessageId: args.waMessageId,
      stage: "delivery_payment_result",
      cause: `résultat inattendu ${resultText.slice(0, 180)}`,
    });
    return true;
  }

  await sendText(args.client.wa_phone, reply);
  await repo.addTurn(args.client.id, "assistant", reply);
  return true;
}

type VerificationCodeResult = {
  status?: string;
  attempts_left?: number;
};

export function verificationCodeReplyText(
  client: repo.Client,
  result: VerificationCodeResult,
): string {
  const english = client.language === "en";
  let text: string;
  switch (result.status) {
    case "account_created":
      text = english
        ? "✅ All set! Your Revive account has been created successfully and linked to this WhatsApp number."
        : "✅ C'est bon ! Ton compte Revive a été créé avec succès et relié à ce numéro WhatsApp.";
      break;
    case "verified":
      text = english
        ? "✅ All set! Your Revive account is now linked to this WhatsApp number."
        : "✅ C'est bon ! Ton compte Revive est maintenant relié à ce numéro WhatsApp.";
      break;
    case "verified_pending_merge":
      text = english
        ? "✅ Your account is verified. The Revive team is finishing the last account update; you don't need to do anything."
        : "✅ Ton compte est bien vérifié. L'équipe Revive termine la dernière mise à jour ; tu n'as rien à faire.";
      break;
    case "wrong_code": {
      const left = Number(result.attempts_left);
      const suffix = Number.isFinite(left)
        ? english
          ? ` (${left} attempt${left === 1 ? "" : "s"} left)`
          : ` (${left} essai${left === 1 ? "" : "s"} restant${left === 1 ? "" : "s"})`
        : "";
      text = english
        ? `That code doesn't match the latest email. Please check it and send it again${suffix}.`
        : `Ce code ne correspond pas au dernier email. Envoie-le-moi de nouveau après vérification${suffix}.`;
      break;
    }
    case "expired":
      text = english
        ? "That code has expired. Send me your email again here and I'll send you a new one."
        : "Ce code a expiré. Envoie-moi ton email ici et l'équipe t'en enverra un nouveau.";
      break;
    case "too_many_attempts":
    case "link_failed":
      text = english
        ? "The Revive team will finish setting up your account here. You don't need to call or do anything else."
        : "L'équipe Revive va terminer la configuration de ton compte ici. Tu n'as pas besoin d'appeler ni de faire autre chose.";
      break;
    default:
      text = english
        ? "This verification is no longer active. Send me your email again here and I'll restart it."
        : "Cette vérification n'est plus active. Envoie-moi ton email ici et je la relance.";
  }
  return applyFrenchRegister(text, !english && client.fr_register === "vous");
}

export interface VerificationCodeRoutingDeps {
  getOpen: typeof links.getOpen;
  execute: typeof executeTool;
  send: typeof sendText;
  addTurn: typeof repo.addTurn;
  technicalFailure: typeof handleTechnicalFailure;
}

const verificationCodeRoutingDeps: VerificationCodeRoutingDeps = {
  getOpen: links.getOpen,
  execute: executeTool,
  send: sendText,
  addTurn: repo.addTurn,
  technicalFailure: handleTechnicalFailure,
};

/**
 * A fresh six-digit email code is server-owned input, not conversational text.
 * Route it directly to the verification tool so a model lapse (prod 17/08:
 * copied the private trace marker and never called submit_verification_code)
 * cannot strand a client who supplied the code. Wrong/expired-code and abuse
 * checks remain inside the tool and are therefore unchanged.
 */
export async function maybeHandleVerificationCode(
  client: repo.Client,
  text: string,
  waMessageId: string,
  deps: VerificationCodeRoutingDeps = verificationCodeRoutingDeps,
): Promise<boolean> {
  if (!links.looksLikeCode(text)) return false;
  const request = await deps.getOpen(client.id);
  if (!request || request.status !== "AWAITING_CODE" || !request.code_hash) return false;

  const input = { code: text.trim() };
  let resultText: string;
  try {
    resultText = await deps.execute(client, "submit_verification_code", input);
  } catch (err) {
    console.error("Deterministic verification-code routing failed:", err);
    await deps.addTurn(
      client.id,
      "tool",
      `submit_verification_code(${JSON.stringify(input)}) -> ${JSON.stringify({
        error: "tool_failed",
        message: describeLoopFailure(err),
      })}`,
    );
    await deps.technicalFailure({
      client,
      waMessageId,
      stage: "verification_code_tool",
      cause: err,
    });
    return true;
  }

  await deps.addTurn(
    client.id,
    "tool",
    `submit_verification_code(${JSON.stringify(input)}) -> ${resultText.slice(0, 2000)}`,
  );
  let result: VerificationCodeResult;
  try {
    result = JSON.parse(resultText) as VerificationCodeResult;
  } catch {
    result = {};
  }
  const reply = verificationCodeReplyText(client, result);
  const wamid = await deps.send(client.wa_phone, reply);
  await deps.addTurn(client.id, "assistant", reply, wamid ?? undefined);
  return true;
}

export async function handleInboundText(args: {
  waPhone: string;
  text: string;
  waMessageId: string;
  profileName?: string;
  referral?: WhatsAppReferral;
}): Promise<void> {
  const inboundText = normalizeInboundText(args.text);
  let text = inboundText;
  const client = await repo.upsertClient(args.waPhone);
  const presentedChoices = await repo.latestPresentedChoices(client.id);
  const matchedChoice = resolveFreeTextChoice(text, presentedChoices);
  if (matchedChoice) {
    text += `\n[choix écrit résolu] ${matchedChoice.title} (id: ${matchedChoice.choice_id})`;
  }
  // An interactive list is still open but this text selects none of its options
  // (prod 06/08: Mareme confirmed "niveau débutant" right after the slot list —
  // the model carried the present_options <NO_REPLY> discipline into this turn
  // and went silent twice, killing a hot lead with a technical handoff). The
  // flag injects an explicit current-turn ban on the sentinel via
  // dynamicContext(); a matched choice needs no guard.
  const pendingInteractiveList = !matchedChoice && presentedChoices.length > 0;
  // Same trap past the 2h presented_choices TTL (prod 07/08: Kadidiatou answered
  // « Dimanche » 22h after the slot list → <NO_REPLY> twice). When nothing is
  // open but Awa's LAST message was an interactive list, the client is replying
  // to an expired list: ban the sentinel and force fresh options (stale ids).
  const expiredInteractiveList =
    !pendingInteractiveList &&
    !matchedChoice &&
    isInteractiveListTurn(await repo.lastAssistantTurnContent(client.id));
  const campaign = isPackDiscoveryCampaignEntry({ text: inboundText, referral: args.referral, allowedSourceIds: config.PACK_DISCOVERY_META_SOURCE_IDS });
  // Log every inbound ad referral (matched or not) so the real ad source_id can be harvested
  // from Railway logs and added to PACK_DISCOVERY_META_SOURCE_IDS to tighten attribution.
  if (args.referral?.sourceId) console.info(`[campaign] inbound referral source_id=${args.referral.sourceId} type=${args.referral.sourceType ?? ""} headline=${JSON.stringify(args.referral.headline ?? "")} matched=${campaign.matched} by=${campaign.matchedBy ?? ""}`);
  if (campaign.matched && campaign.matchedBy) await repo.recordCampaignLead({ clientId: client.id, campaignKey: PACK_DISCOVERY_CAMPAIGN, triggerMessageId: args.waMessageId, matchedBy: campaign.matchedBy, sourceId: args.referral?.sourceId, sourceType: args.referral?.sourceType, sourceUrl: args.referral?.sourceUrl, headline: args.referral?.headline, ctwaClid: args.referral?.ctwaClid });

  // Name a chat-only lead from their matching Wix fiche (fire-and-forget) so the
  // admin stops showing "(sans nom)" for someone who never books.
  void maybeEnrichClientNameFromWix(client);

  // The alert already receives this WhatsApp profile name. Store the same
  // fallback before it is sent so the linked admin row is labelled identically.
  await maybeStoreWhatsAppProfileName(client, args.profileName);

  // Conversation-start ping (before the incoming turn is persisted, so the gap
  // query sees only prior activity).
  await maybeNotifyConversationStart(client, inboundText, args.profileName);

  const lang = detectLanguage(inboundText);
  if (lang) {
    await repo.updateClientLanguage(client.id, lang);
    client.language = lang;
  }
  if (detectFrenchRegister(inboundText) === "vous") {
    await repo.latchClientFormalRegister(client.id);
    client.fr_register = "vous";
  }

  await repo.addTurn(client.id, "user", text, args.waMessageId);

  // Human takeover is a hard gate: keep the incoming turn, alert reception,
  // and never enter the model/tool loop. The timestamp expires automatically
  // after 12h, so normal handling resumes without a background sweep.
  if (isHumanTakeoverActive(client)) {
    notifyHumanTakeoverInbound(client, text);
    return;
  }

  // Verification codes are deterministic protocol input. Process them before
  // intent classification or the language model so the tool call cannot be
  // replaced by a leaked trace/prose reply.
  if (await maybeHandleVerificationCode(client, inboundText, args.waMessageId)) return;

  const signal = campaign.matched ? "revive_intent" : classifyConversationSignal(text);

  // Only an automatic no-intent pause may reopen itself, and only for an
  // explicit Revive signal. Manual/non-serious pauses remain hard gates.
  if (isAwaDisengaged(client)) {
    if (client.awa_disengaged_kind !== "no_intent" || signal !== "revive_intent") return;
    if (!(await repo.clearNoIntentDisengagement(client.id))) return;
    client.awa_disengaged_at = null;
    client.awa_disengaged_until = null;
    client.awa_disengaged_reason = null;
    client.awa_disengaged_kind = null;
    client.awa_no_intent_streak = 0;
    client.awa_no_intent_last_at = null;
  }

  if (signal === "no_intent") {
    const guard = await repo.recordNoIntentTurn(client.id);
    if (guard.disengaged) {
      const closing = noIntentClosingMessage(
        client.language ?? lang,
        client.fr_register === "vous",
      );
      const wamid = await sendText(client.wa_phone, closing);
      await repo.addTurn(client.id, "assistant", closing, wamid ?? undefined);
      return;
    }
  } else {
    // A clear OR substantive message breaks consecutiveness. Substantive
    // unknowns still reach Awa; only short low-information fragments count.
    await repo.resetNoIntentStreak(client.id);
    if (client.awa_disengaged_kind === "no_intent") {
      await repo.clearNoIntentDisengagement(client.id);
    }
  }

  // Multi-session commitment button taps are routed by the SERVER (deterministic,
  // "le serveur décide"): ms_later and ms_link are self-contained and answered
  // here without the model; ms_continue falls through to the model, which re-runs
  // check_availability (the stored slot's slot_cache entry has a 2h TTL and is
  // long gone for a multi-day plan) then create_payment_link with the item id.
  if (await maybeHandleCommitmentTap(client, text)) return;

  // Blue ticks + "typing…" bubble while the agent thinks (best-effort, non-blocking).
  void sendTypingIndicator(args.waMessageId);

  // Lazy TTL sweep so the "active link" context below is accurate.
  await Promise.all([
    repo.expireStaleBookings(),
    repo.expireStalePlanOrders(),
    repo.expireStaleCafeOrders(),
    deliveries.expireStaleDeliveryPaymentAttempts(),
    commitments.expireStaleCommitments(),
  ]);
  const [
    activeBooking,
    activePlanOrder,
    expiredPlanOrder,
    activeCafeOrder,
    memberships,
    recentRefunds,
    habit,
    upcomingBookingsCount,
    preferredPaymentMethod,
    deliveryOrders,
    activeCommitment,
    omOutageActive,
  ] = await Promise.all([
    repo.activeAwaitingPayment(client.id),
    repo.activeAwaitingPlanOrder(client.id),
    repo.latestRecentExpiredPlanOrder(client.id),
    repo.activeAwaitingCafeOrder(client.id),
    activeMemberships(client),
    repo.recentRefunds(client.id),
    repo.bookingHabit(client.id),
    repo.countUpcomingBooked(client.id),
    repo.lastSuccessfulBookingPaymentMethod(client.id),
    deliveries.actionableDeliveriesForPhone(client.wa_phone),
    commitments.activeCommitmentSnapshot(client.id),
    isOmOutageActive().catch(() => false),
  ]);

  // The delivery confirmation explicitly asks for a terse method reply. Resolve
  // that exact reply server-side so an unrelated old booking conversation can
  // never turn it into a class payment link (prod incident 27/07).
  if (
    await maybeHandleDeliveryPaymentReply({
      client,
      text: inboundText,
      waMessageId: args.waMessageId,
      deliveryOrders,
      hasCompetingPaymentContext: !!(
        activeBooking ||
        activePlanOrder ||
        activeCafeOrder ||
        activeCommitment
      ),
    })
  ) {
    return;
  }

  const history = await repo.lastTurnsForReplay(client.id, 30);
  const currentConversationHistory = turnsAfterConversationGap(history);
  // If a long silence split the thread, tell the model how stale the prior
  // exchange is so it never resumes an expired offer or a past-date pitch
  // (prod: a 9-day-later "Bonjour" got "on en était à ton créneau du 16 juillet").
  let conversationGapDays: number | null = null;
  if (currentConversationHistory.length > 0 && currentConversationHistory.length < history.length) {
    const boundary = history.length - currentConversationHistory.length;
    const prev = new Date(history[boundary - 1].created_at).getTime();
    const curr = new Date(history[boundary].created_at).getTime();
    if (Number.isFinite(prev) && Number.isFinite(curr) && curr > prev) {
      conversationGapDays = Math.max(1, Math.round((curr - prev) / 86_400_000));
    }
  }
  // Pack Découverte campaign RETIRED (Babakar, 01/08/2026): the offer is gone,
  // so no inbound lead is ever steered into the 10k first-session pitch. New and
  // returning discovery leads all go through L'Invitée. Referral leads are still
  // recorded above for attribution, but the entry pitch is off. The continuation
  // /fulfillment path (PACK_DISCOVERY_CONTINUATION_PLAN_IDS, reception-activated)
  // stays live while step-1 packs are still in flight (e.g. Zeina, 28/07); this
  // whole entry mechanism is removed once no pack is in flight and no campaign
  // lead has fired for 14 days.
  const packDiscoveryCampaign = false;
  const packDiscoveryMetaNewLead = false;

  // Clés era: the retired campaign notes above never fire, so a Meta lead who
  // clicked the Clé Invitée ad and sent its pre-filled opener ("Puis-je en
  // savoir plus à ce sujet ?") would land with NO subject context — Awa cannot
  // see the ad creative and the opener names nothing, so she'd ask "à propos
  // de quoi ?" to a warm lead. The matcher already recognizes the opener (and
  // the allow-listed referral source_id); this flag just tells the prompt what
  // "ce sujet" is. Gated on the Clés catalog being live.
  const cleInviteeAdLead = config.KEYS_AUTOMATION_ENABLED && campaign.matched;

  // Unlinked-number signal: a subscriber messaging from a number that isn't on
  // their Wix fiche is invisible to Awa and could be pushed to Wave for a class
  // their abonnement covers. `shouldOfferLinking` is true when the live lookup
  // succeeded, the number matches NO unique contact, and the one-shot email
  // prompt hasn't fired. It NO LONGER triggers a proactive first-contact
  // invitation (removed 17/07 — too heavy on a "Salut"); it only drives the
  // prompt's UNLINKED-NUMBER note so the model treats them as a brand-new client
  // and raises the account only when useful (claimed membership/history, or a
  // failed membership booking). The account question still fires automatically
  // after a first payment from an unlinked number (fulfillment.ts).
  const unlinkedNeverAsked = shouldOfferLinking(memberships, client);
  const hasActivePaymentLink = !!(
    activeBooking ||
    activePlanOrder ||
    activeCafeOrder ||
    deliveryOrders.some((order) => order.payment_status === "AWAITING_PAYMENT")
  );
  // First contact = Awa has never replied to this client before (the current
  // inbound turn is already persisted at this point, so we look for a prior
  // ASSISTANT turn, not an empty history). Drives the "Moi c'est Awa, je suis
  // une assistante automatisée de Revive" self-introduction — see
  // dynamicContext(). Awa states that she is automated, and a
  // "bonjour" that fires the capability menu should still open with a warm
  // introduction rather than a bare option list.
  const isFirstContact = !history.some((t) => t.role === "assistant");
  const replyRequirements = deriveReplyRequirements(inboundText, isFirstContact);
  // Tiered capability menu on vague openers (incl. returning clients), once per ~24h.
  const capabilityMenu = capabilityMenuKind({
    isVague: isVagueOpener(text),
    unlinkedNeverAsked,
    hasActivePaymentLink,
    upcomingBookingsCount,
    capabilityMenuAt: client.capability_menu_at,
  });

  const messages: Anthropic.MessageParam[] = buildHistoryMessages(currentConversationHistory);
  if (messages.length === 0) {
    messages.push({ role: "user", content: text });
  }

  // Studio closures in the next ~30 days + the known-answers FAQ, so Awa states
  // closures proactively and answers repeat questions without a handoff.
  const nowMs = Date.now();
  const [studioClosures, faqEntries] = await Promise.all([
    closuresRepo
      .closuresInWindow(new Date(nowMs), new Date(nowMs + 30 * 86_400_000))
      .catch(() => []),
    faqRepo.publishedFaqEntries().catch(() => []),
  ]);

  // Google-review gate state: "announce" (no gate yet — mention the condition
  // during an early-renewal pitch), "pending" (invitations locked, awaiting her
  // review), or null (feature off, or already activated → nothing to say).
  let reviewGate: "announce" | "pending" | null = null;
  if (config.KEYS_AUTOMATION_ENABLED && config.GOOGLE_REVIEW_URL) {
    const gate = await keyRepo.reviewGateForClient(client.id).catch(() => null);
    if (!gate) reviewGate = "announce";
    else if (!gate.activated_at) reviewGate = "pending";
  }

  const system: Anthropic.TextBlockParam[] = [
    // Stable prefix — cached.
    { type: "text", text: systemPrompt(), cache_control: { type: "ephemeral" } },
    // Volatile context — after the cache breakpoint.
    {
      type: "text",
      text: dynamicContext({
        clientName: client.name ?? args.profileName ?? null,
        clientLanguage: client.language ?? lang,
        clientRegister: client.fr_register,
        activeBooking,
        activePlanOrder,
        expiredPlanOrder,
        activeCafeOrder,
        deliveryOrders,
        memberships: memberships === null ? null : memberships.plans,
        unlinkedNeverAsked,
        recentRefunds,
        habit,
        upcomingBookingsCount,
        preferredPaymentMethod,
        capabilityMenu,
        firstContact: isFirstContact,
        activeCommitment,
        packDiscoveryCampaign,
        packDiscoveryMetaNewLead,
        cleInviteeAdLead,
        omOutageActive,
        reviewGate,
        reviewLink: config.GOOGLE_REVIEW_URL || undefined,
        conversationGapDays,
        studioClosures,
        faqEntries,
        pendingInteractiveList,
        expiredInteractiveList,
      }) + replyRequirementsInstruction(replyRequirements),
    },
  ];

  let replyText: string | null = null;
  let interactiveSent = false;
  let scheduleReplySent = false;
  let terminalHandled = false;
  let introRepair: IntroRepairResult | null = null;
  // Allowlist for the outbound payment-link guard (prod 25/07 fabricated link):
  // exact URLs the SERVER issued — active DB payment records + any link a real
  // payment tool returns this turn (added in the loop below).
  const approvedPaymentUrls = new Set<string>();
  for (const rec of [activeBooking, activePlanOrder, activeCafeOrder]) {
    if (rec?.payment_link) approvedPaymentUrls.add(normalizeUrl(rec.payment_link));
  }
  for (const d of deliveryOrders ?? []) {
    const link = (d as { payment_link?: string | null }).payment_link;
    if (link) approvedPaymentUrls.add(normalizeUrl(link));
  }
  // Slot-time guard (prod 11/08 wrong-time payment link): server-vouched Dakar
  // slot facts of this turn; once a slot-locking tool succeeds, the reply may
  // not state any other class time/date (enforced by the safety lint below).
  const slotTimeGuard = createSlotTimeGuard();
  // Book-first, menu-after (abonnement flow): a successful book_with_membership
  // this turn means the SERVER sends the incontournables list right after the
  // model's confirmation — deterministic, never left to the model's judgment
  // (the Wave flow gets the same list from the webhook).
  let membershipBooked = false;
  let circuitTripped = false;
  let toolExecutedThisTurn = false;
  let silenceWithToolsRetried = false;
  let agentSystem = system;

  let lastResponse: Anthropic.Message | null = null;
  let loopError: unknown = null;
  try {
    for (let i = 0; i < MAX_TOOL_ITERATIONS; i++) {
      // Meta drops the "typing…" bubble after ~25s; re-arm it at every model
      // round so it survives long tool chains (bookings, cancellations...).
      if (i > 0) void sendTypingIndicator(args.waMessageId);
      const response = await withOverloadRetry(
        () =>
          anthropic.messages.create({
            model: config.CLAUDE_MODEL,
            max_tokens: REPLY_MAX_TOKENS,
            output_config: { effort: "low" },
            system: agentSystem,
            tools: TOOL_DEFINITIONS,
            messages,
          }),
        // Keep the "typing…" bubble alive so the client sees Awa is still there.
        () => void sendTypingIndicator(args.waMessageId),
      );
      lastResponse = response;

      if (response.stop_reason !== "tool_use") {
        replyText = extractText(response);
        // Truncated reply (hit max_tokens): a half-written message — worse, a
        // half-written payment link — must never reach the client. Retry once
        // with a bigger budget and keep the fuller result.
        if (response.stop_reason === "max_tokens") {
          console.warn("Model reply hit max_tokens — retrying with a larger budget");
          try {
            const retry = await withOverloadRetry(
              () => anthropic.messages.create({
                model: config.CLAUDE_MODEL,
                max_tokens: REPLY_MAX_TOKENS_RETRY,
                output_config: { effort: "low" },
                system: agentSystem,
                tools: TOOL_DEFINITIONS,
                messages,
              }),
              () => void sendTypingIndicator(args.waMessageId),
            );
            if (retry.stop_reason !== "tool_use") {
              const retried = extractText(retry);
              if (retried) replyText = retried;
              if (retry.stop_reason === "max_tokens") {
                console.error("Reply STILL truncated at the larger budget");
                replyText = null;
                loopError = new Error("reply_truncated_twice");
              }
            } else {
              replyText = null;
              loopError = new Error("reply_retry_requested_tool_without_execution");
            }
          } catch (err) {
            console.error("max_tokens retry failed:", err);
            replyText = null;
            loopError = err;
          }
        }
        if (
          loopError == null &&
          shouldRetryUnexpectedSilenceWithTools({
            replyText,
            interactiveSent,
            toolExecuted: toolExecutedThisTurn,
            alreadyRetried: silenceWithToolsRetried,
          })
        ) {
          silenceWithToolsRetried = true;
          replyText = null;
          agentSystem = [
            ...system,
            { type: "text", text: UNEXPECTED_SILENCE_TOOL_RETRY_INSTRUCTION },
          ];
          console.warn(
            "Model returned stale silence before any current-turn tool — retrying once with tools",
          );
          continue;
        }
        break;
      }

      // Execute tool calls; append assistant turn + one user turn of results.
      messages.push({ role: "assistant", content: response.content });
      const results: Anthropic.ToolResultBlockParam[] = [];
      for (const block of response.content) {
        if (block.type !== "tool_use") continue;
        toolExecutedThisTurn = true;
        let result: string;
        let isError = false;
        try {
          result = await executeTool(
            client,
            block.name,
            block.input as Record<string, unknown>,
            {
              replyRequirements,
              language: client.language ?? lang,
              formal: client.fr_register === "vous",
              approvedPaymentUrls,
            },
          );
          if (
            (block.name === "present_options" || block.name === "get_class_schedule") &&
            result.includes('"sent":true')
          ) {
            interactiveSent = true;
            if (block.name === "get_class_schedule") scheduleReplySent = true;
          }
          if (block.name === "book_with_membership" && result.includes('"booked":true')) {
            membershipBooked = true;
          }
        } catch (err) {
          isError = true;
          result = JSON.stringify({
            error: "tool_failed",
            message:
              "The service is temporarily unavailable. Apologize and call handoff_to_human and reception " +
              "will reach out to the client.",
          });
          console.error(`Tool ${block.name} failed:`, err);
          await handleTechnicalFailure({
            client,
            waMessageId: args.waMessageId,
            stage: `tool_exception:${block.name}`,
            cause: err,
          });
          terminalHandled = true;
          circuitTripped = true;
        }
        await repo.addTurn(client.id, "tool", `${block.name}(${JSON.stringify(block.input)}) -> ${result.slice(0, 2000)}`);
        // Trust the link ONLY when a real payment tool minted it this turn.
        if (!isError && canToolResultApprovePaymentUrl(block.name)) {
          try {
            const parsed = JSON.parse(result) as { payment_link?: unknown };
            if (typeof parsed.payment_link === "string" && parsed.payment_link) {
              approvedPaymentUrls.add(normalizeUrl(parsed.payment_link));
            }
          } catch {
            /* non-JSON result — nothing to allow */
          }
        }
        if (!isError) absorbSlotTimeFacts(slotTimeGuard, block.name, result);
        results.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: result,
          is_error: isError || undefined,
        });

        if (terminalHandled) break;

        const input = block.input as Record<string, unknown>;
        const resourceKey = toolResourceKey(input);
        const technicalError = toolErrorCode(result);
        if (technicalError) {
          const failure = await repo.recordAgentToolFailure({
            clientId: client.id,
            toolName: block.name,
            errorCode: technicalError,
            resourceKey,
          });
          if (failure.failureCount >= 2) {
            await tripToolCircuitBreaker({
              client,
              toolName: block.name,
              errorCode: technicalError,
              resourceKey,
              waMessageId: args.waMessageId,
            });
            terminalHandled = true;
            circuitTripped = true;
            break;
          }
        } else if (toolResultError(result) === null) {
          await repo.clearAgentToolFailure({
            clientId: client.id,
            toolName: block.name,
            resourceKey,
          });
        }
      }
      messages.push({ role: "user", content: results });
      if (circuitTripped) break;
    }

    // Iteration cap reached while the model still wanted tools: an action may
    // have JUST run (a payment link created, a booking made). Force ONE final
    // reply WITHOUT tools so the client gets the real outcome instead of the
    // misleading "technical issue" fallback that made Awa deny work she'd done.
    if (!terminalHandled && !replyText && !interactiveSent && lastResponse?.stop_reason === "tool_use") {
      console.warn("Tool-iteration cap reached — forcing a final reply without tools");
      const final = await withOverloadRetry(
        () =>
          anthropic.messages.create({
            model: config.CLAUDE_MODEL,
            max_tokens: REPLY_MAX_TOKENS,
            output_config: { effort: "low" },
            system: agentSystem,
            messages,
          }),
        () => void sendTypingIndicator(args.waMessageId),
      );
      replyText = extractText(final);
    }
  } catch (err) {
    loopError = err;
    console.error("Agent loop failed:", err);
  }

  // The schedule image caption is the complete, server-validated answer. Even
  // if the model ignores the tool's sentinel instruction, never send a second
  // follow-up (the exact duplicate/pushy shape of the 03/08 production bug).
  if (scheduleReplySent) replyText = NO_REPLY_SENTINEL;

  // A stale <NO_REPLY> (or an unexplained empty end_turn) without a message
  // delivered in THIS turn is not a real outage. Retry once without tools and
  // with an explicit current-turn guard. This is intentionally before the
  // technical fallback: a normal "Ok merci" must never be sent to reception.
  // If the retry is silent too, settle it with deterministic copy rather than
  // turning two successful-but-empty model responses into an outage.
  let replyOutcome = classifyReplyOutcome(replyText, interactiveSent);
  if (!terminalHandled && replyOutcome === "recover" && loopError == null && lastResponse) {
    const silenceKind = replyText?.trim() === NO_REPLY_SENTINEL ? NO_REPLY_SENTINEL : "empty reply";
    console.warn(
      `Model returned ${silenceKind} without a current-turn interactive message — forcing one reply`,
    );
    try {
      const recovered = await withOverloadRetry(
        () =>
          anthropic.messages.create({
            model: config.CLAUDE_MODEL,
            max_tokens: REPLY_MAX_TOKENS,
            output_config: { effort: "low" },
            system: [
              ...system,
              { type: "text", text: UNEXPECTED_SILENCE_RECOVERY_INSTRUCTION },
            ],
            messages,
          }),
        () => void sendTypingIndicator(args.waMessageId),
      );
      const resolution = resolveSilenceRecovery(
        extractText(recovered),
        client.language ?? lang,
        client.fr_register === "vous",
      );
      replyText = resolution.replyText;
      replyOutcome = "deliver";
      if (resolution.usedFallback) {
        console.warn(
          `Model returned silence twice (stop_reason: ${recovered.stop_reason ?? "unknown"}) — ` +
            "using deterministic acknowledgement",
        );
      }
    } catch (err) {
      loopError = err;
      console.error("Unexpected-silence recovery failed:", err);
    }
  }

  // present_options already delivered (and logged) the reply — send nothing
  // more. A failed recovery is also cleared here so the literal sentinel can
  // never leak to the client; the normal technical fallback handles that case.
  // On deliver, strip any leaked sentinel so a mixed reply reaches the client as
  // clean text (the token itself is internal and must never be shown).
  replyOutcome = classifyReplyOutcome(replyText, interactiveSent);
  if (replyOutcome !== "deliver") replyText = null;
  else replyText = stripNoReplySentinel(replyText);

  // Coverage policy (04/08 — three lost leads in one morning): a deliverable
  // reply is NEVER discarded for coverage reasons. Presentation is repaired in
  // place, static facts are appended after the lint stage, and ONE model
  // rewrite is attempted only when something non-appendable is missing AND the
  // reply carries no server-approved payment link — a rewrite must never risk
  // dropping a real checkout link (Bitty 04/08: a paid Wave link was thrown
  // away over a stray question mark). Only the safety lint below may block.
  if (replyText) {
    introRepair = repairFirstContactIntro(replyText, replyRequirements, {
      language: client.language ?? lang,
      formal: client.fr_register === "vous",
      maxLength: 4096,
    });
    replyText = introRepair.text;
    const missing = missingReplyRequirements(replyText, replyRequirements);
    const carriesApprovedPaymentLink = extractUrls(replyText).some(
      (url) => isPaymentUrl(url) && approvedPaymentUrls.has(normalizeUrl(url)),
    );
    if (missing.length > 0 && !carriesApprovedPaymentLink) {
      console.warn(`Outbound reply missing required business coverage (${missing.join(", ")}) — corrective retry`);
      try {
        const corrected = await withOverloadRetry(
          () =>
            anthropic.messages.create({
              model: config.CLAUDE_MODEL,
              max_tokens: REPLY_MAX_TOKENS,
              output_config: { effort: "low" },
              system: [
                ...system,
                { type: "text", text: correctiveCoverageInstruction(missing) },
              ],
              messages,
            }),
          () => void sendTypingIndicator(args.waMessageId),
        );
        const retried = stripNoReplySentinel(extractText(corrected));
        const repairedRetry = repairFirstContactIntro(retried, replyRequirements, {
          language: client.language ?? lang,
          formal: client.fr_register === "vous",
          maxLength: 4096,
        });
        if (
          retried &&
          repairedRetry.segments.every((segment) => segment.length <= 4096) &&
          missingReplyRequirements(repairedRetry.text, replyRequirements).length === 0 &&
          lintOutboundReply(repairedRetry.text, approvedPaymentUrls, slotTimeGuard).ok
        ) {
          introRepair = repairedRetry;
          replyText = repairedRetry.text;
        }
        // A failed rewrite keeps the repaired original — the append stage
        // below completes what it can; delivery is never sacrificed.
      } catch (err) {
        console.error("Corrective coverage retry failed — delivering the repaired original:", err);
      }
    }
  }

  // Outbound payment-link guard (prod 25/07). Only model-authored text reaches
  // here as deliverable; the fallbacks below are fixed server strings. On a
  // block, retry ONCE without tools (so no side effect can repeat) constrained
  // to server-approved links; if it still fails, drop to the technical fallback
  // (which also alerts reception) rather than ever send a fabricated link.
  if (replyText) {
    const lint = lintOutboundReply(replyText, approvedPaymentUrls, slotTimeGuard);
    if (!lint.ok) {
      console.warn(`Outbound reply blocked (${lint.reason}: ${lint.detail ?? ""}) — corrective retry`);
      try {
        const corrected = await withOverloadRetry(
          () =>
            anthropic.messages.create({
              model: config.CLAUDE_MODEL,
              max_tokens: REPLY_MAX_TOKENS,
              output_config: { effort: "low" },
              system: [
                ...system,
                { type: "text", text: correctiveLintInstruction(approvedPaymentUrls, slotTimeGuard) },
              ],
              messages,
            }),
          () => void sendTypingIndicator(args.waMessageId),
        );
        const retried = stripNoReplySentinel(extractText(corrected));
        const repairedRetry = repairFirstContactIntro(retried, replyRequirements, {
          language: client.language ?? lang,
          formal: client.fr_register === "vous",
          maxLength: 4096,
        });
        if (
          retried &&
          repairedRetry.segments.every((segment) => segment.length <= 4096) &&
          lintOutboundReply(repairedRetry.text, approvedPaymentUrls, slotTimeGuard).ok
        ) {
          // Safety is the only gate here — any coverage gap left in the
          // rewrite is completed or logged by the append stage below.
          introRepair = repairedRetry;
          replyText = repairedRetry.text;
        } else {
          introRepair = null;
          replyText = null;
          loopError = loopError ?? new Error(`outbound_lint_failed:${lint.reason}`);
        }
      } catch (err) {
        console.error("Corrective lint retry failed:", err);
        replyText = null;
        loopError = loopError ?? new Error("outbound_lint_retry_error");
      }
    }
  }

  // Slot-time echo (prod 11/08): a payment-link/booking reply that states NO
  // time at all would leave the client to trust their memory of the promised
  // slot — append the server-known one so the real booked time is always
  // visible before any money moves. Only when the turn locked exactly one
  // slot (a reschedule has old+new; ambiguity must not be guessed).
  if (replyText && slotTimeGuard.active) {
    const uniqueFacts = Array.from(new Set(slotTimeGuard.facts));
    if (uniqueFacts.length === 1 && extractTimeTokens(replyText).length === 0) {
      const echoLine = `📅 ${uniqueFacts[0]}`;
      replyText = `${replyText.trim()}\n\n${echoLine}`;
      if (introRepair) {
        if (introRepair.segments.length === 1 && replyText.length <= 4096) {
          introRepair = { ...introRepair, text: replyText, segments: [replyText] };
        } else {
          introRepair = {
            ...introRepair,
            text: replyText,
            segments: [...introRepair.segments, echoLine],
          };
        }
      }
    }
  }

  // Deterministic completion — LAST, on whatever text survived the safety
  // lint: append the server-known static facts still missing (address, booking
  // method, planning link) instead of ever degrading to the technical
  // fallback. Anything non-appendable (e.g. a stray question) is logged for
  // the review sweep, never fatal.
  if (replyText) {
    const stillMissing = missingReplyRequirements(replyText, replyRequirements);
    if (stillMissing.length > 0) {
      const appendResult = appendMissingCoverageInfo(replyText, stillMissing, {
        language: client.language ?? lang,
        formal: client.fr_register === "vous",
        mapsUrl: businessMapsUrl(),
      });
      if (appendResult.appended.length > 0 && introRepair) {
        const merged = appendResult.text;
        if (introRepair.segments.length === 1 && merged.length <= 4096) {
          introRepair = { ...introRepair, text: merged, segments: [merged] };
          replyText = merged;
        } else {
          // Preserve the existing safe split; the facts ride as their own message.
          introRepair = {
            ...introRepair,
            text: merged,
            segments: [...introRepair.segments, appendResult.lines.join("\n")],
          };
          replyText = merged;
        }
      } else if (appendResult.appended.length > 0) {
        replyText = appendResult.text;
      }
      const remaining = missingReplyRequirements(replyText, replyRequirements);
      console.warn(
        `[outbound_coverage_degraded] client=${client.id} appended=${appendResult.appended.join(",") || "none"} ` +
          `remaining=${remaining.join(",") || "none"}`,
      );
    }
  }

  if (!replyText && !interactiveSent && !terminalHandled) {
    const stage =
      loopError instanceof Error && /^outbound_(?:lint|coverage)/.test(loopError.message)
        ? "output_filter"
        : loopError instanceof Error && /^model returned /.test(loopError.message)
          ? "agent_empty_reply"
          : "agent_call";
    await handleTechnicalFailure({
      client,
      waMessageId: args.waMessageId,
      stage,
      cause: describeLoopFailure(loopError),
    });
    terminalHandled = true;
  }

  if (replyText) {
    // Keep the outbound wamid so a 👍 reaction to this message can be matched
    // to the question it answers.
    for (const segment of introRepair?.segments ?? [replyText]) {
      const wamid = await sendText(args.waPhone, segment);
      await repo.addTurn(client.id, "assistant", segment, wamid ?? undefined);
    }
    if (introRepair) {
      logOutboundIntroRepair({ clientId: client.id, channel: "text", repair: introRepair });
    }
  }

  // NOTE: no proactive account-linking invitation here anymore. Pushing "do you
  // already have an account?" onto a first "Salut" read as heavy admin friction
  // (owner feedback 17/07). Default posture is now "brand-new client" — Awa
  // handles the need first; the account question surfaces only when it earns its
  // place: the model asks when a claimed membership/history comes up or a
  // membership booking fails (systemPrompt), and the SAME invitation still fires
  // server-side after a first payment from an unlinked number
  // (maybeHandleUnlinkedClient in fulfillment.ts) — the real "useful moment".
  // `unlinkedNeverAsked` is still computed above: it only feeds the prompt's
  // UNLINKED-NUMBER context note now, it no longer triggers a send.

  // Plus d'offre bar automatique post-réservation : la liste « Envie
  // d'accompagner ta séance ? » n'apportait rien (Babakar 08/08). Le menu
  // reste accessible à la demande (cap_menu, texte libre, /commander).
}

/** Image received but the description failed — ask kindly for text. */
export async function handleFailedImage(waPhone: string, waMessageId: string, profileName?: string): Promise<void> {
  const client = await repo.upsertClient(waPhone);
  await maybeStoreWhatsAppProfileName(client, profileName);
  await maybeNotifyConversationStart(client, "[image]", profileName);
  await repo.addTurn(client.id, "user", "[image reçue — lecture échouée]", waMessageId);
  if (isHumanTakeoverActive(client)) {
    notifyHumanTakeoverInbound(client, "[image reçue]");
    return;
  }
  if (isAwaDisengaged(client)) return;
  void sendTypingIndicator(waMessageId);
  const reply = applyFrenchRegister(
    "Désolée, je n'ai pas réussi à lire ton image 🙏🏾 Tu peux m'écrire ce qu'elle montre ?\n" +
      "(Sorry, I couldn't read your image — could you tell me what it shows?)",
    client.fr_register === "vous",
  );
  await sendText(waPhone, reply);
  await repo.addTurn(client.id, "assistant", reply);
}

/**
 * Emoji reaction (client long-pressed a message and tapped ❤️/👍) — log it so
 * the admin thread shows it, but NEVER reply: answering a ❤️ with « je ne peux
 * pas lire ce type de message » read as a bug (client du 21/07).
 */
export async function handleReaction(
  waPhone: string,
  waMessageId: string,
  emoji: string | null | undefined,
  profileName?: string,
  reactedToMessageId?: string,
): Promise<void> {
  const client = await repo.upsertClient(waPhone);
  await maybeStoreWhatsAppProfileName(client, profileName);
  const label = emoji ? `[réaction ${emoji}]` : "[réaction retirée]";
  await repo.addTurn(client.id, "user", label, waMessageId);
  if (isHumanTakeoverActive(client)) {
    notifyHumanTakeoverInbound(client, label);
    return;
  }
  // A 👍/OK reaction to Awa's last QUESTION is an affirmative answer — route it
  // into the model so the conversation progresses instead of stalling (prod:
  // a client answered a question with 👍 and the turn died). Non-affirmative
  // reactions (❤️, 🙏, 😂…) stay logged-only. The model prompt keeps a reaction
  // from authorizing any irreversible action on its own.
  const lastAssistant = await repo.latestAssistantTurn(client.id);
  if (shouldRouteReactionAsReply(emoji, reactedToMessageId, lastAssistant)) {
    await handleInboundText({
      waPhone,
      text: "[réaction 👍 — oui, en réponse à ta dernière question]",
      waMessageId,
      profileName,
    });
  }
}

/** Polite reply for stickers / documents / other unreadable media (SPEC §8). */
export async function handleUnsupportedMedia(
  waPhone: string,
  waMessageId: string,
  label = "[non-text message]",
  profileName?: string,
): Promise<void> {
  const client = await repo.upsertClient(waPhone);
  await maybeStoreWhatsAppProfileName(client, profileName);
  await maybeNotifyConversationStart(client, label, profileName);
  await repo.addTurn(client.id, "user", label, waMessageId);
  if (isHumanTakeoverActive(client)) {
    notifyHumanTakeoverInbound(client, label);
    return;
  }
  if (isAwaDisengaged(client)) return;
  void sendTypingIndicator(waMessageId);
  const reply = applyFrenchRegister(
    "Je ne peux pas lire ce type de message 🙏🏾 Écris-moi (ou envoie une note vocale) et je continue à t'aider !\n" +
      "(I can't read this kind of message — please type or voice-note it and we'll continue.)",
    client.fr_register === "vous",
  );
  await sendText(waPhone, reply);
  await repo.addTurn(client.id, "assistant", reply);
}

/** Voice note received but transcription failed — ask kindly for text. */
export async function handleFailedVoiceNote(waPhone: string, waMessageId: string, profileName?: string): Promise<void> {
  const client = await repo.upsertClient(waPhone);
  await maybeStoreWhatsAppProfileName(client, profileName);
  await maybeNotifyConversationStart(client, "[note vocale]", profileName);
  await repo.addTurn(client.id, "user", "[note vocale — transcription échouée]", waMessageId);
  if (isHumanTakeoverActive(client)) {
    notifyHumanTakeoverInbound(client, "[note vocale]");
    return;
  }
  if (isAwaDisengaged(client)) return;
  const guard = await repo.recordNoIntentTurn(client.id);
  if (guard.disengaged) {
    const closing = noIntentClosingMessage(
      client.language,
      client.fr_register === "vous",
    );
    const wamid = await sendText(waPhone, closing);
    await repo.addTurn(client.id, "assistant", closing, wamid ?? undefined);
    return;
  }
  void sendTypingIndicator(waMessageId);
  const reply = applyFrenchRegister(
    "Désolée, je n'ai pas réussi à écouter ta note vocale 🙏🏾 Tu peux me l'écrire ?\n" +
      "(Sorry, I couldn't process your voice note — could you type it instead?)",
    client.fr_register === "vous",
  );
  await sendText(waPhone, reply);
  await repo.addTurn(client.id, "assistant", reply);
}
