import type Anthropic from "@anthropic-ai/sdk";
import { config } from "../config.js";
import { notifyReception, sendVerificationCodeEmail } from "../lib/notify.js";
import { sendInteractive, sendImage } from "../lib/whatsapp.js";
import {
  buildWeeklyGrid,
  renderScheduleImage,
  scheduleText,
  type ScheduleEntry,
} from "../lib/scheduleImage.js";
import {
  CAFE_MENU,
  computeExtras,
  extrasFromJson,
  formatExtrasOneLine,
} from "../lib/cafeMenu.js";
import * as wix from "../lib/wix.js";
import { planVerifiedMerge } from "../lib/crmAudit.js";
import * as wave from "../lib/wave.js";
import { invalidateMembershipCache } from "../lib/membershipContext.js";
import * as links from "../domain/linkRequests.js";
import type { LinkRequest } from "../domain/linkRequests.js";
import * as repo from "../domain/repo.js";
import type { Client } from "../domain/repo.js";

/**
 * A Wave payment link must NOT be sold while an email verification is mid-flight
 * (a code was just sent but not yet typed): the account being linked may hold an
 * abonnement that covers this class/plan, so selling now risks charging a
 * subscriber for nothing. This sequencing is a SERVER decision, never left to
 * the model (it dropped the prompt-level rule under booking momentum, 11/07).
 * Blocks ONLY the narrow window where a code is live:
 *  - AWAITING_CODE (email accepted, code emailed) AND not yet expired.
 * Does NOT block AWAITING_EMAIL (a claimer who ignored the offer can still buy)
 * nor an expired code (a >10-min silence shouldn't hold the sale; the >30-min
 * sweep escalates to reception separately).
 */
export function verificationBlocksPayment(request: LinkRequest | null, now: Date): boolean {
  if (!request || request.status !== "AWAITING_CODE") return false;
  if (!request.code_expires_at) return false;
  return new Date(request.code_expires_at).getTime() > now.getTime();
}

const VERIFICATION_PENDING_RESULT = JSON.stringify({
  error: "verification_pending",
  message:
    "A 6-digit code was just emailed to this client's claimed Revive account — their abonnement may cover " +
    "this, so do NOT sell a Wave link yet. Your next message must tell them the code is in their inbox (check " +
    "spam) and ask them to type it HERE; once they do, resume the booking (check_membership → book_with_membership " +
    "if covered, otherwise the link). ONLY if the client says they can't access that email or explicitly prefers " +
    "to pay now, call this tool again with client_declined_verification:true.",
});

/**
 * Tool definitions (SPEC §6). Kept in a stable order so the prompt cache
 * prefix (tools render first) never shifts.
 */
export const TOOL_DEFINITIONS: Anthropic.Tool[] = [
  {
    name: "list_classes",
    description:
      "List the classes offered at Revive with name, description, price in FCFA (XOF) and duration. " +
      "Call this before recommending or naming any class. Results are cached server-side for 10 minutes.",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "check_availability",
    description:
      "Get time slots for a class between two dates, including full ones. Open slots carry an event_id " +
      "needed to create a payment link; slots marked full:true exist but cannot be booked — mention they " +
      "are full and propose open alternatives instead. Each slot includes the coach's name — the ONLY valid " +
      "source to answer who teaches a class. Call this whenever the client asks about times/days for a class.",
    input_schema: {
      type: "object",
      properties: {
        service_id: { type: "string", description: "Class id from list_classes" },
        date_from: { type: "string", description: "ISO 8601 start of the search window, e.g. 2026-07-03T00:00:00Z" },
        date_to: { type: "string", description: "ISO 8601 end of the search window (max ~14 days after date_from)" },
      },
      required: ["service_id", "date_from", "date_to"],
      additionalProperties: false,
    },
  },
  {
    name: "create_payment_link",
    description:
      "Create a Wave payment link for a specific class slot (the CLASS only — never the café). Re-verifies the " +
      "slot is still open, cancels any previous unpaid link for this client, and returns the payment URL, amount " +
      "and expiry to relay to the client. Supports group bookings: set participants > 1 to book several spots " +
      "under the same name with ONE payment link for the total (price × participants). Call this as soon as the " +
      "client clearly chose a slot and you know their first name — do NOT ask about the menu first. The café " +
      "menu is offered automatically AFTER the booking is confirmed (its own separate link via " +
      "create_cafe_payment_link); nothing café-related goes on this link.",
    input_schema: {
      type: "object",
      properties: {
        service_id: { type: "string", description: "Class id from list_classes" },
        event_id: { type: "string", description: "event_id (or choice_id) of the chosen slot from check_availability" },
        slot_start: { type: "string", description: "ISO start time of the chosen slot" },
        client_name: { type: "string", description: "Client's first name for the booking" },
        participants: {
          type: "integer",
          minimum: 1,
          maximum: 10,
          description:
            "Number of spots to book under this name (default 1). One payment link covers all of them. " +
            "Each class has a max spots per booking (Wix policy) — the tool rejects amounts above it with the allowed max.",
        },
        client_declined_verification: {
          type: "boolean",
          description:
            "Set true ONLY when an email verification is pending (a code was sent) AND the client explicitly " +
            "says they can't access that inbox or prefers to pay by Wave now. Otherwise leave absent: if a code " +
            "is pending, the server refuses the link so the client can type the code first (their abonnement may " +
            "cover this class).",
        },
      },
      required: ["service_id", "event_id", "slot_start", "client_name"],
      additionalProperties: false,
    },
  },
  {
    name: "list_plans",
    description:
      "List the abonnements/packs (pricing plans) Revive sells, with plan_id, price in FCFA, billing type " +
      "(one_time or recurring), period, and covers_classes (which classes the plan can pay for). " +
      "Call this before recommending or quoting ANY plan. Results are cached server-side for 10 minutes.",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "create_plan_payment_link",
    description:
      "Create a Wave payment link to BUY an abonnement/pack. Price comes from the Wix catalog. After payment, " +
      "the plan is activated automatically (or by reception if the client has no member account) and the client " +
      "gets a WhatsApp confirmation. Only call after the client clearly chose a plan from list_plans and you " +
      "know their first name. For recurring plans this link covers the FIRST period only — renewals are handled " +
      "with the studio.",
    input_schema: {
      type: "object",
      properties: {
        plan_id: { type: "string", description: "Plan id from list_plans" },
        client_name: { type: "string", description: "Client's first name" },
        client_declined_verification: {
          type: "boolean",
          description:
            "Set true ONLY when an email verification is pending (a code was sent) AND the client explicitly " +
            "says they can't access that inbox or prefers to pay now. Otherwise leave absent: if a code is " +
            "pending, the server refuses the link so the client can type the code first (they may already own a plan).",
        },
      },
      required: ["plan_id", "client_name"],
      additionalProperties: false,
    },
  },
  {
    name: "check_membership",
    description:
      "Check whether this client has an active abonnement (Wix pricing plan) — identity is verified " +
      "server-side via their WhatsApp number. Call this when the client mentions having an abonnement, " +
      "pack or credits, asks how many sessions they have left, or BEFORE creating any payment link. " +
      "Returns their active plans with covers_classes (which classes each plan can pay for) and " +
      "remaining_sessions (current balance), or why verification failed. Set claim:true when the CLIENT " +
      "ASSERTS having an abonnement/prepaid plan (\"j'ai un abonnement\", \"c'est prépayé\") — if the plan " +
      "then can't be found under their number, the server opens a link request and the result tells you " +
      "to propose the email verification (request_email_verification).",
    input_schema: {
      type: "object",
      properties: {
        claim: {
          type: "boolean",
          description:
            "true ONLY when the client explicitly claims to have an abonnement/prepaid plan. " +
            "Leave absent for routine checks (balance questions, pre-link verification).",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "book_with_membership",
    description:
      "Book one OR several spots on a class slot using the client's active abonnement — no Wave payment. " +
      "Set participants > 1 to book several people in ONE go, all deducted from THIS client's plan (one " +
      "session per spot, same class/slot). Wix validates that the plan covers this service and that enough " +
      "sessions remain; if not eligible or the balance can't cover the whole group, this returns an error " +
      "and you should offer the normal Wave payment for the total instead (all-or-nothing — the plan never " +
      "covers only part of a group). Only call when the context or check_membership shows an active plan " +
      "whose covers_classes includes this class, and the client chose a slot from check_availability.",
    input_schema: {
      type: "object",
      properties: {
        service_id: { type: "string", description: "Class id from list_classes" },
        event_id: { type: "string", description: "event_id (or choice_id) of the chosen slot from check_availability" },
        slot_start: { type: "string", description: "ISO start time of the chosen slot" },
        client_name: { type: "string", description: "Client's first name" },
        participants: {
          type: "integer",
          minimum: 1,
          maximum: 10,
          description:
            "How many spots to book on this plan (default 1). Use > 1 only when the client explicitly wants " +
            "to bring several people on their own abonnement — that many sessions are deducted from their plan.",
        },
      },
      required: ["service_id", "event_id", "slot_start", "client_name"],
      additionalProperties: false,
    },
  },
  {
    name: "create_cafe_payment_link",
    description:
      "Create a Wave payment link for a MENU order attached to a class the client has ALREADY booked (paid by " +
      "Wave or by abonnement — the café always rides on its own separate small link, it is never bundled into " +
      "the class link). Use it whenever the client wants something from the menu once their class is confirmed: " +
      "the studio automatically offers the menu right after every booking, and this tool turns their order into a " +
      "café-only link. Leave linked_booking_id empty to attach to the class they just booked (the default), or " +
      "pass a specific booking_id from get_my_bookings / book_with_membership if the client has several upcoming " +
      "bookings and you must disambiguate. The server prices everything from the menu file and returns the link + " +
      "breakdown. Also works with NO class booking at all when the client explicitly asks to order from the menu " +
      "(standalone order, picked up at the counter) — the result tells you which case applied. Never use this for " +
      "a class (that's create_payment_link).",
    input_schema: {
      type: "object",
      properties: {
        linked_booking_id: {
          type: "string",
          description:
            "Optional booking_id of the confirmed class this café order accompanies (from get_my_bookings or " +
            "book_with_membership). Omit to use the client's most recent upcoming booking.",
        },
        extras: {
          type: "array",
          minItems: 1,
          maxItems: 15,
          description:
            "The menu order. item_id values come ONLY from the ids in <cafe_menu>; the server computes all prices.",
          items: {
            type: "object",
            properties: {
              item_id: { type: "string", description: "Menu item id exactly as listed in <cafe_menu>" },
              qty: { type: "integer", minimum: 1, maximum: 10 },
            },
            required: ["item_id", "qty"],
            additionalProperties: false,
          },
        },
        order_note: {
          type: "string",
          description:
            "Free-text note (timing, oat vs cow milk, allergies). Default when absent: ready after the class.",
        },
      },
      required: ["extras"],
      additionalProperties: false,
    },
  },
  {
    name: "get_my_bookings",
    description:
      "List this client's upcoming confirmed bookings. Returns { bookings: [...] }: each has booked_via " +
      "'awa' (taken through this chat) or 'studio' (booked at the counter or on the website, matched by the " +
      "client's WhatsApp number). Both carry a booking_id usable with cancel_booking (16h rule for all) — " +
      "for 'studio' ones Awa doesn't know the payment method, so refunds/re-credits go through reception. " +
      "Use it before answering about existing bookings and before any cancel/reschedule.",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "cancel_booking",
    description:
      "Cancel one of THIS client's upcoming bookings (all its spots). Only allowed 16 hours or more " +
      "before the class start — the server enforces this and refuses otherwise. Membership-paid bookings: " +
      "the plan session is automatically re-credited. Wave-paid bookings: the client will be refunded " +
      "manually by reception (they are notified automatically). Studio bookings (booking_id starting with " +
      "'studio:'): cancelled in Wix, but any refund/re-credit goes through reception (payment method unknown " +
      "to Awa). Also the first step of a reschedule (cancel, then book the new slot in the same turn). Call " +
      "ONLY after get_my_bookings gave you the booking_id AND the client explicitly confirmed they want to " +
      "cancel that specific class.",
    input_schema: {
      type: "object",
      properties: {
        booking_id: {
          type: "string",
          description: "booking_id of the booking to cancel, from get_my_bookings",
        },
      },
      required: ["booking_id"],
      additionalProperties: false,
    },
  },
  {
    name: "join_waitlist",
    description:
      "Put the client on the waitlist for a FULL slot they explicitly want (offer it only after saying the slot " +
      "is full and proposing open alternatives). The system re-checks availability every few minutes and sends " +
      "them ONE WhatsApp message if a spot frees up — no spot is ever held: first come, first served, and booking " +
      "then follows the normal payment flow. The server re-verifies the slot live: if it is actually open, the " +
      "result says so and you should just book it normally instead.",
    input_schema: {
      type: "object",
      properties: {
        service_id: { type: "string", description: "Class id from list_classes" },
        event_id: { type: "string", description: "event_id of the FULL slot, from check_availability" },
        slot_start: { type: "string", description: "ISO start of that slot (the `start` field from check_availability)" },
      },
      required: ["service_id", "event_id", "slot_start"],
      additionalProperties: false,
    },
  },
  {
    name: "leave_waitlist",
    description:
      "Remove the client from the waitlist when they ask (all their pending waitlist spots, or one class's " +
      "with service_id). Waitlist entries also expire silently on their own when the class starts.",
    input_schema: {
      type: "object",
      properties: {
        service_id: {
          type: "string",
          description: "Optional class id — remove only this class's waitlist entries",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "request_email_verification",
    description:
      "Start linking this WhatsApp number to the client's existing Revive account via their email: the " +
      "server finds the Wix account carrying that email and sends a 6-digit code TO THAT INBOX; the client " +
      "then reads the code from their email and types it here (submit_verification_code). Use whenever a " +
      "client shares the email of their existing account — after a failed check_membership claim, after the " +
      "post-payment linking question, or any account/history context. If the client says they have no email " +
      "or can't access it, call with client_has_no_email:true instead — reception takes over (the client " +
      "does NOT need to call). You never see the code: it only exists in the client's inbox.",
    input_schema: {
      type: "object",
      properties: {
        email: { type: "string", description: "The email of the client's existing Revive account" },
        client_has_no_email: {
          type: "boolean",
          description:
            "true when the client says they have no email or cannot access it — hands over to reception",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "submit_verification_code",
    description:
      "Verify the 6-digit code the client received by email (after request_email_verification) and, when " +
      "correct, link their WhatsApp number to their Wix account — their abonnement and history become " +
      "visible immediately. Call this when the client types a 6-digit number while an email verification " +
      "is in progress. Never guess, invent or confirm a code yourself: only the client can read it from " +
      "their inbox.",
    input_schema: {
      type: "object",
      properties: {
        code: { type: "string", description: "The 6-digit code exactly as the client typed it" },
      },
      required: ["code"],
      additionalProperties: false,
    },
  },
  {
    name: "handoff_to_human",
    description:
      "Escalate the conversation to the human reception team. Triggers: the client wants to call or speak to " +
      "a person (e.g. \"je peux vous appeler ?\"), complaints, refunds beyond what cancel_booking handles, " +
      "cancelling or rescheduling less than 16h before the class, partial group cancellations, " +
      "medical questions, anything off-script. Records the handoff and returns the reception WhatsApp number " +
      "to give the client immediately.",
    input_schema: {
      type: "object",
      properties: {
        reason: { type: "string", description: "Short reason for the handoff" },
      },
      required: ["reason"],
      additionalProperties: false,
    },
  },
  {
    name: "present_options",
    description:
      "Send the client a native WhatsApp clickable-choice message and deliver it IMMEDIATELY (this tool sends " +
      "it, you don't). Up to 3 short options without descriptions render as tap buttons; otherwise a list " +
      "(max 10 rows TOTAL) opens behind a button. Rows can carry a `section` header so several menu " +
      "categories show grouped in ONE list, visible by scrolling, with no need to re-open a sub-menu. " +
      "Use it whenever the client must pick among known options: menu items grouped by section " +
      "(title = item name, description = price + short pitch, section = e.g. '🍵 Iced Matcha'), " +
      "class slots from check_availability (option id = the slot's choice_id, NEVER the long event_id), or " +
      "quick yes/no confirmations. The client's " +
      "tap comes back as a normal message '[choix cliqué] <title> (id: <id>)'. Free text always stays possible " +
      `— never say the client MUST use the buttons. After this tool succeeds, reply exactly ${"<NO_REPLY>"} ` +
      "and nothing else: the interactive message IS your reply.",
    input_schema: {
      type: "object",
      properties: {
        body: {
          type: "string",
          description: "The message text shown above the choices (short, in the client's language)",
        },
        button_label: {
          type: "string",
          description: 'Label of the button that opens the list (max 20 chars, e.g. "Voir le menu"). Ignored for ≤3 tap buttons.',
        },
        options: {
          type: "array",
          minItems: 1,
          maxItems: 10,
          items: {
            type: "object",
            properties: {
              id: { type: "string", description: "Stable id returned when clicked (menu item id, event_id, or a short slug you choose)" },
              title: { type: "string", description: "Visible label (24 chars max on lists, 20 on buttons)" },
              description: { type: "string", description: "Optional second line (72 chars max), e.g. price" },
              section: { type: "string", description: "Optional group header (24 chars max) — rows sharing it appear under it in one list, e.g. '🍵 Iced Matcha'" },
            },
            required: ["id", "title"],
            additionalProperties: false,
          },
        },
      },
      required: ["body", "options"],
      additionalProperties: false,
    },
  },
  {
    name: "get_class_schedule",
    description:
      "Send the client the studio's WEEKLY class schedule (Monday→Sunday grid, no dates) as an image, generated " +
      "live from the Wix catalog — this tool renders AND delivers it itself. Use it when the client asks for the " +
      "overall planning/schedule/timetable of the studio ('le planning des cours', 'vos horaires', 'the schedule') " +
      "WITHOUT naming one class. For the slots of ONE specific class (or to actually book), keep using " +
      "check_availability — the weekly grid carries no dates and no open-spot counts. If the image cannot be sent, " +
      "the tool returns the schedule as text for you to relay.",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
  },
];

/**
 * When the model's final text equals this sentinel, the agent loop sends
 * nothing: a present_options call already delivered the reply.
 */
export const NO_REPLY_SENTINEL = "<NO_REPLY>";

// Weekly schedule (grid + rendered PNG) — dateless Mon→Sun timetable, safe to
// share across clients and cache briefly. png null = render failed, use text.
let scheduleCache: { at: number; entries: ScheduleEntry[]; png: Buffer | null } | null = null;
const SCHEDULE_TTL_MS = 30 * 60 * 1000;

/**
 * Human-readable time in Dakar local time (GMT+0). Injected into every tool
 * result that carries a timestamp so the model relays it verbatim instead of
 * attempting timezone math (which it once got wrong: "18h15 → 19h15 GMT+0").
 */
function fmtDakar(iso: string): string {
  return new Date(iso).toLocaleString("fr-FR", {
    timeZone: config.TIMEZONE,
    weekday: "long",
    day: "numeric",
    month: "long",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Hours from now until a timestamp (fractional; negative if past). */
function hoursUntil(ts: Date | string): number {
  return (new Date(ts).getTime() - Date.now()) / 3_600_000;
}

/**
 * A client claims an abonnement that check_membership can't verify (their Wix
 * card probably carries another phone number — real cases: Dieynaba and
 * Rokhaya, 07/2026). The fix is a LINK REQUEST: Awa proposes the email
 * verification (self-service, request_email_verification); if that path dies
 * — no email, not found, wrong codes, or silence >30 min (sweep in index.ts)
 * — the request lands in the /admin/crm one-click queue and reception is
 * notified by linkRequests.notifyLinkNeedsReception.
 */
async function escalateLinkRequest(
  request: Pick<links.LinkRequest, "id" | "client_id" | "reception_notified_at">,
  client: Client,
  detail: string,
): Promise<void> {
  await links.markNeedsReception(request.id, detail);
  await links.notifyLinkNeedsReception(request, client, detail);
}

/**
 * Execute one tool call. Inputs come from the model and are validated
 * server-side (SPEC §9): event_ids must match slots we actually served this
 * client (slot_cache), and amounts always come from the Wix catalog — never
 * from model output.
 */
export async function executeTool(
  client: Client,
  name: string,
  input: Record<string, unknown>,
): Promise<string> {
  switch (name) {
    case "list_classes": {
      const services = await wix.listServices();
      return JSON.stringify(
        services.map((s) => ({
          service_id: s.id,
          name: s.name,
          description: s.description,
          price_fcfa: s.priceXof,
          duration_minutes: s.durationMinutes,
        })),
      );
    }

    case "check_availability": {
      const serviceId = String(input.service_id ?? "");
      const dateFrom = String(input.date_from ?? "");
      const dateTo = String(input.date_to ?? "");
      if (!serviceId || Number.isNaN(Date.parse(dateFrom)) || Number.isNaN(Date.parse(dateTo))) {
        return JSON.stringify({ error: "invalid_arguments" });
      }
      const service = await wix.getService(serviceId);
      if (!service) return JSON.stringify({ error: "unknown_service_id" });

      // Slots whose class already started must never be offered nor cached —
      // a link sold for a started class can only end in a refund.
      const now = Date.now();
      const slots = (await wix.queryAvailability(serviceId, dateFrom, dateTo))
        .filter((s) => Date.parse(s.startDate) > now)
        .slice(0, 30);
      const openSlots = slots.filter((s) => s.openSpots > 0);

      // Server-side slot cache: only event_ids recorded here are accepted by
      // create_payment_link — full slots are deliberately NOT cached, so they
      // can never be turned into a payment link.
      await repo.cacheSlots(
        client.id,
        serviceId,
        openSlots.map((s) => ({ eventId: s.eventId, slot: s.raw })),
      );

      return JSON.stringify({
        service: service.name,
        timezone_note:
          "start_dakar is the class time in Dakar local time — relay it verbatim. NEVER convert timezones or mention GMT/UTC.",
        slots: slots.map((s) => ({
          // Full slots expose their event_id too — join_waitlist needs it. They
          // stay unbookable: only OPEN slots go in slot_cache, and the payment
          // tools re-verify open spots live anyway.
          event_id: s.eventId,
          // Short alias usable as a clickable row id in present_options
          // (event_ids can exceed WhatsApp's 200-char row id limit).
          choice_id: s.openSpots > 0 ? repo.slotChoiceKey(s.eventId) : undefined,
          start: s.startDate,
          start_dakar: fmtDakar(s.startDate),
          duration_minutes: s.endDate
            ? Math.round((Date.parse(s.endDate) - Date.parse(s.startDate)) / 60000)
            : undefined,
          open_spots: s.openSpots,
          full: s.openSpots <= 0 || undefined,
          coach: s.coach ?? undefined,
        })),
        note:
          slots.some((s) => s.openSpots <= 0)
            ? "Slots marked full:true exist but cannot be booked — if the client asked for one of them, say it's " +
              "full and suggest open alternatives; if they still want THAT slot, offer the waitlist (join_waitlist " +
              "with its event_id)."
            : undefined,
      });
    }

    case "create_payment_link": {
      const serviceId = String(input.service_id ?? "");
      const eventId = String(input.event_id ?? "");
      const clientName = String(input.client_name ?? "").slice(0, 80).trim();
      const participants = Math.min(10, Math.max(1, Math.round(Number(input.participants ?? 1)) || 1));
      if (!serviceId || !eventId || !clientName) {
        return JSON.stringify({ error: "invalid_arguments" });
      }

      // 0. Code-before-payment: refuse while an email verification is live,
      //    unless the client explicitly declined it (see verificationBlocksPayment).
      if (input.client_declined_verification !== true) {
        const pending = await links.getOpen(client.id);
        if (verificationBlocksPayment(pending, new Date())) return VERIFICATION_PENDING_RESULT;
      }

      // 1. The event_id must be one we served this client (prompt-injection
      //    stance). Accepts the short choice_id alias too (interactive clicks).
      const cached = await repo.getCachedSlot(client.id, eventId);
      if (!cached || cached.service_id !== serviceId) {
        return JSON.stringify({
          error: "unknown_slot",
          message: "This slot was not offered to the client. Re-run check_availability and pick from its results.",
        });
      }
      const resolvedEventId = cached.event_id;

      // 2. Price comes from the catalog, never from the model.
      const service = await wix.getService(serviceId);
      if (!service) return JSON.stringify({ error: "unknown_service_id" });
      if (!service.priceXof || service.priceXof <= 0) {
        return JSON.stringify({
          error: "no_price",
          message: "This class has no fixed price configured. Hand off to reception.",
        });
      }

      // 2b. Wix rejects a single booking above the service's participants cap
      //     — enforce BEFORE taking money (a 5-spot payment once ended in a
      //     refund because the cap was 3).
      if (participants > service.maxParticipantsPerBooking) {
        return JSON.stringify({
          error: "group_too_large",
          max_participants_per_booking: service.maxParticipantsPerBooking,
          message:
            `This class allows at most ${service.maxParticipantsPerBooking} spot(s) per booking. ` +
            `Offer to book ${service.maxParticipantsPerBooking} now (they can pay and book the rest right after, ` +
            `one booking at a time), or suggest contacting reception for the whole group at once.`,
        });
      }

      // 3. Re-verify the slot still has enough open spots right now.
      const slot = (cached.slot_json as any) ?? {};
      const slotStart: string = slot.startDate ?? String(input.slot_start ?? "");

      // 3a. The cached slot may predate the class start (a client can come
      //     back hours later and ask to "resend the link") — never sell a
      //     slot whose class already started: Wix can no longer book it and
      //     the payment would end in a manual refund.
      if (!slotStart || Date.parse(slotStart) <= Date.now()) {
        return JSON.stringify({
          error: "slot_already_started",
          message:
            "This class has already started — it can no longer be booked. " +
            "Apologize and offer upcoming slots via check_availability.",
        });
      }

      const fresh = await wix.isSlotStillOpen(serviceId, resolvedEventId, slotStart, participants);
      if (!fresh) {
        return JSON.stringify({
          error: "not_enough_spots",
          message:
            participants > 1
              ? `Fewer than ${participants} open spots remain on this slot. Offer a smaller group size or another slot via check_availability.`
              : "This slot just filled up. Apologize and offer alternatives via check_availability.",
        });
      }

      // 4. One active link per client: expire any previous DRAFT/AWAITING_PAYMENT.
      await repo.expireActiveBookings(client.id);
      await repo.updateClientName(client.id, clientName);

      // 5. DRAFT booking → Wave session → AWAITING_PAYMENT. Class only — the
      //    café is never bundled here; it gets its own link after the booking
      //    is confirmed (create_cafe_payment_link).
      const totalXof = service.priceXof * participants;
      const draft = await repo.createDraftBooking({
        clientId: client.id,
        serviceId,
        serviceName: service.name,
        eventId: resolvedEventId,
        slotJson: fresh.raw,
        slotStart: fresh.startDate,
        slotEnd: fresh.endDate ?? null,
        amountXof: totalXof,
        participants,
        extrasJson: null,
        extrasAmountXof: 0,
        orderNote: null,
      });

      let session;
      try {
        session = await wave.createCheckoutSession({
          amountXof: totalXof,
          clientReference: draft.id,
        });
      } catch (err) {
        await repo.expireActiveBookings(client.id); // clean up the DRAFT
        throw err;
      }

      const expiresAt = new Date(Date.now() + config.PAYMENT_LINK_TTL_MINUTES * 60 * 1000);
      await repo.setAwaitingPayment(draft.id, session.id, session.wave_launch_url, expiresAt);

      return JSON.stringify({
        payment_link: session.wave_launch_url,
        amount_fcfa: totalXof,
        class_total_fcfa: totalXof,
        participants,
        price_per_person_fcfa: service.priceXof,
        expires_in_minutes: config.PAYMENT_LINK_TTL_MINUTES,
        class: service.name,
        slot_start: fresh.startDate,
        slot_start_dakar: fmtDakar(fresh.startDate),
        note:
          "Relay the link to the client (class only). Spot(s) confirmed only once paid; confirmation arrives " +
          "automatically on WhatsApp, and the café menu is offered right after that — do NOT bring up the menu now.",
      });
    }

    case "create_cafe_payment_link": {
      const linkedBookingId = String(input.linked_booking_id ?? "").trim();

      // The café preferably rides on one of THIS client's own confirmed,
      // still-upcoming bookings (Wave- OR membership-paid). An explicit id is
      // checked for ownership (same stance as cancel_booking); with no id we
      // default to the class they most recently booked — the Wave flow books
      // server-side, so the model never sees that booking_id. An explicit id
      // that doesn't match is an error; NO booking at all falls back to a
      // standalone counter order (client explicitly ordering from the menu).
      const linked = linkedBookingId
        ? await repo.findClientBooking(client.id, linkedBookingId)
        : await repo.latestUpcomingBooking(client.id);
      const booking =
        linked && linked.status === "BOOKED" && new Date(linked.slot_start).getTime() > Date.now()
          ? linked
          : null;
      if (linkedBookingId && !booking) {
        return JSON.stringify({
          error: "unknown_booking",
          message:
            "No upcoming confirmed booking matches this booking_id for this client — re-run get_my_bookings, " +
            "or omit linked_booking_id (standalone counter order).",
        });
      }

      // Prices come from cafe-menu.md, never from the model.
      const resolved = computeExtras(CAFE_MENU.items, input.extras);
      if (!resolved.ok) {
        return JSON.stringify({
          error: resolved.error,
          message: resolved.message,
          unknown_item_ids: resolved.unknownIds,
          valid_item_ids: resolved.validIds,
        });
      }
      if (resolved.totalXof <= 0) {
        return JSON.stringify({ error: "empty_order", message: "The café order is empty." });
      }
      const orderNote = String(input.order_note ?? "").slice(0, 200).trim() || null;

      // One active café link per client at a time.
      await repo.expireActiveCafeOrders(client.id);
      const draft = await repo.createDraftCafeOrder({
        clientId: client.id,
        linkedBookingId: booking?.id ?? null,
        serviceName: booking?.service_name ?? null,
        slotStart: booking?.slot_start ?? null,
        extrasJson: resolved.lines,
        amountXof: resolved.totalXof,
        orderNote,
      });

      let session;
      try {
        session = await wave.createCheckoutSession({
          amountXof: resolved.totalXof,
          clientReference: draft.id,
        });
      } catch (err) {
        await repo.expireActiveCafeOrders(client.id); // clean up the DRAFT
        throw err;
      }

      const expiresAt = new Date(Date.now() + config.PAYMENT_LINK_TTL_MINUTES * 60 * 1000);
      await repo.setCafeOrderAwaitingPayment(draft.id, session.id, session.wave_launch_url, expiresAt);

      return JSON.stringify({
        payment_link: session.wave_launch_url,
        amount_fcfa: resolved.totalXof,
        extras: resolved.lines.map((l) => ({ item: l.name, qty: l.qty, line_total_fcfa: l.lineTotalXof })),
        order_note: orderNote ?? undefined,
        expires_in_minutes: config.PAYMENT_LINK_TTL_MINUTES,
        for_class: booking?.service_name ?? undefined,
        slot_start_dakar: booking ? fmtDakar(String(booking.slot_start)) : undefined,
        standalone_order: booking ? undefined : true,
        note: booking
          ? "Relay the link — this covers ONLY the café order (the class itself is already booked and paid, " +
            "nothing more to pay for it). State the items and total. Ready after the class unless the note says " +
            "otherwise. Confirmation arrives automatically on WhatsApp once paid."
          : "Relay the link — standalone café order, no class attached. State the items and total, and say the " +
            "order is picked up at the counter (ready as soon as possible unless the note says otherwise). " +
            "Confirmation arrives automatically on WhatsApp once paid.",
      });
    }

    case "list_plans": {
      const plans = await wix.listPlans();
      return JSON.stringify(
        await Promise.all(
          plans.map(async (p) => {
            const covers = await wix.planCoveredClassNames(p.id);
            return {
              plan_id: p.id,
              name: p.name,
              description: p.description || undefined,
              price_fcfa: p.priceXof,
              billing: p.billing,
              period: p.periodLabel ?? undefined,
              covers_classes:
                covers === null ? "unknown — coverage is verified at booking time" : covers,
              billing_note:
                p.billing === "recurring"
                  ? `Renouvelé chaque ${p.periodLabel ?? "période"} — via Awa le paiement couvre la première période, le renouvellement se gère avec le studio.`
                  : undefined,
            };
          }),
        ),
      );
    }

    case "create_plan_payment_link": {
      const planId = String(input.plan_id ?? "");
      const clientName = String(input.client_name ?? "").slice(0, 80).trim();
      if (!planId || !clientName) return JSON.stringify({ error: "invalid_arguments" });

      // Code-before-payment: don't sell a plan while an email verification is
      // live — the client may already own a plan under another number.
      if (input.client_declined_verification !== true) {
        const pending = await links.getOpen(client.id);
        if (verificationBlocksPayment(pending, new Date())) return VERIFICATION_PENDING_RESULT;
      }

      // Price and existence come from the Wix catalog — never from the model.
      const plan = await wix.getPlan(planId);
      if (!plan) return JSON.stringify({ error: "unknown_plan_id", message: "Re-run list_plans and pick a plan_id from it." });

      await repo.updateClientName(client.id, clientName);
      const phone = `+${client.wa_phone.replace(/^\+/, "")}`;

      // Member resolution decides auto vs manual activation after payment —
      // resolved NOW and stored, so the webhook path stays fast and simple.
      const memberId = await wix.resolveMemberIdForPlan(phone, clientName || client.name || undefined);

      // One active plan link per client.
      await repo.expireActivePlanOrders(client.id);
      const draft = await repo.createDraftPlanOrder({
        clientId: client.id,
        planId,
        planName: plan.name,
        amountXof: plan.priceXof,
        memberId,
      });

      let session;
      try {
        session = await wave.createCheckoutSession({
          amountXof: plan.priceXof,
          clientReference: draft.id,
        });
      } catch (err) {
        await repo.expireActivePlanOrders(client.id);
        throw err;
      }

      const expiresAt = new Date(Date.now() + config.PAYMENT_LINK_TTL_MINUTES * 60 * 1000);
      await repo.setPlanOrderAwaitingPayment(draft.id, session.id, session.wave_launch_url, expiresAt);

      return JSON.stringify({
        payment_link: session.wave_launch_url,
        amount_fcfa: plan.priceXof,
        plan: plan.name,
        billing: plan.billing,
        period: plan.periodLabel ?? undefined,
        expires_in_minutes: config.PAYMENT_LINK_TTL_MINUTES,
        note:
          "Relay the link. The plan is confirmed only once paid; the client gets an automatic WhatsApp " +
          "confirmation after payment." +
          (plan.billing === "recurring"
            ? " Recurring plan: this payment covers the FIRST period; renewals are handled with the studio — say so."
            : ""),
      });
    }

    case "check_membership": {
      const claim = input.claim === true;
      // Identity = verified WhatsApp number → unambiguous CRM contact.
      const contactId = await wix.findContactIdByPhone(
        `+${client.wa_phone.replace(/^\+/, "")}`,
        client.name ?? undefined,
      );
      if (!contactId) {
        if (claim) await links.getOrOpen(client.id); // silence >30 min → reception (sweep)
        return JSON.stringify({
          verified: false,
          reason: "no_matching_contact",
          message:
            "Could not match this WhatsApp number to a unique client account. The client may have an " +
            "abonnement under another number." +
            (claim
              ? " PROPOSE the email verification NOW: ask for the email of their Revive account, then " +
                "call request_email_verification — a code sent to that inbox links this number " +
                "automatically, in this conversation. If they have no email or no access to it, call " +
                "request_email_verification with client_has_no_email:true (reception takes over — they " +
                "do NOT need to call). Meanwhile offer normal Wave payment for bookings that can't wait."
              : " Hand off to reception to verify, or offer normal Wave payment."),
        });
      }
      const memberships = await wix.listActiveMemberships(contactId);
      if (memberships.length === 0) {
        if (claim) await links.getOrOpen(client.id); // silence >30 min → reception (sweep)
        return JSON.stringify({
          verified: true,
          active_plans: [],
          message:
            "No active abonnement for this client." +
            (claim
              ? " The client claims one — it is probably on ANOTHER fiche (registered under a different " +
                "number or email). PROPOSE the email verification NOW: ask for the email of their Revive " +
                "account, then call request_email_verification. If they have no email or no access, call " +
                "request_email_verification with client_has_no_email:true (reception takes over — they do " +
                "NOT need to call). Meanwhile offer normal Wave payment for bookings that can't wait."
              : " Use the normal Wave payment flow."),
        });
      }
      const activePlans = await Promise.all(
        memberships.map(async (m) => {
          const covers = await wix.planCoveredClassNames(m.planId);
          const remaining = await wix.planRemainingSessions(contactId, m.planId, m.planName);
          return {
            plan: m.planName,
            expires: m.expiresAt,
            covers_classes:
              covers === null ? "unknown — coverage is verified at booking time" : covers,
            remaining_sessions:
              remaining === null ? "unknown — verified by Wix at booking time" : remaining,
          };
        }),
      );
      return JSON.stringify({
        verified: true,
        active_plans: activePlans,
        note:
          "Only propose book_with_membership for classes in covers_classes — for other classes, " +
          "say the plan doesn't cover them and offer normal Wave payment. remaining_sessions is " +
          "the current balance — a number can be relayed to the client as of right now; " +
          "'unknown' means say the balance is checked at booking time, NEVER guess a number.",
      });
    }

    case "book_with_membership": {
      const serviceId = String(input.service_id ?? "");
      const eventId = String(input.event_id ?? "");
      const clientName = String(input.client_name ?? "").slice(0, 80).trim();
      const participants = Math.min(10, Math.max(1, Math.round(Number(input.participants ?? 1)) || 1));
      if (!serviceId || !eventId || !clientName) {
        return JSON.stringify({ error: "invalid_arguments" });
      }

      // Same server-side validations as the Wave flow (choice_id accepted too).
      const cached = await repo.getCachedSlot(client.id, eventId);
      if (!cached || cached.service_id !== serviceId) {
        return JSON.stringify({
          error: "unknown_slot",
          message: "This slot was not offered to the client. Re-run check_availability first.",
        });
      }
      const resolvedEventId = cached.event_id;
      const service = await wix.getService(serviceId);
      if (!service) return JSON.stringify({ error: "unknown_service_id" });

      // Wix rejects a single booking above the service's per-booking cap — same
      // guard as the Wave group flow, enforced BEFORE deducting any session.
      if (participants > service.maxParticipantsPerBooking) {
        return JSON.stringify({
          error: "group_too_large",
          max_participants_per_booking: service.maxParticipantsPerBooking,
          message:
            `This class allows at most ${service.maxParticipantsPerBooking} spot(s) per booking. ` +
            `Offer to book ${service.maxParticipantsPerBooking} on the plan now, or contact reception for a larger group.`,
        });
      }

      const slot = (cached.slot_json as any) ?? {};
      const slotStart: string = slot.startDate ?? String(input.slot_start ?? "");
      const fresh = await wix.isSlotStillOpen(serviceId, resolvedEventId, slotStart, participants);
      if (!fresh) {
        return JSON.stringify({
          error: "slot_full",
          message:
            participants > 1
              ? `Fewer than ${participants} open spots remain on this slot. Offer a smaller group or another slot via check_availability.`
              : "This slot just filled up. Offer alternatives via check_availability.",
        });
      }

      await repo.updateClientName(client.id, clientName);
      const phone = `+${client.wa_phone.replace(/^\+/, "")}`;

      // 1. Identify the contact and check plan eligibility BEFORE creating
      //    anything in Wix — a "no" costs nothing and leaves no orphan booking.
      const contactId = await wix.findContactIdByPhone(phone, clientName || client.name || undefined);
      if (!contactId) {
        return JSON.stringify({
          error: "no_matching_contact",
          message:
            "Could not match this WhatsApp number to a unique client account, so the abonnement " +
            "cannot be verified. Offer normal Wave payment, or reception to link their account.",
        });
      }
      const benefit = await wix.findEligibleBenefit(serviceId, contactId);
      if (!benefit) {
        return JSON.stringify({
          error: "not_eligible",
          message:
            "The client's abonnement does not cover this class (or has no sessions left this period). " +
            "Explain this kindly and offer the normal Wave payment, or reception for questions about their plan.",
        });
      }

      // All-or-nothing for groups: the plan must have enough sessions to cover
      // EVERY spot — never book part of a group on the plan. If it can't, offer
      // Wave for the whole group instead.
      if (participants > benefit.available) {
        return JSON.stringify({
          error: "not_enough_sessions",
          remaining_sessions: benefit.available,
          requested: participants,
          message:
            `The client's abonnement has only ${benefit.available} session(s) left — not enough for ${participants} ` +
            `people. Do NOT book part of the group on the plan. Offer to pay for the whole group via the normal Wave ` +
            `payment (create_payment_link with participants=${participants}), or a smaller group that fits the balance.`,
        });
      }

      // 2. Booking (CREATED) → 3. deduct one credit per spot → 4. confirm in calendar.
      const wixBookingId = await wix.createBookingRaw({
        slot: fresh.raw,
        name: clientName,
        phone,
        participants,
        paymentOption: "MEMBERSHIP",
      });

      try {
        const redemption = await wix.redeemMembershipForBooking({
          wixBookingId,
          serviceId,
          benefit,
          count: participants,
        });
        try {
          await wix.confirmBookingPaid(wixBookingId);
        } catch (err) {
          // Credit already deducted and booking exists — reception can confirm
          // manually; do not fail the client's booking over calendar status.
          console.error(`Membership booking ${wixBookingId} confirmed with plan but calendar confirm failed:`, err);
          notifyReception(
            "⚠️ Résa abonnement à confirmer manuellement",
            `La séance a été décomptée de l'abonnement "${redemption.membershipName}" mais la ` +
              `confirmation calendrier a échoué.\n  Booking Wix : ${wixBookingId}\n  Client : ${clientName} (${phone})\n` +
              `À faire : confirmer la réservation dans le dashboard Wix.`,
          );
        }
        const membershipBooking = await repo.createMembershipBooking({
          clientId: client.id,
          serviceId,
          serviceName: service.name,
          eventId: resolvedEventId,
          slotJson: fresh.raw,
          slotStart: fresh.startDate,
          slotEnd: fresh.endDate ?? null,
          wixBookingId,
          benefitTransactionId: redemption.transactionId || null,
          participants,
        });
        // Sessions were just deducted — the cached balance is stale.
        invalidateMembershipCache(client.id);
        return JSON.stringify({
          booked: true,
          booking_id: membershipBooking.id,
          paid_with: redemption.membershipName,
          participants,
          sessions_deducted: participants,
          remaining_sessions: Math.max(0, benefit.available - participants),
          class: service.name,
          slot_start: fresh.startDate,
          slot_start_dakar: fmtDakar(fresh.startDate),
          note:
            (participants > 1
              ? `Booked and confirmed ${participants} spots using the client's abonnement (${participants} sessions deducted). `
              : "Booked and confirmed using the client's abonnement (one session deducted). ") +
            "Confirm to the client with class, date/time, how many spots and that it used their plan (mention remaining_sessions), " +
            "and remind them cancellation is free up to 16h before the class (after that the session is due) — no payment needed. " +
            "Do NOT mention or propose the café menu in your confirmation: the system automatically shows the " +
            "menu list right after your message. When the client then picks an item, use create_cafe_payment_link " +
            "with this booking_id.",
        });
      } catch (err) {
        const notEligible = err instanceof Error && err.message === "not_eligible";
        console.error(`Membership redemption failed for booking ${wixBookingId}:`, err);
        // Cleanup: don't leave an orphan CREATED booking behind.
        try {
          await wix.declineBooking(wixBookingId);
        } catch (cleanupErr) {
          console.error(`Failed to decline orphan booking ${wixBookingId}:`, cleanupErr);
        }
        return JSON.stringify({
          error: notEligible ? "not_eligible" : "membership_booking_failed",
          message: notEligible
            ? "The client's abonnement does not cover this class (or has no sessions left this period). " +
              "Explain this kindly and offer the normal Wave payment, or reception for questions about their plan."
            : "Technical problem while using the abonnement. Offer the Wave payment flow or reception.",
        });
      }
    }

    case "get_my_bookings": {
      let bookings = await repo.upcomingBooked(client.id);

      // Live-sync with Wix: bookings cancelled by reception in the Wix
      // dashboard must not be shown as confirmed here.
      const wixIds = bookings.map((b) => b.wix_booking_id).filter((x): x is string => !!x);
      if (wixIds.length > 0) {
        try {
          const statuses = await wix.getBookingStatuses(wixIds);
          const cancelledIds = new Set(
            Object.entries(statuses)
              .filter(([, s]) => s === "CANCELED" || s === "DECLINED")
              .map(([id]) => id),
          );
          for (const b of bookings) {
            if (b.wix_booking_id && cancelledIds.has(b.wix_booking_id)) {
              await repo.markCancelled(b.id);
            }
          }
          bookings = bookings.filter(
            (b) => !(b.wix_booking_id && cancelledIds.has(b.wix_booking_id)),
          );
        } catch (err) {
          console.error("Wix booking status sync failed (showing local state):", err);
        }
      }

      const own = bookings.map((b) => ({
        booking_id: b.id,
        class: b.service_name,
        start: b.slot_start,
        start_dakar: fmtDakar(String(b.slot_start)),
        participants: b.participants,
        paid_with: b.payment_method === "membership" ? "abonnement" : "wave",
        booked_via: "awa",
        status: "confirmed",
        cancellable_free_of_charge: hoursUntil(b.slot_start) >= 16 || undefined,
        cafe_order:
          b.extras_amount_xof > 0
            ? {
                items: formatExtrasOneLine(extrasFromJson(b.extras_json)),
                total_fcfa: b.extras_amount_xof,
                note: b.order_note ?? "prête après le cours",
              }
            : undefined,
      }));

      // Also surface bookings the client made at the counter or on the Wix
      // website (identified by their WhatsApp number → CRM contact). Awa can
      // cancel these too (16h rule) via the "studio:" booking_id — but she has
      // no local payment context, so any refund/re-credit goes through
      // reception. Dedupe against the Wix ids Awa already created.
      const external: unknown[] = [];
      // Track whether this number resolves to a unique Wix contact. When it
      // does NOT and we found nothing to show, the client may well have an
      // account (and its bookings) under another number → surface a hint so
      // Awa can propose email linking instead of a bare "not found". null =
      // lookup failed (unknown), don't assert either way.
      let contactMatched: boolean | null = null;
      try {
        const contactId = await wix.findContactIdByPhone(
          `+${client.wa_phone.replace(/^\+/, "")}`,
          client.name ?? undefined,
        );
        contactMatched = contactId !== null;
        if (contactId) {
          const ownWixIds = new Set(
            bookings.map((b) => b.wix_booking_id).filter((x): x is string => !!x),
          );
          const wixBookings = await wix.listContactUpcomingBookings(contactId);
          for (const wb of wixBookings) {
            if (ownWixIds.has(wb.id)) continue; // already in `own`
            external.push({
              booking_id: `studio:${wb.id}`,
              class: wb.serviceName,
              start: wb.startDate,
              start_dakar: fmtDakar(wb.startDate),
              participants: wb.participants,
              booked_via: "studio", // counter or website
              status: "confirmed",
            });
          }
        }
      } catch (err) {
        console.error("Wix contact bookings lookup failed (showing Awa bookings only):", err);
      }

      return JSON.stringify({
        bookings: [...own, ...external],
        note:
          external.length > 0
            ? "booked_via 'studio' bookings were made at the counter/website. cancel_booking works on them " +
              "(same 16h rule) via their studio: booking_id, but Awa does not know how they were paid — after " +
              "cancelling, any refund or session re-credit is handled by reception (the client contacts them; " +
              "reception is also notified automatically)."
            : undefined,
        // No bookings AND this number is on no Wix account: their account (and
        // its bookings/abonnement) may be under another number. Invite linking
        // by email rather than a flat "not found".
        account_note:
          own.length === 0 && external.length === 0 && contactMatched === false
            ? "This WhatsApp number matches no Revive account, so any account this client already has is under a " +
              "different number. If they believe they have a booking or an abonnement, invite them to link their " +
              "account by email (request_email_verification) — otherwise just say the slot isn't booked and offer to book it."
            : undefined,
      });
    }

    case "cancel_booking": {
      const bookingId = String(input.booking_id ?? "");
      if (!bookingId) return JSON.stringify({ error: "invalid_arguments" });

      // Bookings made at the counter/website ("studio:<wix id>" from
      // get_my_bookings): Awa can cancel them in Wix (same 16h rule), but she
      // has no payment context (cash? OM? plan via the site?), so the money
      // side is ALWAYS reception's — client is told to contact them, reception
      // gets an email to check refund/re-credit.
      if (bookingId.startsWith("studio:")) {
        const wixId = bookingId.slice("studio:".length);
        // Ownership check server-side: the id must be among THIS client's own
        // upcoming Wix bookings (re-fetched live — never trust the model's id).
        const contactId = await wix.findContactIdByPhone(
          `+${client.wa_phone.replace(/^\+/, "")}`,
          client.name ?? undefined,
        );
        const theirs = contactId ? await wix.listContactUpcomingBookings(contactId) : [];
        const wb = theirs.find((b) => b.id === wixId);
        if (!wb) {
          return JSON.stringify({
            error: "unknown_booking",
            message: "No such upcoming studio booking for this client. Re-run get_my_bookings.",
          });
        }
        const hoursLeftStudio = hoursUntil(wb.startDate);
        if (hoursLeftStudio < 16) {
          return JSON.stringify({
            error: "too_late_16h_policy",
            hours_before_class: Math.max(0, Math.round(hoursLeftStudio * 10) / 10),
            message:
              "Cancellation refused: less than 16 hours before the class, the session is due (studio policy). " +
              "Politely explain the 16h rule and say that for exceptional situations they can contact reception. " +
              "Do NOT suggest examples of valid excuses.",
          });
        }
        await wix.cancelBooking(wixId);
        notifyReception(
          "ℹ️ Annulation d'une résa studio via Awa — vérifier remboursement/re-crédit",
          `Awa a annulé (≥ 16h avant le cours) une réservation prise au comptoir ou sur le site :\n` +
            `  Client : ${client.name ?? "?"} (+${client.wa_phone.replace(/^\+/, "")})\n` +
            `  Cours : ${wb.serviceName} — ${fmtDakar(wb.startDate)} (${wb.participants} place(s))\n` +
            `  Booking Wix : ${wixId}\n\n` +
            `Awa ne connaît pas le mode de paiement de cette résa : vérifier dans Wix s'il y a un ` +
            `remboursement ou un re-crédit de séance à faire. Le client a été invité à vous contacter.`,
        );
        return JSON.stringify({
          cancelled: true,
          class: wb.serviceName,
          slot_start_dakar: fmtDakar(wb.startDate),
          booked_via: "studio",
          reception_whatsapp: config.RECEPTION_PHONE,
          note:
            "Cancelled in Wix. This booking was made at the counter/website, so Awa does not know how it was " +
            "paid: tell the client the cancellation is done and that for any refund or session re-credit they " +
            "should CONTACT RECEPTION (give this number) — reception has also been notified. Do not promise " +
            "a refund amount, a re-credit, or a delay.",
        });
      }

      // The booking must belong to THIS client (never trust a model-provided
      // id beyond that check) and still be upcoming + confirmed.
      const booking = await repo.findClientBooking(client.id, bookingId);
      if (!booking || booking.status !== "BOOKED" || !booking.wix_booking_id) {
        return JSON.stringify({
          error: "unknown_booking",
          message: "No such upcoming confirmed booking for this client. Re-run get_my_bookings.",
        });
      }

      // 16h policy — enforced server-side, never left to the model.
      const hoursLeft = hoursUntil(booking.slot_start);
      if (hoursLeft < 16) {
        return JSON.stringify({
          error: "too_late_16h_policy",
          hours_before_class: Math.max(0, Math.round(hoursLeft * 10) / 10),
          message:
            "Cancellation refused: less than 16 hours before the class, the session is due (studio policy). " +
            "Politely explain the 16h rule and say that for exceptional situations they can contact reception. " +
            "Do NOT suggest examples of valid excuses.",
        });
      }

      // Cancel in Wix first — if that fails, nothing changed anywhere.
      await wix.cancelBooking(booking.wix_booking_id);

      if (booking.payment_method === "membership") {
        // Re-credit the plan session, then close the row.
        let recredited = false;
        if (booking.benefit_transaction_id) {
          try {
            await wix.revertBenefitTransaction(booking.benefit_transaction_id);
            recredited = true;
          } catch (err) {
            console.error(`Re-credit failed for booking ${bookingId}:`, err);
          }
        }
        if (!recredited) {
          notifyReception(
            "⚠️ Séance(s) d'abonnement à re-créditer manuellement",
            `Awa a annulé une réservation payée par abonnement mais n'a pas pu re-créditer ` +
              `automatiquement.\n  Client : ${client.name ?? "?"} (+${client.wa_phone.replace(/^\+/, "")})\n` +
              `  Cours : ${booking.service_name} — ${fmtDakar(String(booking.slot_start))}\n` +
              `  Séance(s) à re-créditer : ${booking.participants}\n` +
              `  Booking Wix : ${booking.wix_booking_id}\n\n` +
              `À faire : re-créditer ${booking.participants} séance(s) sur le plan du client dans le dashboard Wix.`,
          );
        }
        await repo.markCancelled(bookingId);
        // The re-credit (or pending manual one) changed the plan balance.
        invalidateMembershipCache(client.id);
        return JSON.stringify({
          cancelled: true,
          class: booking.service_name,
          slot_start_dakar: fmtDakar(String(booking.slot_start)),
          session_recredited: recredited,
          sessions_recredited: recredited ? booking.participants : 0,
          note: recredited
            ? (booking.participants > 1
                ? `Cancelled; all ${booking.participants} plan sessions were re-credited automatically. Tell the client.`
                : "Cancelled; the plan session was re-credited automatically. Tell the client.")
            : "Cancelled; the plan session(s) will be re-credited by the reception team (already notified). Tell the client.",
        });
      }

      // Wave-paid: refund is owed — reception processes it manually.
      await repo.markRefundNeeded(bookingId);
      notifyReception(
        `💸 REMBOURSEMENT à faire (annulation client) — ${booking.amount_xof} FCFA`,
        `Un client a annulé via Awa (≥ 16h avant le cours) — remboursement à traiter dans le portail Wave :\n` +
          `  Client : ${client.name ?? "?"} (+${client.wa_phone.replace(/^\+/, "")})\n` +
          `  Cours : ${booking.service_name} — ${fmtDakar(String(booking.slot_start))}\n` +
          `  Montant : ${booking.amount_xof} FCFA (${booking.participants} place(s))\n` +
          (booking.extras_amount_xof > 0
            ? `  Dont commande café : ${booking.extras_amount_xof} FCFA (${formatExtrasOneLine(
                extrasFromJson(booking.extras_json),
              )}) — vérifier qu'elle n'a pas déjà été servie.\n`
            : "") +
          `  Session Wave : ${booking.wave_session_id ?? "?"}\n` +
          `  Booking id : ${bookingId}\n\n` +
          `Après remboursement dans le portail Wave, clôturer avec :\n` +
          `  npm run refund:done -- ${bookingId}`,
      );
      return JSON.stringify({
        cancelled: true,
        class: booking.service_name,
        slot_start_dakar: fmtDakar(String(booking.slot_start)),
        refund: "client_contacts_reception",
        reception_whatsapp: config.RECEPTION_PHONE,
        amount_fcfa: booking.amount_xof,
        cafe_order_refund_note:
          booking.extras_amount_xof > 0
            ? `The refund total includes their café order (${booking.extras_amount_xof} FCFA) — mention it.`
            : undefined,
        note:
          "Cancelled. Tell the client to CONTACT RECEPTION themselves (give this number) to arrange " +
          "the refund — do not say reception will contact them, and do not promise a delay.",
      });
    }

    case "join_waitlist": {
      const serviceId = String(input.service_id ?? "");
      const eventId = String(input.event_id ?? "");
      const slotStart = String(input.slot_start ?? "");
      if (!serviceId || !eventId || Number.isNaN(Date.parse(slotStart))) {
        return JSON.stringify({ error: "invalid_arguments" });
      }
      const service = await wix.getService(serviceId);
      if (!service) return JSON.stringify({ error: "unknown_service_id" });

      // Server-authoritative: the slot must exist in Wix right now. The model
      // can't invent waitlist entries for slots it was never shown either —
      // the event_id has to match a real session of that service.
      const slot = await wix.findSlot(serviceId, eventId, slotStart);
      if (!slot) {
        return JSON.stringify({
          error: "unknown_slot",
          message: "No such slot in Wix. Re-run check_availability and use a full slot's event_id.",
        });
      }
      if (Date.parse(slot.startDate) <= Date.now()) {
        return JSON.stringify({ error: "slot_already_started" });
      }
      if (slot.openSpots > 0) {
        return JSON.stringify({
          slot_open: true,
          open_spots: slot.openSpots,
          message:
            "This slot has open spots right now — no waitlist needed. Book it normally " +
            "(re-run check_availability, then payment link or membership).",
        });
      }
      const { already } = await repo.joinWaitlist({
        clientId: client.id,
        serviceId,
        serviceName: service.name,
        eventId,
        slotStart: slot.startDate,
      });
      return JSON.stringify({
        joined: true,
        already_on_waitlist: already || undefined,
        class: service.name,
        slot_start_dakar: fmtDakar(slot.startDate),
        note:
          "Tell the client: they'll get ONE WhatsApp message here if a spot frees up — no spot is held " +
          "(first come, first served) and no guarantee one will free. They can ask to be removed anytime.",
      });
    }

    case "leave_waitlist": {
      const serviceId = String(input.service_id ?? "").trim() || undefined;
      const removed = await repo.leaveWaitlist(client.id, serviceId);
      return JSON.stringify({
        removed,
        note:
          removed > 0
            ? "Confirm to the client they're off the waitlist."
            : "The client had no pending waitlist entry (maybe it already expired) — reassure them.",
      });
    }

    case "request_email_verification": {
      const request = await links.getOrOpen(client.id);
      if (input.client_has_no_email === true) {
        const detail = "le client n'a pas d'email (ou n'y a pas accès)";
        await escalateLinkRequest(request, client, detail);
        return JSON.stringify({
          status: "reception_notified",
          message:
            "Reception has been notified and will link the account from the dashboard — tell the client " +
            "the team is on it (no need to call). Offer normal Wave payment for bookings that can't wait.",
        });
      }
      const email = String(input.email ?? "").trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) || email.length > 254) {
        return JSON.stringify({
          error: "invalid_email",
          message: "This doesn't look like a valid email — ask the client to re-send it.",
        });
      }
      if (!links.canSendCode(request)) {
        return JSON.stringify({
          status: "too_many_requests",
          message:
            "Verification-email limit reached for today (anti-abuse). Tell the client to try again " +
            "tomorrow, or offer reception / normal Wave payment meanwhile.",
        });
      }
      await repo.saveClaimedEmail(client.id, email); // surfaces in the daily summary
      let candidate: wix.EmailCandidate;
      try {
        const contacts = await wix.findContactsByEmail(email);
        const planHolderIds = new Set<string>(
          (await wix.listAllActiveOrders())
            .map((o: any) => o?.buyer?.contactId)
            .filter(Boolean),
        );
        candidate = wix.resolveEmailCandidate(contacts, planHolderIds, client.wa_phone);
      } catch (err) {
        console.error("Email-candidate lookup failed:", err);
        await escalateLinkRequest(request, client, `recherche Wix en erreur (email ${email})`);
        return JSON.stringify({
          status: "lookup_failed",
          message:
            "Technical hiccup while checking this email — reception has been notified and will link the " +
            "account manually. Tell the client the team is on it (no need to call).",
        });
      }
      switch (candidate.kind) {
        case "already_linked":
          invalidateMembershipCache(client.id);
          return JSON.stringify({
            status: "already_linked",
            message:
              "The account carrying this email ALREADY has this WhatsApp number — no verification " +
              "needed. Run check_membership again to see their plans.",
          });
        case "none":
          await escalateLinkRequest(request, client, `aucune fiche Wix ne porte l'email déclaré (${email})`);
          return JSON.stringify({
            status: "email_not_found",
            message:
              "No Revive account carries this email. Reception has been notified and will link the " +
              "account manually — tell the client the team is on it (no need to call). They can also " +
              "re-try with another email address. Offer normal Wave payment for bookings that can't wait.",
          });
        case "ambiguous":
          await escalateLinkRequest(
            request,
            client,
            `email partagé par ${candidate.count} fiches Wix (${email}) — choix humain requis`,
          );
          return JSON.stringify({
            status: "needs_reception",
            message:
              "Several Revive accounts share this email — a human has to pick the right one. Reception " +
              "has been notified and will link the account — tell the client the team is on it (no need " +
              "to call). Offer normal Wave payment for bookings that can't wait.",
          });
        case "one": {
          const code = links.generateCode();
          await links.setAwaitingCode(request.id, email, candidate.contact.id, links.hashCode(code, request.id));
          try {
            await sendVerificationCodeEmail(email, code);
          } catch (err) {
            console.error("Verification-code email failed:", err);
            await escalateLinkRequest(request, client, `envoi du code impossible (email ${email})`);
            return JSON.stringify({
              status: "send_failed",
              message:
                "The verification email could not be sent — reception has been notified and will link " +
                "the account manually. Tell the client the team is on it (no need to call).",
            });
          }
          return JSON.stringify({
            status: "code_sent",
            expires_in_minutes: links.CODE_TTL_MINUTES,
            message:
              "A 6-digit code was just emailed to that address. Ask the client to read it in their inbox " +
              "(spam folder too) and type it HERE — then call submit_verification_code. The code is valid " +
              `${links.CODE_TTL_MINUTES} minutes. You do NOT know the code and can never confirm or ` +
              "repeat it — it only exists in the client's inbox.",
          });
        }
      }
      break;
    }

    case "submit_verification_code": {
      const code = String(input.code ?? "").trim();
      const request = await links.getOpen(client.id);
      if (!request || request.status !== "AWAITING_CODE" || !request.code_hash) {
        return JSON.stringify({
          status: "no_pending_verification",
          message:
            "No verification is in progress for this client — start one with " +
            "request_email_verification (ask for their account email first).",
        });
      }
      if (!links.looksLikeCode(code)) {
        return JSON.stringify({
          status: "wrong_format",
          message: "The code is exactly 6 digits — ask the client to re-send just the code.",
        });
      }
      if (request.code_expires_at && new Date(request.code_expires_at) < new Date()) {
        return JSON.stringify({
          status: "expired",
          can_resend: true,
          message:
            `This code expired (${links.CODE_TTL_MINUTES} min). Offer to send a fresh one with ` +
            "request_email_verification (same email).",
        });
      }
      if (!links.verifyCode(code, request.id, request.code_hash)) {
        const attempts = await links.registerFailedAttempt(request.id);
        if (attempts >= links.MAX_CODE_ATTEMPTS) {
          await escalateLinkRequest(request, client, `${attempts} codes erronés — vérification bloquée`);
          return JSON.stringify({
            status: "too_many_attempts",
            message:
              "Too many wrong codes — this verification is closed (anti-abuse). Reception has been " +
              "notified and will link the account manually; tell the client the team is on it.",
          });
        }
        return JSON.stringify({
          status: "wrong_code",
          attempts_left: links.MAX_CODE_ATTEMPTS - attempts,
          message: "Wrong code. Ask the client to double-check the LATEST email and try again.",
        });
      }
      const wa = `+${client.wa_phone.replace(/^\+/, "")}`;
      try {
        await wix.addPhoneToContact(request.wix_contact_id!, wa);
      } catch (err) {
        console.error("addPhoneToContact failed after verified code:", err);
        await escalateLinkRequest(request, client, "code vérifié mais écriture Wix en échec");
        return JSON.stringify({
          status: "link_failed",
          message:
            "The code was right but the account update failed — reception has been notified and will " +
            "finish the linking manually. Tell the client the team is on it (no need to call).",
        });
      }
      await links.markVerified(request.id, request.wix_contact_id!);
      invalidateMembershipCache(client.id);

      // Post-verification duplicate handling. The number was JUST added to the
      // proven fiche, so we list ALL fiches carrying it (not the "unique-or-
      // null" collapse of findContactIdByPhone — that returns null both when
      // the Wix search index simply lags the write we just made, AND when a
      // real second fiche exists; conflating them produced a FALSE
      // "verified_pending_merge", cf. the 340 ms race seen 11/07).
      const provenId = request.wix_contact_id!;
      const allFiches = await wix.findContactsByPhone(wa);
      const otherIds = allFiches
        .map((c: any) => c.id as string)
        .filter((id) => id && id !== provenId);

      if (otherIds.length > 0) {
        // A genuine second fiche (typically created by a past Wave payment).
        // Auto-merge it into the proven fiche when safe: never merge a fiche
        // that is itself a member or holds an active plan as a source.
        try {
          const [memberIds, planHolders] = await Promise.all([
            wix.findMemberContactIds(otherIds),
            (async () => {
              const holders = new Set<string>();
              for (const id of otherIds) {
                const plans = await wix.listActiveMemberships(id);
                if (plans.length > 0) holders.add(id);
              }
              return holders;
            })(),
          ]);
          const plan = planVerifiedMerge(provenId, otherIds, planHolders, memberIds);
          if (plan) {
            await wix.mergeContacts(plan.targetId, plan.sourceIds);
            invalidateMembershipCache(client.id);
            if (plan.leftoverIds.length > 0) {
              // Some fiches couldn't be absorbed (member/plan holder) — escalate
              // just those, but the mergeable ones are already cleaned up.
              notifyReception(
                "🔀 Compte relié — fiche(s) protégée(s) restantes",
                `Le client ${client.name ?? "?"} (${wa}) a prouvé son compte (fiche ${provenId}). ` +
                  `J'ai fusionné automatiquement ${plan.sourceIds.length} doublon(s), mais ` +
                  `${plan.leftoverIds.length} fiche(s) protégée(s) (compte membre / abonnement) subsiste(nt) : ` +
                  `${plan.leftoverIds.join(", ")}.\n\nVérifier dans ${config.BASE_URL}/admin/crm → « Doublons ».`,
              );
            }
          } else {
            // Nothing safe to merge (the other fiche is a member/plan holder) —
            // fall back to the reception one-click path.
            notifyReception(
              "🔀 Compte vérifié par email — fusion de doublons requise",
              `Le client ${client.name ?? "?"} (${wa}) a PROUVÉ (code email) que son compte est la fiche ` +
                `${provenId}, mais son numéro figure aussi sur une autre fiche protégée ` +
                `(compte membre / abonnement) : ${otherIds.join(", ")}.\n\n` +
                `À faire (1 clic) : ${config.BASE_URL}/admin/crm → section « Doublons ».`,
            );
            return JSON.stringify({
              status: "verified_pending_merge",
              message:
                "Code correct — the account is verified. Another fiche on this number can't be auto-merged " +
                "(member/plan holder), so their plan may show only after the team merges — reception was " +
                "notified. Tell the client it's verified and the team finishes shortly (no need to call); " +
                "offer normal Wave payment for bookings that truly can't wait.",
            });
          }
        } catch (err) {
          console.error("Auto-merge after verification failed:", err);
          notifyReception(
            "🔀 Compte vérifié — auto-fusion en échec",
            `Le client ${client.name ?? "?"} (${wa}) a prouvé son compte (fiche ${provenId}) mais ` +
              `l'auto-fusion des doublons a échoué. À faire (1 clic) : ${config.BASE_URL}/admin/crm → « Doublons ».`,
          );
          return JSON.stringify({
            status: "verified_pending_merge",
            message:
              "Code correct — the account is verified, but merging a duplicate fiche failed; reception was " +
              "notified. Tell the client it's verified and the team finishes shortly (no need to call); offer " +
              "normal Wave payment for bookings that truly can't wait.",
          });
        }
      }

      const memberships = await wix.listActiveMemberships(request.wix_contact_id!);
      return JSON.stringify({
        status: "verified",
        active_plans: memberships.map((m) => ({ plan: m.planName, expires: m.expiresAt })),
        message:
          "Account linked! You CAN now tell the client their account is connected to this WhatsApp " +
          "number. Their active plans are listed above (details/balance via check_membership) — offer " +
          "to book their next class right away, on the plan when it covers the class.",
      });
    }

    case "handoff_to_human": {
      const reason = String(input.reason ?? "unspecified").slice(0, 500);
      await repo.recordHandoff(client.id, reason);
      notifyReception(
        `🙋🏾 Handoff client — ${reason.slice(0, 60)}`,
        `Un client a besoin de la réception :\n` +
          `  Client : ${client.name ?? "?"} (+${client.wa_phone.replace(/^\+/, "")})\n` +
          `  Motif : ${reason}\n\n` +
          `Awa lui a donné le numéro de la réception — il va probablement écrire ou appeler.\n` +
          `Extrait de la conversation dans le registre handoffs (npm run summary).`,
      );
      return JSON.stringify({
        reception_whatsapp: config.RECEPTION_PHONE,
        note:
          "Handoff recorded in the reception register (email notification is best-effort — never claim " +
          "an email was sent). Give the client this number and tell them the team will help.",
      });
    }

    case "get_class_schedule": {
      // Build (or reuse) the weekly grid + PNG. The grid is the standing
      // Mon→Sun timetable — dateless by design — so a 30 min cache is safe
      // and turns the heaviest render in the bot into a no-op for most calls.
      let cached = scheduleCache && Date.now() - scheduleCache.at < SCHEDULE_TTL_MS ? scheduleCache : null;
      if (!cached) {
        const services = await wix.listServices();
        const now = new Date();
        const weekAhead = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
        const slots = await wix.queryAvailabilityMulti(
          services.map((s) => s.id),
          now.toISOString(),
          weekAhead.toISOString(),
        );
        const entries = buildWeeklyGrid(slots, services);
        if (entries.length === 0) {
          return JSON.stringify({
            error: "no_classes_scheduled",
            message:
              "No class sessions found in the coming week, so there is no schedule to show. " +
              "Say the planning is unavailable right now and offer the reception contact.",
          });
        }
        let png: Buffer | null = null;
        try {
          png = renderScheduleImage(entries);
        } catch (err) {
          console.error("Schedule image render failed (falling back to text):", err);
        }
        cached = { at: Date.now(), entries, png };
        scheduleCache = cached;
      }

      const text = scheduleText(cached.entries);
      if (cached.png) {
        try {
          await sendImage(client.wa_phone, cached.png, "Planning des cours — Revive 🗓️");
          await repo.addTurn(client.id, "assistant", `[image envoyée : planning hebdomadaire des cours]\n${text}`);
          return JSON.stringify({
            sent: true,
            schedule: text,
            note:
              "The weekly schedule image was already delivered to the client. Do NOT repeat the schedule in text. " +
              "Follow up with ONE short message in the client's language asking which class (and day) they want, " +
              "then use check_availability as usual — the image shows no dates or open spots.",
          });
        } catch (err) {
          console.error("Schedule image send failed (falling back to text):", err);
        }
      }
      // Render or delivery failed — never leave the client unanswered.
      return JSON.stringify({
        sent: false,
        schedule: text,
        note:
          "The image could not be sent. Relay this schedule as a short, readable text message (keep the day " +
          "grouping), then ask which class they want and use check_availability as usual.",
      });
    }

    case "present_options": {
      const body = String(input.body ?? "").trim();
      const buttonLabel = String(input.button_label ?? "Choisir").trim();
      const options = (Array.isArray(input.options) ? input.options : [])
        .map((o: any) => ({
          id: String(o?.id ?? "").trim(),
          title: String(o?.title ?? "").trim(),
          description: o?.description ? String(o.description).trim() : undefined,
          section: o?.section ? String(o.section).trim() : undefined,
        }))
        .filter((o) => o.id && o.title);
      const uniqueIds = new Set(options.map((o) => o.id));
      if (!body || options.length === 0 || options.length > 10 || uniqueIds.size !== options.length) {
        return JSON.stringify({
          error: "invalid_options",
          message:
            "present_options needs a body and 1-10 options, each with a UNIQUE id and a title. " +
            "Fix the input and retry, or fall back to plain text.",
        });
      }
      const kind = await sendInteractive(client.wa_phone, body, buttonLabel, options);
      // Log what the client saw, so rebuilt history stays coherent.
      await repo.addTurn(
        client.id,
        "assistant",
        `${body}\n[message interactif ${kind} — options : ${options.map((o) => o.title).join(" · ")}]`,
      );
      return JSON.stringify({
        sent: true,
        format: kind,
        note:
          `Interactive ${kind} message already delivered to the client and logged. ` +
          `Reply exactly ${NO_REPLY_SENTINEL} now — anything else would duplicate the message.`,
      });
    }

    default:
      return JSON.stringify({ error: `unknown_tool: ${name}` });
  }
}
