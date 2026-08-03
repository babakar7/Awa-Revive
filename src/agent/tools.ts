import type Anthropic from "@anthropic-ai/sdk";
import { config } from "../config.js";
import { notifyReception, sendVerificationCodeEmail } from "../lib/notify.js";
import { sendInteractive, sendImage, sendDocument } from "../lib/whatsapp.js";
import {
  buildWeeklyGrid,
  renderScheduleImage,
  scheduleText,
  type ScheduleEntry,
} from "../lib/scheduleImage.js";
import { classTip } from "../lib/classTips.js";
import { formatXof } from "../lib/receiptImage.js";
import { renderInvoicePdf } from "../lib/invoicePdf.js";
import * as invoices from "../domain/invoiceRepo.js";
import { recordInvoiceLog } from "../domain/notificationRepo.js";
import { orderedPaymentMethodOptions, paymentMethodLabel } from "../lib/paymentMethod.js";
import { clientOutreachLink } from "../lib/receptionContact.js";
import { isCapabilityOptionId } from "../lib/capabilityMenu.js";
import { invalidSlotOptionIds } from "./slotOptions.js";
import { findCoveringPlan } from "./coverageGuard.js";
import { activeMemberships } from "../lib/membershipContext.js";
import {
  computeExtras,
  extrasFromJson,
  formatExtrasOneLine,
  getCafeMenu,
} from "../lib/cafeMenu.js";
import * as wix from "../lib/wix.js";
import { planVerifiedMerge } from "../lib/crmAudit.js";
import * as om from "../lib/orangeMoney.js";
import { invalidateMembershipCache } from "../lib/membershipContext.js";
import * as links from "../domain/linkRequests.js";
import type { LinkRequest } from "../domain/linkRequests.js";
import * as repo from "../domain/repo.js";
import type { Client } from "../domain/repo.js";
import * as commitments from "../domain/commitments.js";
import * as closuresRepo from "../domain/closuresRepo.js";
import { recordBookingFunnelEvent } from "../domain/bookingFunnel.js";
import { backfillBookingContacts } from "../domain/bookingContactBackfill.js";
import { createClientPaymentSession } from "../domain/paymentSession.js";
import * as deliveries from "../domain/deliveryRepo.js";
import { PACK_DISCOVERY_CAMPAIGN, isCampaignReformerService } from "../domain/packDiscoveryCampaign.js";
import { isPlanSellableByAwa } from "../domain/planSaleGuard.js";
import { planNamesConflict } from "../domain/planNameGuard.js";
import { resolveServiceAlias } from "../domain/serviceAlias.js";
import { recordWixOrderForBooking, type PaymentLog } from "../domain/fulfillment.js";
import * as keyRepo from "../domain/keyRepo.js";
import {
  dakarDateKey,
  keyMappingForPlan,
  keyMappingForType,
  anyInvitationScopeAllows,
  anyBonusScopeAllows,
  invitationScopeAllows,
  bonusScopeAllows,
  invitationFriendRuleForService,
} from "../domain/keyRules.js";
import { resolveContinuitySource } from "../domain/keyContinuity.js";
import { isOmOutageActive } from "../domain/omOutage.js";
import {
  missingReplyRequirements,
  missingRequirementsToolResult,
  type ReplyRequirement,
} from "./replyCoverage.js";
import {
  decideMemberProvisioning,
  effectiveMemberContactId,
  provisionWixMember,
  type MemberProvisioningDecision,
  type MemberProvisioningResult,
} from "../domain/memberProvisioning.js";

export type ClientPaymentMethod = "wave" | "orange_money" | "maxit";

/** Server-side payment rail resolution (unit-tested). */
export function resolvePaymentMethod(
  raw: unknown,
  omEnabled: boolean,
  preferred?: string | null,
): { ok: true; method: ClientPaymentMethod } | { ok: false; error: string; message: string } {
  const m = String(raw ?? "").trim().toLowerCase();
  if (!m) {
    if (!omEnabled) return { ok: true, method: "wave" };
    // Multi-booking convenience: if the client already paid a previous booking,
    // reuse that method instead of forcing the 3-button choice again (Fix Zoé
    // 23/07). Only falls through to asking when there is no known preference.
    if (preferred) {
      const fromPreferred = resolvePaymentMethod(preferred, omEnabled);
      if (fromPreferred.ok) return fromPreferred;
    }
    return {
      ok: false,
      error: "payment_method_required",
      message:
        "payment_method is required. Ask the client which way they want to pay with present_options: " +
        "[Payer Wave (id: pay_wave)] [Payer Orange Money (id: pay_om)] [Payer Max It (id: pay_maxit)], " +
        "then call this tool again with payment_method wave | orange_money | maxit.",
    };
  }
  if (m === "wave") return { ok: true, method: "wave" };
  if (m === "orange_money" || m === "om") {
    if (!omEnabled) {
      return {
        ok: false,
        error: "orange_money_unavailable",
        message: "Orange Money is not available right now — offer Wave only.",
      };
    }
    return { ok: true, method: "orange_money" };
  }
  if (m === "maxit" || m === "max_it") {
    if (!omEnabled) {
      return {
        ok: false,
        error: "maxit_unavailable",
        message: "Max It is not available right now — offer Wave only.",
      };
    }
    return { ok: true, method: "maxit" };
  }
  return {
    ok: false,
    error: "invalid_payment_method",
    message: "payment_method must be wave, orange_money, or maxit.",
  };
}

// Self-healing errors for invented ids (prod 01/08: the model called tools with
// slugs like "sculpt" or placeholders like "invitee_key_id_placeholder", costing
// an extra error→re-lookup round-trip). Returning the live valid ids lets the
// model correct in ONE turn. These are tool results the model reads — the
// technical ids are NEVER shown to the client.
const MAX_ID_HINTS = 20;

export async function unknownServiceIdResult(): Promise<string> {
  let valid: Array<{ service_id: string; name: string }> = [];
  try {
    valid = (await wix.listServices())
      .slice(0, MAX_ID_HINTS)
      .map((s) => ({ service_id: s.id, name: s.name }));
  } catch {
    /* catalog fetch failed — still return the actionable message below */
  }
  return JSON.stringify({
    error: "unknown_service_id",
    message:
      "That service_id is not in the catalog. Never invent or abbreviate a service_id — " +
      "use one from valid_services below verbatim (or re-run list_classes).",
    valid_services: valid,
  });
}

export async function unknownPlanIdResult(): Promise<string> {
  let valid: Array<{ plan_id: string; name: string }> = [];
  try {
    valid = (await wix.listPlans())
      .slice(0, MAX_ID_HINTS)
      .map((p) => ({ plan_id: p.id, name: p.name }));
  } catch {
    /* catalog fetch failed — still return the actionable message below */
  }
  return JSON.stringify({
    error: "unknown_plan_id",
    message:
      "That plan_id is not in the catalog. Never invent or abbreviate a plan_id — " +
      "use one from valid_plans below verbatim (or re-run list_plans).",
    valid_plans: valid,
  });
}

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
 * Does NOT block a NEW-account verification either (wix_contact_id null): a
 * fresh fiche can't hold an abonnement, so there's nothing to protect — holding
 * the sale would just strand a paying new client mid-booking (prod 14/07 Rama).
 */
export function verificationBlocksPayment(request: LinkRequest | null, now: Date): boolean {
  if (!request || request.status !== "AWAITING_CODE") return false;
  if (!request.wix_contact_id) return false; // create-account path — no plan to cover this
  if (!request.code_expires_at) return false;
  return new Date(request.code_expires_at).getTime() > now.getTime();
}

/**
 * When an email matches NO existing Wix fiche, decide the next step:
 *  - "send_code": a name is known → create the account straight away (email the
 *    code now). This fires as soon as name+email are both present — including
 *    the very first call when the client sent them together in reply to the
 *    creation invitation. No second "do you confirm?" round-trip (prod 14/07
 *    Rama: the double confirm let the thread fall through, no code was sent).
 *  - "name_required": the client asked to create but no name yet → ask for it.
 *  - "offer_creation": no name and no create intent → offer to create, or let
 *    them re-send a different email if they expected an existing account.
 */
export function decideNoneCandidateAction(
  wantsCreate: boolean,
  clientName: string,
): "send_code" | "name_required" | "offer_creation" {
  if (clientName) return "send_code";
  return wantsCreate ? "name_required" : "offer_creation";
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Tool handlers have no request logger; the order sync only needs somewhere
// to surface failures (the sweep in index.ts retries them with app.log).
const consolePaymentLog: PaymentLog = {
  info: () => undefined,
  warn: (o, m) => console.warn(m ?? "wix order sync", o),
  error: (o, m) => console.error(m ?? "wix order sync", o),
};

/**
 * Eligibility for add_spots_to_booking. Pure so it's unit-testable. NO 16h rule:
 * adding spots is a PURCHASE (not a cancellation) — a class starting in 2h is
 * fine as long as seats remain (the handler re-checks Wix availability). The
 * per-service participants cap is enforced in the handler (needs the catalog).
 */
export function validateAddSpots(
  booking: Pick<repo.PendingBooking, "status" | "slot_start" | "wix_booking_id"> | null,
  extraRaw: unknown,
  now: Date,
): { ok: true; extra: number } | { ok: false; error: string; message: string } {
  if (!booking) {
    return { ok: false, error: "unknown_booking", message: "No booking of this client matches that id. Re-check with get_my_bookings." };
  }
  if (booking.status !== "BOOKED" || !booking.wix_booking_id) {
    return {
      ok: false,
      error: "not_confirmed",
      message: "That booking isn't a confirmed paid booking — you can only add spots to an already-confirmed one.",
    };
  }
  if (!booking.slot_start || new Date(booking.slot_start).getTime() <= now.getTime()) {
    return {
      ok: false,
      error: "class_already_started",
      message: "That class has already started — spots can no longer be added. Offer upcoming slots via check_availability.",
    };
  }
  const extra = Math.round(Number(extraRaw));
  if (!Number.isFinite(extra) || extra < 1 || extra > 10) {
    return { ok: false, error: "invalid_participants", message: "extra_participants must be a whole number between 1 and 10." };
  }
  return { ok: true, extra };
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

/** A direct-send tool already delivered the whole client reply. */
export const NO_REPLY_SENTINEL = "<NO_REPLY>";

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
      "Get time slots for a class between two dates, including full ones. Each slot carries a short choice_id " +
      "(a slot_… value) — that is what you pass to create_payment_link / book_with_membership / join_waitlist; " +
      "slots marked full:true exist but cannot be booked — mention they are full and propose open alternatives " +
      "instead. Each slot includes the coach's name — the ONLY valid source to answer who teaches a class. " +
      "Call this whenever the client asks about times/days for a class.",
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
      "Create a payment link for a specific class slot (the CLASS only — never the bar). Re-verifies the " +
      "slot is still open, cancels any previous unpaid link for this client, and returns the payment URL, amount " +
      "and expiry to relay to the client. payment_method: wave | orange_money | maxit — when Orange Money is " +
      "enabled, REQUIRED (if the client hasn't chosen, present_options: Payer Wave / Payer Orange Money / Payer Max It). " +
      "Supports group bookings via participants. Call once the client chose a slot + name — do NOT ask about the menu first.",
    input_schema: {
      type: "object",
      properties: {
        service_id: { type: "string", description: "Class id from list_classes" },
        event_id: {
          type: "string",
          description:
            "The chosen slot's choice_id from check_availability (a short slot_… value). Copy it exactly as " +
            "returned — that short id is the only slot identifier you are given.",
        },
        slot_start: { type: "string", description: "ISO start time of the chosen slot" },
        client_name: {
          type: "string",
          description:
            "Client's first name for the booking — the real name they gave. If you don't know it yet, ASK " +
            "before creating the link; never pass an initial, a guess or a placeholder.",
        },
        payment_method: {
          type: "string",
          enum: ["wave", "orange_money", "maxit"],
          description:
            "How the client pays. Required when OM is enabled. Map present_options: pay_wave→wave, pay_om→orange_money, pay_maxit→maxit.",
        },
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
            "says they can't access that inbox or prefers to pay now. Otherwise leave absent: if a code " +
            "is pending, the server refuses the link so the client can type the code first (their abonnement may " +
            "cover this class). NEVER set it merely to escape a verification_required error — instead re-run " +
            "request_email_verification and follow its answer (the account may already be linked).",
        },
        commitment_item_id: {
          type: "string",
          description:
            "ONLY for a multi-session commitment (see start_multi_session_commitment). The id of the session " +
            "this link pays for, from the commitment's items. REQUIRED whenever an active commitment exists for " +
            "the SAME class — the server rejects an ungrouped link otherwise. For a NEEDS_RESELECTION session, " +
            "pass the item id together with a NEW event_id and the server re-points that session to the new slot.",
        },
      },
      required: ["service_id", "event_id", "slot_start", "client_name"],
      additionalProperties: false,
    },
  },
  {
    name: "refresh_expired_plan_payment_link",
    description:
      "Create a fresh auditable payment attempt for this client's own expired plan order (less than 7 days old). " +
      "Use when the dynamic context names an expired order and the client wants a new link. The server reloads " +
      "the plan, current price, member, eligibility and payment method. If an initial class was selected, it is " +
      "revalidated before any payment is created.",
    input_schema: {
      type: "object",
      properties: {
        order_id: { type: "string", description: "Expired plan order id from the dynamic context." },
      },
      required: ["order_id"],
      additionalProperties: false,
    },
  },
  {
    name: "start_multi_session_commitment",
    description:
      "Persist a multi-session plan when a client agrees to pay for SEVERAL sessions of the SAME class à la carte " +
      "(one payment link each) — e.g. \"je veux réserver 5 séances de Bébé Nageur\". Call this ONCE, after you and " +
      "the client have agreed the full list of dates and you've recapped them. The server then remembers the plan " +
      "across payments and, after each paid session, asks the client whether to continue — so the plan can never be " +
      "silently abandoned. Do NOT use for abonnement/membership bookings (book_with_membership handles those). After " +
      "this returns ok, create the FIRST session's link with create_payment_link, passing its commitment_item_id.",
    input_schema: {
      type: "object",
      properties: {
        service_id: { type: "string", description: "Class id from list_classes (all sessions are this same class)." },
        client_name: { type: "string", description: "Client's first name (the real name they gave)." },
        slots: {
          type: "array",
          minItems: 2,
          maxItems: 15,
          description:
            "The agreed sessions, IN ORDER. One entry per session, each the choice_id of a slot the client picked " +
            "from check_availability (short slot_… value). The count is the number of sessions the client committed to.",
          items: {
            type: "object",
            properties: {
              event_id: {
                type: "string",
                description: "The slot's choice_id from check_availability (short slot_… value), copied exactly.",
              },
            },
            required: ["event_id"],
            additionalProperties: false,
          },
        },
      },
      required: ["service_id", "client_name", "slots"],
      additionalProperties: false,
    },
  },
  {
    name: "abandon_multi_session_commitment",
    description:
      "Cancel the client's active multi-session plan when they explicitly want to stop it (\"je préfère arrêter\", " +
      "\"laisse tomber les autres séances\"). Sessions already booked and paid are kept; only the remaining unpaid " +
      "sessions are cancelled. Call this before starting a DIFFERENT plan if one is already active.",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
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
      "Create a payment link to BUY an abonnement/pack (Wave, Orange Money, or Max It). Price from Wix catalog. " +
      "For a client without a Wix member, this first requires email verification and safely creates the member; " +
      "then payment_method is required when OM is enabled (present_options three buttons if unset). After verified " +
      "payment the plan activates automatically. Manual activation remains only when the client explicitly cannot " +
      "access/refuses email verification.",
    input_schema: {
      type: "object",
      properties: {
        plan_id: { type: "string", description: "Plan id from list_plans" },
        plan_name_confirm: {
          type: "string",
          description:
            "The exact plan NAME from list_plans that matches plan_id — copy it verbatim. The server " +
            "cross-checks it against the id and refuses the link if they disagree (anti-conflation guard: " +
            "prevents billing the wrong plan when the conversation jumped between topics).",
        },
        client_name: { type: "string", description: "Client's first name" },
        payment_method: {
          type: "string",
          enum: ["wave", "orange_money", "maxit"],
          description: "How the client pays. Required when OM is enabled.",
        },
        start: {
          type: "string",
          enum: ["now", "after_current"],
          description:
            "When the plan should start. Default 'now'. Use 'after_current' ONLY when the client is renewing/re-buying " +
            "while they still have an active plan and wants the new one to begin when the current one ends (no lost days). " +
            "The server computes the real start date from Wix — you never pass a date. If the client has no active plan, " +
            "the server falls back to 'now' and says so in the result.",
        },
        client_declined_verification: {
          type: "boolean",
          description:
            "Set true ONLY when an email verification is pending (a code was sent) AND the client explicitly " +
            "says they can't access that inbox or refuses verification. This keeps the manual-after-payment fallback. " +
            "Otherwise leave absent: the server requires verification before any plan payment. NEVER set it merely " +
            "to escape a verification_required error — re-run request_email_verification and follow its answer " +
            "(the account may already be linked, in which case a simple retry succeeds).",
        },
        service_id: {
          type: "string",
          description:
            "Optional first class for a Key purchase. Must be passed together with event_id and slot_start.",
        },
        event_id: {
          type: "string",
          description:
            "The selected first class choice_id (short slot_… value). Must be passed with service_id and slot_start.",
        },
        slot_start: {
          type: "string",
          description:
            "The exact ISO start returned with event_id. Must be passed with service_id and event_id.",
        },
      },
      required: ["plan_id", "plan_name_confirm", "client_name"],
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
        event_id: {
          type: "string",
          description:
            "The chosen slot's choice_id from check_availability (a short slot_… value). Copy it exactly as " +
            "returned — that short id is the only slot identifier you are given.",
        },
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
    name: "book_key_bonus",
    description:
      "Book the ONE/TWO extra class benefit attached to an active Clé de la Maison. " +
      "Only Aquabike, Yoga, Mat or Step from Monday to Friday are accepted; the server selects the exact " +
      "linked bonus order, never another subscription. IMPORTANT: once confirmed, this bonus class cannot " +
      "be cancelled, moved or carried over and the credit remains consumed. Tell the client this before calling.",
    input_schema: {
      type: "object",
      properties: {
        service_id: { type: "string", description: "Class id from list_classes" },
        event_id: { type: "string", description: "Chosen slot choice_id from check_availability" },
        slot_start: { type: "string", description: "ISO start time of the chosen slot" },
        client_name: { type: "string", description: "Key holder's first name" },
      },
      required: ["service_id", "event_id", "slot_start", "client_name"],
      additionalProperties: false,
    },
  },
  {
    name: "book_key_invitation",
    description:
      "Book an earned Clé invitation for a friend under the key holder's Wix account. Only Reformer at " +
      "12:30 Monday-Friday is accepted. The friend must never have taken a Reformer class at Revive; prior " +
      "Aquabike, Yoga, Mat, Step or other Revive visits do not disqualify. Provide first name and phone for " +
      "the server-side check. IMPORTANT: once confirmed, an invitation cannot be cancelled, moved " +
      "or carried over and the right remains consumed. Tell the client this before calling.",
    input_schema: {
      type: "object",
      properties: {
        service_id: { type: "string", description: "Reformer service id from list_classes" },
        event_id: { type: "string", description: "Chosen 12:30 slot choice_id" },
        slot_start: { type: "string", description: "ISO start time of the chosen slot" },
        client_name: { type: "string", description: "Key holder's first name" },
        friend_first_name: { type: "string", description: "Invited friend's first name" },
        friend_phone: { type: "string", description: "Invited friend's WhatsApp phone with country code" },
      },
      required: [
        "service_id",
        "event_id",
        "slot_start",
        "client_name",
        "friend_first_name",
        "friend_phone",
      ],
      additionalProperties: false,
    },
  },
  {
    name: "request_invitee_guarantee",
    description:
      "Record a request under L'Invitée's first-session guarantee and hand it to reception. " +
      "The server checks the same-day deadline, that no second Reformer session and no bonus class " +
      "were used. Reception still verifies actual attendance and decides/processes the refund. " +
      "Never promise that the refund is approved or already completed.",
    input_schema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "record_google_review",
    description:
      "Activate the client's review-locked Clé invitation(s) after she leaves a Google review. " +
      "Call ONLY once she has sent a screenshot of her published review (an [image reçue] message " +
      "showing a Google review) or clearly confirmed she just published it — never on a mere promise " +
      "to do it later. The server checks that a pending review gate exists for this client; the " +
      "screenshot is sufficient (no reception approval). Idempotent: a second screenshot is harmless.",
    input_schema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "create_cafe_payment_link",
    description:
      "Create a payment link for a MENU (bar) order after a class is booked, or a standalone counter order. " +
      "payment_method: wave | orange_money | maxit (required when OM enabled). Server prices from the menu file.",
    input_schema: {
      type: "object",
      properties: {
        linked_booking_id: {
          type: "string",
          description:
            "Optional booking_id of the confirmed class this bar order accompanies (from get_my_bookings or " +
            "book_with_membership). Omit to use the client's most recent upcoming booking.",
        },
        payment_method: {
          type: "string",
          enum: ["wave", "orange_money", "maxit"],
          description: "How the client pays. Required when OM is enabled.",
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
              selections: {
                type: "array",
                minItems: 1,
                maxItems: 6,
                description:
                  "One answer for each required choice shown on this menu item, in the same order.",
                items: {
                  type: "object",
                  properties: {
                    label: {
                      type: "string",
                      description: "Choice label copied exactly from <cafe_menu> (for example Type de lait).",
                    },
                    value: {
                      type: "string",
                      description: "Selected response copied exactly from the brackets for that label.",
                    },
                  },
                  required: ["label", "value"],
                  additionalProperties: false,
                },
              },
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
    name: "create_delivery_payment_link",
    description:
      "Record CASH or create a Wave / Orange Money / Max It payment link for an EXISTING delivery " +
      "that the server placed in this client's live delivery context. The server owns the items and total; " +
      "never use create_cafe_payment_link for a delivery.",
    input_schema: {
      type: "object",
      properties: {
        delivery_order_id: {
          type: "string",
          description: "Delivery id from the live delivery_payment context.",
        },
        payment_method: {
          type: "string",
          enum: ["wave", "orange_money", "maxit", "cash"],
          description:
            "Client's explicit choice. Map WAVE→wave, OM/Orange Money→orange_money, MAXIT→maxit, ESPÈCES/CASH→cash.",
        },
      },
      required: ["delivery_order_id", "payment_method"],
      additionalProperties: false,
    },
  },
  {
    name: "get_my_bookings",
    description:
      "List this client's upcoming confirmed bookings. Returns { bookings: [...] }: each has booked_via " +
      "'awa' (taken through this chat) or 'studio' (booked at the counter or on the website, matched by the " +
      "client's WhatsApp number). Both carry a booking_id usable for rescheduling or cancellation. " +
      "A voluntary cancellation is never refundable; offer a same-class move or transfer first. " +
      "Use it before answering about existing bookings and before any cancel/reschedule.",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "cancel_booking",
    description:
      "Cancel one of THIS client's upcoming bookings (all its spots). Only allowed 16 hours or more " +
      "before the class start — the server enforces this and refuses otherwise. Membership-paid bookings: " +
      "the plan session is automatically re-credited. Direct-paid bookings are NON-REFUNDABLE when the client " +
      "cancels voluntarily. Studio/site bookings require handoff because their payment type is unknown. Offer " +
      "reschedule_booking for the same class or a self-service transfer first; for a transfer, leave the booking " +
      "unchanged and tell the replacement to attend under the original booking name, with no reception handoff. For a final direct " +
      "cancellation, call ONLY after the client explicitly accepts " +
      "that payment is lost, and pass acknowledge_no_refund:true. Never use cancellation as part of a reschedule.",
    input_schema: {
      type: "object",
      properties: {
        booking_id: {
          type: "string",
          description: "booking_id of the booking to cancel, from get_my_bookings",
        },
        acknowledge_no_refund: {
          type: "boolean",
          description:
            "Set true only after a direct-paid client explicitly accepted that this voluntary cancellation " +
            "releases the seat without any refund. Omit for membership bookings; studio/site cancellations require handoff.",
        },
      },
      required: ["booking_id"],
      additionalProperties: false,
    },
  },
  {
    name: "reschedule_booking",
    description:
      "Directly move one of THIS client's confirmed bookings to a new slot of the SAME class, keeping its " +
      "existing payment and all its places. Only allowed 16 hours or more before the CURRENT class — the " +
      "server enforces ownership, same-class matching and fresh availability. Get booking_id from " +
      "get_my_bookings and event_id from check_availability, after the client chose and explicitly confirmed " +
      "the new slot. NEVER call cancel_booking or create_payment_link for this same-class move.",
    input_schema: {
      type: "object",
      properties: {
        booking_id: { type: "string", description: "booking_id from get_my_bookings" },
        event_id: {
          type: "string",
          description: "New slot's choice_id from check_availability (the short slot_… value)",
        },
      },
      required: ["booking_id", "event_id"],
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
        event_id: { type: "string", description: "choice_id of the FULL slot, from check_availability" },
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
      "Verify a client's email by code, to either LINK an existing Revive account or CREATE a new one. The " +
      "server sends a 6-digit code TO THAT INBOX; the client reads it from their email and types it here " +
      "(submit_verification_code). Use whenever a client shares an email — after a failed check_membership " +
      "claim, the post-payment linking question, or the account invitation. If the client sent their full " +
      "name AND email together (e.g. answering the 'send me your name and email and I'll create one' " +
      "invitation), pass BOTH email and client_name on the FIRST call — the server then emails the code " +
      "straight away (no 'do you confirm?' round-trip). Only omit client_name when the client expected an " +
      "EXISTING account: then, if the email matches no Wix account, the server replies " +
      "email_not_found_offer_creation WITHOUT sending a code — offer to create a fresh account; if the " +
      "client agrees, call again with create_account:true AND client_name (their full name). If the " +
      "client says they have no email or can't access it, call with client_has_no_email:true instead — " +
      "reception takes over (the client does NOT need to call). You never see the code: it only exists in " +
      "the client's inbox. This tool is explicitly allowed during a plan purchase: always pass the already-known " +
      "client_name on the first call.",
    input_schema: {
      type: "object",
      properties: {
        email: { type: "string", description: "The email to verify (existing account, or the one for a new account)" },
        create_account: {
          type: "boolean",
          description:
            "true ONLY when the email matched no account and the client agreed to create a new one — must be " +
            "sent together with client_name",
        },
        client_name: {
          type: "string",
          description: "The client's full name, required when create_account is true (used on the new fiche)",
        },
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
    name: "send_invoice",
    description:
      "Send the client a REAL numbered facture (invoice IMAGE, same register and numbering as the " +
      "reception's factures) for one of their recent payments (class, abonnement, or bar). Call this " +
      "when they ask for a facture / reçu / justificatif / receipt / proof of payment. Amounts always " +
      "come from the server. Asking again for the same payment resends the SAME facture number. " +
      "Optional receipt_id to pick among several recent payments; omit to auto-send the single latest " +
      "or get a list of choices. Optional company to put a company name on the facture (facture " +
      "entreprise) — ask the client for the exact name first if they want one.",
    input_schema: {
      type: "object",
      properties: {
        receipt_id: {
          type: "string",
          description:
            "Id of a candidate from a previous send_invoice result (booking/plan/cafe id). Omit on first call.",
        },
        company: {
          type: "string",
          description:
            "Company / organisation name to print under the client's name (facture entreprise). " +
            "Only when the client asked for it, spelled exactly as they gave it.",
        },
        client_name: {
          type: "string",
          description:
            "Client's full name for the facture — only needed when the tool returned " +
            "missing_client_name and you asked the client; it is saved to their profile.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "handoff_to_human",
    description:
      "Escalate the conversation to the human reception team. Triggers: the client wants to call or speak to " +
      "a person (e.g. \"je peux vous appeler ?\"), complaints, alleged Revive-fault refund claims, " +
      "different-class changes, cancelling or rescheduling less than 16h before the class, partial group cancellations, " +
      "medical questions, factures needing special legal mentions or covering payments send_invoice " +
      "doesn't list, anything off-script. Records the handoff, notifies reception with a one-tap link to " +
      "message the client, and the client is simply told reception will reach out to them — they send nothing.",
    input_schema: {
      type: "object",
      properties: {
        reason: {
          type: "string",
          description:
            "A short complete sentence in French, written in the CLIENT'S first person so it can be sent " +
            "directly to reception. Example: \"Je souhaite parler directement à quelqu'un de l'équipe Revive\". " +
            "Never write \"le client souhaite\". Keep it high-level: no internal ids, amounts, full transcript, " +
            "or sensitive medical details.",
        },
      },
      required: ["reason"],
      additionalProperties: false,
    },
  },
  {
    name: "disengage_conversation",
    description:
      "Stop engaging a contact who is clearly NOT here for the studio — sustained sexual/suggestive/romantic " +
      "advances toward Awa, someone plainly toying with the bot, or a sustained rapid loop of greetings, " +
      "goodbyes or unclear fragments after Awa already redirected them, with no booking/studio intent. Do NOT use " +
      "this for a single awkward or ambiguous line, ordinary warmth or a compliment, a complaint, or a real " +
      "client who flirts but also has a genuine studio need (serve the need, ignore the flirtation). After you " +
      "call it, send exactly ONE short, polite, firm closing line re-anchoring to the studio, then nothing else: " +
      "the system automatically stops replying to this contact afterwards (auto-resumes after ~24h; reception " +
      "can lift it). No refund/booking side effects — it only silences Awa for this contact.",
    input_schema: {
      type: "object",
      properties: {
        reason: {
          type: "string",
          description:
            "A short factual French sentence for the studio's admin badge only (never sent to the client), " +
            'e.g. "Messages à caractère suggestif, aucune intention de réservation". Keep it neutral and brief; ' +
            "no transcript, no ids.",
        },
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
      "Send the client the studio's WEEKLY class schedule (Monday→Sunday grid, no dates) as an image with your " +
      "complete answer as its caption, generated live from the Wix catalog. This tool renders AND delivers the whole " +
      "client reply itself. The required message field must answer every CURRENT-TURN REQUIRED COVERAGE item; on a " +
      "first contact it includes the greeting/automated-assistant introduction, while an ongoing conversation must " +
      "not re-introduce Awa. Use it whenever the client wants an " +
      "OVERVIEW of the studio's classes WITHOUT naming one: 'le planning des cours', 'vos horaires', 'the schedule', " +
      "AND any request to see ALL the slots at once or asking whether a site/page lists them ('avez-vous un site " +
      "avec tous les créneaux', 'je peux voir tous les créneaux ?', 'la liste complète des cours', 'c'est quoi le " +
      "programme de la semaine'). In that case CALL THIS TOOL and include www.revive.sn/planning in message. For the " +
      "slots of ONE specific class (or to " +
      "actually book), keep using check_availability — the weekly grid carries no dates and no open-spot counts. If " +
      "the image cannot be sent, the tool returns the schedule as text for you to relay. After sent:true, reply " +
      `exactly ${NO_REPLY_SENTINEL} and nothing else.`,
    input_schema: {
      type: "object",
      properties: {
        message: {
          type: "string",
          description:
            "The complete client-facing image caption (max 1024 chars): answer all current questions, include the online planning link, and do not append a CTA unless the client showed buying intent.",
        },
      },
      required: ["message"],
      additionalProperties: false,
    },
  },
  {
    name: "add_spots_to_booking",
    description:
      "Add extra spots to one of THIS client's existing CONFIRMED bookings — same class, same slot — when a client " +
      "who already booked wants to add people/places ('rajouter 2 personnes', 'add 2 more spots'). Creates a payment " +
      "link for ONLY the additional spots; after payment those extra places are confirmed automatically. Get " +
      "booking_id from get_my_bookings. Does NOT apply to a 'studio:' booking (taken at the counter/website — instead " +
      "book the extra spots as a normal NEW booking via check_availability + create_payment_link), nor when the " +
      "client wants the extra spots deducted from their abonnement (use book_with_membership). payment_method: " +
      "wave | orange_money | maxit — REQUIRED when Orange Money is enabled (present_options the three buttons).",
    input_schema: {
      type: "object",
      properties: {
        booking_id: { type: "string", description: "id of the client's existing confirmed booking (from get_my_bookings)" },
        extra_participants: {
          type: "integer",
          minimum: 1,
          maximum: 10,
          description: "How many spots to ADD (not the new total). 1–10.",
        },
        payment_method: {
          type: "string",
          enum: ["wave", "orange_money", "maxit"],
          description: "How the client pays. Required when OM is enabled. Map: pay_wave→wave, pay_om→orange_money, pay_maxit→maxit.",
        },
        client_declined_verification: {
          type: "boolean",
          description:
            "Set true ONLY when an email verification is pending (a code was sent) AND the client explicitly says " +
            "they can't access that inbox or prefer to pay now. Otherwise leave absent. NEVER set it merely to " +
            "escape a verification_required error — re-run request_email_verification and follow its answer.",
        },
      },
      required: ["booking_id", "extra_participants"],
      additionalProperties: false,
    },
  },
];

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

export function nextSevenDayWindow(dateTo: string): { dateFrom: string; dateTo: string } {
  const end = new Date(dateTo);
  if (Number.isNaN(end.getTime())) throw new Error("invalid date_to");
  const from = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate() + 1));
  const to = new Date(from.getTime() + 6 * 86_400_000);
  return {
    dateFrom: `${from.toISOString().slice(0, 10)}T00:00:00Z`,
    dateTo: `${to.toISOString().slice(0, 10)}T23:59:59Z`,
  };
}

async function trackFunnel(
  args: Parameters<typeof recordBookingFunnelEvent>[0],
): Promise<void> {
  await recordBookingFunnelEvent(args).catch((error) =>
    console.error(`Failed to record booking funnel stage ${args.stage}:`, error),
  );
}

function slotResult(slot: wix.WixSlot, alternative = false): Record<string, unknown> {
  return {
    // Only the short choice_id is exposed to the model — the long Wix event_id
    // (~450 chars) is deliberately withheld: replayed tool history is truncated
    // (TOOL_REPLAY_MAXLEN), so a copied event_id used to come back mangled and
    // fail as unknown_slot (Zoé, 23/07 — two failed create_payment_link calls).
    // The server maps the choice_id back to the real event_id via slot_cache.
    choice_id: repo.slotChoiceKey(slot.eventId),
    start: slot.startDate,
    start_dakar: fmtDakar(slot.startDate),
    duration_minutes: slot.endDate
      ? Math.round((Date.parse(slot.endDate) - Date.parse(slot.startDate)) / 60000)
      : undefined,
    open_spots: slot.openSpots,
    full: slot.openSpots <= 0 || undefined,
    coach: slot.coach ?? undefined,
    alternative: alternative || undefined,
  };
}

async function freshSlotAlternatives(
  clientId: string,
  serviceId: string,
  excludedEventId: string,
): Promise<wix.WixSlot[]> {
  const from = new Date();
  const to = new Date(from.getTime() + 7 * 86_400_000);
  const slots = (await wix.queryAvailability(serviceId, from.toISOString(), to.toISOString()))
    .filter((slot) => slot.openSpots > 0 && slot.eventId !== excludedEventId && Date.parse(slot.startDate) > Date.now())
    .slice(0, 10);
  await repo.cacheSlots(
    clientId,
    serviceId,
    slots.map((slot) => ({ eventId: slot.eventId, slot: slot.raw })),
  );
  if (slots.length > 0) {
    await trackFunnel({
      clientId,
      stage: "slots_shown",
      metadata: { service_id: serviceId, open_slots: slots.length, stale_selection_recovery: true },
    });
  }
  return slots;
}

function paymentChoicePayload(preferred: string | null): Record<string, unknown> {
  const omEnabled = om.isOmEnabled();
  return {
    preferred_payment_method: preferred,
    payment_options: orderedPaymentMethodOptions(preferred, omEnabled),
    // Once the client has paid a previous booking, don't re-ask the 3-button
    // choice on every subsequent link of the same flow (Zoé, 23/07 — the Wave /
    // OM / Max It buttons were shown 4 times in a row). Reuse that method by
    // default; the client can still switch by saying so.
    payment_choice_required: omEnabled && !preferred,
    payment_note:
      omEnabled && preferred
        ? `The client last paid with ${preferred}. Create the link directly with that method — do NOT show the ` +
          `payment buttons again. If they'd rather use another way, they can just say so.`
        : undefined,
  };
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
  request: Pick<links.LinkRequest, "id" | "client_id" | "reception_notified_at"> &
    Partial<Pick<links.LinkRequest, "claimed_email">>,
  client: Client,
  detail: string,
): Promise<void> {
  await links.markNeedsReception(request.id, detail);
  await links.notifyLinkNeedsReception(
    request,
    client,
    detail,
    request.claimed_email ?? client.claimed_email,
  );
}

interface PlanMemberContext {
  contactId: string | null;
  memberId: string | null;
  verification: links.LinkRequest | null;
  decision: MemberProvisioningDecision;
}

/**
 * Read-only identity resolution. Safe to call before eligibility/renewal
 * guards: it never creates a Wix member.
 */
async function resolvePlanMemberContext(
  client: Client,
  phone: string,
  nameHint: string,
  pending: links.LinkRequest | null,
  now = new Date(),
): Promise<PlanMemberContext> {
  const [phoneContactId, recentProof, durableRow] = await Promise.all([
    wix.findContactIdByPhone(phone, nameHint || undefined),
    links.recentlyResolved(client.id, 60),
    links.latestProvenLinkRequest(client.id),
  ]);
  // recentProof: freshness arbitration only. durableProof: authorizes creating
  // the member for the phone's own fiche (any age). pending: codeAlreadySent.
  const contactId = effectiveMemberContactId(phoneContactId, recentProof, now);
  const memberId = contactId ? await wix.findMemberIdByContactId(contactId) : null;
  const durableProof = durableRow
    ? { linkedContactId: durableRow.linked_contact_id, claimedEmail: durableRow.claimed_email }
    : null;
  return {
    contactId,
    memberId,
    // Kept for downstream reception/notify + declined-fallback consumers.
    verification: recentProof ?? pending,
    decision: decideMemberProvisioning({
      phoneContactId,
      memberId,
      recentProof,
      durableProof,
      pendingVerification: pending
        ? { status: pending.status, codeExpiresAt: pending.code_expires_at }
        : null,
      now,
    }),
  };
}

/** The only write side of plan-member provisioning. Call immediately pre-draft. */
async function provisionPlanMember(
  context: PlanMemberContext,
  client: Client,
): Promise<MemberProvisioningResult> {
  return provisionWixMember(context.decision, {
    getContact: wix.getContactById,
    findMemberId: wix.findMemberIdByContactId,
    createMember: wix.createMember,
    notifyFailure: async (reason, detail) => {
      if (context.verification) {
        await links.notifyLinkNeedsReception(
          context.verification,
          client,
          `provisionnement membre Wix impossible (${reason}) : ${detail.slice(0, 500)}`,
          context.verification.claimed_email,
        );
        return;
      }
      notifyReception(
        "⚠️ Compte membre Wix à vérifier avant paiement",
        `Le provisioning membre a échoué pour ${client.name ?? "?"} ` +
          `(+${client.wa_phone.replace(/^\+/, "")}). Aucun paiement n'a été créé.\n` +
          `Motif : ${reason} — ${detail.slice(0, 500)}`,
      );
    },
  });
}

/**
 * Extra note appended to payment-link tool results for OM/Max It while the
 * owner-activated outage mode is on (lost Sonatel callbacks): the model must
 * pre-warn the client and never treat a payment claim as "not received".
 */
async function omOutageNoteFor(method: string): Promise<string> {
  if (method !== "orange_money" && method !== "maxit") return "";
  const active = await isOmOutageActive().catch(() => false);
  if (!active) return "";
  return (
    " OM OUTAGE MODE IS ON: tell the client, in one short kind sentence, that the payment confirmation " +
    "for this method is currently verified by the team and can take a bit longer than usual. If they later " +
    "say they've paid, NEVER say the payment wasn't received — reassure that the team is verifying it and " +
    "call handoff_to_human once with amount + item + approximate payment time."
  );
}

/**
 * Owner-approved narrow override of the 13/07 "Awa never creates Wix members"
 * rule (probe-create-member.ts). ONE case: a brand-NEW account whose email the
 * client herself supplied for verification, but the code never arrived and she
 * chose to pay now. Manual reception activation then left the client waiting
 * indefinitely (Maryeme 01/08). Instead we create the fiche + member directly
 * so the plan auto-activates and the first class books itself. Wix WILL email a
 * welcome/set-password mail — acceptable here because the client asked for an
 * account and gave this exact email. Fails safe: any duplicate/mismatch/error
 * returns null and the caller keeps the manual-after-payment fallback (no throw).
 */
async function autoProvisionDeclinedNewAccount(
  verification: links.LinkRequest | null,
  client: Client,
): Promise<{ contactId: string; memberId: string } | null> {
  const email = verification?.claimed_email?.trim();
  // New-account path only. An existing fiche (verification carries a
  // wix_contact_id) is a LINK case that genuinely needs the code — never
  // auto-create over it.
  if (!email || verification?.wix_contact_id) return null;
  const wa = `+${client.wa_phone.replace(/^\+/, "")}`;
  try {
    // A fiche already on this number means link/merge, not create — hand it to
    // the manual path rather than spawning a duplicate.
    if (await wix.findContactIdByPhone(wa, client.name ?? undefined)) return null;
    const contactId = await wix.createContact({
      name: verification?.claimed_name ?? client.name ?? undefined,
      phone: wa,
      email,
    });
    const member = await wix.createMember(email);
    // Clean linkage = the member landed on the fiche we just made. A different
    // contactId means the email already belonged to another fiche (a link case
    // in disguise): don't guess — fall back to manual so reception reconciles.
    if (member.contactId && member.contactId !== contactId) return null;
    const memberId = member.id ?? (await wix.findMemberIdByContactId(contactId));
    if (!memberId) return null;
    return { contactId, memberId };
  } catch (err) {
    console.error("Auto-provision of declined new account failed — manual fallback:", err);
    return null;
  }
}

function verificationRequiredResult(
  error: "plan_member_verification_required" | "discovery_member_verification_required",
  codeAlreadySent: boolean,
): string {
  return JSON.stringify({
    error,
    verification: codeAlreadySent ? "code_active" : "email_required",
    message: codeAlreadySent
      ? "A valid verification code was already emailed. Ask the client to type that 6-digit code here now; do NOT call request_email_verification again and do NOT create a payment link."
      : "An email verification is required before this plan purchase can be auto-activated. Ask for the client's email, then call request_email_verification and pass the already-known client_name on that FIRST call. Tell them Wix may also send an optional welcome/set-password email; choosing a password is not required. If they refuse or cannot access the inbox, retry create_plan_payment_link with client_declined_verification:true — for a new account we then create it directly with the email they gave (payment stays automatic); for an existing account the team activates it manually after payment. The tool result's ACTIVATION note tells you which; follow it.",
  });
}

async function exactBenefitWithShortRetry(args: {
  serviceId: string;
  contactId: string;
  planId: string;
  orderId: string;
}): Promise<wix.EligibleBenefit | null> {
  for (const delay of [0, 300, 900]) {
    if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
    const benefit = wix.selectEligibleBenefit(
      await wix.findEligibleBenefits(args.serviceId, args.contactId, 1),
      { planId: args.planId, orderId: args.orderId },
    );
    if (benefit) return benefit;
  }
  return null;
}

type ValidInitialPlanSlot = {
  service: wix.WixService;
  fresh: wix.WixSlot;
  eventId: string;
};

async function validateInitialPlanSlot(args: {
  planId: string;
  serviceId: string;
  eventId: string;
  slotStart: string;
}): Promise<ValidInitialPlanSlot | { error: "initial_slot_started" | "initial_slot_unavailable" }> {
  if (!args.slotStart || !Number.isFinite(Date.parse(args.slotStart))) {
    return { error: "initial_slot_unavailable" };
  }
  if (Date.parse(args.slotStart) <= Date.now()) return { error: "initial_slot_started" };
  const service = await wix.getService(args.serviceId);
  if (!service || !service.pricingPlanIds.includes(args.planId)) {
    return { error: "initial_slot_unavailable" };
  }
  const closed = await closuresRepo.closureAt(new Date(args.slotStart)).catch(() => null);
  if (closed) return { error: "initial_slot_unavailable" };
  const fresh = await wix.isSlotStillOpen(args.serviceId, args.eventId, args.slotStart, 1);
  if (!fresh) return { error: "initial_slot_unavailable" };
  return { service, fresh, eventId: args.eventId };
}

async function createProtectedBenefitBooking(args: {
  client: Client;
  serviceId: string;
  resolvedEventId: string;
  fresh: wix.WixSlot;
  service: wix.WixService;
  contact: wix.WixContactMatch;
  bookingName: string;
  benefit: wix.EligibleBenefit;
  key: keyRepo.KeyRegistry;
  kind: "BONUS" | "INVITATION";
  invitationId?: string | null;
}): Promise<Record<string, unknown>> {
  const phone = `+${args.client.wa_phone.replace(/^\+/, "")}`;
  let wixBookingId: string | null = null;
  let redeemed = false;
  try {
    wixBookingId = await wix.createBookingRaw({
      slot: args.fresh.raw,
      name: args.bookingName,
      phone,
      participants: 1,
      paymentOption: "MEMBERSHIP",
      resolvedContact: args.contact,
    });
    const redemption = await wix.redeemMembershipForBooking({
      wixBookingId,
      serviceId: args.serviceId,
      benefit: args.benefit,
      count: 1,
    });
    redeemed = true;
    try {
      await wix.confirmBookingPaid(wixBookingId);
    } catch (error) {
      notifyReception(
        "⚠️ Avantage Clé — réservation à confirmer",
        `Le crédit ${args.kind} a été consommé, mais la confirmation Wix a échoué.\n` +
          `Booking Wix : ${wixBookingId}\nClient : ${args.bookingName} (${phone})`,
      );
    }
    let local: repo.PendingBooking | null = null;
    try {
      local = await repo.createMembershipBooking({
        clientId: args.client.id,
        serviceId: args.serviceId,
        serviceName: args.service.name,
        eventId: args.resolvedEventId,
        slotJson: args.fresh.raw,
        slotStart: args.fresh.startDate,
        slotEnd: args.fresh.endDate ?? null,
        wixBookingId,
        benefitTransactionId: redemption.transactionId || null,
        participants: 1,
      });
    } catch (error) {
      console.error(`Protected-benefit local booking persistence failed for ${wixBookingId}:`, error);
    }
    if (local) {
      await recordWixOrderForBooking(local.id, consolePaymentLog).catch(() => undefined);
    }
    await keyRepo.markProtectedBenefitBooking({
      wixBookingId,
      localBookingId: local?.id ?? null,
      keyId: args.key.id,
      invitationId: args.invitationId ?? null,
      kind: args.kind,
    });
    if (args.invitationId) {
      await keyRepo.markInvitationUsed({
        invitationId: args.invitationId,
        wixBookingId,
      });
    }
    invalidateMembershipCache(args.client.id);
    if (!local) {
      notifyReception(
        "⚠️ Avantage Clé réservé — synchro locale à réparer",
        `La réservation Wix ${wixBookingId} et son débit ${args.kind} sont confirmés, ` +
          `mais la ligne Resabot manque.\nClient : ${args.bookingName} (${phone})\nCours : ${args.service.name}`,
      );
    }
    return {
      booked: true,
      booking_id: local?.id ?? `studio:${wixBookingId}`,
      class: args.service.name,
      slot_start: args.fresh.startDate,
      slot_start_dakar: fmtDakar(args.fresh.startDate),
      benefit: args.kind.toLowerCase(),
      paid_with: redemption.membershipName,
      cancellable: false,
      reschedulable: false,
      note:
        "Confirmed. Remind the client explicitly that this bonus/invitation is final: " +
        "it cannot be cancelled, moved or carried over and its credit remains consumed.",
    };
  } catch (error) {
    if (wixBookingId && !redeemed) {
      try {
        await wix.declineBooking(wixBookingId);
      } catch (cleanupError) {
        console.error(`Could not decline protected-benefit booking ${wixBookingId}:`, cleanupError);
      }
    }
    throw error;
  }
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
  turnContext: { replyRequirements?: readonly ReplyRequirement[] } = {},
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
      let serviceId = String(input.service_id ?? "");
      const dateFrom = String(input.date_from ?? "");
      const dateTo = String(input.date_to ?? "");
      if (
        !serviceId ||
        Number.isNaN(Date.parse(dateFrom)) ||
        Number.isNaN(Date.parse(dateTo)) ||
        Date.parse(dateFrom) > Date.parse(dateTo)
      ) {
        return JSON.stringify({ error: "invalid_arguments" });
      }
      let service = await wix.getService(serviceId);
      if (!service) {
        const services = await wix.listServices();
        const alias = resolveServiceAlias(serviceId, services);
        if (alias) {
          serviceId = alias;
          service = services.find((candidate) => candidate.id === alias) ?? null;
        }
      }
      if (!service) return await unknownServiceIdResult();

      await trackFunnel({
        clientId: client.id,
        stage: "availability_requested",
        metadata: { service_id: serviceId, date_from: dateFrom, date_to: dateTo },
      });

      // Studio closures (Maggal, holidays…): Wix keeps the slots on those days,
      // so the server drops any slot that starts inside a closure — covering the
      // requested window plus the fallback next-seven-day window.
      const closures = await closuresRepo
        .closuresInWindow(new Date(dateFrom), new Date(Date.parse(dateTo) + 8 * 86_400_000))
        .catch(() => [] as closuresRepo.StudioClosure[]);
      const isSlotClosed = (s: wix.WixSlot) =>
        closures.length > 0 && closuresRepo.isClosedAt(new Date(s.startDate), closures) !== null;

      // Slots whose class already started must never be offered nor cached —
      // a link sold for a started class can only end in a refund.
      const now = Date.now();
      let requestedSlots: wix.WixSlot[];
      try {
        requestedSlots = (await wix.queryAvailability(serviceId, dateFrom, dateTo))
          .filter((s) => Date.parse(s.startDate) > now && !isSlotClosed(s))
          .slice(0, 30);
      } catch (error) {
        await trackFunnel({
          clientId: client.id,
          stage: "technical_failure",
          failureCode: "wix_booking_failed",
          metadata: { operation: "availability", service_id: serviceId },
        });
        throw error;
      }
      const requestedOpenSlots = requestedSlots.filter((s) => s.openSpots > 0);
      let alternativeSlots: wix.WixSlot[] = [];
      let alternativeWindow: { dateFrom: string; dateTo: string } | null = null;
      if (requestedOpenSlots.length === 0) {
        await trackFunnel({
          clientId: client.id,
          stage: "no_availability",
          failureCode: "no_availability",
          metadata: { service_id: serviceId, date_from: dateFrom, date_to: dateTo },
        });
        alternativeWindow = nextSevenDayWindow(dateTo);
        try {
          alternativeSlots = (await wix.queryAvailability(
            serviceId,
            alternativeWindow.dateFrom,
            alternativeWindow.dateTo,
          ))
            .filter((s) => Date.parse(s.startDate) > now && !isSlotClosed(s))
            .slice(0, 30);
        } catch (error) {
          await trackFunnel({
            clientId: client.id,
            stage: "technical_failure",
            failureCode: "wix_booking_failed",
            metadata: { operation: "availability_alternative", service_id: serviceId },
          });
          throw error;
        }
      }
      const slots = [...requestedSlots, ...alternativeSlots];
      const openSlots = slots.filter((s) => s.openSpots > 0);

      // Server-side slot cache: only slots recorded here can be turned into a
      // choice_id the model may act on (prompt-injection stance). ALL served
      // slots are cached — including full ones — so join_waitlist can resolve a
      // full slot's choice_id back to its event_id. Full slots are still never
      // bookable: create_payment_link re-verifies openness live (isSlotStillOpen)
      // before taking any money, so a cached full slot is rejected there.
      await repo.cacheSlots(
        client.id,
        serviceId,
        slots.map((s) => ({ eventId: s.eventId, slot: s.raw })),
      );

      if (openSlots.length > 0) {
        await trackFunnel({
          clientId: client.id,
          stage: "slots_shown",
          metadata: {
            service_id: serviceId,
            open_slots: openSlots.length,
            used_next_window: alternativeSlots.length > 0,
          },
        });
      }

      const preferredPaymentMethod = await repo.lastSuccessfulBookingPaymentMethod(client.id);

      return JSON.stringify({
        service_id: serviceId,
        service: service.name,
        requested_period: { date_from: dateFrom, date_to: dateTo },
        alternative_period: alternativeWindow
          ? { date_from: alternativeWindow.dateFrom, date_to: alternativeWindow.dateTo }
          : undefined,
        timezone_note:
          "start_dakar is the class time in Dakar local time — relay it verbatim. NEVER convert timezones or mention GMT/UTC.",
        closed_dates:
          closures.length > 0
            ? closures.map((c) => ({
                reason: c.reason,
                from: c.starts_at.toISOString(),
                to: c.ends_at.toISOString(),
              }))
            : undefined,
        slots: slots.map((s) => slotResult(s, alternativeSlots.includes(s))),
        ...paymentChoicePayload(preferredPaymentMethod),
        note:
          requestedOpenSlots.length === 0 && alternativeSlots.some((s) => s.openSpots > 0)
            ? "No open slot existed in the requested period, so the server searched the next seven-day window once. " +
              "Present the open alternative slots NOW in the same response and clearly label alternative_period; do not ask whether to search farther first."
            : requestedOpenSlots.length === 0
              ? "No open slot exists in the requested period or the next seven-day window. Say which two periods were checked; do not claim the class is unavailable forever."
            : slots.some((s) => s.openSpots <= 0)
            ? "Slots marked full:true exist but cannot be booked — if the client asked for one of them, say it's " +
              "full and suggest open alternatives; if they still want THAT slot, offer the waitlist (join_waitlist " +
              "with its choice_id)."
            : undefined,
      });
    }

    case "create_payment_link": {
      const claimedServiceId = String(input.service_id ?? "");
      const eventId = String(input.event_id ?? "");
      const clientName = String(input.client_name ?? "").slice(0, 80).trim();
      const participants = Math.min(10, Math.max(1, Math.round(Number(input.participants ?? 1)) || 1));
      if (!claimedServiceId || !eventId || !clientName) {
        return JSON.stringify({ error: "invalid_arguments" });
      }

      // 0. Code-before-payment: refuse while an email verification is live,
      //    unless the client explicitly declined it (see verificationBlocksPayment).
      const pendingVerification = await links.getOpen(client.id);
      if (
        input.client_declined_verification !== true &&
        verificationBlocksPayment(pendingVerification, new Date())
      ) {
        return VERIFICATION_PENDING_RESULT;
      }

      // The offered slot is the server authority for the service. The model may
      // repeat a human-readable alias, but it cannot change the class or price:
      // both come from the client-scoped slot cache populated by availability.
      const cached = await repo.getCachedSlot(client.id, eventId);
      if (!cached) {
        return JSON.stringify({
          error: "unknown_slot",
          message: "This slot was not offered to the client. Re-run check_availability and pick from its results.",
        });
      }
      const serviceId = cached.service_id;
      if (claimedServiceId !== serviceId) {
        console.warn("Service id mismatch recovered from offered slot", {
          tool: name,
          clientId: client.id,
          claimedServiceId,
          canonicalServiceId: serviceId,
        });
      }

      // 0c. Membership-coverage guard (server decides): if the client's active
      //     plan covers THIS service with enough sessions, refuse the paid link
      //     and route through book_with_membership — prevents double-charging a
      //     class the plan already pays for. Uses only cached data (memberships
      //     + services are both memoized this turn). Any lookup miss → allow
      //     payment (never strand a booking on a flaky read). Non-looping: fires
      //     only when remaining >= participants (see findCoveringPlan).
      try {
        const membership = await activeMemberships(client);
        if (membership && membership.plans.length > 0) {
          const services = await wix.listServices();
          const svc = services.find((s) => s.id === serviceId);
          const covering = findCoveringPlan(
            serviceId,
            svc?.pricingPlanIds,
            membership.plans,
            participants,
          );
          if (covering) {
            return JSON.stringify({
              error: "covered_by_membership",
              message:
                `Ce client a un abonnement actif « ${covering.plan} » qui couvre ce cours ` +
                `(${covering.remaining} séance(s) restante(s)). Réserve avec book_with_membership ` +
                `(participants=${participants}) — ne crée PAS de lien de paiement et ne facture pas ce cours en plus. ` +
                `Si book_with_membership répond not_enough_sessions, tu pourras alors proposer le paiement de l'appoint. ` +
                `CAS ACCOMPAGNANT (« je paie pour mon ami(e) », une place en plus pour quelqu'un d'autre) : réserve ` +
                `d'abord LA place du client avec book_with_membership, puis appelle add_spots_to_booking avec le ` +
                `booking_id retourné et extra_participants pour la/les place(s) de l'accompagnant — ça crée le lien de ` +
                `paiement UNIQUEMENT pour ces places-là, sans toucher à l'abonnement. Ne repasse jamais par ` +
                `create_payment_link pour l'accompagnant : il sera refusé ici même (incident Khadidjatou 02/08).`,
            });
          }
        }
      } catch (err) {
        console.error("Membership-coverage guard skipped (lookup failed):", err);
      }

      // 0b. Multi-session commitment gating. While a commitment is ACTIVE for
      //     THIS class, every link must be tied to one of its sessions — an
      //     ungrouped link for the same class would silently break the plan.
      const activeCommitment = await commitments.activeCommitment(client.id);
      let commitmentItemId: string | null =
        input.commitment_item_id != null ? String(input.commitment_item_id) : null;
      let commitmentItem: commitments.CommitmentItem | null = null;
      if (activeCommitment && activeCommitment.service_id === serviceId && !commitmentItemId) {
        const snap = await commitments.commitmentSnapshot(activeCommitment.id);
        return JSON.stringify({
          error: "commitment_item_required",
          commitment_item_id: snap?.next_item?.id ?? null,
          progress: snap ? `${snap.booked_count}/${snap.commitment.requested_count}` : undefined,
          message:
            "This client has an active multi-session plan for this class. Pass commitment_item_id for the next " +
            "unpaid session (returned here as commitment_item_id) so the plan advances; do not create an ungrouped link. " +
            "If they instead want to STOP the plan, call abandon_multi_session_commitment first.",
        });
      }
      if (commitmentItemId) {
        commitmentItem = await commitments.getItem(commitmentItemId);
        if (
          !commitmentItem ||
          !activeCommitment ||
          commitmentItem.commitment_id !== activeCommitment.id ||
          activeCommitment.service_id !== serviceId
        ) {
          return JSON.stringify({
            error: "invalid_commitment_item",
            message:
              "commitment_item_id doesn't match this client's active plan for this class. Omit it for a standalone " +
              "booking, or re-check the active plan.",
          });
        }
        if (commitmentItem.intent_status === "CANCELLED") {
          return JSON.stringify({
            error: "commitment_item_cancelled",
            message: "That session was cancelled. Pick another session of the plan or start fresh.",
          });
        }
        const block = await commitments.itemPaymentBlock(commitmentItemId);
        if (block === "booked") {
          return JSON.stringify({
            error: "commitment_item_already_booked",
            message: "That session is already booked. Move to the next unpaid session of the plan.",
          });
        }
        if (block === "in_flight") {
          return JSON.stringify({
            error: "commitment_item_in_flight",
            message: "That session already has a payment being processed. Wait for it to settle before retrying.",
          });
        }
      }

      // 1. The event_id must be one we served this client (prompt-injection
      //    stance). Accepts the short choice_id alias too (interactive clicks).
      const resolvedEventId = cached.event_id;
      await trackFunnel({
        clientId: client.id,
        stage: "slot_selected",
        metadata: { service_id: serviceId, participants },
      });

      // 2. Price comes from the catalog, never from the model.
      const service = await wix.getService(serviceId);
      if (!service) return await unknownServiceIdResult();
      if (!service.priceXof || service.priceXof <= 0) {
        return JSON.stringify({
          error: "no_price",
          message:
            "This class has no fixed price configured. Call handoff_to_human and reception " +
            "will reach out to the client.",
        });
      }

      // 2b. Wix rejects a single booking above the service's participants cap
      //     — enforce BEFORE taking money (a 5-spot payment once ended in a
      //     refund because the cap was 3).
      if (participants > service.maxParticipantsPerBooking) {
        await trackFunnel({
          clientId: client.id,
          stage: "slot_selected",
          failureCode: "group_capacity",
          metadata: {
            service_id: serviceId,
            participants,
            max_participants: service.maxParticipantsPerBooking,
          },
        });
        return JSON.stringify({
          error: "group_too_large",
          max_participants_per_booking: service.maxParticipantsPerBooking,
          message:
            `This class allows at most ${service.maxParticipantsPerBooking} spot(s) per booking. ` +
            `Offer to book ${service.maxParticipantsPerBooking} now (they can pay and book the rest right after, ` +
            `one booking at a time). For the whole group at once, call handoff_to_human and reception ` +
            `will reach out to them.`,
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
        await trackFunnel({
          clientId: client.id,
          stage: "slot_selected",
          failureCode: "slot_already_started",
          metadata: { service_id: serviceId, selection_result: "started" },
        });
        const alternatives = await freshSlotAlternatives(client.id, serviceId, resolvedEventId);
        return JSON.stringify({
          error: "slot_already_started",
          alternatives: alternatives.map((s) => slotResult(s, true)),
          message:
            "This class has already started — it can no longer be booked. " +
            "Apologize and present the fresh alternatives returned here immediately in the same response.",
        });
      }

      // 3a-bis. Never sell a slot that falls on a studio closure created after
      //         it was offered/cached (Maggal, holiday…). Payment-link creation
      //         is a guarded chokepoint; a closed slot here would end in a refund.
      const slotClosure = await closuresRepo.closureAt(new Date(slotStart)).catch(() => null);
      if (slotClosure) {
        const alternatives = await freshSlotAlternatives(client.id, serviceId, resolvedEventId);
        return JSON.stringify({
          error: "studio_closed",
          reason: slotClosure.reason,
          alternatives: alternatives.map((s) => slotResult(s, true)),
          message:
            `Le studio est fermé ce jour-là (${slotClosure.reason}) — cette séance n'est pas réservable. ` +
            "Excuse-toi, explique la fermeture, et propose immédiatement les alternatives fournies ici.",
        });
      }

      const fresh = await wix.isSlotStillOpen(serviceId, resolvedEventId, slotStart, participants);
      if (!fresh) {
        await trackFunnel({
          clientId: client.id,
          stage: "slot_selected",
          failureCode: participants > 1 ? "group_capacity" : "slot_unavailable",
          metadata: { service_id: serviceId, participants, selection_result: "unavailable" },
        });
        const alternatives = await freshSlotAlternatives(client.id, serviceId, resolvedEventId);
        return JSON.stringify({
          error: "not_enough_spots",
          alternatives: alternatives.map((s) => slotResult(s, true)),
          message:
            participants > 1
              ? `Fewer than ${participants} open spots remain. Present the fresh alternatives returned here immediately, or offer a smaller group.`
              : "This slot just filled up. Apologize and present the fresh alternatives returned here immediately in the same response.",
        });
      }

      // Resolve the campaign plan identity before asking for a payment method:
      // strict conversation order is name → email proof → payment. This is
      // read-only; member creation still happens after the payment guard.
      const campaign =
        !config.KEYS_AUTOMATION_ENABLED &&
        participants === 1 &&
        isCampaignReformerService({
          serviceId,
          serviceName: service.name,
          configuredServiceIds: config.PACK_DISCOVERY_SERVICE_IDS,
        }) &&
        await repo.activeCampaignLead(client.id, PACK_DISCOVERY_CAMPAIGN);
      let campaignMemberContext: PlanMemberContext | null = null;
      if (campaign) {
        campaignMemberContext = await resolvePlanMemberContext(
          client,
          `+${client.wa_phone.replace(/^\+/, "")}`,
          clientName || client.name || "",
          pendingVerification,
        );
        if (
          campaignMemberContext.contactId &&
          await wix.hasPastPilatesBooking(campaignMemberContext.contactId)
        ) {
          return JSON.stringify({
            error: "discovery_not_eligible",
            message: "Client already did Pilates at Revive; offer the normal class price.",
          });
        }
        if (
          config.PACK_DISCOVERY_STEP1_PLAN_ID &&
          campaignMemberContext.decision.action === "require_verification"
        ) {
          return verificationRequiredResult(
            "discovery_member_verification_required",
            campaignMemberContext.decision.codeAlreadySent,
          );
        }
      }

      const preferred = await repo.lastSuccessfulBookingPaymentMethod(client.id);
      const pay = resolvePaymentMethod(input.payment_method, om.isOmEnabled(), preferred);
      if (!pay.ok) {
        return JSON.stringify({
          error: pay.error,
          message: pay.message,
          ...paymentChoicePayload(preferred),
          note: "An explicit choice is still required. Present payment_options in exactly the returned order.",
        });
      }

      // 4. Keep the client name current before either the direct-class or
      // Pack Découverte plan path below.
      await repo.updateClientName(client.id, clientName);

      // 4b. Re-selection: a commitment session whose agreed slot the client just
      //     changed (NEEDS_RESELECTION, or simply a different valid choice_id) —
      //     re-point the session to the freshly validated slot before drafting.
      if (commitmentItemId && commitmentItem && commitmentItem.event_id !== resolvedEventId) {
        await commitments.reselectItemSlot(commitmentItemId, resolvedEventId, fresh.startDate);
      }

      // 5. DRAFT booking → payment session → AWAITING_PAYMENT. Class only.

      // Pack Découverte Meta leads buy a REAL one-session plan for the first
      // payment. The later webhook redeems that benefit against this exact slot
      // so Wix shows an abonnement deduction in the participant list.
      if (campaign && config.PACK_DISCOVERY_STEP1_PLAN_ID) {
        if (fresh.startDate && Date.parse(fresh.startDate) > Date.now() + 7 * 24 * 60 * 60 * 1000) {
          return JSON.stringify({
            error: "discovery_step1_slot_too_late",
            message:
              "The first Pack Découverte plan is valid for seven days, so this selected class is too far away. " +
              "Re-run check_availability and offer a Reformer slot within the next seven days.",
          });
        }

        const step1Plan = await wix.getPlan(config.PACK_DISCOVERY_STEP1_PLAN_ID);
        if (!step1Plan || step1Plan.priceXof !== 10_000) {
          return JSON.stringify({
            error: "discovery_step1_plan_unavailable",
            message: "Pack Découverte étape 1 is not configured correctly in Wix. Hand off to reception; do not take payment.",
          });
        }
        const covered = await wix.planCoveredClassNames(step1Plan.id);
        if (covered !== null && !covered.includes(service.name)) {
          return JSON.stringify({
            error: "discovery_step1_not_covered",
            message: "The étape-1 plan does not cover this class in Wix. Hand off to reception; do not take payment.",
          });
        }

        const prepared = await provisionPlanMember(campaignMemberContext!, client);
        if (prepared.status === "verification_required") {
          return verificationRequiredResult(
            "discovery_member_verification_required",
            prepared.codeAlreadySent,
          );
        }
        if (prepared.status === "failed") {
          return JSON.stringify({
            error:
              prepared.reason === "contact_mismatch"
                ? "discovery_member_contact_mismatch"
                : "discovery_member_creation_failed",
            message:
              "The Wix member attachment could not be prepared safely. Reception has been notified and no payment was created.",
          });
        }

        await repo.expireActivePlanOrders(client.id);
        const planDraft = await repo.createDraftPlanOrder({
          clientId: client.id,
          planId: step1Plan.id,
          planName: step1Plan.name,
          amountXof: step1Plan.priceXof,
          memberId: prepared.memberId,
          campaignCode: PACK_DISCOVERY_CAMPAIGN,
          serviceId,
          serviceName: service.name,
          eventId: resolvedEventId,
          slotJson: fresh.raw,
          slotStart: fresh.startDate,
          slotEnd: fresh.endDate ?? null,
        });
        let session;
        try {
          session = await createClientPaymentSession({
            method: pay.method,
            amountXof: step1Plan.priceXof,
            clientReference: planDraft.id,
            name: step1Plan.name,
          });
        } catch (err) {
          await repo.expireActivePlanOrders(client.id);
          throw err;
        }
        await repo.setPlanOrderAwaitingPayment(
          planDraft.id,
          session.sessionId,
          session.paymentLink,
          session.expiresAt,
          session.method,
        );
        return JSON.stringify({
          payment_link: session.paymentLink,
          payment_method: session.method,
          payment_app: paymentMethodLabel(session.method),
          amount_fcfa: step1Plan.priceXof,
          class: service.name,
          slot_start: fresh.startDate,
          slot_start_dakar: fmtDakar(fresh.startDate),
          expires_in_minutes: config.PAYMENT_LINK_TTL_MINUTES,
          plan: step1Plan.name,
          note:
            "Relay only the class, the 10 000 FCFA amount, expiry, and payment link. After verified payment, " +
            "Awa activates the Wix Pack Découverte étape 1 plan and confirms this selected class using its one session.",
        });
      }

      // One active class-payment link per client. This is deliberately after
      // the campaign-plan branch so an email/account issue never invalidates
      // another usable direct-class link.
      await repo.expireActiveBookings(client.id);
      const totalXof = campaign ? 10_000 : service.priceXof * participants;
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
        commitmentItemId,
        campaignCode: campaign ? PACK_DISCOVERY_CAMPAIGN : null,
      });

      let session;
      try {
        session = await createClientPaymentSession({
          method: pay.method,
          amountXof: totalXof,
          clientReference: draft.id,
          name: service.name,
        });
      } catch (err) {
        await repo.expireActiveBookings(client.id); // clean up the DRAFT
        await trackFunnel({
          clientId: client.id,
          bookingId: draft.id,
          stage: "technical_failure",
          paymentMethod: pay.method,
          failureCode: "payment_provider_error",
          idempotencyKey: `booking:${draft.id}:payment-provider-error`,
          metadata: { operation: "create_payment_link", service_id: serviceId },
        });
        throw err;
      }

      await repo.setAwaitingPayment(
        draft.id,
        session.sessionId,
        session.paymentLink,
        session.expiresAt,
        session.method,
      );
      await trackFunnel({
        clientId: client.id,
        bookingId: draft.id,
        stage: "payment_link_created",
        paymentMethod: session.method,
        idempotencyKey: `booking:${draft.id}:payment-link-created`,
        metadata: {
          service_id: serviceId,
          amount_xof: totalXof,
          participants,
          expires_in_minutes: config.PAYMENT_LINK_TTL_MINUTES,
        },
      });

      const appLabel = paymentMethodLabel(session.method);
      return JSON.stringify({
        payment_link: session.paymentLink,
        payment_method: session.method,
        payment_app: appLabel,
        amount_fcfa: totalXof,
        class_total_fcfa: totalXof,
        participants,
        price_per_person_fcfa: service.priceXof,
        expires_in_minutes: config.PAYMENT_LINK_TTL_MINUTES,
        class: service.name,
        slot_start: fresh.startDate,
        slot_start_dakar: fmtDakar(fresh.startDate),
        note:
          `Your reply must contain ONLY the class, amount, expiry, and payment link. ` +
          `Do not add the bar, another class, an upsell, or any unrelated suggestion while payment is unresolved. ` +
          `The client chose ${appLabel}; confirmation arrives automatically after verified payment.` +
          (await omOutageNoteFor(session.method)),
      });
    }

    case "start_multi_session_commitment": {
      const claimedServiceId = String(input.service_id ?? "");
      const clientName = String(input.client_name ?? "").slice(0, 80).trim();
      const rawSlots = Array.isArray(input.slots) ? input.slots : [];
      if (!claimedServiceId || !clientName || rawSlots.length < 2) {
        return JSON.stringify({ error: "invalid_arguments" });
      }

      // Resolve every choice_id server-side (prompt-injection stance): each must
      // be a slot we served this client, for ONE class, still in the future.
      const resolved: { eventId: string; slotStart: string }[] = [];
      let serviceId: string | null = null;
      for (const raw of rawSlots) {
        const choiceId = String((raw as any)?.event_id ?? "");
        const cached = await repo.getCachedSlot(client.id, choiceId);
        if (!cached || (serviceId !== null && cached.service_id !== serviceId)) {
          return JSON.stringify({
            error: "unknown_slot",
            message:
              "One of the sessions wasn't offered to this client for the same class. Re-run check_availability " +
              "and rebuild the list from its results.",
          });
        }
        serviceId ??= cached.service_id;
        const slotStart = (cached.slot_json as any)?.startDate ?? "";
        if (!slotStart || Date.parse(slotStart) <= Date.now()) {
          return JSON.stringify({
            error: "slot_already_started",
            message: "One of the agreed sessions is in the past. Pick fresh slots and try again.",
          });
        }
        resolved.push({ eventId: cached.event_id, slotStart });
      }
      if (!serviceId) return JSON.stringify({ error: "unknown_slot" });
      if (claimedServiceId !== serviceId) {
        console.warn("Service id mismatch recovered from offered slots", {
          tool: name,
          clientId: client.id,
          claimedServiceId,
          canonicalServiceId: serviceId,
        });
      }
      const service = await wix.getService(serviceId);
      if (!service) return await unknownServiceIdResult();

      await repo.updateClientName(client.id, clientName);
      const result = await commitments.startCommitment({
        clientId: client.id,
        serviceId,
        serviceName: service.name,
        requestedCount: resolved.length,
        slots: resolved,
      });

      if (result.outcome === "conflict") {
        return JSON.stringify({
          error: "active_commitment_exists",
          existing: {
            service: result.existing.commitment.service_name,
            progress: `${result.existing.booked_count}/${result.existing.commitment.requested_count}`,
          },
          message:
            "This client already has a different active multi-session plan. To start this new one, call " +
            "abandon_multi_session_commitment first (their already-booked sessions are kept), then retry.",
        });
      }

      const snap = result.snapshot;
      return JSON.stringify({
        ok: true,
        commitment_id: snap.commitment.id,
        service: snap.commitment.service_name,
        requested_count: snap.commitment.requested_count,
        booked_count: snap.booked_count,
        next_commitment_item_id: snap.next_item?.id ?? null,
        already_existed: result.outcome === "existing",
        note:
          `Plan saved: ${snap.commitment.requested_count} sessions of ${snap.commitment.service_name}. ` +
          `Now create the FIRST session's payment link with create_payment_link, passing ` +
          `commitment_item_id = next_commitment_item_id. After each paid session I'll ask the client whether ` +
          `to continue — never promise to send the next link yourself.`,
      });
    }

    case "abandon_multi_session_commitment": {
      const active = await commitments.activeCommitment(client.id);
      if (!active) {
        return JSON.stringify({
          error: "no_active_commitment",
          message: "This client has no active multi-session plan to stop.",
        });
      }
      const outcome = await commitments.abandonCommitment(client.id, active.id);
      if (outcome === "deferred") {
        return JSON.stringify({
          error: "payment_settling",
          message:
            "A session of this plan was just paid and is still being confirmed. Tell the client you'll stop the " +
            "rest once that one finishes, and try again in a moment.",
        });
      }
      return JSON.stringify({
        ok: true,
        message:
          "Plan stopped. Any sessions already booked and paid are kept; the remaining unpaid sessions are " +
          "cancelled. Confirm this to the client.",
      });
    }

    case "add_spots_to_booking": {
      const bookingId = String(input.booking_id ?? "").trim();

      // Studio bookings (counter/website) have no local slot to extend.
      if (bookingId.startsWith("studio:")) {
        return JSON.stringify({
          error: "studio_booking_not_extendable",
          message:
            "This booking was taken at the counter or on the website, so I can't add to it directly. Book the " +
            "extra spots as a NEW booking on the same slot instead: check_availability for that class, then " +
            "create_payment_link with the number of extra people.",
        });
      }
      if (!UUID_RE.test(bookingId)) {
        return JSON.stringify({
          error: "unknown_booking",
          message: "That doesn't look like a booking id. Get it from get_my_bookings.",
        });
      }

      // 0. Code-before-payment guard (same as create_payment_link).
      const pendingVerification = await links.getOpen(client.id);
      if (
        input.client_declined_verification !== true &&
        verificationBlocksPayment(pendingVerification, new Date())
      ) {
        return VERIFICATION_PENDING_RESULT;
      }

      // 1. Ownership + eligibility (belongs to client, BOOKED, in the future, 1–10).
      const booking = await repo.findClientBooking(client.id, bookingId);
      const check = validateAddSpots(booking, input.extra_participants, new Date());
      if (!check.ok) return JSON.stringify({ error: check.error, message: check.message });
      const source = booking!;
      const extra = check.extra;
      await trackFunnel({
        clientId: client.id,
        stage: "slot_selected",
        metadata: { service_id: source.service_id, participants: extra, booking_extension: true },
      });

      // 2. Price from the catalog (never the model) + per-booking cap (the NEW
      //    booking must satisfy the cap on its own).
      const service = await wix.getService(source.service_id);
      if (!service) return await unknownServiceIdResult();
      if (!service.priceXof || service.priceXof <= 0) {
        return JSON.stringify({
          error: "no_price",
          message:
            "This class has no fixed price configured. Call handoff_to_human and reception will reach out to the client.",
        });
      }
      if (extra > service.maxParticipantsPerBooking) {
        await trackFunnel({
          clientId: client.id,
          stage: "slot_selected",
          failureCode: "group_capacity",
          metadata: {
            service_id: source.service_id,
            participants: extra,
            max_participants: service.maxParticipantsPerBooking,
            booking_extension: true,
          },
        });
        return JSON.stringify({
          error: "group_too_large",
          max_participants_per_booking: service.maxParticipantsPerBooking,
          message:
            `This class allows at most ${service.maxParticipantsPerBooking} spot(s) per booking, so I can add at ` +
            `most that many at once. Offer to add ${service.maxParticipantsPerBooking} now (the rest right after), ` +
            `or handoff_to_human for the whole group.`,
        });
      }

      // 3. Re-verify the SAME slot still has enough open spots for the addition.
      const slotStart = new Date(source.slot_start).toISOString();
      const fresh = await wix.isSlotStillOpen(source.service_id, source.event_id, slotStart, extra);
      if (!fresh) {
        await trackFunnel({
          clientId: client.id,
          stage: "slot_selected",
          failureCode: extra > 1 ? "group_capacity" : "slot_unavailable",
          metadata: { service_id: source.service_id, participants: extra, booking_extension: true },
        });
        const alternatives = await freshSlotAlternatives(
          client.id,
          source.service_id,
          source.event_id,
        );
        return JSON.stringify({
          error: "not_enough_spots",
          alternatives: alternatives.map((s) => slotResult(s, true)),
          message:
            `Fewer than ${extra} open spot(s) remain. Present the fresh alternatives returned here immediately, ` +
            `or offer a smaller number.`,
        });
      }

      // 4. One active link per client: expire any DRAFT/AWAITING (never the source BOOKED row).
      const preferred = await repo.lastSuccessfulBookingPaymentMethod(client.id);
      const pay = resolvePaymentMethod(input.payment_method, om.isOmEnabled(), preferred);
      if (!pay.ok) {
        return JSON.stringify({
          error: pay.error,
          message: pay.message,
          ...paymentChoicePayload(preferred),
          note: "An explicit choice is still required. Present payment_options in exactly the returned order.",
        });
      }
      await repo.expireActiveBookings(client.id);

      // 5. NEW booking on the same event for ONLY the extra spots. The paid row
      //    and its Wix booking are never touched; the payment-first pipeline
      //    creates the extra Wix booking on payment.
      const totalXof = service.priceXof * extra;
      const draft = await repo.createDraftBooking({
        clientId: client.id,
        serviceId: source.service_id,
        serviceName: service.name,
        eventId: source.event_id,
        slotJson: fresh.raw,
        slotStart: fresh.startDate,
        slotEnd: fresh.endDate ?? null,
        amountXof: totalXof,
        participants: extra,
        extrasJson: null,
        extrasAmountXof: 0,
        orderNote: `Ajout de ${extra} place(s) à la résa ${source.id.slice(0, 8)}`,
      });

      let session;
      try {
        session = await createClientPaymentSession({
          method: pay.method,
          amountXof: totalXof,
          clientReference: draft.id,
          name: service.name,
        });
      } catch (err) {
        await repo.expireActiveBookings(client.id); // clean up the DRAFT
        await trackFunnel({
          clientId: client.id,
          bookingId: draft.id,
          stage: "technical_failure",
          paymentMethod: pay.method,
          failureCode: "payment_provider_error",
          idempotencyKey: `booking:${draft.id}:payment-provider-error`,
          metadata: { operation: "add_spots_payment", service_id: source.service_id },
        });
        throw err;
      }
      await repo.setAwaitingPayment(draft.id, session.sessionId, session.paymentLink, session.expiresAt, session.method);
      await trackFunnel({
        clientId: client.id,
        bookingId: draft.id,
        stage: "payment_link_created",
        paymentMethod: session.method,
        idempotencyKey: `booking:${draft.id}:payment-link-created`,
        metadata: {
          service_id: source.service_id,
          amount_xof: totalXof,
          participants: extra,
          booking_extension: true,
          expires_in_minutes: config.PAYMENT_LINK_TTL_MINUTES,
        },
      });

      const appLabel = paymentMethodLabel(session.method);
      return JSON.stringify({
        payment_link: session.paymentLink,
        payment_method: session.method,
        payment_app: appLabel,
        amount_fcfa: totalXof,
        extra_participants: extra,
        price_per_person_fcfa: service.priceXof,
        existing_participants: source.participants,
        total_after_payment: source.participants + extra,
        expires_in_minutes: config.PAYMENT_LINK_TTL_MINUTES,
        class: service.name,
        slot_start: fresh.startDate,
        slot_start_dakar: fmtDakar(fresh.startDate),
        note:
          `Your reply must contain ONLY the class, amount, expiry, and payment link. ` +
          `Do not add the bar or any unrelated suggestion while payment is unresolved. The link covers ${extra} ` +
          `additional spot(s), and the automatic confirmation arrives after verified payment.`,
      });
    }

    case "create_cafe_payment_link": {
      const linkedBookingId = String(input.linked_booking_id ?? "").trim();

      // The bar preferably rides on one of THIS client's own confirmed,
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
      const resolved = computeExtras(getCafeMenu().items, input.extras, { requireChoices: true });
      if (!resolved.ok) {
        return JSON.stringify({
          error: resolved.error,
          message: resolved.message,
          unknown_item_ids: resolved.unknownIds,
          valid_item_ids: resolved.validIds,
        });
      }
      if (resolved.totalXof <= 0) {
        return JSON.stringify({ error: "empty_order", message: "The bar order is empty." });
      }
      const orderNote = String(input.order_note ?? "").slice(0, 200).trim() || null;

      const pay = resolvePaymentMethod(input.payment_method, om.isOmEnabled());
      if (!pay.ok) return JSON.stringify({ error: pay.error, message: pay.message });

      // One active bar link per client at a time.
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
        session = await createClientPaymentSession({
          method: pay.method,
          amountXof: resolved.totalXof,
          clientReference: draft.id,
          name: "Bar Revive",
        });
      } catch (err) {
        await repo.expireActiveCafeOrders(client.id); // clean up the DRAFT
        throw err;
      }

      await repo.setCafeOrderAwaitingPayment(
        draft.id,
        session.sessionId,
        session.paymentLink,
        session.expiresAt,
        session.method,
      );

      const appLabel = paymentMethodLabel(session.method);
      return JSON.stringify({
        payment_link: session.paymentLink,
        payment_method: session.method,
        payment_app: appLabel,
        amount_fcfa: resolved.totalXof,
        extras: resolved.lines.map((l) => ({ item: l.name, qty: l.qty, line_total_fcfa: l.lineTotalXof })),
        order_note: orderNote ?? undefined,
        expires_in_minutes: config.PAYMENT_LINK_TTL_MINUTES,
        for_class: booking?.service_name ?? undefined,
        slot_start_dakar: booking ? fmtDakar(String(booking.slot_start)) : undefined,
        standalone_order: booking ? undefined : true,
        note: booking
          ? `Relay the link (open in ${appLabel}) — ONLY the bar order. Confirmation arrives automatically once paid.`
          : `Relay the link (open in ${appLabel}) — standalone bar order, pick up at the counter. Confirmation automatic once paid.`,
      });
    }

    case "create_delivery_payment_link": {
      const orderId = String(input.delivery_order_id ?? "").trim();
      const rawMethod = String(input.payment_method ?? "").trim().toLowerCase();
      const order = await deliveries.findDeliveryOrder(orderId);
      if (!order || order.client_phone.replace(/\D/g, "") !== client.wa_phone.replace(/\D/g, "")) {
        return JSON.stringify({
          error: "unknown_delivery",
          message: "This open delivery does not belong to this WhatsApp client.",
        });
      }
      if (!['IN_KITCHEN', 'OUT_FOR_DELIVERY'].includes(order.status)) {
        return JSON.stringify({
          error: "delivery_closed",
          message: "This delivery is already closed and its payment choice cannot be changed.",
        });
      }
      if (order.payment_status === "PAID") {
        return JSON.stringify({
          already_paid: true,
          amount_fcfa: order.amount_xof,
          payment_method: order.payment_method,
          note: "Confirm that payment was already received. Do not create or send another link.",
        });
      }
      if (order.payment_status === "REFUND_NEEDED") {
        return JSON.stringify({
          error: "payment_review_required",
          message: "A late or duplicate payment needs reception review. Do not request another payment.",
        });
      }

      if (rawMethod === "cash" || rawMethod === "especes" || rawMethod === "espèces") {
        const selected = await deliveries.selectDeliveryCash(order.id);
        if (!selected) return JSON.stringify({ error: "delivery_not_payable" });
        notifyReception(
          `${order.is_test ? "🧪 TEST — " : ""}💵 Espèces choisies — livraison`,
          `Client : ${order.client_name} (+${order.client_phone})\n` +
            `Montant à encaisser à la livraison : ${order.amount_xof} FCFA\n` +
            `Commande : ${formatExtrasOneLine(deliveries.orderItems(order))}\n` +
            (order.activated_at
              ? `Le départ est maintenant autorisé.`
              : `Le paiement est enregistré ; le départ restera bloqué jusqu'à l'activation cuisine.`),
          { whatsappFirst: true, preferTemplate: true },
        );
        return JSON.stringify({
          cash_selected: true,
          delivery_order_id: order.id,
          amount_fcfa: order.amount_xof,
          note:
            "Confirm that cash is recorded and the exact amount will be handed to the delivery person. Do not send a payment link.",
        });
      }

      const pay = resolvePaymentMethod(rawMethod, om.isOmEnabled());
      if (!pay.ok) {
        return JSON.stringify({
          error: pay.error,
          message:
            pay.error === "payment_method_required"
              ? "Ask the client to choose Wave, Orange Money, Max It, or cash."
              : pay.message,
        });
      }

      const active = await deliveries.activeDeliveryPaymentAttempt(order.id);
      if (active && active.method === pay.method && active.payment_link && active.link_expires_at) {
        return JSON.stringify({
          payment_link: active.payment_link,
          payment_method: active.method,
          payment_app: paymentMethodLabel(active.method),
          amount_fcfa: active.amount_xof,
          delivery_order_id: order.id,
          expires_in_minutes: Math.max(
            1,
            Math.round((new Date(active.link_expires_at).getTime() - Date.now()) / 60_000),
          ),
          reused_active_link: true,
          note: "Send only this delivery payment link and its amount. Confirmation is automatic after verified payment.",
        });
      }

      const attempt = await deliveries.createDraftDeliveryPaymentAttempt({
        orderId: order.id,
        clientId: client.id,
        clientPhone: client.wa_phone,
        method: pay.method,
      });
      if (!attempt) return JSON.stringify({ error: "delivery_not_payable" });

      let session;
      try {
        session = await createClientPaymentSession({
          method: pay.method,
          amountXof: attempt.amount_xof,
          clientReference: attempt.id,
          name: `Livraison Revive — ${order.client_name}`,
        });
      } catch (error) {
        await deliveries.setDeliveryPaymentAttemptFailed(attempt.id);
        throw error;
      }
      const awaiting = await deliveries.setDeliveryPaymentAwaiting({
        attemptId: attempt.id,
        sessionId: session.sessionId,
        paymentLink: session.paymentLink,
        expiresAt: session.expiresAt,
      });
      if (!awaiting) return JSON.stringify({ error: "delivery_not_payable" });

      return JSON.stringify({
        payment_link: session.paymentLink,
        payment_method: session.method,
        payment_app: paymentMethodLabel(session.method),
        amount_fcfa: order.amount_xof,
        delivery_order_id: order.id,
        expires_in_minutes: config.PAYMENT_LINK_TTL_MINUTES,
        items: formatExtrasOneLine(deliveries.orderItems(order)),
        note:
          "Send only the delivery total, expiry, and payment link. Do not mention cash on delivery. Verified payment automatically unlocks departure.",
      });
    }

    case "list_plans": {
      const plans = (await wix.listPlans()).filter(
        (p) =>
          isPlanSellableByAwa(p.id, config.AWA_SELLABLE_PLAN_IDS) &&
          !config.PACK_DISCOVERY_CONTINUATION_PLAN_IDS.includes(p.id),
      );
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
                  ? `Renouvelé chaque ${p.periodLabel ?? "période"} — via Awa le paiement couvre la première période ; pour renouveler, il suffit de racheter le plan ici quand il se termine.`
                  : undefined,
            };
          }),
        ),
      );
    }

    case "create_plan_payment_link": {
      const planId = String(input.plan_id ?? "");
      const planNameConfirm = String(input.plan_name_confirm ?? "").trim();
      const clientName = String(input.client_name ?? "").slice(0, 80).trim();
      if (!planId || !planNameConfirm || !clientName) {
        return JSON.stringify({ error: "invalid_arguments" });
      }

      // Code-before-payment: don't sell a plan while an email verification is
      // live — the client may already own a plan under another number.
      const pendingVerification = await links.getOpen(client.id);
      if (
        input.client_declined_verification !== true &&
        verificationBlocksPayment(pendingVerification, new Date())
      ) {
        return verificationRequiredResult("plan_member_verification_required", true);
      }

      // Price and existence come from the Wix catalog — never from the model.
      const plan = await wix.getPlan(planId);
      if (!plan) return await unknownPlanIdResult();
      if (!isPlanSellableByAwa(plan.id, config.AWA_SELLABLE_PLAN_IDS)) {
        return JSON.stringify({
          error: "plan_not_sellable",
          message: "This Wix plan is internal or not launched. Do not create a payment link; re-run list_plans.",
        });
      }
      if (config.PACK_DISCOVERY_CONTINUATION_PLAN_IDS.includes(plan.id)) return JSON.stringify({ error: "reception_only_plan", message: "Reception activates this Pack Découverte continuation at the studio; do not sell it." });
      // Anti-conflation guard: the id and the name the model confirmed must be the
      // SAME plan. When a conversation jumps topics (e.g. Pack Découverte → Aquabike)
      // the model can pair a stale plan_id with the intended name and bill the wrong
      // pack. Compare on a normalized form (accent/case/punctuation-insensitive);
      // accept either exact match or one containing the other (catalog names vary
      // in verbosity), reject a clear divergence.
      if (planNamesConflict(plan.name, planNameConfirm)) {
        return JSON.stringify({
          error: "plan_mismatch",
          message:
            `plan_id resolves to "${plan.name}" but you confirmed "${planNameConfirm}". These are different plans — ` +
            `re-run list_plans and pass the plan_id AND plan_name_confirm of the SAME plan the client agreed to.`,
        });
      }

      await repo.updateClientName(client.id, clientName);
      const phone = `+${client.wa_phone.replace(/^\+/, "")}`;

      // Read-only identity resolution. The email-proven fiche wins over a stale
      // phone index, and the same effective contact is used by every guard.
      const memberContext = await resolvePlanMemberContext(
        client,
        phone,
        clientName || client.name || "",
        pendingVerification,
      );
      let contactId = memberContext.contactId;
      let memberId = memberContext.memberId;
      // True only when we just created a brand-new Wix account for a
      // declined-verification client (Fix D) — drives the "welcome email is
      // coming" line so we don't say that to an existing member.
      let accountJustCreated = false;

      // Pack Découverte eligibility (server decides): only for first-time
      // Pilates clients. History visible only when contactId is linked — if
      // null (unknown number / unlinked account), sell without asking (minimal
      // friction; an old client on a new number may slip through — accepted).
      // Other past classes (aquabike, yoga…) do not disqualify.
      if (
        wix.isDiscoveryPlan(plan.name) &&
        contactId &&
        (await wix.hasPastPilatesBooking(contactId))
      ) {
        return JSON.stringify({
          error: "discovery_not_eligible",
          message:
            "This client has already done Pilates at Revive — the discovery pack is for first-time " +
            "Pilates clients only. Do NOT sell it. Offer a normal single class (à la carte) or another plan instead.",
        });
      }
      if (
        config.KEYS_AUTOMATION_ENABLED &&
        plan.id === config.INVITEE_PLAN_ID &&
        contactId
      ) {
        try {
          const alreadyUsed =
            (await wix.hasAnyPastReviveBooking(contactId)) ||
            (await wix.hasPlanOrderHistory({
              contactId,
              memberId,
              planIds: config.INVITEE_HISTORY_PLAN_IDS,
            }));
          if (alreadyUsed) {
            return JSON.stringify({
              error: "invitee_not_eligible",
              message:
                "Une ancienne commande Pack Découverte ou L'Invitée apparaît sur ton compte. " +
                "Comme cette offre est limitée à une fois par personne, je ne peux pas l'activer automatiquement. " +
                "Si cette commande avait été annulée avant ton essai, je peux transmettre ta demande à la réception pour vérification.",
            });
          }
        } catch (error) {
          console.error("L'Invitée eligibility lookup failed (allowing sale with audit):", error);
          await repo.recordSystemAudit(
            "invitee_eligibility_lookup_failed_allow",
            "client",
            client.id,
            {
              contactId,
              memberId,
              error: error instanceof Error ? error.message : String(error),
            },
          ).catch(() => undefined);
        }
      }

      const keyMapping =
        config.KEYS_AUTOMATION_ENABLED ? keyMappingForPlan(plan.id) : null;
      const isKeyPlan = keyMapping !== null;
      const initialFields = [input.service_id, input.event_id, input.slot_start];
      const initialFieldCount = initialFields.filter(
        (value) => typeof value === "string" && value.trim() !== "",
      ).length;
      if (initialFieldCount !== 0 && initialFieldCount !== 3) {
        return JSON.stringify({
          error: "invalid_arguments",
          message: "service_id, event_id and slot_start form one indivisible group. Pass all three or none.",
        });
      }
      let initialSlot: ValidInitialPlanSlot | null = null;
      if (initialFieldCount === 3) {
        const claimedServiceId = String(input.service_id);
        const choiceId = String(input.event_id);
        const claimedStart = String(input.slot_start);
        const cached = await repo.getCachedSlot(client.id, choiceId);
        const cachedStart = String((cached?.slot_json as any)?.startDate ?? "");
        if (
          !cached ||
          cached.service_id !== claimedServiceId ||
          !cachedStart ||
          Math.abs(Date.parse(cachedStart) - Date.parse(claimedStart)) > 60_000
        ) {
          return JSON.stringify({
            error: "initial_slot_unavailable",
            message:
              "The initial slot is absent or stale. No payment was created. Re-run check_availability and use a fresh choice_id.",
          });
        }
        const checked = await validateInitialPlanSlot({
          planId: plan.id,
          serviceId: cached.service_id,
          eventId: cached.event_id,
          slotStart: cachedStart,
        });
        if ("error" in checked) {
          return JSON.stringify({
            error: checked.error,
            message:
              checked.error === "initial_slot_started"
                ? "The initial class has already started. No payment was created. Re-run check_availability."
                : "The initial class is full, closed, missing from Wix, or not covered by this plan. No payment was created. Re-run check_availability.",
          });
        }
        initialSlot = checked;
      }
      const currentKey = isKeyPlan
        ? await keyRepo.activeKeyForClient({
            clientId: client.id,
            wixMemberId: memberId,
            family: keyMapping!.family,
          })
        : null;
      const continuitySource = isKeyPlan
        ? await resolveContinuitySource({
            family: keyMapping!.family,
            clientId: client.id,
            contactId,
            memberId,
            at: new Date(),
          })
        : null;

      // Chained renewal: when the client wants the new plan to start after the
      // current one, resolve the real end date from Wix (never from the model).
      // No active plan / no readable end date → fall back to "now" and flag it.
      let startsAt: Date | null = null;
      let startFellBack = false;
      if (continuitySource) {
        // Keys never overlap. An early renewal always starts when the current
        // Key or legacy Reformer plan (including an approved extension) ends.
        startsAt = new Date(continuitySource.expiresAt);
      } else if (input.start === "after_current") {
        const endIso = contactId ? await wix.latestPlanEndDate(contactId) : null;
        if (endIso) startsAt = new Date(endIso);
        else startFellBack = true;
      }
      if (isKeyPlan && startsAt && (await repo.hasScheduledKeyOrder(client.id, keyMapping!.family))) {
        return JSON.stringify({
          error: "next_key_already_scheduled",
          message:
            "Cette cliente a déjà une prochaine Clé payée et programmée. Ne crée pas un second lien ; " +
            "explique qu'une seule prochaine Clé peut être en attente et transmets à la réception pour tout changement.",
        });
      }

      // Conversation order is strict: name → email proof (when needed) →
      // payment method. This is decision-only; the Wix member is still not
      // created until the payment-method guard below has passed.
      if (
        memberContext.decision.action === "require_verification" &&
        input.client_declined_verification !== true
      ) {
        return verificationRequiredResult(
          "plan_member_verification_required",
          memberContext.decision.codeAlreadySent,
        );
      }

      const pay = resolvePaymentMethod(input.payment_method, om.isOmEnabled());
      if (!pay.ok) return JSON.stringify({ error: pay.error, message: pay.message });

      // Provision only after every plan/catalog/eligibility/renewal/payment
      // guard passed, immediately before the local draft. A refusal/inaccessible
      // inbox explicitly opts into the existing manual-after-payment fallback.
      // F4 guard is structural: a client with a durable proof for the phone's
      // own fiche yields decision.action === "create_member" (not
      // require_verification), so a bogus client_declined_verification:true is
      // inert here — the member is created and the plan auto-activates (this is
      // exactly what trapped Lisa Coulaud 02/08, where the model lied about a
      // refusal to escape a verification loop).
      const declinedVerification =
        memberContext.decision.action === "require_verification" &&
        input.client_declined_verification === true;
      if (declinedVerification) {
        // Client couldn't get the code / declined. For a brand-new account with
        // the email she gave, create it directly so activation is automatic
        // instead of a manual-limbo fallback (owner-approved, see helper). Any
        // ambiguity → null → the existing manual path below.
        const auto = await autoProvisionDeclinedNewAccount(memberContext.verification, client);
        if (auto) {
          contactId = auto.contactId;
          memberId = auto.memberId;
          accountJustCreated = true;
        }
      }
      if (!declinedVerification) {
        const prepared = await provisionPlanMember(memberContext, client);
        // The decision guard above makes this branch unreachable, but keep the
        // check as a defensive invariant if the decision type evolves.
        if (prepared.status === "verification_required") {
          return verificationRequiredResult(
            "plan_member_verification_required",
            prepared.codeAlreadySent,
          );
        }
        if (prepared.status === "failed") {
          return JSON.stringify({
            error:
              prepared.reason === "contact_mismatch"
                ? "plan_member_contact_mismatch"
                : "plan_member_creation_failed",
            message:
              "The Wix member could not be attached safely. Reception has been notified and no payment was created.",
          });
        }
        contactId = prepared.contactId;
        memberId = prepared.memberId;
      }

      // One active plan link per client.
      await repo.expireActivePlanOrders(client.id);
      const draft = await repo.createDraftPlanOrder({
        clientId: client.id,
        planId,
        planName: plan.name,
        amountXof: plan.priceXof,
        memberId,
        startsAt,
        isKey: isKeyPlan,
        keyFamily: keyMapping?.family ?? null,
        // Continuity rights are finalized only after a verified payment.
        keyInvitationCount: null,
        continuitySourceKind: continuitySource?.kind,
        continuitySourceOrderId: continuitySource?.orderId,
        continuitySourcePlanId: continuitySource?.planId,
        continuityExpiresAt: continuitySource?.expiresAt,
        continuityRemaining: continuitySource?.remaining,
        serviceId: initialSlot?.service.id,
        serviceName: initialSlot?.service.name,
        eventId: initialSlot?.eventId,
        slotJson: initialSlot?.fresh.raw,
        slotStart: initialSlot?.fresh.startDate,
        slotEnd: initialSlot?.fresh.endDate ?? null,
      });

      let session;
      try {
        session = await createClientPaymentSession({
          method: pay.method,
          amountXof: plan.priceXof,
          clientReference: draft.id,
          name: plan.name,
        });
      } catch (err) {
        await repo.expireActivePlanOrders(client.id);
        throw err;
      }

      await repo.setPlanOrderAwaitingPayment(
        draft.id,
        session.sessionId,
        session.paymentLink,
        session.expiresAt,
        session.method,
      );

      const startNote = startsAt
        ? currentKey?.key_type === "INVITEE"
          ? ` This is a chained Key: after payment it starts after L'Invitée's third Reformer session has happened, or on ${startsAt.toISOString().slice(0, 10)} at the latest. Tell the client both conditions; any unused L'Invitée bonus stays valid until its own expiry.`
          : ` This is a chained renewal: after payment the plan starts on ${startsAt.toISOString().slice(0, 10)} (when the current one ends) — tell the client that date.`
        : startFellBack
          ? " The client asked to start after their current plan, but no active plan with a future end date was found, so it will start NOW — tell them that."
          : "";

      const appLabel = paymentMethodLabel(session.method);
      // Manual activation remains available only through the explicit
      // no-inbox/refusal fallback. Every verified purchase stores a member id.
      const activationManual = !memberId;
      const activationNote = activationManual
        ? " ACTIVATION: no Wix member could be created, so the team activates the plan MANUALLY after payment — tell the client the ACTIVATION itself isn't instant. CRITICAL: payment CONFIRMATION is still automatic and separate. If the client says they paid, reassure them the confirmation lands within a minute or two and, if it doesn't, call handoff_to_human. NEVER tell the client to wait for, watch for, or report back an 'activation confirmation' — that leaves them hanging (real drift: Maryeme 01/08)."
        : accountJustCreated
          ? " ACTIVATION: automatic after verified payment. We just created a Revive account for the client with the email they gave, so Wix will email them a welcome/set-password link — mention it up front so it isn't a surprise; choosing a password is not required to book."
          : " ACTIVATION: automatic after verified payment. Wix may send an optional welcome/set-password email; choosing a password is not required.";
      return JSON.stringify({
        payment_link: session.paymentLink,
        payment_method: session.method,
        payment_app: appLabel,
        amount_fcfa: plan.priceXof,
        plan: plan.name,
        order_id: draft.id,
        billing: plan.billing,
        period: plan.periodLabel ?? undefined,
        starts_on: startsAt ? startsAt.toISOString().slice(0, 10) : "now",
        activation: activationManual ? "manual_after_payment" : "auto_after_payment",
        initial_class: initialSlot?.service.name,
        initial_slot_start: initialSlot?.fresh.startDate,
        expires_in_minutes: config.PAYMENT_LINK_TTL_MINUTES,
        note:
          `Relay the link (open in ${appLabel}). The plan is confirmed only once paid; automatic WhatsApp confirmation after payment.` +
          (initialSlot
            ? " After activation, the selected first class is booked automatically and one exact plan credit is redeemed. The place is guaranteed only after Wix confirms it."
            : "") +
          startNote +
          activationNote +
          (plan.billing === "recurring"
            ? " Recurring plan: this payment covers the FIRST period; renewal is self-service — the client just buys it again here when it ends, say so."
            : "") +
          (await omOutageNoteFor(session.method)),
      });
    }

    case "refresh_expired_plan_payment_link": {
      const orderId = String(input.order_id ?? "").trim();
      if (!orderId) return JSON.stringify({ error: "invalid_arguments" });
      const previous = await repo.findPlanOrderById(orderId);
      if (!previous || previous.client_id !== client.id) {
        return JSON.stringify({ error: "plan_order_not_found" });
      }
      if (["PAID", "ACTIVATED", "SCHEDULED"].includes(previous.status)) {
        return JSON.stringify({ error: "plan_order_already_paid" });
      }
      if (previous.status !== "EXPIRED") {
        return JSON.stringify({ error: "plan_order_not_expired" });
      }
      const expiredAt = previous.link_expires_at ?? previous.updated_at;
      if (Date.now() - new Date(expiredAt).getTime() > 7 * 86_400_000) {
        return JSON.stringify({ error: "plan_order_too_old" });
      }
      if (await repo.activeAwaitingPlanOrder(client.id)) {
        return JSON.stringify({ error: "concurrent_plan_payment" });
      }

      const plan = await wix.getPlan(previous.plan_id);
      if (!plan || !isPlanSellableByAwa(plan.id, config.AWA_SELLABLE_PLAN_IDS)) {
        return JSON.stringify({ error: "plan_not_sellable" });
      }
      if (config.PACK_DISCOVERY_CONTINUATION_PLAN_IDS.includes(plan.id)) {
        return JSON.stringify({ error: "reception_only_plan" });
      }

      const phone = `+${client.wa_phone.replace(/^\+/, "")}`;
      const contactId = await wix.findContactIdByPhone(phone, client.name ?? undefined);
      const memberId = contactId ? await wix.findMemberIdByContactId(contactId) : null;
      if (!memberId) {
        return JSON.stringify({
          error: "plan_member_verification_required",
          message: "The member identity must be verified again before a replacement payment can be created.",
        });
      }
      if (
        config.KEYS_AUTOMATION_ENABLED &&
        plan.id === config.INVITEE_PLAN_ID &&
        contactId &&
        ((await wix.hasAnyPastReviveBooking(contactId)) ||
          (await wix.hasPlanOrderHistory({
            contactId,
            memberId,
            planIds: config.INVITEE_HISTORY_PLAN_IDS,
          })))
      ) {
        return JSON.stringify({ error: "invitee_not_eligible" });
      }

      let initialSlot: ValidInitialPlanSlot | null = null;
      if (previous.service_id || previous.event_id || previous.slot_start) {
        if (!previous.service_id || !previous.event_id || !previous.slot_start) {
          return JSON.stringify({ error: "initial_slot_unavailable" });
        }
        const checked = await validateInitialPlanSlot({
          planId: plan.id,
          serviceId: previous.service_id,
          eventId: previous.event_id,
          slotStart: new Date(previous.slot_start).toISOString(),
        });
        if ("error" in checked) {
          return JSON.stringify({
            error: checked.error,
            message:
              checked.error === "initial_slot_started"
                ? "The selected initial class has already started. No payment was created; run check_availability."
                : "The selected initial class is no longer available. No payment was created; run check_availability.",
          });
        }
        initialSlot = checked;
      }

      const pay = resolvePaymentMethod(previous.payment_method, om.isOmEnabled());
      if (!pay.ok) return JSON.stringify({ error: pay.error, message: pay.message });
      let draft: repo.PlanOrder;
      try {
        draft = await repo.createDraftPlanOrder({
          clientId: client.id,
          planId: plan.id,
          planName: plan.name,
          amountXof: plan.priceXof,
          memberId,
          startsAt: previous.starts_at,
          isKey: keyMappingForPlan(plan.id) !== null,
          keyFamily: previous.key_family,
          keyInvitationCount: null,
          continuitySourceKind: previous.continuity_source_kind,
          continuitySourceOrderId: previous.continuity_source_order_id,
          continuitySourcePlanId: previous.continuity_source_plan_id,
          continuityExpiresAt: previous.continuity_expires_at,
          continuityRemaining: previous.continuity_remaining,
          serviceId: initialSlot?.service.id,
          serviceName: initialSlot?.service.name,
          eventId: initialSlot?.eventId,
          slotJson: initialSlot?.fresh.raw,
          slotStart: initialSlot?.fresh.startDate,
          slotEnd: initialSlot?.fresh.endDate ?? null,
          retryOfOrderId: previous.id,
        });
      } catch (error) {
        if ((error as { code?: string })?.code === "23505") {
          return JSON.stringify({ error: "concurrent_plan_payment" });
        }
        throw error;
      }
      let session;
      try {
        session = await createClientPaymentSession({
          method: pay.method,
          amountXof: plan.priceXof,
          clientReference: draft.id,
          name: plan.name,
        });
      } catch (error) {
        await repo.expireActivePlanOrders(client.id);
        throw error;
      }
      await repo.setPlanOrderAwaitingPayment(
        draft.id,
        session.sessionId,
        session.paymentLink,
        session.expiresAt,
        session.method,
      );
      return JSON.stringify({
        payment_link: session.paymentLink,
        payment_method: session.method,
        payment_app: paymentMethodLabel(session.method),
        amount_fcfa: plan.priceXof,
        plan: plan.name,
        order_id: draft.id,
        replaces_order_id: previous.id,
        initial_class: initialSlot?.service.name,
        initial_slot_start: initialSlot?.fresh.startDate,
        expires_in_minutes: config.PAYMENT_LINK_TTL_MINUTES,
        note: "Relay this new server-issued link. The previous expired order remains in the audit trail.",
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
          const remaining = await wix.planRemainingSessions(
            contactId,
            m.planId,
            m.planName,
            m.orderId,
          );
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

    case "request_invitee_guarantee": {
      if (!config.KEYS_AUTOMATION_ENABLED) {
        return JSON.stringify({
          error: "keys_not_enabled",
          message: "La garantie L'Invitée n'est pas encore ouverte. Transmets à la réception.",
        });
      }
      const holderPhone = `+${client.wa_phone.replace(/^\+/, "")}`;
      const contact = await wix.findContactByPhone(holderPhone, client.name || undefined);
      if (!contact) {
        return JSON.stringify({
          error: "holder_account_not_found",
          message:
            "Le compte de la détentrice n'est pas identifiable sans ambiguïté. Transmets à la réception.",
        });
      }
      const memberId = await wix.findMemberIdByContactId(contact.id);
      // Look the INVITEE up by type: an active key of another family (e.g. a more
      // recently started Aquabike) must never mask the Invitée and refuse a valid
      // guarantee request.
      const key = await keyRepo.activeKeyOfType({
        clientId: client.id,
        wixMemberId: memberId,
        type: "INVITEE",
      });
      if (!key) {
        return JSON.stringify({
          error: "no_active_invitee_key",
          message:
            "Aucune Clé L'Invitée active n'est liée à cette cliente. Transmets à la réception en cas de doute.",
        });
      }
      const facts = await keyRepo.inviteeGuaranteeFacts(key.id);
      const first = facts.reformerBookings[0];
      const now = new Date();
      if (!first || first.slot_start.getTime() > now.getTime()) {
        return JSON.stringify({
          error: "first_session_not_completed",
          message:
            "La garantie s'exerce après la première séance. Si la cliente signale un problème particulier, transmets à la réception.",
        });
      }
      if (dakarDateKey(first.slot_start) !== dakarDateKey(now)) {
        return JSON.stringify({
          error: "guarantee_deadline_passed",
          first_session_date: dakarDateKey(first.slot_start),
          message:
            "La demande devait être faite avant la fin de la journée de la première séance. Transmets à la réception si la cliente conteste les faits.",
        });
      }
      if (facts.reformerBookings.length > 1 || facts.bonusBookings > 0) {
        return JSON.stringify({
          error: "guarantee_already_consumed",
          reformer_bookings: facts.reformerBookings.length,
          bonus_bookings: facts.bonusBookings,
          message:
            "La garantie ne s'applique plus après une deuxième réservation Reformer ou l'utilisation du cours bonus. Transmets à la réception si la cliente conteste les faits.",
        });
      }
      const detail = {
        requestedAt: now.toISOString(),
        firstSessionAt: first.slot_start.toISOString(),
        firstWixBookingId: first.wix_booking_id,
        reformerBookings: facts.reformerBookings.length,
        bonusBookings: facts.bonusBookings,
        attendanceNeedsReceptionCheck: true,
      };
      const recorded = await keyRepo.recordGuaranteeRequest(key.id, detail);
      if (!recorded) {
        return JSON.stringify({
          already_recorded: true,
          reception_notified: true,
          message:
            "La demande est déjà enregistrée. Dis à la cliente que la réception vérifie sa présence et la recontactera ici.",
        });
      }
      const reason = `Garantie L'Invitée — vérification présence et remboursement humain (Clé ${key.id})`;
      await repo.recordHandoff(client.id, reason);
      notifyReception(
        "🛡️ Demande de garantie L'Invitée",
        `Une cliente demande la garantie après sa première séance.\n` +
          `  Cliente : ${client.name ?? contact.fullName ?? "?"} (${holderPhone})\n` +
          `  Clé : ${key.id}\n` +
          `  Commande Wix : ${key.paid_order_id}\n` +
          `  Première séance : ${first.slot_start.toISOString()}\n` +
          `  Booking Wix : ${first.wix_booking_id}\n` +
          `  Contrôles serveur : même journée, aucune 2e réservation Reformer, aucun bonus utilisé.\n\n` +
          `À faire : vérifier dans Wix qu'elle a réellement participé (et non no-show), puis approuver/refuser et rembourser manuellement. Awa n'a promis aucun remboursement.`,
      );
      return JSON.stringify({
        request_recorded: true,
        reception_notified: true,
        attendance_check_pending: true,
        refund_completed: false,
        message:
          "La demande est enregistrée et transmise. Dis seulement que la réception vérifie la présence et reviendra vers la cliente ici ; ne promets ni approbation ni délai de remboursement.",
      });
    }

    case "record_google_review": {
      if (!config.KEYS_AUTOMATION_ENABLED || !config.GOOGLE_REVIEW_URL) {
        return JSON.stringify({
          error: "review_gate_not_enabled",
          message: "L'activation par avis n'est pas ouverte. Remercie pour l'avis, n'active ni ne promets rien.",
        });
      }
      const activated = await keyRepo.activateReviewGate(client.id);
      if (!activated) {
        const existing = await keyRepo.reviewGateForClient(client.id);
        if (existing?.activated_at) {
          return JSON.stringify({
            already_activated: true,
            message: "Ses invitations sont déjà actives — remercie-la simplement pour son avis.",
          });
        }
        return JSON.stringify({
          error: "no_pending_review_gate",
          message:
            "Aucune invitation en attente d'avis pour cette cliente. Remercie pour l'avis ; n'active ni ne promets rien.",
        });
      }
      const unlocked = activated.key_id
        ? await keyRepo.activatePendingInvitations(activated.key_id)
        : 0;
      const holderPhone = `+${client.wa_phone.replace(/^\+/, "")}`;
      notifyReception(
        "⭐ Avis Google reçu — invitation activée",
        `Une cliente a laissé son avis Google ; ses invitations sont désormais actives.\n` +
          `  Cliente : ${client.name ?? "?"} (${holderPhone})\n` +
          `  Commande Clé : ${activated.plan_order_id}\n` +
          (activated.key_id
            ? `  Invitations débloquées : ${unlocked}\n`
            : `  Clé encore programmée — ses invitations naîtront actives au démarrage.\n`) +
          `\nAucune action requise : la capture d'écran suffit (FYI).`,
      );
      return JSON.stringify({
        review_recorded: true,
        invitations_activated: unlocked,
        key_scheduled: activated.key_id === null,
        message:
          "Remercie chaleureusement et confirme que son invitation est active" +
          (activated.key_id === null ? " (elle le sera dès le démarrage de sa Clé)" : "") +
          ". Rappelle qu'elle s'offre sur le créneau Reformer de 12h30, du lundi au vendredi, à une amie jamais venue chez Revive.",
      });
    }

    case "book_key_bonus":
    case "book_key_invitation": {
      if (!config.KEYS_AUTOMATION_ENABLED) {
        return JSON.stringify({
          error: "keys_not_enabled",
          message: "Les Clés ne sont pas encore ouvertes. Ne promets pas la réservation ; transmets à la réception.",
        });
      }
      const isInvitation = name === "book_key_invitation";
      const serviceId = String(input.service_id ?? "");
      const eventId = String(input.event_id ?? "");
      const clientName = String(input.client_name ?? "").slice(0, 80).trim();
      if (!serviceId || !eventId || !clientName) {
        return JSON.stringify({ error: "invalid_arguments" });
      }
      const cached = await repo.getCachedSlot(client.id, eventId);
      if (!cached || cached.service_id !== serviceId) {
        return JSON.stringify({
          error: "unknown_slot",
          message: "Ce créneau n'a pas été proposé à cette cliente. Relance check_availability.",
        });
      }
      const slot = (cached.slot_json as any) ?? {};
      const slotStart = String(slot.startDate ?? input.slot_start ?? "");
      const start = new Date(slotStart);
      if (!slotStart || Number.isNaN(start.getTime()) || start.getTime() <= Date.now()) {
        return JSON.stringify({ error: "invalid_or_past_slot" });
      }
      // Scope is per-plan-family: a Clé/sur-mesure invitation is Reformer at
      // 12h30; an Aquabike invitation is an Aquabike class any weekday hour. The
      // pair must be admitted by at least one configured mapping's rule.
      const scopeAllowed = isInvitation
        ? anyInvitationScopeAllows(serviceId, start)
        : anyBonusScopeAllows(serviceId, start);
      if (!scopeAllowed) {
        return JSON.stringify({
          error: isInvitation ? "invitation_slot_not_allowed" : "bonus_slot_not_allowed",
          message: isInvitation
            ? "L'invitation Clé/sur mesure est limitée au Reformer à 12h30 (lun–ven) ; l'invitation Aquabike à un cours Aquabike (lun–ven, à toute heure). Ne propose aucun autre créneau."
            : "Le cours en plus est limité à Aquabike, Yoga, Mat ou Step (lun–ven) ; la séance Reformer offerte de l'Abonnement Aquabike se prend au créneau calme de 12h30 (lun–ven).",
        });
      }
      const service = await wix.getService(serviceId);
      if (!service) return await unknownServiceIdResult();
      const fresh = await wix.isSlotStillOpen(serviceId, cached.event_id, slotStart, 1);
      if (!fresh) {
        return JSON.stringify({
          error: "slot_full",
          message: "Le créneau vient de se remplir. Relance check_availability.",
        });
      }
      const holderPhone = `+${client.wa_phone.replace(/^\+/, "")}`;
      const contact = await wix.findContactByPhone(
        holderPhone,
        clientName || client.name || undefined,
      );
      if (!contact) {
        return JSON.stringify({
          error: "holder_account_not_found",
          message: "Le compte de la détentrice n'est pas identifiable sans ambiguïté. Transmets à la réception.",
        });
      }
      const memberId = await wix.findMemberIdByContactId(contact.id);
      const activeKeys = await keyRepo.activeKeysForClient({
        clientId: client.id,
        wixMemberId: memberId,
      });
      if (
        activeKeys.length === 0 ||
        !memberId ||
        activeKeys.some((candidate) => candidate.wix_member_id !== memberId)
      ) {
        return JSON.stringify({
          error: "no_active_key",
          message: "Aucune Clé active et liée à ce compte Wix. Transmets à la réception en cas de doute.",
        });
      }

      if (!isInvitation) {
        const eligibleKeys = [...activeKeys]
          .filter((candidate) => {
            const candidateMapping = keyMappingForType(candidate.key_type);
            return (
              !!candidateMapping &&
              start.getTime() < candidate.effective_ends_at.getTime() &&
              candidate.bonus_order_id &&
              candidate.bonus_status === "ACTIVE" &&
              bonusScopeAllows(candidateMapping, serviceId, start)
            );
          })
          .sort(
            (a, b) =>
              a.effective_ends_at.getTime() - b.effective_ends_at.getTime(),
          );
        if (eligibleKeys.length === 0) {
          return JSON.stringify({
            error: "bonus_not_ready",
            message:
              "Le cours en plus n'est pas encore activé. La réparation automatique est en cours ; " +
              "si la cliente attend, transmets à la réception.",
          });
        }
        let selected:
          | { key: keyRepo.KeyRegistry; benefit: wix.EligibleBenefit }
          | null = null;
        for (const candidate of eligibleKeys) {
          const benefit = await exactBenefitWithShortRetry({
            serviceId,
            contactId: contact.id,
            planId: candidate.bonus_plan_id!,
            orderId: candidate.bonus_order_id!,
          });
          if (benefit) {
            selected = { key: candidate, benefit };
            break;
          }
        }
        if (!selected) {
          return JSON.stringify({
            error: "bonus_not_available",
            message: "Le crédit bonus lié à cette Clé n'est pas disponible ou a déjà été utilisé.",
          });
        }
        try {
          return JSON.stringify(
            await createProtectedBenefitBooking({
              client,
              serviceId,
              resolvedEventId: cached.event_id,
              fresh,
              service,
              contact,
              bookingName: contact.fullName || clientName,
              benefit: selected.benefit,
              key: selected.key,
              kind: "BONUS",
            }),
          );
        } catch (error) {
          console.error("Key bonus booking failed:", error);
          return JSON.stringify({
            error: "bonus_booking_failed",
            message: "La réservation bonus n'a pas abouti. Transmets à la réception ; ne promets pas de réservation.",
          });
        }
      }

      const friendFirstName = String(input.friend_first_name ?? "").slice(0, 80).trim();
      const friendDigits = String(input.friend_phone ?? "").replace(/\D/g, "");
      const friendPhone =
        friendDigits.length === 9 && friendDigits.startsWith("7")
          ? `+221${friendDigits}`
          : friendDigits
            ? `+${friendDigits}`
            : "";
      if (!friendFirstName || !friendPhone) {
        return JSON.stringify({ error: "friend_details_required" });
      }
      let friendResolution: wix.PhoneContactResolution;
      try {
        friendResolution = await wix.resolvePhoneContact(friendPhone, friendFirstName);
      } catch (error) {
        console.error("Invitation friend lookup failed:", error);
        return JSON.stringify({
          error: "friend_eligibility_unknown",
          message: "L'éligibilité de l'amie n'a pas pu être vérifiée. Transmets à la réception.",
        });
      }
      if (friendResolution.kind === "ambiguous") {
        return JSON.stringify({
          error: "friend_contact_ambiguous",
          matches: friendResolution.count,
          message: "Plusieurs fiches correspondent à ce téléphone. La réception doit vérifier avant toute réservation.",
        });
      }
      if (friendResolution.kind === "one") {
        try {
          // Each invitation disqualifies only prior practice of ITS discipline
          // at Revive: Aquabike invitation → never did Aquabike; Clé/sur-mesure
          // → never did Reformer. Other classes never disqualify.
          const friendRule = invitationFriendRuleForService(serviceId);
          const disqualified =
            friendRule === "NEVER_AQUABIKE"
              ? await wix.hasPastAquabikeBooking(friendResolution.contact.id)
              : await wix.hasPastReformerBooking(friendResolution.contact.id);
          if (disqualified) {
            return JSON.stringify({
              error: "friend_not_new",
              message:
                friendRule === "NEVER_AQUABIKE"
                  ? "L'invitation Aquabike est réservée à une personne qui n'a jamais fait d'Aquabike chez Revive. " +
                    "Une venue pour un autre cours ou service ne la disqualifie pas."
                  : "L'invitation est réservée à une personne qui n'a jamais fait de Reformer chez Revive. " +
                    "Une venue pour un autre cours ou service ne la disqualifie pas.",
            });
          }
        } catch (error) {
          console.error("Invitation history lookup failed:", error);
          return JSON.stringify({
            error: "friend_eligibility_unknown",
            message: "L'historique de l'amie n'a pas pu être vérifié. Transmets à la réception.",
          });
        }
      }
      let invitationSelection:
        | { key: keyRepo.KeyRegistry; invitation: keyRepo.KeyInvitation }
        | null = null;
      for (const candidate of [...activeKeys].sort(
        (a, b) => a.effective_ends_at.getTime() - b.effective_ends_at.getTime(),
      )) {
        if (start.getTime() >= candidate.effective_ends_at.getTime()) continue;
        const candidateMapping = keyMappingForType(candidate.key_type);
        if (!candidateMapping || !invitationScopeAllows(candidateMapping, serviceId, start)) {
          continue;
        }
        const invitation = await keyRepo.availableInvitationForKey(candidate.id);
        if (invitation) {
          invitationSelection = { key: candidate, invitation };
          break;
        }
      }
      if (!invitationSelection) {
        if (
          config.GOOGLE_REVIEW_URL &&
          (await keyRepo.hasPendingReviewInvitation(activeKeys.map((k) => k.id)))
        ) {
          return JSON.stringify({
            error: "invitation_pending_review",
            review_link: config.GOOGLE_REVIEW_URL,
            message:
              "L'invitation de cette cliente s'active avec son avis Google (une seule fois, sans jamais insister). " +
              "Explique-le gentiment, renvoie le lien review_link, demande une capture d'écran de l'avis publié, " +
              "puis appelle record_google_review dès qu'elle l'envoie.",
          });
        }
        return JSON.stringify({
          error: "no_invitation_available",
          message:
            "Aucune invitation active ne couvre ce créneau. Elle doit être utilisée avant l'expiration de la Clé qui l'a accordée.",
        });
      }
      const assigned = await keyRepo.assignInvitation({
        invitationId: invitationSelection.invitation.id,
        firstName: friendFirstName,
        phone: friendPhone,
      });
      if (!assigned) {
        return JSON.stringify({
          error: "invitation_already_assigned",
          message: "Cette invitation est déjà attribuée. Relance la vérification ou transmets à la réception.",
        });
      }
      // Family-specific invitation plan: Aquabike uses its own hidden plan
      // (connected only to Aquabike services) so a retained credit can never be
      // redeemed on Reformer, and vice versa.
      const invitationPlanId =
        keyMappingForType(invitationSelection.key.key_type)?.invitation.planId ??
        config.INVITATION_PLAN_ID;
      let invitationOrderId = assigned.wix_invitation_order_id;
      try {
        if (!invitationOrderId) {
          invitationOrderId = await wix.createOfflinePlanOrder(
            invitationPlanId,
            memberId,
          );
          const stored = await keyRepo.attachInvitationOrder(assigned.id, invitationOrderId);
          invitationOrderId = stored?.wix_invitation_order_id ?? invitationOrderId;
        }
        const benefit = await exactBenefitWithShortRetry({
          serviceId,
          contactId: contact.id,
          planId: invitationPlanId,
          orderId: invitationOrderId,
        });
        if (!benefit) {
          return JSON.stringify({
            error: "invitation_credit_not_ready",
            invitation_assigned: true,
            message:
              "L'invitation est attribuée et son crédit Wix est conservé, mais pas encore utilisable. " +
              "Réessaie dans un instant ; ne crée pas une deuxième invitation.",
          });
        }
        const result = await createProtectedBenefitBooking({
          client,
          serviceId,
          resolvedEventId: cached.event_id,
          fresh,
          service,
          contact,
          bookingName: contact.fullName || clientName,
          benefit,
          key: invitationSelection.key,
          kind: "INVITATION",
          invitationId: assigned.id,
        });
        return JSON.stringify({
          ...result,
          friend_first_name: friendFirstName,
          friend_phone: friendPhone,
          participant_display:
            `Invitation — ${friendFirstName} (détentrice : ${contact.fullName || clientName})`,
        });
      } catch (error) {
        console.error("Key invitation booking failed:", error);
        return JSON.stringify({
          error: "invitation_booking_failed",
          invitation_assigned: true,
          message:
            "La réservation n'a pas abouti. Le droit et l'ordre Wix existant sont conservés pour réessayer ; " +
            "ne crée pas une deuxième invitation. Transmets à la réception si nécessaire.",
        });
      }
    }

    case "book_with_membership": {
      const claimedServiceId = String(input.service_id ?? "");
      const eventId = String(input.event_id ?? "");
      const clientName = String(input.client_name ?? "").slice(0, 80).trim();
      const participants = Math.min(10, Math.max(1, Math.round(Number(input.participants ?? 1)) || 1));
      if (!claimedServiceId || !eventId || !clientName) {
        return JSON.stringify({ error: "invalid_arguments" });
      }

      // Same server-side validations as the Wave flow (choice_id accepted too).
      const cached = await repo.getCachedSlot(client.id, eventId);
      if (!cached) {
        return JSON.stringify({
          error: "unknown_slot",
          message: "This slot was not offered to the client. Re-run check_availability first.",
        });
      }
      const serviceId = cached.service_id;
      if (claimedServiceId !== serviceId) {
        console.warn("Service id mismatch recovered from offered slot", {
          tool: name,
          clientId: client.id,
          claimedServiceId,
          canonicalServiceId: serviceId,
        });
      }
      const resolvedEventId = cached.event_id;
      await trackFunnel({
        clientId: client.id,
        stage: "slot_selected",
        metadata: { service_id: serviceId, participants },
      });
      const service = await wix.getService(serviceId);
      if (!service) return await unknownServiceIdResult();

      // Wix rejects a single booking above the service's per-booking cap — same
      // guard as the Wave group flow, enforced BEFORE deducting any session.
      if (participants > service.maxParticipantsPerBooking) {
        await trackFunnel({
          clientId: client.id,
          stage: "slot_selected",
          failureCode: "group_capacity",
          metadata: {
            service_id: serviceId,
            participants,
            max_participants: service.maxParticipantsPerBooking,
          },
        });
        return JSON.stringify({
          error: "group_too_large",
          max_participants_per_booking: service.maxParticipantsPerBooking,
          message:
            `This class allows at most ${service.maxParticipantsPerBooking} spot(s) per booking. ` +
            `Offer to book ${service.maxParticipantsPerBooking} on the plan now. If they want a larger group, ` +
            `call handoff_to_human and reception will reach out to them.`,
        });
      }

      const slot = (cached.slot_json as any) ?? {};
      const slotStart: string = slot.startDate ?? String(input.slot_start ?? "");
      // Studio closure guard on the membership path too (a plan booking would
      // otherwise slip a free booking onto a closed day).
      if (slotStart) {
        const membershipSlotClosure = await closuresRepo
          .closureAt(new Date(slotStart))
          .catch(() => null);
        if (membershipSlotClosure) {
          return JSON.stringify({
            error: "studio_closed",
            reason: membershipSlotClosure.reason,
            message:
              `Le studio est fermé ce jour-là (${membershipSlotClosure.reason}) — cette séance n'est pas réservable, ` +
              "même avec l'abonnement. Excuse-toi, explique la fermeture, et propose une autre date.",
          });
        }
      }
      const fresh = await wix.isSlotStillOpen(serviceId, resolvedEventId, slotStart, participants);
      if (!fresh) {
        await trackFunnel({
          clientId: client.id,
          stage: "slot_selected",
          failureCode: participants > 1 ? "group_capacity" : "slot_unavailable",
          metadata: { service_id: serviceId, participants, selection_result: "unavailable" },
        });
        const alternatives = await freshSlotAlternatives(client.id, serviceId, resolvedEventId);
        return JSON.stringify({
          error: "slot_full",
          alternatives: alternatives.map((s) => slotResult(s, true)),
          message:
            participants > 1
              ? `Fewer than ${participants} open spots remain. Present the fresh alternatives returned here immediately, or offer a smaller group.`
              : "This slot just filled up. Present the fresh alternatives returned here immediately in the same response.",
        });
      }

      const phone = `+${client.wa_phone.replace(/^\+/, "")}`;

      // 1. Identify the contact and check plan eligibility BEFORE creating
      //    anything in Wix — a "no" costs nothing and leaves no orphan booking.
      const contact = await wix.findContactByPhone(phone, clientName || client.name || undefined);
      if (!contact) {
        await trackFunnel({
          clientId: client.id,
          stage: "slot_selected",
          failureCode: "client_account_not_found",
          metadata: { service_id: serviceId, selection_result: "account_not_found" },
        });
        return JSON.stringify({
          error: "no_matching_contact",
          message:
            "Could not match this WhatsApp number to a unique client account, so the abonnement " +
            "cannot be verified. Offer normal Wave payment, or reception to link their account.",
        });
      }
      const bookingName = contact.fullName || clientName;
      await repo.updateClientName(client.id, bookingName);
      let selectedKey: keyRepo.KeyRegistry | null = null;
      let benefit: wix.EligibleBenefit | null = null;
      let keySelectionRequired = false;
      if (
        config.KEYS_AUTOMATION_ENABLED &&
        config.KEY_REFORMER_SERVICE_IDS.includes(serviceId)
      ) {
        const memberId = await wix.findMemberIdByContactId(contact.id);
        const activeKeys = await keyRepo.activeKeysForClient({
          clientId: client.id,
          wixMemberId: memberId,
        });
        if (activeKeys.length > 0) {
          keySelectionRequired = true;
          if (participants !== 1) {
            return JSON.stringify({
              error: "key_is_personal",
              message:
                "Une Clé est personnelle et non transférable : réserve une seule place avec la Clé. " +
                "Pour une amie, utilise une invitation disponible ou un paiement séparé.",
            });
          }
          const benefits = await wix.findEligibleBenefits(
            serviceId,
            contact.id,
            participants,
          );
          for (const candidate of activeKeys) {
            const exact = wix.selectEligibleBenefit(benefits, {
              planId: candidate.plan_id,
              orderId: candidate.paid_order_id,
            });
            if (exact) {
              selectedKey = candidate;
              benefit = exact;
              break;
            }
          }
        }
      }
      if (!keySelectionRequired) {
        benefit = await wix.findEligibleBenefit(serviceId, contact.id, participants);
      }
      if (!benefit) {
        await trackFunnel({
          clientId: client.id,
          stage: "slot_selected",
          failureCode: "membership_not_eligible",
          metadata: { service_id: serviceId, selection_result: "membership_not_eligible" },
        });
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
        await trackFunnel({
          clientId: client.id,
          stage: "slot_selected",
          failureCode: "membership_balance_insufficient",
          metadata: { service_id: serviceId, participants, remaining_sessions: benefit.available },
        });
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
      let wixBookingId: string;
      try {
        wixBookingId = await wix.createBookingRaw({
          slot: fresh.raw,
          name: bookingName,
          phone,
          participants,
          paymentOption: "MEMBERSHIP",
          resolvedContact: contact,
        });
      } catch {
        await trackFunnel({
          clientId: client.id,
          stage: "technical_failure",
          paymentMethod: "membership",
          failureCode: "membership_booking_failed",
          metadata: { service_id: serviceId, operation: "membership_create_booking" },
        });
        return JSON.stringify({
          error: "membership_booking_failed",
          message: "Technical problem while using the abonnement. Offer the normal payment flow or reception.",
        });
      }

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
              `confirmation calendrier a échoué.\n  Booking Wix : ${wixBookingId}\n  Client : ${bookingName} (${phone})\n` +
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
        if (selectedKey) {
          await keyRepo.recordKeyReformerBooking({
            wixBookingId,
            localBookingId: membershipBooking.id,
            keyId: selectedKey.id,
            slotStart: fresh.startDate,
          });
        }
        await trackFunnel({
          clientId: client.id,
          bookingId: membershipBooking.id,
          stage: "payment_confirmed",
          paymentMethod: "membership",
          idempotencyKey: `booking:${membershipBooking.id}:payment-confirmed`,
          metadata: { service_id: serviceId, participants },
        });
        await trackFunnel({
          clientId: client.id,
          bookingId: membershipBooking.id,
          stage: "booked",
          paymentMethod: "membership",
          idempotencyKey: `booking:${membershipBooking.id}:booked`,
          metadata: { service_id: serviceId, participants },
        });
        // Sessions were just deducted — the cached balance is stale.
        invalidateMembershipCache(client.id);
        // Dashboard order ("séance déduite") — the sweep retries on failure,
        // and the booking above stays confirmed either way.
        await recordWixOrderForBooking(membershipBooking.id, consolePaymentLog).catch(
          () => undefined,
        );
        const tip = classTip(service.name, client.language);
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
            (tip ? `Also include this pre-class tip VERBATIM: ${tip} ` : "") +
            "If the client ALSO wants to pay for a companion's spot on this same class (\"je paie pour mon ami(e)\"), " +
            "call add_spots_to_booking with THIS booking_id and extra_participants — it charges money for only those " +
            "spots without touching the plan; never create_payment_link (it would be refused covered_by_membership). " +
            "Do NOT mention or propose the bar menu in your confirmation: the system automatically shows the " +
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
        if (!notEligible) {
          await trackFunnel({
            clientId: client.id,
            stage: "technical_failure",
            paymentMethod: "membership",
            failureCode: "membership_booking_failed",
            metadata: { service_id: serviceId, operation: "membership_redemption" },
          });
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
        paid_with: paymentMethodLabel(b.payment_method),
        booked_via: "awa",
        status: "confirmed",
        changeable_before_cutoff: hoursUntil(b.slot_start) >= 16 || undefined,
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
      // website (identified by their WhatsApp number → CRM contact). They use
      // the same 16h change rule and voluntary cancellations are non-refundable.
      // Dedupe against the Wix ids Awa already created.
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
              changeable_before_cutoff: hoursUntil(wb.startDate) >= 16 || undefined,
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
            ? "booked_via 'studio' bookings were made at the counter/website. Offer a same-class move or " +
              "a self-service transfer first (the replacement attends under the original booking name; no Wix change " +
              "and no reception handoff). Because Awa cannot see their payment type, a final cancellation requires " +
              "handoff_to_human and the booking must stay unchanged until reception handles it."
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

    case "reschedule_booking": {
      const bookingId = String(input.booking_id ?? "");
      const requestedEventId = String(input.event_id ?? "");
      if (!bookingId || !requestedEventId) return JSON.stringify({ error: "invalid_arguments" });

      const cached = await repo.getCachedSlot(client.id, requestedEventId);
      if (!cached) {
        return JSON.stringify({
          error: "unknown_slot",
          message: "This new slot was not offered to the client. Re-run check_availability and let them pick a slot.",
        });
      }
      const slot = (cached.slot_json as any) ?? {};
      const newStart = typeof slot.startDate === "string" ? slot.startDate : "";
      if (!newStart) {
        return JSON.stringify({ error: "invalid_slot", message: "The selected slot has no usable start time. Re-run check_availability." });
      }

      // Website/counter bookings have no local payment record, but Wix can
      // still move them directly. Re-fetch the client's Wix bookings first so
      // a model can never move somebody else's reservation.
      if (bookingId.startsWith("studio:")) {
        const wixId = bookingId.slice("studio:".length);
        const protectedBenefit = await keyRepo.protectedBenefitForWixBooking(wixId);
        if (protectedBenefit) {
          return JSON.stringify({
            error: "key_benefit_non_changeable",
            benefit: protectedBenefit.kind.toLowerCase(),
            message:
              "Ce cours en plus ou cette invitation est définitif dès la réservation : " +
              "il ne peut être ni déplacé, ni reporté et le crédit reste consommé.",
          });
        }
        const contactId = await wix.findContactIdByPhone(
          `+${client.wa_phone.replace(/^\+/, "")}`,
          client.name ?? undefined,
        );
        const theirs = contactId ? await wix.listContactUpcomingBookings(contactId) : [];
        const source = theirs.find((b) => b.id === wixId);
        if (!source) {
          return JSON.stringify({
            error: "unknown_booking",
            message: "No such upcoming studio booking for this client. Re-run get_my_bookings.",
          });
        }
        if (hoursUntil(source.startDate) < 16) {
          return JSON.stringify({
            error: "too_late_16h_policy",
            hours_before_class: Math.max(0, Math.round(hoursUntil(source.startDate) * 10) / 10),
            message: "Rescheduling refused: less than 16 hours before the current class, the session is due. If they insist on an exceptional situation, call handoff_to_human.",
          });
        }
        if (!source.serviceId || source.serviceId !== cached.service_id) {
          return JSON.stringify({
            error: "different_class_not_reschedulable",
            message: "Direct rescheduling only keeps the same class. Do not cancel this booking; explain that changing class uses the cancellation/new-booking flow.",
          });
        }
        const fresh = await wix.isSlotStillOpen(source.serviceId, cached.event_id, newStart, source.participants);
        if (!fresh) {
          return JSON.stringify({
            error: "slot_full",
            message: "That new slot is no longer open for all their places. Re-run check_availability and offer another slot; the current booking is unchanged.",
          });
        }
        await wix.rescheduleBooking(wixId, fresh);
        return JSON.stringify({
          rescheduled: true,
          class: source.serviceName,
          old_slot_start_dakar: fmtDakar(source.startDate),
          new_slot_start_dakar: fmtDakar(fresh.startDate),
          participants: source.participants,
          payment_preserved: true,
          note: "The booking was moved directly in Wix. Confirm the new time; do NOT mention a refund, new payment or reception.",
        });
      }

      const booking = await repo.findClientBooking(client.id, bookingId);
      if (!booking || booking.status !== "BOOKED" || !booking.wix_booking_id) {
        return JSON.stringify({ error: "unknown_booking", message: "No such upcoming confirmed booking for this client. Re-run get_my_bookings." });
      }
      const protectedBenefit = await keyRepo.protectedBenefitForBooking(booking.id);
      if (protectedBenefit) {
        return JSON.stringify({
          error: "key_benefit_non_changeable",
          benefit: protectedBenefit.kind.toLowerCase(),
          message:
            "Ce cours en plus ou cette invitation est définitif dès la réservation : " +
            "il ne peut être ni déplacé, ni reporté. Le crédit reste consommé. " +
            "Si Revive a annulé le cours, transmettre à la réception pour remplacement.",
        });
      }
      if (hoursUntil(booking.slot_start) < 16) {
        return JSON.stringify({
          error: "too_late_16h_policy",
          hours_before_class: Math.max(0, Math.round(hoursUntil(booking.slot_start) * 10) / 10),
          message: "Rescheduling refused: less than 16 hours before the current class, the session is due. If they insist on an exceptional situation, call handoff_to_human.",
        });
      }
      if (booking.service_id !== cached.service_id) {
        return JSON.stringify({
          error: "different_class_not_reschedulable",
          message: "Direct rescheduling only keeps the same class. Do not cancel this booking; explain that changing class uses the cancellation/new-booking flow.",
        });
      }
      const fresh = await wix.isSlotStillOpen(booking.service_id, cached.event_id, newStart, booking.participants);
      if (!fresh) {
        return JSON.stringify({
          error: "slot_full",
          message: "That new slot is no longer open for all their places. Re-run check_availability and offer another slot; the current booking is unchanged.",
        });
      }

      await wix.rescheduleBooking(booking.wix_booking_id, fresh);
      const stored = await repo.updateBookedSlot({
        bookingId,
        clientId: client.id,
        eventId: cached.event_id,
        slotJson: fresh.raw,
        slotStart: fresh.startDate,
        slotEnd: fresh.endDate ?? null,
      });
      if (!stored) {
        notifyReception(
          "⚠️ Déplacement Wix à synchroniser",
          `Awa a déplacé dans Wix la réservation ${bookingId} de ${client.name ?? "?"}, mais la mise à jour locale a échoué.\n` +
            `Cours : ${booking.service_name}\nNouveau créneau : ${fmtDakar(fresh.startDate)}\nBooking Wix : ${booking.wix_booking_id}`,
        );
      }
      return JSON.stringify({
        rescheduled: true,
        class: booking.service_name,
        old_slot_start_dakar: fmtDakar(String(booking.slot_start)),
        new_slot_start_dakar: fmtDakar(fresh.startDate),
        participants: booking.participants,
        payment_preserved: true,
        local_sync_pending: !stored || undefined,
        note: "The booking was moved directly in Wix and its payment is unchanged. Confirm the new time; do NOT mention a refund or send a payment link.",
      });
    }

    case "cancel_booking": {
      const bookingId = String(input.booking_id ?? "");
      if (!bookingId) return JSON.stringify({ error: "invalid_arguments" });

      // Bookings made at the counter/website ("studio:<wix id>" from
      // get_my_bookings) have no trusted local payment type. Awa therefore
      // keeps them intact and hands final cancellation to reception.
      if (bookingId.startsWith("studio:")) {
        const wixId = bookingId.slice("studio:".length);
        const protectedBenefit = await keyRepo.protectedBenefitForWixBooking(wixId);
        if (protectedBenefit) {
          return JSON.stringify({
            error: "key_benefit_non_cancellable",
            benefit: protectedBenefit.kind.toLowerCase(),
            message:
              "Ce cours en plus ou cette invitation ne peut être ni annulé, ni reporté et le crédit reste consommé.",
          });
        }
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
              "Politely explain the 16h rule. If they insist on an exceptional situation, call handoff_to_human " +
              "and reception will reach out to them. " +
              "Do NOT suggest examples of valid excuses.",
          });
        }
        return JSON.stringify({
          error: "studio_cancellation_requires_reception",
          class: wb.serviceName,
          slot_start_dakar: fmtDakar(wb.startDate),
          booked_via: "studio",
          note:
            "Keep this booking unchanged and call handoff_to_human. Reception must identify whether it used " +
            "money or a plan credit, apply the no-cash-refund policy, and contact the client here. Do not " +
            "promise a refund or re-credit.",
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

      const protectedBenefit = await keyRepo.protectedBenefitForBooking(booking.id);
      if (protectedBenefit) {
        return JSON.stringify({
          error: "key_benefit_non_cancellable",
          benefit: protectedBenefit.kind.toLowerCase(),
          message:
            "Ce cours en plus ou cette invitation est définitif dès la réservation : " +
            "il ne peut être ni annulé, ni reporté et le crédit reste consommé. " +
            "Si Revive a annulé le cours, transmettre à la réception pour remplacement.",
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
            "Politely explain the 16h rule. If they insist on an exceptional situation, call handoff_to_human " +
            "and reception will reach out to them. " +
            "Do NOT suggest examples of valid excuses.",
        });
      }

      if (
        booking.payment_method !== "membership" &&
        input.acknowledge_no_refund !== true
      ) {
        return JSON.stringify({
          error: "no_refund_confirmation_required",
          message:
            "Do not cancel yet. Explain that a voluntary cancellation is non-refundable, and offer a " +
            "same-class reschedule or a self-service transfer to another person, who attends under the original " +
            "booking name without any Wix change or reception handoff. Retry with acknowledge_no_refund:true " +
            "only after the client explicitly accepts losing the payment.",
        });
      }

      // Cancel in Wix first — if that fails, nothing changed anywhere.
      // Pricing-plan bookings use Wix's native refund path so the dashboard's
      // booking/payment state and the Benefit Programs credit cannot diverge.
      await wix.cancelBooking(booking.wix_booking_id, {
        refundMembership: booking.payment_method === "membership",
      });

      if (booking.payment_method === "membership") {
        // Verify the native plan refund, with a guarded manual fallback for
        // older custom-redemption bookings that Wix cannot associate itself.
        let recredited = false;
        let recreditSource: "native" | "fallback" | null = null;
        if (booking.benefit_transaction_id) {
          try {
            recreditSource = await wix.ensureBenefitTransactionReverted(
              booking.benefit_transaction_id,
            );
            recredited = true;
          } catch (err) {
            console.error(`Re-credit failed for booking ${bookingId}:`, err);
          }
        } else {
          // The native refund was explicitly requested, but old/imported rows
          // may not retain the Benefit Programs transaction id for verification.
          recredited = true;
          recreditSource = "native";
        }
        let refundMarkerSynced = false;
        if (recredited) {
          try {
            // Native cancellation can restore the plan credit but leave Wix's
            // booking/payment view at PAID. Keep both authoritative views aligned.
            await wix.markCancelledBookingRefunded(booking.wix_booking_id);
            refundMarkerSynced = true;
          } catch (err) {
            console.error(`Refund marker sync failed for booking ${bookingId}:`, err);
            notifyReception(
              "⚠️ Statut de remboursement Wix à synchroniser",
              `La séance d'abonnement a bien été annulée et re-créditée, mais Wix affiche encore ` +
                `potentiellement la réservation comme payée.\n  Client : ${client.name ?? "?"} (+${client.wa_phone.replace(/^\+/, "")})\n` +
                `  Cours : ${booking.service_name} — ${fmtDakar(String(booking.slot_start))}\n` +
                `  Booking Wix : ${booking.wix_booking_id}\n\n` +
                `À faire : marquer le paiement de cette réservation annulée comme REMBOURSÉ dans Wix. ` +
                `Ne pas ajouter de séance : le crédit a déjà été restauré.`,
            );
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
          recredit_source: recreditSource,
          wix_payment_status_synced: refundMarkerSynced,
          note: recredited
            ? (booking.participants > 1
                ? `Cancelled; all ${booking.participants} plan sessions were re-credited automatically. Tell the client.`
                : "Cancelled; the plan session was re-credited automatically. Tell the client.")
            : "Cancelled; the plan session(s) will be re-credited by the reception team (already notified). Tell the client.",
        });
      }

      await repo.markCancelledWithoutRefund(bookingId);
      return JSON.stringify({
        cancelled: true,
        class: booking.service_name,
        slot_start_dakar: fmtDakar(String(booking.slot_start)),
        non_refundable: true,
        cafe_order_note:
          booking.extras_amount_xof > 0
            ? `The paid bar order (${booking.extras_amount_xof} FCFA) is unchanged and is not refunded.`
            : undefined,
        note:
          "Cancelled after explicit no-refund acceptance. Confirm that the seat was released and the payment " +
          "is not refunded. Do not mention reception or any refund process.",
      });
    }

    case "join_waitlist": {
      const claimedServiceId = String(input.service_id ?? "");
      const rawId = String(input.event_id ?? "");
      const claimedSlotStart = String(input.slot_start ?? "");
      if (!claimedServiceId || !rawId || Number.isNaN(Date.parse(claimedSlotStart))) {
        return JSON.stringify({ error: "invalid_arguments" });
      }
      // A waitlist entry is valid only for a slot actually served to this
      // client. The cache also decides the canonical service.
      const cachedFull = await repo.getCachedSlot(client.id, rawId);
      if (!cachedFull) {
        return JSON.stringify({
          error: "unknown_slot",
          message: "This slot was not offered to the client. Re-run check_availability first.",
        });
      }
      const eventId = cachedFull.event_id;
      const serviceId = cachedFull.service_id;
      const slotStart = String((cachedFull.slot_json as any)?.startDate ?? "");
      if (!slotStart || Number.isNaN(Date.parse(slotStart))) {
        return JSON.stringify({
          error: "unknown_slot",
          message: "The cached slot is incomplete. Re-run check_availability first.",
        });
      }
      if (claimedServiceId !== serviceId) {
        console.warn("Service id mismatch recovered from offered slot", {
          tool: name,
          clientId: client.id,
          claimedServiceId,
          canonicalServiceId: serviceId,
        });
      }
      const service = await wix.getService(serviceId);
      if (!service) return await unknownServiceIdResult();

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
      const claimedServiceId = String(input.service_id ?? "").trim();
      let serviceId: string | undefined;
      if (claimedServiceId) {
        const exact = await wix.getService(claimedServiceId);
        if (exact) {
          serviceId = exact.id;
        } else {
          const services = await wix.listServices();
          serviceId = resolveServiceAlias(claimedServiceId, services) ?? undefined;
          if (!serviceId) {
            return JSON.stringify({
              error: "unknown_service_id",
              removed: 0,
              message: "The class could not be identified. Re-run list_classes before confirming removal.",
            });
          }
        }
      }
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
      // Just verified/linked moments ago? Don't start over or email a second
      // code (which would re-arm AWAITING_CODE and block the payment link).
      // The account is already set up — continue the booking. Prod 13/07.
      const justResolved = await links.recentlyResolved(client.id);
      if (justResolved) {
        invalidateMembershipCache(client.id);
        return JSON.stringify({
          status: "already_verified_recently",
          message:
            "This client's account was JUST verified/linked moments ago — do NOT start another " +
            "verification, do NOT ask for the email again, do NOT send a new code. Their account is " +
            "connected. Simply continue what they wanted: run check_membership if you need their plans, " +
            "otherwise proceed to book (create_payment_link, or book_with_membership if a plan covers it).",
        });
      }
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
            "tomorrow, or offer normal Wave payment meanwhile. If they want reception help now, call " +
            "handoff_to_human and reception will reach out to them.",
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
        case "already_linked": {
          invalidateMembershipCache(client.id);
          const durable = await links.latestProvenLinkRequest(client.id);
          if (durable && durable.linked_contact_id === candidate.contactId) {
            // The phone's fiche was already PROVEN by a past code. No member yet
            // is fine — create_plan_payment_link now provisions it from this
            // durable proof (F1). Do NOT re-verify and do NOT mutate the proof's
            // timestamp (that would fake a "recent" proof and bypass the
            // phone-ambiguity guard). Just tell the model to retry.
            return JSON.stringify({
              status: "already_linked",
              message:
                "The account carrying this email ALREADY has this WhatsApp number and was previously " +
                "verified. No new verification is needed — retry create_plan_payment_link NOW (with the " +
                "payment method) and it will succeed. To just show plans, run check_membership.",
            });
          }
          // The fiche carries this phone+email but was NEVER proven by a code
          // (e.g. a fiche a past Wave payment created). A durable proof is
          // required before we may open a member for it (anti-hijack), so send
          // a real code now — exactly like a single-candidate link.
          const code = links.generateCode();
          await links.setAwaitingCode(request.id, email, candidate.contactId, links.hashCode(code, request.id));
          try {
            await sendVerificationCodeEmail(email, code);
          } catch (err) {
            console.error("Verification-code email failed (already-linked reproof):", err);
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
              "A 6-digit code was just emailed to that address to finish setting up the account (check " +
              "spam too). Ask the client to type it HERE, then call submit_verification_code. The code is " +
              `valid ${links.CODE_TTL_MINUTES} minutes. You do NOT know it — it only exists in their inbox.`,
          });
        }
        case "none": {
          const wantsCreate = input.create_account === true;
          const clientName = String(input.client_name ?? "").slice(0, 80).trim();
          // No fiche carries this email — DON'T escalate.
          const action = decideNoneCandidateAction(wantsCreate, clientName);
          if (action === "name_required") {
            return JSON.stringify({
              status: "name_required",
              message:
                "To create the account, ask the client for their full name, then call again with " +
                "create_account:true and client_name.",
            });
          }
          if (action === "offer_creation") {
            return JSON.stringify({
              status: "email_not_found_offer_creation",
              message:
                "No existing Revive account carries this email. Ask the client: do they want you to CREATE a " +
                "new account with this email? If yes, get their full name and call request_email_verification " +
                "again with client_name (create_account:true). If they expected an existing account, they " +
                "can re-send a different email instead. (No code was sent yet.)",
            });
          }
          // action === "send_code": name is known → create the account now.
          const code = links.generateCode();
          // wix_contact_id null = create-account marker: the fiche is created at
          // submit_verification_code time, once the email is proven by code.
          await links.setAwaitingCode(request.id, email, null, links.hashCode(code, request.id), clientName);
          try {
            await sendVerificationCodeEmail(email, code);
          } catch (err) {
            console.error("Verification-code email failed (account creation):", err);
            await escalateLinkRequest(request, client, `envoi du code impossible (création compte, email ${email})`);
            return JSON.stringify({
              status: "send_failed",
              message:
                "The verification email could not be sent — reception has been notified. Tell the client the " +
                "team is on it (no need to call).",
            });
          }
          return JSON.stringify({
            status: "code_sent_for_new_account",
            expires_in_minutes: links.CODE_TTL_MINUTES,
            message:
              "A 6-digit code was just emailed to that address. Ask the client to read it in their inbox " +
              "(spam folder too) and type it HERE — then call submit_verification_code, which will create " +
              `their new Revive account. The code is valid ${links.CODE_TTL_MINUTES} minutes. You do NOT ` +
              "know the code and can never confirm or repeat it — it only exists in the client's inbox.",
          });
        }
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
            "No verification is in progress. This usually means the code was ALREADY accepted earlier in " +
            "this conversation (the account is set up) — do NOT restart a verification, re-ask for the " +
            "email, or resubmit an old code. Just continue what the client wanted: answer their question " +
            "and/or proceed to book (create_payment_link, or book_with_membership if a plan covers it). " +
            "Start a NEW request_email_verification only if the client now brings up a different account.",
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
      // Two paths converge here, both now proven by the code:
      //  - wix_contact_id set → existing account, attach this number to it;
      //  - wix_contact_id null → create-account path, create the fiche now.
      let provenId: string;
      try {
        if (request.wix_contact_id) {
          await wix.addPhoneToContact(request.wix_contact_id, wa);
          provenId = request.wix_contact_id;
        } else {
          provenId = await wix.createContact({
            name: request.claimed_name ?? client.name ?? undefined,
            phone: wa,
            email: request.claimed_email ?? undefined,
          });
        }
      } catch (err) {
        console.error("Wix write failed after verified code:", err);
        await escalateLinkRequest(request, client, "code vérifié mais écriture Wix en échec");
        return JSON.stringify({
          status: "link_failed",
          message:
            "The code was right but the account update failed — reception has been notified and will " +
            "finish the linking manually. Tell the client the team is on it (no need to call).",
        });
      }
      await links.markVerified(request.id, provenId);
      invalidateMembershipCache(client.id);

      // Les réservations payées AVANT la création de la fiche (nom de profil
      // WhatsApp « A », cas Amy Ndiaye 20/07) restent orphelines dans Wix —
      // maintenant que la fiche est prouvée, on les rattache. Non bloquant.
      void backfillBookingContacts({ clientId: client.id, phone: wa, contactId: provenId });

      // Post-verification duplicate handling. The number is JUST on the proven
      // fiche (attached or freshly created), so we list ALL fiches carrying it
      // (not the "unique-or-null" collapse of findContactIdByPhone — that
      // returns null both when the Wix search index simply lags the write we
      // just made, AND when a real second fiche exists; conflating them
      // produced a FALSE "verified_pending_merge", cf. the 340 ms race 11/07).
      // On the create path this also absorbs any anonymous fiche a past Wave
      // payment left on this number.
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

      const memberships = await wix.listActiveMemberships(provenId);
      const created = !request.wix_contact_id;
      return JSON.stringify({
        status: created ? "account_created" : "verified",
        active_plans: memberships.map((m) => ({ plan: m.planName, expires: m.expiresAt })),
        message: created
          ? "New Revive account created and linked to this WhatsApp number! Tell the client their account " +
            "is set up — future bookings and any abonnement will be tied to it automatically. Offer to book " +
            "their next class right away."
          : "Account linked! You CAN now tell the client their account is connected to this WhatsApp " +
            "number. Their active plans are listed above (details/balance via check_membership) — offer " +
            "to book their next class right away, on the plan when it covers the class.",
      });
    }

    case "send_invoice": {
      const candidates = await repo.recentReceiptCandidates(client.id);
      if (candidates.length === 0) {
        return JSON.stringify({
          sent: false,
          error: "no_recent_payments",
          message:
            "No recent payments found for this client (class, plan, or bar in the last 90 days), so " +
            "there is nothing to invoice. Tell them politely; for a facture on an older or special " +
            "payment, use handoff_to_human. Do NOT invent amounts.",
        });
      }
      const wantedId = input.receipt_id ? String(input.receipt_id).trim() : "";
      let chosen = wantedId ? candidates.find((c) => c.id === wantedId) : undefined;
      if (wantedId && !chosen) {
        return JSON.stringify({
          sent: false,
          error: "unknown_receipt_id",
          candidates: candidates.map((c) => ({
            receipt_id: c.id,
            kind: c.kind,
            label: c.label,
            amount_xof: c.amountXof,
            amount_label: formatXof(c.amountXof),
          })),
          message: "That receipt_id is not in the client's recent payments. Ask which one they want.",
        });
      }
      if (!chosen && candidates.length > 1) {
        return JSON.stringify({
          sent: false,
          needs_choice: true,
          candidates: candidates.map((c) => ({
            receipt_id: c.id,
            kind: c.kind,
            label: c.label,
            detail: c.detail,
            amount_xof: c.amountXof,
            amount_label: formatXof(c.amountXof),
            paid_at: c.paidAt.toISOString(),
          })),
          message:
            "Several recent payments — ask the client which one (or present_options) then call send_invoice " +
            "again with that receipt_id. Do NOT invent amounts; use the list above.",
        });
      }
      chosen = chosen ?? candidates[0];
      // A facture carries the client's identity — never emit one for an
      // anonymous row. The model asks for the name and passes it back here.
      const givenName = input.client_name ? String(input.client_name).trim().slice(0, 80) : "";
      if (!client.name && givenName) {
        await repo.updateClientName(client.id, givenName);
        client = { ...client, name: givenName };
      }
      if (!client.name) {
        return JSON.stringify({
          sent: false,
          error: "missing_client_name",
          message:
            "This client has no name on file and a facture needs one. Ask for their full name, " +
            "then call send_invoice again passing it as client_name.",
        });
      }
      let detailLine = chosen.detail;
      if (chosen.kind === "booking" && chosen.detail) {
        const d = new Date(chosen.detail);
        if (!Number.isNaN(d.getTime())) {
          detailLine = d.toLocaleString("fr-FR", {
            timeZone: config.TIMEZONE,
            weekday: "long",
            day: "numeric",
            month: "long",
            hour: "2-digit",
            minute: "2-digit",
          });
        }
      }
      const company = input.company ? String(input.company).trim().slice(0, 120) : null;
      try {
        // One facture per payment: re-asking resends the same number. A new
        // company name on the facture is the one case that mints a new one.
        let invoice = await invoices.findInvoiceBySource(chosen.kind, chosen.id);
        if (invoice && company && (invoice.client_ref ?? "") !== company) invoice = null;
        if (!invoice) {
          invoice = await invoices.createInvoice({
            client_name: client.name,
            client_phone: client.wa_phone,
            client_ref: company,
            lines: [
              {
                label: detailLine ? `${chosen.label} — ${detailLine}` : chosen.label,
                qty: 1,
                unit_xof: chosen.amountXof,
                total_xof: chosen.amountXof,
              },
            ],
            total_xof: chosen.amountXof,
            note: null,
            source_kind: chosen.kind,
            source_id: chosen.id,
            payment_method: chosen.paidVia,
            payment_ref: chosen.paymentRef,
            paid_at: chosen.paidAt,
            created_by: "awa",
          });
        }
        const pdf = await renderInvoicePdf({
          number: invoice.number,
          clientName: invoice.client_name,
          clientRef: invoice.client_ref,
          clientPhone: invoice.client_phone,
          lines: invoices.invoiceLines(invoice),
          totalXof: invoice.total_xof,
          note: invoice.note,
          paidVia: invoice.payment_method,
          paymentRef: invoice.payment_ref,
          paidAt: invoice.paid_at,
          createdAt: invoice.created_at,
        });
        const caption = `Facture ${invoice.number} — Revive · ${formatXof(invoice.total_xof)}`;
        const wamid = await sendDocument(client.wa_phone, pdf, `Facture-${invoice.number}.pdf`, caption);
        await invoices.markInvoiceSent(invoice.id, "sent");
        await recordInvoiceLog(client.wa_phone, `[facture ${invoice.number}] ${caption}`, "sent", null, wamid ?? null);
        await repo.addTurn(
          client.id,
          "assistant",
          `[document envoyé : facture ${invoice.number} (PDF) — ${chosen.label} ${formatXof(chosen.amountXof)}]`,
        );
        return JSON.stringify({
          sent: true,
          invoice_number: invoice.number,
          receipt_id: chosen.id,
          kind: chosen.kind,
          label: chosen.label,
          amount_xof: chosen.amountXof,
          note:
            "Facture image already delivered (visible in /admin/factures). Confirm briefly in the " +
            "client's language, naming the facture number. If they need extra legal mentions the " +
            "facture doesn't carry, use handoff_to_human.",
        });
      } catch (err) {
        console.error("send_invoice failed:", err);
        return JSON.stringify({
          sent: false,
          error: "invoice_send_failed",
          message:
            "Could not create or send the facture. Apologize briefly and call handoff_to_human so " +
            "reception prepares it.",
        });
      }
    }

    case "handoff_to_human": {
      const reason = String(input.reason ?? "unspecified").slice(0, 500);
      await repo.recordHandoff(client.id, reason);
      const outreach = clientOutreachLink(client.wa_phone, client.name);
      notifyReception(
        `🙋🏾 Handoff client — ${reason.slice(0, 60)}`,
        `Un client attend une réponse de la réception :\n` +
          `  Client : ${client.name ?? "?"} (+${client.wa_phone.replace(/^\+/, "")})\n` +
          `  Motif : ${reason}\n\n` +
          `→ Écris-lui directement (message prérempli) : ${outreach.url}\n` +
          `Extrait de la conversation dans le registre handoffs (npm run summary).`,
      );
      return JSON.stringify({
        reception_notified: true,
        reception_whatsapp: config.RECEPTION_PHONE,
        note:
          "Handoff recorded and reception notified with a one-tap link to write to this client. " +
          "Tell the client, in their language, that reception will contact them directly HERE shortly to " +
          "handle their request — they do NOT need to do anything or send any message. Do NOT give them a " +
          "link. Only if the client explicitly asked to CALL, also give reception_whatsapp as the phone number.",
      });
    }

    case "disengage_conversation": {
      const reason = String(input.reason ?? "Contact non sérieux").slice(0, 500);
      await repo.setAwaDisengaged(client.id, reason, 24, "nonserious");
      return JSON.stringify({
        disengaged: true,
        note:
          "Awa will now stay silent to this contact (auto-resumes after ~24h; reception can lift it). " +
          "Send exactly ONE short, polite, firm line in the client's language re-anchoring to Revive and " +
          "reservations — do not reciprocate, moralize or scold — then STOP. Do not add anything else.",
      });
    }

    case "get_class_schedule": {
      // This tool has a WhatsApp side effect. Validate the exact caption that
      // Meta will receive BEFORE rendering/uploading anything, so the model
      // cannot send the image first and omit the greeting or sibling questions.
      const message = String(input.message ?? "").trim().slice(0, 1024);
      const missing = missingReplyRequirements(
        message,
        turnContext.replyRequirements ?? [],
        { scheduleAttached: true },
      );
      if (!message || missing.length > 0) {
        return missingRequirementsToolResult(
          missing.length > 0 ? missing : ["schedule_overview"],
        );
      }
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
              "Say the planning is unavailable right now and call handoff_to_human and reception " +
              "will reach out to the client.",
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
          const wamid = await sendImage(client.wa_phone, cached.png, message);
          await repo.addTurn(
            client.id,
            "assistant",
            `${message}\n[image envoyée : planning hebdomadaire des cours]\n${text}`,
            wamid ?? undefined,
          );
          return JSON.stringify({
            sent: true,
            schedule: text,
            note:
              `The complete caption + weekly schedule image were already delivered and logged. Reply exactly ${NO_REPLY_SENTINEL} ` +
              "and nothing else — any follow-up would duplicate or push the informational reply.",
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
          "grouping) together with every CURRENT-TURN REQUIRED COVERAGE answer. Do not add a booking question " +
          "unless the client showed buying intent.",
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
      const missing = missingReplyRequirements(
        body,
        turnContext.replyRequirements ?? [],
      );
      if (missing.length > 0) return missingRequirementsToolResult(missing);
      if (!body || options.length === 0 || options.length > 10 || uniqueIds.size !== options.length) {
        return JSON.stringify({
          error: "invalid_options",
          message:
            "present_options needs a body and 1-10 options, each with a UNIQUE id and a title. " +
            "Fix the input and retry, or fall back to plain text.",
        });
      }
      // Slot option ids must be real choice_ids from a fresh check_availability,
      // never composed by the model (prod 29/07: slot_placeholder2/3/4 shipped
      // as options next to one real slot). Send nothing on any miss so the model
      // must re-fetch.
      const badSlotIds = await invalidSlotOptionIds(
        options.map((o) => o.id),
        (id) => repo.getCachedSlot(client.id, id),
      );
      if (badSlotIds.length > 0) {
        return JSON.stringify({
          error: "unknown_slot_option",
          message:
            "Every slot_ option id must be a choice_id returned by a FRESH check_availability " +
            `in this conversation. Invented or expired ids: ${badSlotIds.join(", ")}. ` +
            "Re-run check_availability and pass ONLY the choice_ids it returns. Nothing was sent.",
        });
      }
      const { kind, wamid } = await sendInteractive(client.wa_phone, body, buttonLabel, options);
      await repo.savePresentedChoices(
        client.id,
        options.map((option) => ({ id: option.id, title: option.title })),
      ).catch((error) =>
        console.error("Failed to persist presented choices after delivery:", error),
      );
      // Log what the client saw, so rebuilt history stays coherent. Keep the
      // outbound wamid so a reaction to this message can be matched to it.
      await repo.addTurn(
        client.id,
        "assistant",
        `${body}\n[message interactif ${kind} — options : ${options.map((o) => o.title).join(" · ")}]`,
        wamid ?? undefined,
      );
      // Once-per-conversation window for vague-opener capability menus.
      if (options.some((o) => isCapabilityOptionId(o.id))) {
        await repo.markCapabilityMenuShown(client.id).catch((err) =>
          console.error("markCapabilityMenuShown failed:", err),
        );
      }
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
