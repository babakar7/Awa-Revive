import Anthropic from "@anthropic-ai/sdk";
import { config } from "../config.js";
import { notifyReception, notifyNewConversation } from "../lib/notify.js";
import * as repo from "../domain/repo.js";
import { activeMemberships } from "../lib/membershipContext.js";
import { shouldOfferLinking } from "../lib/linkAsk.js";
import { sendText, sendTypingIndicator } from "../lib/whatsapp.js";
import { CAFE_MENU } from "../lib/cafeMenu.js";
import { sendCafeMenuOffer } from "../lib/cafeOffer.js";
import { SYSTEM_PROMPT, dynamicContext } from "./systemPrompt.js";
import { capabilityMenuKind, isVagueOpener } from "../lib/capabilityMenu.js";
import {
  receptionLinkInstruction,
  receptionWhatsAppLink,
} from "../lib/receptionContact.js";
import { TOOL_DEFINITIONS, executeTool, NO_REPLY_SENTINEL } from "./tools.js";

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

/** Concatenate the text blocks of a model response into the reply string. */
export function extractText(response: Anthropic.Message): string {
  return response.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
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
  try {
    const last = await repo.lastConversationActivityAt(client.id);
    if (!isConversationStart(last, Date.now(), config.NEW_CHAT_NOTIFY_GAP_HOURS)) return;
    notifyNewConversation({
      displayName: client.name ?? profileName ?? "Client",
      waPhone: client.wa_phone,
      preview: preview.replace(/\s+/g, " ").trim().slice(0, 160),
    });
  } catch (err) {
    console.error("maybeNotifyConversationStart failed (non-blocking):", err);
  }
}

/**
 * The client just received the technical fallback: the agent loop crashed or produced
 * nothing. Record it in the handoffs register and tell reception (fire and
 * forget — this must never delay or break the reply path). Deduped 24h per
 * client so a retry-spam doesn't flood anyone.
 */
async function notifyTechnicalFailure(client: repo.Client): Promise<void> {
  try {
    if (await repo.recentHandoffExists(client.id, TECH_FAILURE_HANDOFF_PREFIX, 24)) return;
    await repo.recordHandoff(client.id, TECH_FAILURE_HANDOFF_PREFIX);
    notifyReception(
      "⚠️ Échec technique — un client est planté",
      `Awa n'a pas réussi à répondre à ${client.name ?? "?"} (+${client.wa_phone.replace(/^\+/, "")}) ` +
        `et lui a envoyé le message d'erreur avec un lien WhatsApp prérempli vers la réception.\n\n` +
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
export async function handleInboundText(args: {
  waPhone: string;
  text: string;
  waMessageId: string;
  profileName?: string;
}): Promise<void> {
  // Blue ticks + "typing…" bubble while the agent thinks (best-effort, non-blocking).
  void sendTypingIndicator(args.waMessageId);

  const client = await repo.upsertClient(args.waPhone);

  // Conversation-start ping (before the incoming turn is persisted, so the gap
  // query sees only prior activity).
  await maybeNotifyConversationStart(client, args.text, args.profileName);

  const lang = detectLanguage(args.text);
  if (lang) await repo.updateClientLanguage(client.id, lang);

  await repo.addTurn(client.id, "user", args.text, args.waMessageId);

  // Lazy TTL sweep so the "active link" context below is accurate.
  await Promise.all([
    repo.expireStaleBookings(),
    repo.expireStalePlanOrders(),
    repo.expireStaleCafeOrders(),
  ]);
  const [
    activeBooking,
    activePlanOrder,
    activeCafeOrder,
    memberships,
    recentRefunds,
    habit,
    upcomingBookingsCount,
  ] = await Promise.all([
    repo.activeAwaitingPayment(client.id),
    repo.activeAwaitingPlanOrder(client.id),
    repo.activeAwaitingCafeOrder(client.id),
    activeMemberships(client),
    repo.recentRefunds(client.id),
    repo.bookingHabit(client.id),
    repo.countUpcomingBooked(client.id),
  ]);

  const history = await repo.lastTurnsForReplay(client.id, 30);

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
  const hasActivePaymentLink = !!(activeBooking || activePlanOrder || activeCafeOrder);
  // First contact = Awa has never replied to this client before (the current
  // inbound turn is already persisted at this point, so we look for a prior
  // ASSISTANT turn, not an empty history). Drives the mandatory "I'm an AI
  // assistant" self-introduction — see dynamicContext(): clients were being
  // disappointed to learn only later that Awa is a bot, and on a "bonjour" the
  // capability menu otherwise fires with no disclosure at all.
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
    { type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } },
    // Volatile context — after the cache breakpoint.
    {
      type: "text",
      text: dynamicContext({
        clientName: client.name ?? args.profileName ?? null,
        clientLanguage: client.language ?? lang,
        activeBooking,
        activePlanOrder,
        activeCafeOrder,
        memberships: memberships === null ? null : memberships.plans,
        unlinkedNeverAsked,
        recentRefunds,
        habit,
        upcomingBookingsCount,
        capabilityMenu,
        firstContact: isFirstContact,
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
            if (Array.isArray(opts) && opts.some((o: any) => CAFE_MENU.items.has(String(o?.id)))) {
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
              "The service is temporarily unavailable. Apologize and call handoff_to_human so the client " +
              "receives the prefilled reception link.",
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
    console.error("Agent loop failed:", err);
  }

  // present_options already delivered (and logged) the reply — send nothing
  // more. Only honored when an interactive message actually went out, so a
  // spurious sentinel can never leave the client without an answer.
  if (replyText?.trim() === NO_REPLY_SENTINEL) replyText = null;
  if (!replyText && !interactiveSent) {
    replyText = technicalFallbackMessage(client.name ?? args.profileName ?? null);
    usedTechnicalFallback = true;
    // Boucle de résultat (§4.31) : le client vient de recevoir « souci
    // technique » — la réception DOIT le savoir (avant : un console.error que
    // personne ne lit, client planté en silence). Dédup 24h par client.
    void notifyTechnicalFailure(client);
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
  void sendTypingIndicator(waMessageId);
  const client = await repo.upsertClient(waPhone);
  await maybeNotifyConversationStart(client, "[image]");
  await repo.addTurn(client.id, "user", "[image reçue — lecture échouée]", waMessageId);
  const reply =
    "Désolée, je n'ai pas réussi à lire ton image 🙏🏾 Tu peux m'écrire ce qu'elle montre ?\n" +
    "(Sorry, I couldn't read your image — could you tell me what it shows?)";
  await sendText(waPhone, reply);
  await repo.addTurn(client.id, "assistant", reply);
}

/** Polite reply for stickers / documents / other unreadable media (SPEC §8). */
export async function handleUnsupportedMedia(waPhone: string, waMessageId: string): Promise<void> {
  void sendTypingIndicator(waMessageId);
  const client = await repo.upsertClient(waPhone);
  await maybeNotifyConversationStart(client, "[message non lisible]");
  await repo.addTurn(client.id, "user", "[non-text message]", waMessageId);
  const reply =
    "Je ne peux pas lire ce type de message 🙏🏾 Écris-moi (ou envoie une note vocale) ce que tu veux réserver !\n" +
    "(I can't read this kind of message — please type or voice-note your request.)";
  await sendText(waPhone, reply);
  await repo.addTurn(client.id, "assistant", reply);
}

/** Voice note received but transcription failed — ask kindly for text. */
export async function handleFailedVoiceNote(waPhone: string, waMessageId: string): Promise<void> {
  void sendTypingIndicator(waMessageId);
  const client = await repo.upsertClient(waPhone);
  await maybeNotifyConversationStart(client, "[note vocale]");
  await repo.addTurn(client.id, "user", "[note vocale — transcription échouée]", waMessageId);
  const reply =
    "Désolée, je n'ai pas réussi à écouter ta note vocale 🙏🏾 Tu peux me l'écrire ?\n" +
    "(Sorry, I couldn't process your voice note — could you type it instead?)";
  await sendText(waPhone, reply);
  await repo.addTurn(client.id, "assistant", reply);
}
