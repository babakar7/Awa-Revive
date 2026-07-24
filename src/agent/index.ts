import Anthropic from "@anthropic-ai/sdk";
import { config } from "../config.js";
import { notifyReception, notifyNewConversation } from "../lib/notify.js";
import * as repo from "../domain/repo.js";
import { activeMemberships } from "../lib/membershipContext.js";
import { shouldOfferLinking } from "../lib/linkAsk.js";
import { sendText, sendTypingIndicator, type WhatsAppReferral } from "../lib/whatsapp.js";
import { findContactByPhone } from "../lib/wix.js";
import { getCafeMenu } from "../lib/cafeMenu.js";
import { sendCafeMenuOffer } from "../lib/cafeOffer.js";
import { systemPrompt, dynamicContext } from "./systemPrompt.js";
import { capabilityMenuKind, isVagueOpener } from "../lib/capabilityMenu.js";
import {
  receptionLinkInstruction,
  receptionWhatsAppLink,
} from "../lib/receptionContact.js";
import { TOOL_DEFINITIONS, executeTool, NO_REPLY_SENTINEL } from "./tools.js";
import { isAwaDisengaged, isHumanTakeoverActive } from "../domain/adminOperations.js";
import * as deliveries from "../domain/deliveryRepo.js";
import * as commitments from "../domain/commitments.js";
import { emailAskMessage } from "../lib/linkAsk.js";
import { commitmentLaterAck } from "../lib/commitmentMessages.js";
import { PACK_DISCOVERY_CAMPAIGN, isPackDiscoveryCampaignEntry } from "../domain/packDiscoveryCampaign.js";

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

/** Run an Anthropic call, sleeping through overload spikes before retrying. */
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
      if (attempt >= delaysMs.length || !isOverloadedError(err)) throw err;
      const delay = delaysMs[attempt++];
      console.warn(`Anthropic overloaded — waiting ${delay / 1000}s then retrying (${attempt}/${delaysMs.length})`);
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

// A past present_options result is replayed in conversation history. On a later
// turn, the model can occasionally carry the old "reply <NO_REPLY>" instruction
// forward even though no interactive message was sent in the CURRENT turn
// (prod 22/07: Modou answered "Ok merci" after an Aquabike slot list). This
// suffix is used for one no-tools recovery call before declaring a real outage.
const UNEXPECTED_SILENCE_RECOVERY_INSTRUCTION =
  "Current-turn delivery guard: no interactive WhatsApp message was sent during this turn. " +
  "Respond now to the latest user with one natural, concise message. Do not output <NO_REPLY>. " +
  "If the latest message is only thanks or an acknowledgement, answer briefly and warmly. " +
  "Do not repeat an earlier list and do not invent information.";

/** Concatenate the text blocks of a model response into the reply string. */
export function extractText(response: Anthropic.Message): string {
  return response.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
}

export type ReplyOutcome = "deliver" | "silent_after_interactive" | "recover";

/**
 * Decide whether the model produced a client reply, a valid current-turn
 * present_options sentinel, or an unexpected silence that deserves one retry.
 * `<NO_REPLY>` is valid ONLY when this turn actually delivered an interactive
 * message; a stale sentinel from history must never become a technical error.
 */
export function classifyReplyOutcome(
  replyText: string | null,
  interactiveSent: boolean,
): ReplyOutcome {
  const text = replyText?.trim() ?? "";
  if (interactiveSent && (text === "" || text === NO_REPLY_SENTINEL)) {
    return "silent_after_interactive";
  }
  if (text === "" || text === NO_REPLY_SENTINEL) return "recover";
  return "deliver";
}

export function technicalFallbackMessage(clientName?: string | null): string {
  const contact = receptionWhatsAppLink(
    config.RECEPTION_PHONE,
    clientName,
    "un souci technique rencontré avec Awa",
  );
  return (
    "Désolé, j'ai un souci technique 🙏🏾 Réessaie dans un instant.\n\n" +
    receptionLinkInstruction("fr", contact.url)
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
      turn.role === "tool" ? `[outil] ${turn.content.slice(0, toolReplayMaxLen)}` : turn.content;
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

const TECH_FAILURE_HANDOFF_PREFIX = "Échec technique — le client a reçu le message d'erreur";

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

function notifyHumanTakeoverInbound(client: repo.Client, preview: string): void {
  notifyReception(
    "Nouveau message pendant un relais humain",
    `${client.name ?? "Client"} (+${client.wa_phone.replace(/^\+/, "")}) a répondu : « ${preview.replace(/\s+/g, " ").trim().slice(0, 180)} »\n` +
      `Ouvrir : ${config.BASE_URL.replace(/\/+$/, "")}/admin/conversations/${client.id}`,
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

/**
 * The client just received the technical fallback: the agent loop crashed or produced
 * nothing. Record it in the handoffs register and tell reception (fire and
 * forget — this must never delay or break the reply path). Deduped 24h per
 * client so a retry-spam doesn't flood anyone. `reason` is the underlying
 * failure (see describeLoopFailure) so the incident stays diagnosable after
 * Railway's short log window rolls over.
 */
async function notifyTechnicalFailure(client: repo.Client, reason?: string): Promise<void> {
  try {
    if (await repo.recentHandoffExists(client.id, TECH_FAILURE_HANDOFF_PREFIX, 24)) return;
    await repo.recordHandoff(client.id, TECH_FAILURE_HANDOFF_PREFIX);
    notifyReception(
      "⚠️ Échec technique — un client est planté",
      `Awa n'a pas réussi à répondre à ${client.name ?? "?"} (+${client.wa_phone.replace(/^\+/, "")}) ` +
        `et lui a envoyé le message d'erreur avec un lien WhatsApp prérempli vers la réception.\n\n` +
        (reason ? `Motif technique : ${reason}\n\n` : "") +
        `À faire : jeter un œil à sa conversation (${config.BASE_URL}/admin/conversations) et le ` +
        `recontacter si son besoin est visible. Si ça se répète, prévenir le support technique.`,
    );
  } catch (err) {
    console.error(`Technical-failure notification failed for client ${client.id}:`, err);
  }
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

export async function handleInboundText(args: {
  waPhone: string;
  text: string;
  waMessageId: string;
  profileName?: string;
  referral?: WhatsAppReferral;
}): Promise<void> {
  const client = await repo.upsertClient(args.waPhone);
  const campaign = isPackDiscoveryCampaignEntry({ text: args.text, referral: args.referral, allowedSourceIds: config.PACK_DISCOVERY_META_SOURCE_IDS });
  if (campaign.matched && campaign.matchedBy) await repo.recordCampaignLead({ clientId: client.id, campaignKey: PACK_DISCOVERY_CAMPAIGN, triggerMessageId: args.waMessageId, matchedBy: campaign.matchedBy, sourceId: args.referral?.sourceId, sourceType: args.referral?.sourceType, sourceUrl: args.referral?.sourceUrl, headline: args.referral?.headline, ctwaClid: args.referral?.ctwaClid });

  // Name a chat-only lead from their matching Wix fiche (fire-and-forget) so the
  // admin stops showing "(sans nom)" for someone who never books.
  void maybeEnrichClientNameFromWix(client);

  // Conversation-start ping (before the incoming turn is persisted, so the gap
  // query sees only prior activity).
  await maybeNotifyConversationStart(client, args.text, args.profileName);

  const lang = detectLanguage(args.text);
  if (lang) await repo.updateClientLanguage(client.id, lang);

  await repo.addTurn(client.id, "user", args.text, args.waMessageId);

  // Human takeover is a hard gate: keep the incoming turn, alert reception,
  // and never enter the model/tool loop. The timestamp expires automatically
  // after 12h, so normal handling resumes without a background sweep.
  if (isHumanTakeoverActive(client)) {
    notifyHumanTakeoverInbound(client, args.text);
    return;
  }

  // Awa disengaged from a non-serious/suggestive contact: stay fully silent.
  // The turn is already persisted above (visible in admin); no team ping — the
  // studio only sees it via the admin badge (silent to team, per product call).
  if (isAwaDisengaged(client)) return;

  // Multi-session commitment button taps are routed by the SERVER (deterministic,
  // "le serveur décide"): ms_later and ms_link are self-contained and answered
  // here without the model; ms_continue falls through to the model, which re-runs
  // check_availability (the stored slot's slot_cache entry has a 2h TTL and is
  // long gone for a multi-day plan) then create_payment_link with the item id.
  if (await maybeHandleCommitmentTap(client, args.text)) return;

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
    activeCafeOrder,
    memberships,
    recentRefunds,
    habit,
    upcomingBookingsCount,
    preferredPaymentMethod,
    deliveryOrders,
    activeCommitment,
  ] = await Promise.all([
    repo.activeAwaitingPayment(client.id),
    repo.activeAwaitingPlanOrder(client.id),
    repo.activeAwaitingCafeOrder(client.id),
    activeMemberships(client),
    repo.recentRefunds(client.id),
    repo.bookingHabit(client.id),
    repo.countUpcomingBooked(client.id),
    repo.lastSuccessfulBookingPaymentMethod(client.id),
    deliveries.actionableDeliveriesForPhone(client.wa_phone),
    commitments.activeCommitmentSnapshot(client.id),
  ]);

  const history = await repo.lastTurnsForReplay(client.id, 30);
  const packDiscoveryCampaign = await repo.activeCampaignLead(client.id, PACK_DISCOVERY_CAMPAIGN);

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
  // ASSISTANT turn, not an empty history). Drives the "Moi c'est Awa,
  // l'assistante de Revive" self-introduction — see dynamicContext(). Awa no
  // longer volunteers that she is an AI (only confirms it if asked), but a
  // "bonjour" that fires the capability menu should still open with a warm
  // introduction rather than a bare option list.
  const isFirstContact = !history.some((t) => t.role === "assistant");
  // Tiered capability menu on vague openers (incl. returning clients), once per ~24h.
  const capabilityMenu = capabilityMenuKind({
    isVague: isVagueOpener(args.text),
    unlinkedNeverAsked,
    hasActivePaymentLink,
    upcomingBookingsCount,
    capabilityMenuAt: client.capability_menu_at,
  });

  const messages: Anthropic.MessageParam[] = buildHistoryMessages(history);
  if (messages.length === 0) {
    messages.push({ role: "user", content: args.text });
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
        activeBooking,
        activePlanOrder,
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
      }),
    },
  ];

  let replyText: string | null = null;
  let interactiveSent = false;
  let usedTechnicalFallback = false;
  // Book-first, menu-after (abonnement flow): a successful book_with_membership
  // this turn means the SERVER sends the incontournables list right after the
  // model's confirmation — deterministic, never left to the model's judgment
  // (the Wave flow gets the same list from the webhook).
  let membershipBooked = false;
  let cafeMenuShown = false;

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
            system,
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
            const retry = await anthropic.messages.create({
              model: config.CLAUDE_MODEL,
              max_tokens: REPLY_MAX_TOKENS_RETRY,
              output_config: { effort: "low" },
              system,
              tools: TOOL_DEFINITIONS,
              messages,
            });
            if (retry.stop_reason !== "tool_use") {
              const retried = extractText(retry);
              if (retried) replyText = retried;
              if (retry.stop_reason === "max_tokens")
                console.error("Reply STILL truncated at the larger budget");
            }
          } catch (err) {
            console.error("max_tokens retry failed — keeping the partial reply:", err);
          }
        }
        break;
      }

      // Execute tool calls; append assistant turn + one user turn of results.
      messages.push({ role: "assistant", content: response.content });
      const results: Anthropic.ToolResultBlockParam[] = [];
      for (const block of response.content) {
        if (block.type !== "tool_use") continue;
        let result: string;
        let isError = false;
        try {
          result = await executeTool(client, block.name, block.input as Record<string, unknown>);
          if (block.name === "present_options" && result.includes('"sent":true')) {
            interactiveSent = true;
            // If the model itself already showed bar items, don't double-send
            // the menu offer below.
            const opts = (block.input as any)?.options;
            if (Array.isArray(opts) && opts.some((o: any) => getCafeMenu().items.has(String(o?.id)))) {
              cafeMenuShown = true;
            }
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
        }
        await repo.addTurn(client.id, "tool", `${block.name}(${JSON.stringify(block.input)}) -> ${result.slice(0, 2000)}`);
        results.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: result,
          is_error: isError || undefined,
        });
      }
      messages.push({ role: "user", content: results });
    }

    // Iteration cap reached while the model still wanted tools: an action may
    // have JUST run (a payment link created, a booking made). Force ONE final
    // reply WITHOUT tools so the client gets the real outcome instead of the
    // misleading "technical issue" fallback that made Awa deny work she'd done.
    if (!replyText && !interactiveSent && lastResponse?.stop_reason === "tool_use") {
      console.warn("Tool-iteration cap reached — forcing a final reply without tools");
      const final = await withOverloadRetry(
        () =>
          anthropic.messages.create({
            model: config.CLAUDE_MODEL,
            max_tokens: REPLY_MAX_TOKENS,
            output_config: { effort: "low" },
            system,
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

  // A stale <NO_REPLY> (or an unexplained empty end_turn) without a message
  // delivered in THIS turn is not a real outage. Retry once without tools and
  // with an explicit current-turn guard. This is intentionally before the
  // technical fallback: a normal "Ok merci" must never be sent to reception.
  let replyOutcome = classifyReplyOutcome(replyText, interactiveSent);
  if (replyOutcome === "recover" && loopError == null && lastResponse) {
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
      replyText = extractText(recovered);
      replyOutcome = classifyReplyOutcome(replyText, false);
      if (replyOutcome === "recover") {
        const repeated = replyText?.trim() === NO_REPLY_SENTINEL ? NO_REPLY_SENTINEL : "empty reply";
        loopError = new Error(
          `model returned ${repeated} twice (stop_reason: ${recovered.stop_reason ?? "unknown"})`,
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
  replyOutcome = classifyReplyOutcome(replyText, interactiveSent);
  if (replyOutcome !== "deliver") replyText = null;
  if (!replyText && !interactiveSent) {
    replyText = technicalFallbackMessage(client.name ?? args.profileName ?? null);
    usedTechnicalFallback = true;
    // Boucle de résultat (§4.31) : le client vient de recevoir « souci
    // technique » — la réception DOIT le savoir (avant : un console.error que
    // personne ne lit, client planté en silence). Dédup 24h par client.
    // On y joint le motif d'erreur réel : les logs Railway ont une fenêtre
    // courte, donc le stocker dans le notification_log rend l'incident
    // diagnosticable après coup (cas Zoé Dourthe 22/07 — erreur déjà défilée).
    void notifyTechnicalFailure(client, describeLoopFailure(loopError));
  }

  if (replyText) {
    await sendText(args.waPhone, replyText);
    await repo.addTurn(client.id, "assistant", replyText);
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

  // Book-first, menu-after: the class was just booked on the client's plan —
  // show the incontournables NOW, right after the confirmation, server-side
  // (skipped if the model already showed bar items itself this turn).
  if (membershipBooked && !cafeMenuShown) {
    await sendCafeMenuOffer({
      waPhone: args.waPhone,
      clientId: client.id,
      lang: client.language ?? lang ?? "fr",
    });
  }
}

/** Image received but the description failed — ask kindly for text. */
export async function handleFailedImage(waPhone: string, waMessageId: string): Promise<void> {
  const client = await repo.upsertClient(waPhone);
  await maybeNotifyConversationStart(client, "[image]");
  await repo.addTurn(client.id, "user", "[image reçue — lecture échouée]", waMessageId);
  if (isHumanTakeoverActive(client)) {
    notifyHumanTakeoverInbound(client, "[image reçue]");
    return;
  }
  if (isAwaDisengaged(client)) return;
  void sendTypingIndicator(waMessageId);
  const reply =
    "Désolée, je n'ai pas réussi à lire ton image 🙏🏾 Tu peux m'écrire ce qu'elle montre ?\n" +
    "(Sorry, I couldn't read your image — could you tell me what it shows?)";
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
): Promise<void> {
  const client = await repo.upsertClient(waPhone);
  const label = emoji ? `[réaction ${emoji}]` : "[réaction retirée]";
  await repo.addTurn(client.id, "user", label, waMessageId);
  if (isHumanTakeoverActive(client)) notifyHumanTakeoverInbound(client, label);
}

/** Polite reply for stickers / documents / other unreadable media (SPEC §8). */
export async function handleUnsupportedMedia(
  waPhone: string,
  waMessageId: string,
  label = "[non-text message]",
): Promise<void> {
  const client = await repo.upsertClient(waPhone);
  await maybeNotifyConversationStart(client, label);
  await repo.addTurn(client.id, "user", label, waMessageId);
  if (isHumanTakeoverActive(client)) {
    notifyHumanTakeoverInbound(client, label);
    return;
  }
  if (isAwaDisengaged(client)) return;
  void sendTypingIndicator(waMessageId);
  const reply =
    "Je ne peux pas lire ce type de message 🙏🏾 Écris-moi (ou envoie une note vocale) et je continue à t'aider !\n" +
    "(I can't read this kind of message — please type or voice-note it and we'll continue.)";
  await sendText(waPhone, reply);
  await repo.addTurn(client.id, "assistant", reply);
}

/** Voice note received but transcription failed — ask kindly for text. */
export async function handleFailedVoiceNote(waPhone: string, waMessageId: string): Promise<void> {
  const client = await repo.upsertClient(waPhone);
  await maybeNotifyConversationStart(client, "[note vocale]");
  await repo.addTurn(client.id, "user", "[note vocale — transcription échouée]", waMessageId);
  if (isHumanTakeoverActive(client)) {
    notifyHumanTakeoverInbound(client, "[note vocale]");
    return;
  }
  if (isAwaDisengaged(client)) return;
  void sendTypingIndicator(waMessageId);
  const reply =
    "Désolée, je n'ai pas réussi à écouter ta note vocale 🙏🏾 Tu peux me l'écrire ?\n" +
    "(Sorry, I couldn't process your voice note — could you type it instead?)";
  await sendText(waPhone, reply);
  await repo.addTurn(client.id, "assistant", reply);
}
