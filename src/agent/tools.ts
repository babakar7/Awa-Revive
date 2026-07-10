import type Anthropic from "@anthropic-ai/sdk";
import { config } from "../config.js";
import { notifyReception } from "../lib/notify.js";
import { sendInteractive } from "../lib/whatsapp.js";
import {
  CAFE_MENU,
  computeExtras,
  extrasFromJson,
  formatExtrasOneLine,
} from "../lib/cafeMenu.js";
import * as wix from "../lib/wix.js";
import * as wave from "../lib/wave.js";
import { invalidateMembershipCache } from "../lib/membershipContext.js";
import * as repo from "../domain/repo.js";
import type { Client } from "../domain/repo.js";

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
      "are full and propose open alternatives instead. Call this whenever the client asks about times/days for a class.",
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
      "remaining_sessions (current balance), or why verification failed.",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "book_with_membership",
    description:
      "Book ONE spot on a class slot using the client's active abonnement — no Wave payment. Wix itself " +
      "validates that the plan covers this service and decrements the plan credit; if not eligible, this " +
      "returns an error and you should offer the normal Wave payment instead. Only call when the " +
      "context or check_membership shows an active plan whose covers_classes includes this class, " +
      "and the client chose a slot from check_availability.",
    input_schema: {
      type: "object",
      properties: {
        service_id: { type: "string", description: "Class id from list_classes" },
        event_id: { type: "string", description: "event_id (or choice_id) of the chosen slot from check_availability" },
        slot_start: { type: "string", description: "ISO start time of the chosen slot" },
        client_name: { type: "string", description: "Client's first name" },
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
      "breakdown. Never use this for a class (that's create_payment_link) or for a café order with no class booking.",
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
      "'awa' (taken through this chat — carries a booking_id usable with cancel_booking) or 'studio' " +
      "(booked at the counter or on the website, matched by the client's WhatsApp number — NO booking_id, " +
      "cannot be cancelled here: any change goes through reception). Use it before answering about existing " +
      "bookings and before any cancel/reschedule.",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "cancel_booking",
    description:
      "Cancel one of THIS client's upcoming bookings (all its spots). Only allowed 16 hours or more " +
      "before the class start — the server enforces this and refuses otherwise. Membership-paid bookings: " +
      "the plan session is automatically re-credited. Wave-paid bookings: the client will be refunded " +
      "manually by reception (they are notified automatically). Also the first step of a reschedule " +
      "(cancel, then book the new slot in the same turn). Call ONLY after get_my_bookings gave you " +
      "the booking_id AND the client explicitly confirmed they want to cancel that specific class.",
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
    name: "record_email",
    description:
      "Record the email address a client provides to link their WhatsApp bookings to their existing Revive " +
      "account. This only STORES the email for the reception team, who will verify and merge the accounts " +
      "manually — never tell the client the linking is done, say the team will handle it. Use whenever a " +
      "client shares an email in the context of their account/history.",
    input_schema: {
      type: "object",
      properties: {
        email: { type: "string", description: "The email address the client provided" },
      },
      required: ["email"],
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
];

/**
 * When the model's final text equals this sentinel, the agent loop sends
 * nothing: a present_options call already delivered the reply.
 */
export const NO_REPLY_SENTINEL = "<NO_REPLY>";

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
          event_id: s.openSpots > 0 ? s.eventId : undefined,
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
        })),
        note:
          slots.some((s) => s.openSpots <= 0)
            ? "Slots marked full:true exist but cannot be booked — if the client asked for one of them, say it's full and suggest open alternatives."
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

      // The café rides on one of THIS client's own confirmed, still-upcoming
      // bookings (Wave- OR membership-paid). An explicit id is checked for
      // ownership (same stance as cancel_booking); with no id we default to the
      // class they most recently booked — the Wave flow books server-side, so
      // the model never sees that booking_id.
      const booking = linkedBookingId
        ? await repo.findClientBooking(client.id, linkedBookingId)
        : await repo.latestUpcomingBooking(client.id);
      if (
        !booking ||
        booking.status !== "BOOKED" ||
        new Date(booking.slot_start).getTime() <= Date.now()
      ) {
        return JSON.stringify({
          error: "unknown_booking",
          message:
            "No matching upcoming confirmed booking for this client. A café-only link attaches to a class the " +
            "client has already booked (Wave or abonnement) — re-run get_my_bookings, or the client books a class first.",
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
        linkedBookingId: booking.id,
        serviceName: booking.service_name,
        slotStart: booking.slot_start,
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
        for_class: booking.service_name,
        slot_start_dakar: fmtDakar(String(booking.slot_start)),
        note:
          "Relay the link — this covers ONLY the café order (the class itself is already booked and paid, " +
          "nothing more to pay for it). State the items and total. Ready after the class unless the note says " +
          "otherwise. Confirmation arrives automatically on WhatsApp once paid.",
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
      // Identity = verified WhatsApp number → unambiguous CRM contact.
      const contactId = await wix.findContactIdByPhone(
        `+${client.wa_phone.replace(/^\+/, "")}`,
        client.name ?? undefined,
      );
      if (!contactId) {
        return JSON.stringify({
          verified: false,
          reason: "no_matching_contact",
          message:
            "Could not match this WhatsApp number to a unique client account. The client may have an " +
            "abonnement under another number — hand off to reception to verify, or offer normal Wave payment.",
        });
      }
      const memberships = await wix.listActiveMemberships(contactId);
      if (memberships.length === 0) {
        return JSON.stringify({
          verified: true,
          active_plans: [],
          message: "No active abonnement for this client. Use the normal Wave payment flow.",
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

      const slot = (cached.slot_json as any) ?? {};
      const slotStart: string = slot.startDate ?? String(input.slot_start ?? "");
      const fresh = await wix.isSlotStillOpen(serviceId, resolvedEventId, slotStart, 1);
      if (!fresh) {
        return JSON.stringify({
          error: "slot_full",
          message: "This slot just filled up. Offer alternatives via check_availability.",
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

      // 2. Booking (CREATED) → 3. deduct one plan credit → 4. confirm in calendar.
      const wixBookingId = await wix.createBookingRaw({
        slot: fresh.raw,
        name: clientName,
        phone,
        participants: 1,
        paymentOption: "MEMBERSHIP",
      });

      try {
        const redemption = await wix.redeemMembershipForBooking({
          wixBookingId,
          serviceId,
          benefit,
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
        });
        // One session was just deducted — the cached balance is stale.
        invalidateMembershipCache(client.id);
        return JSON.stringify({
          booked: true,
          booking_id: membershipBooking.id,
          paid_with: redemption.membershipName,
          remaining_sessions: Math.max(0, benefit.available - 1),
          class: service.name,
          slot_start: fresh.startDate,
          slot_start_dakar: fmtDakar(fresh.startDate),
          note:
            "Booked and confirmed using the client's abonnement (one session deducted). " +
            "Confirm to the client with class, date/time, that it used their plan (mention remaining_sessions), " +
            "and remind them cancellation is free up to 16h before the class (after that the session is due) — no payment needed. " +
            "If they then want something from the menu, use create_cafe_payment_link with this booking_id.",
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
      // website (identified by their WhatsApp number → CRM contact). These have
      // no local payment/plan context, so Awa can show but not cancel them —
      // dedupe against the Wix ids Awa already created.
      const external: unknown[] = [];
      try {
        const contactId = await wix.findContactIdByPhone(
          `+${client.wa_phone.replace(/^\+/, "")}`,
          client.name ?? undefined,
        );
        if (contactId) {
          const ownWixIds = new Set(
            bookings.map((b) => b.wix_booking_id).filter((x): x is string => !!x),
          );
          const wixBookings = await wix.listContactUpcomingBookings(contactId);
          for (const wb of wixBookings) {
            if (ownWixIds.has(wb.id)) continue; // already in `own`
            external.push({
              class: wb.serviceName,
              start: wb.startDate,
              start_dakar: fmtDakar(wb.startDate),
              participants: wb.participants,
              booked_via: "studio", // counter or website
              status: "confirmed",
              not_cancellable_here:
                "Booked outside Awa — to change or cancel it, the client contacts reception.",
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
            ? "booked_via 'studio' bookings were made at the counter/website: show them but say any change goes through reception (no booking_id, cancel_booking won't work on them)."
            : undefined,
      });
    }

    case "cancel_booking": {
      const bookingId = String(input.booking_id ?? "");
      if (!bookingId) return JSON.stringify({ error: "invalid_arguments" });

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
            "⚠️ Séance d'abonnement à re-créditer manuellement",
            `Awa a annulé une réservation payée par abonnement mais n'a pas pu re-créditer la séance ` +
              `automatiquement.\n  Client : ${client.name ?? "?"} (+${client.wa_phone.replace(/^\+/, "")})\n` +
              `  Cours : ${booking.service_name} — ${fmtDakar(String(booking.slot_start))}\n` +
              `  Booking Wix : ${booking.wix_booking_id}\n\n` +
              `À faire : re-créditer une séance sur le plan du client dans le dashboard Wix.`,
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
          note: recredited
            ? "Cancelled; the plan session was re-credited automatically. Tell the client."
            : "Cancelled; the plan session will be re-credited by the reception team (already notified). Tell the client.",
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

    case "record_email": {
      const email = String(input.email ?? "").trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) || email.length > 254) {
        return JSON.stringify({
          error: "invalid_email",
          message: "This doesn't look like a valid email — ask the client to re-send it.",
        });
      }
      await repo.saveClaimedEmail(client.id, email);
      // Surfaces in the handoffs register + daily summary for reception.
      await repo.recordHandoff(client.id, `Compte à lier — email déclaré : ${email}`);
      notifyReception(
        "🔗 Compte à lier — email déclaré par un client",
        `Le client ${client.name ?? "?"} (+${client.wa_phone.replace(/^\+/, "")}) déclare que son compte ` +
          `Revive existant utilise l'email : ${email}\n\n` +
          `À faire : vérifier dans Wix qu'un compte existe avec cet email, puis fusionner les fiches ` +
          `et ajouter le numéro WhatsApp ci-dessus à la fiche.`,
      );
      return JSON.stringify({
        recorded: true,
        note:
          "Email stored for the reception team, who will verify it and merge the client's account manually. " +
          "Thank the client and say the team will link their history soon — do NOT claim it is already linked.",
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
