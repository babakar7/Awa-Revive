import Anthropic from "@anthropic-ai/sdk";
import { config } from "../config.js";
import * as repo from "../domain/repo.js";
import { activeMemberships } from "../lib/membershipContext.js";
import { sendText, sendTypingIndicator } from "../lib/whatsapp.js";
import { CAFE_MENU } from "../lib/cafeMenu.js";
import { sendCafeMenuOffer } from "../lib/cafeOffer.js";
import { SYSTEM_PROMPT, dynamicContext } from "./systemPrompt.js";
import { TOOL_DEFINITIONS, executeTool, NO_REPLY_SENTINEL } from "./tools.js";

const anthropic = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY });

const MAX_TOOL_ITERATIONS = 8;

const FALLBACK_REPLY =
  "Désolé, j'ai un souci technique 🙏🏾 Réessaie dans un instant, ou contacte la réception : " +
  config.RECEPTION_PHONE;

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

  const lang = detectLanguage(args.text);
  if (lang) await repo.updateClientLanguage(client.id, lang);

  await repo.addTurn(client.id, "user", args.text, args.waMessageId);

  // Lazy TTL sweep so the "active link" context below is accurate.
  await Promise.all([
    repo.expireStaleBookings(),
    repo.expireStalePlanOrders(),
    repo.expireStaleCafeOrders(),
  ]);
  const [activeBooking, activePlanOrder, activeCafeOrder, memberships, recentRefunds, habit] =
    await Promise.all([
      repo.activeAwaitingPayment(client.id),
      repo.activeAwaitingPlanOrder(client.id),
      repo.activeAwaitingCafeOrder(client.id),
      activeMemberships(client),
      repo.recentRefunds(client.id),
      repo.bookingHabit(client.id),
    ]);

  const history = await repo.lastTurns(client.id, 20);
  const messages: Anthropic.MessageParam[] = [];
  for (const turn of history) {
    const role = turn.role as "user" | "assistant";
    // First message must be from the user; drop any leading assistant turns.
    if (messages.length === 0 && role !== "user") continue;
    // Coalesce consecutive same-role turns so the roles always alternate as
    // the Messages API requires. Without this, a failed WhatsApp send (which
    // drops the assistant turn before it's persisted) would leave two user
    // turns in a row and make the very next request 400.
    const last = messages[messages.length - 1];
    if (last && last.role === role && typeof last.content === "string") {
      last.content += `\n${turn.content}`;
      continue;
    }
    messages.push({ role, content: turn.content });
  }
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
        memberships,
        recentRefunds,
        habit,
      }),
    },
  ];

  let replyText: string | null = null;
  let interactiveSent = false;
  // Book-first, menu-after (abonnement flow): a successful book_with_membership
  // this turn means the SERVER sends the incontournables list right after the
  // model's confirmation — deterministic, never left to the model's judgment
  // (the Wave flow gets the same list from the webhook).
  let membershipBooked = false;
  let cafeMenuShown = false;

  try {
    for (let i = 0; i < MAX_TOOL_ITERATIONS; i++) {
      // Meta drops the "typing…" bubble after ~25s; re-arm it at every model
      // round so it survives long tool chains (bookings, cancellations...).
      if (i > 0) void sendTypingIndicator(args.waMessageId);
      const response = await anthropic.messages.create({
        model: config.CLAUDE_MODEL,
        max_tokens: 2048,
        output_config: { effort: "low" },
        system,
        tools: TOOL_DEFINITIONS,
        messages,
      });

      if (response.stop_reason !== "tool_use") {
        replyText = response.content
          .filter((b): b is Anthropic.TextBlock => b.type === "text")
          .map((b) => b.text)
          .join("\n")
          .trim();
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
            // If the model itself already showed café items, don't double-send
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
            message: "The service is temporarily unavailable. Apologize and offer the reception contact.",
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
  } catch (err) {
    console.error("Agent loop failed:", err);
  }

  // present_options already delivered (and logged) the reply — send nothing
  // more. Only honored when an interactive message actually went out, so a
  // spurious sentinel can never leave the client without an answer.
  if (replyText?.trim() === NO_REPLY_SENTINEL) replyText = null;
  if (!replyText && !interactiveSent) replyText = FALLBACK_REPLY;

  if (replyText) {
    await sendText(args.waPhone, replyText);
    await repo.addTurn(client.id, "assistant", replyText);
  }

  // Book-first, menu-after: the class was just booked on the client's plan —
  // show the incontournables NOW, right after the confirmation, server-side
  // (skipped if the model already showed café items itself this turn).
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
  await repo.addTurn(client.id, "user", "[note vocale — transcription échouée]", waMessageId);
  const reply =
    "Désolée, je n'ai pas réussi à écouter ta note vocale 🙏🏾 Tu peux me l'écrire ?\n" +
    "(Sorry, I couldn't process your voice note — could you type it instead?)";
  await sendText(waPhone, reply);
  await repo.addTurn(client.id, "assistant", reply);
}
