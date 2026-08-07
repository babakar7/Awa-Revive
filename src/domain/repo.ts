import crypto from "node:crypto";
import type pg from "pg";
import { pool } from "../db/index.js";
import { paymentMethodLabel } from "../lib/paymentMethod.js";
import { recordBookingFunnelEvent } from "./bookingFunnel.js";
import { transition } from "./stateMachine.js";
import { NO_INTENT_THRESHOLD, NO_INTENT_WINDOW_HOURS } from "./noIntentGuard.js";

export type AwaDisengagedKind = "manual" | "nonserious" | "no_intent" | "sexual";

export interface Client {
  id: string;
  wa_phone: string;
  name: string | null;
  language: string | null;
  email_prompted_at: Date | null;
  claimed_email: string | null;
  /** Last capability menu (vague opener) delivered — once-per-conversation window. */
  capability_menu_at: Date | null;
  fr_register: "tu" | "vous" | null;
  /** Studio team/test number — badged in admin, no new-conversation ping. */
  is_test: boolean;
  /** Awa stays paused while this timestamp is in the future. */
  human_takeover_until: Date | null;
  human_takeover_by: string | null;
  human_takeover_at: Date | null;
  /**
   * Awa self-disengaged from a non-serious/suggestive contact: she stays silent
   * (no reply at all, no team ping) while this timestamp is in the future.
   */
  awa_disengaged_until: Date | null;
  awa_disengaged_at: Date | null;
  awa_disengaged_reason: string | null;
  awa_disengaged_kind: AwaDisengagedKind | null;
  awa_no_intent_streak: number;
  awa_no_intent_last_at: Date | null;
}

export interface PendingBooking {
  id: string;
  client_id: string;
  service_id: string;
  service_name: string;
  event_id: string;
  slot_json: unknown;
  slot_start: Date;
  slot_end: Date | null;
  amount_xof: number;
  participants: number;
  status: string;
  wave_session_id: string | null;
  payment_link: string | null;
  link_expires_at: Date | null;
  wix_booking_id: string | null;
  payer_phone: string | null;
  payment_method: string;
  forfeited_at: Date | null;
  benefit_transaction_id: string | null;
  extras_json: unknown;
  extras_amount_xof: number;
  order_note: string | null;
  fulfilling_at: Date | null;
  wix_order_id: string | null;
  wix_payment_recorded_at: Date | null;
  wix_order_sync_at: Date | null;
  wix_order_sync_error: string | null;
  /** Multi-session commitment item this attempt pays for (null = standalone). */
  commitment_item_id: string | null;
  campaign_code: string | null;
}

export interface Turn {
  role: string;
  content: string;
  created_at: Date;
}

// ---------- clients ----------

export async function upsertClient(waPhone: string): Promise<Client> {
  const res = await pool.query(
    `insert into clients (wa_phone) values ($1)
     on conflict (wa_phone) do update set updated_at = now()
     returning id, wa_phone, name, language, email_prompted_at, claimed_email,
               capability_menu_at, fr_register, is_test, human_takeover_until,
               human_takeover_by, human_takeover_at, awa_disengaged_until,
               awa_disengaged_at, awa_disengaged_reason, awa_disengaged_kind,
               awa_no_intent_streak, awa_no_intent_last_at`,
    [waPhone],
  );
  return res.rows[0];
}

/** Mark or unmark a client as a studio team/test number (admin toggle). */
export async function setClientTest(clientId: string, isTest: boolean): Promise<void> {
  await pool.query(
    `update clients set is_test = $2, updated_at = now() where id = $1`,
    [clientId, isTest],
  );
}

/**
 * Silence Awa for a clearly non-serious/suggestive contact: she stops replying
 * (no team notification) until the timestamp passes. Mirrors startHumanTakeover,
 * but self-triggered by Awa (or the admin pause button) — default 24h release.
 */
/**
 * True when this client drove a booking/sales tool in the last `minutes` —
 * the server-side signal that they are a real prospect mid-funnel. Used to
 * refuse disengage_conversation: a client picking slots is NEVER a non-serious
 * contact, however short their messages look (prod incident 05/08 : une
 * prospecte qualifiée, en plein choix de créneau — « En matinée », « En
 * semaine plutôt » — a été coupée 24h pour « conversation répétitive »).
 */
export async function hasRecentBookingActivity(
  clientId: string,
  minutes = 60,
): Promise<boolean> {
  const { rows } = await pool.query(
    `select 1 from conversations
      where client_id = $1
        and role = 'tool'
        and created_at > now() - make_interval(mins => $2)
        and content ~ '^(list_classes|check_availability|present_options|list_plans|check_membership|get_my_bookings|create_payment_link|create_plan_payment_link|refresh_expired_plan_payment_link|book_with_membership|start_multi_session_commitment|add_spots_to_booking|reschedule_booking|join_waitlist|request_email_verification|submit_verification_code)\\('
      limit 1`,
    [clientId, minutes],
  );
  return rows.length > 0;
}

export async function setAwaDisengaged(
  clientId: string,
  reason: string,
  hours = 24,
  kind: AwaDisengagedKind = "nonserious",
): Promise<void> {
  await pool.query(
    `update clients
        set awa_disengaged_at = now(), awa_disengaged_reason = $2,
            awa_disengaged_until = now() + ($3 * interval '1 hour'),
            awa_disengaged_kind = $4, updated_at = now()
      where id = $1`,
    [clientId, reason.slice(0, 500), hours, kind],
  );
}

/** Lift a disengagement so Awa resumes replying to this client. */
export async function clearAwaDisengaged(clientId: string): Promise<void> {
  await pool.query(
    `update clients
        set awa_disengaged_at = null, awa_disengaged_reason = null,
            awa_disengaged_until = null, awa_disengaged_kind = null,
            awa_no_intent_streak = 0, awa_no_intent_last_at = null,
            updated_at = now()
      where id = $1`,
    [clientId],
  );
}

export interface NoIntentTurnResult {
  streak: number;
  disengaged: boolean;
}

/**
 * Increment the rapid no-intent streak and atomically arm the 24 h silence on
 * the threshold turn. The same atomic statement closes any open human follow-up
 * because the no-intent pause makes it non-actionable. This lives in Postgres so
 * deploys and concurrent webhook deliveries cannot reset or double-decide it.
 */
export async function recordNoIntentTurn(clientId: string): Promise<NoIntentTurnResult> {
  const res = await pool.query(
    `with current as (
       select id,
              case
                when awa_no_intent_last_at is null
                  or awa_no_intent_last_at <= now() - ($2 * interval '1 hour')
                then 1
                else awa_no_intent_streak + 1
              end as next_streak
         from clients
        where id = $1
        for update
     ), updated_client as (
       update clients c
        set awa_no_intent_streak = current.next_streak,
            awa_no_intent_last_at = now(),
            awa_disengaged_at = case when current.next_streak >= $3 then now() else c.awa_disengaged_at end,
            awa_disengaged_until = case when current.next_streak >= $3 then now() + ($2 * interval '1 hour') else c.awa_disengaged_until end,
            awa_disengaged_reason = case when current.next_streak >= $3 then 'Conversation répétitive sans intention Revive' else c.awa_disengaged_reason end,
            awa_disengaged_kind = case when current.next_streak >= $3 then 'no_intent' else c.awa_disengaged_kind end,
            updated_at = now()
       from current
      where c.id = current.id
      returning current.next_streak::int as streak,
                (current.next_streak >= $3) as disengaged
     ), closed_handoffs as (
       update handoffs
          set status = 'DONE', done_by = 'awa-system', done_at = now(),
              resolution_outcome = 'not_applicable',
              resolution_note = 'Auto : conversation mise en pause (boucle sans intention)'
        where client_id = $1 and status = 'OPEN'
          and exists (select 1 from updated_client where disengaged)
        returning id
     ), closed_reviews as (
       update conversation_reviews
          set status = 'DONE', done_by = 'awa-system', done_at = now(),
              resolution_outcome = 'not_applicable',
              resolution_note = 'Auto : conversation mise en pause (boucle sans intention)'
        where client_id = $1 and status = 'OPEN'
          and exists (select 1 from updated_client where disengaged)
        returning id
     )
     select streak, disengaged,
            (select count(*)::int from closed_handoffs) as handoffs_closed,
            (select count(*)::int from closed_reviews) as reviews_closed
       from updated_client`,
    [clientId, NO_INTENT_WINDOW_HOURS, NO_INTENT_THRESHOLD],
  );
  const result = res.rows[0] as NoIntentTurnResult | undefined;
  return result
    ? { streak: result.streak, disengaged: result.disengaged }
    : { streak: 0, disengaged: false };
}

export async function resetNoIntentStreak(clientId: string): Promise<void> {
  await pool.query(
    `update clients
        set awa_no_intent_streak = 0, awa_no_intent_last_at = null, updated_at = now()
      where id = $1 and (awa_no_intent_streak <> 0 or awa_no_intent_last_at is not null)`,
    [clientId],
  );
}

/** Re-open only an automatic no-intent pause; manual/model pauses never match. */
export async function clearNoIntentDisengagement(clientId: string): Promise<boolean> {
  const res = await pool.query(
    `update clients
        set awa_disengaged_at = null, awa_disengaged_reason = null,
            awa_disengaged_until = null, awa_disengaged_kind = null,
            awa_no_intent_streak = 0, awa_no_intent_last_at = null,
            updated_at = now()
      where id = $1 and awa_disengaged_kind = 'no_intent'`,
    [clientId],
  );
  return (res.rowCount ?? 0) > 0;
}

export async function recordCampaignLead(args: { clientId: string; campaignKey: string; triggerMessageId: string; matchedBy: "meta_referral" | "message"; sourceId?: string; sourceType?: string; sourceUrl?: string; headline?: string; ctwaClid?: string }): Promise<void> {
  await pool.query(`insert into campaign_leads (client_id,campaign_key,trigger_message_id,matched_by,source_id,source_type,source_url,headline,ctwa_clid) values ($1,$2,$3,$4,$5,$6,$7,$8,$9) on conflict (client_id,campaign_key) do update set updated_at=now(), source_id=coalesce(campaign_leads.source_id,excluded.source_id), ctwa_clid=coalesce(campaign_leads.ctwa_clid,excluded.ctwa_clid)`, [args.clientId,args.campaignKey,args.triggerMessageId,args.matchedBy,args.sourceId ?? null,args.sourceType ?? null,args.sourceUrl ?? null,args.headline ?? null,args.ctwaClid ?? null]);
}
export async function activeCampaignLead(clientId: string, campaignKey: string): Promise<{ matchedBy: "meta_referral" | "message" } | null> {
  const r = await pool.query(
    `select matched_by from campaign_leads l
      where l.client_id=$1 and l.campaign_key=$2 and l.created_at > now()-interval '14 days'
        and not exists (
          select 1 from pending_bookings b
           where b.client_id=l.client_id and b.campaign_code=l.campaign_key
             and b.status in ('PAID','BOOKED','REFUND_NEEDED')
        )
      limit 1`,
    [clientId, campaignKey],
  );
  const matchedBy = r.rows[0]?.matched_by;
  return matchedBy === "meta_referral" || matchedBy === "message" ? { matchedBy } : null;
}

/**
 * Timestamp of this client's most recent conversation turn, or null if they
 * have never messaged. Used to tell a fresh conversation start (no activity
 * for a while, or ever) from a continuing one — call it BEFORE persisting the
 * incoming turn, so "now" isn't counted as prior activity.
 */
export async function lastConversationActivityAt(clientId: string): Promise<Date | null> {
  const res = await pool.query(
    `select max(created_at) as last from conversations where client_id = $1`,
    [clientId],
  );
  return res.rows[0]?.last ?? null;
}

/** One-shot flag: the "link your account" email question is asked at most once. */
export async function markEmailPrompted(clientId: string): Promise<void> {
  await pool.query(
    `update clients set email_prompted_at = now(), updated_at = now()
      where id = $1 and email_prompted_at is null`,
    [clientId],
  );
}

/**
 * Stamp that a capability menu was delivered (vague-opener shortcut).
 * Arms the 24h "once per conversation" window. Always updates (re-show after window).
 */
export async function markCapabilityMenuShown(clientId: string): Promise<void> {
  await pool.query(
    `update clients set capability_menu_at = now(), updated_at = now() where id = $1`,
    [clientId],
  );
}

/**
 * Atomically claim the right to show the post-booking bar menu offer.
 * Returns false when it was already shown within the last 24h — a client
 * paying several sessions in a row gets the offer once, not after every
 * payment. Claimed BEFORE sending: a lost offer is a minor miss, a repeated
 * one reads as spam.
 */
export async function claimCafeOffer(clientId: string): Promise<boolean> {
  const res = await pool.query(
    `update clients set cafe_offer_at = now(), updated_at = now()
      where id = $1 and (cafe_offer_at is null or cafe_offer_at < now() - interval '7 days')
      returning id`,
    [clientId],
  );
  return (res.rowCount ?? 0) > 0;
}

/**
 * Find a local client whose WhatsApp number matches any of the given phone
 * spellings (a Wix contact's phones come in e164/raw forms). wa_phone is
 * stored as bare digits (WhatsApp wa_id), so we compare on digits only.
 * Returns null when the subscriber has never messaged Awa (no local row).
 */
export async function findClientByPhone(candidates: string[]): Promise<Client | null> {
  const digits = [...new Set(candidates.map((c) => c.replace(/\D/g, "")).filter(Boolean))];
  if (digits.length === 0) return null;
  const res = await pool.query(
    `select id, wa_phone, name, language, email_prompted_at, claimed_email,
            capability_menu_at, fr_register, is_test, human_takeover_until,
            human_takeover_by, human_takeover_at, awa_disengaged_until,
            awa_disengaged_at, awa_disengaged_reason, awa_disengaged_kind,
            awa_no_intent_streak, awa_no_intent_last_at
       from clients where regexp_replace(wa_phone, '\\D', '', 'g') = any($1) limit 1`,
    [digits],
  );
  return res.rows[0] ?? null;
}

/**
 * Atomically claim the right to send ONE renewal nudge for a Wix order.
 * Returns false if a previous sweep already claimed it (one-shot per plan
 * period; a renewal creates a new Wix order → a fresh claim). Claimed BEFORE
 * sending: a lost nudge is a minor miss, a double nudge is spam.
 */
export async function claimRenewalNudge(
  wixOrderId: string,
  clientId: string | null,
  kind = "RENEWAL",
): Promise<boolean> {
  const res = await pool.query(
    `insert into renewal_nudges (wix_order_id, client_id, kind, outcome, detail)
     values ($1, $2, $3, 'FAILED', 'claimed')
     on conflict (wix_order_id) do nothing`,
    [wixOrderId, clientId, kind],
  );
  return (res.rowCount ?? 0) > 0;
}

export async function completeRenewalNudge(
  wixOrderId: string,
  outcome: "SENT" | "SUPPRESSED" | "FAILED",
  detail: string,
): Promise<void> {
  await pool.query(
    `update renewal_nudges
        set outcome=$2, detail=$3, sent_at=now()
      where wix_order_id=$1`,
    [wixOrderId, outcome, detail.slice(0, 1000)],
  );
}

export async function saveClaimedEmail(clientId: string, email: string): Promise<void> {
  await pool.query(
    `update clients set claimed_email = $2, updated_at = now() where id = $1`,
    [clientId, email],
  );
}

export async function updateClientLanguage(clientId: string, language: string): Promise<void> {
  await pool.query(
    `update clients set language = $2, updated_at = now() where id = $1`,
    [clientId, language],
  );
}

export async function latchClientFormalRegister(clientId: string): Promise<void> {
  await pool.query(
    `update clients set fr_register='vous', updated_at=now()
      where id=$1 and fr_register is distinct from 'vous'`,
    [clientId],
  );
}

export async function updateClientName(clientId: string, name: string): Promise<void> {
  await pool.query(
    `update clients set name = $2, updated_at = now() where id = $1 and (name is null or name <> $2)`,
    [clientId, name],
  );
}

/**
 * Store a WhatsApp display name only as a fallback. Names obtained from a Wix
 * contact, booking, or admin action are authoritative and must never be
 * replaced by the informal profile name a person can edit in WhatsApp.
 * Returns the name that won so callers can keep their in-memory client fresh.
 */
export async function setClientNameIfMissing(clientId: string, name: string): Promise<string | null> {
  const res = await pool.query(
    `update clients
        set name = $2, updated_at = now()
      where id = $1 and nullif(btrim(name), '') is null
      returning name`,
    [clientId, name],
  );
  return res.rows[0]?.name ?? null;
}

// ---------- conversations ----------

export async function addTurn(
  clientId: string,
  role: "user" | "assistant" | "tool" | "system",
  content: string,
  waMessageId?: string,
): Promise<void> {
  await pool.query(
    `insert into conversations (client_id, role, content, wa_message_id) values ($1, $2, $3, $4)`,
    [clientId, role, content, waMessageId ?? null],
  );
}

export async function lastTurns(clientId: string, n = 20): Promise<Turn[]> {
  const res = await pool.query(
    `select role, content, created_at
       from (select role, content, created_at from (
               select role, content, created_at
                 from conversations
                where client_id = $1 and role in ('user', 'assistant')
               union all
               select 'assistant' as role,
                      '[MESSAGE HUMAIN DE L''ÉQUIPE REVIVE — contexte, pas une réponse d''Awa]' ||
                      E'\n' || body as content,
                      coalesce(sent_at, created_at) as created_at
                 from admin_outbound_messages
                where client_id = $1 and status = 'sent'
             ) history order by created_at desc limit $2) t
      order by created_at asc`,
    [clientId, n],
  );
  return res.rows;
}

/** Awa's most recent outbound turn (text or interactive) with its wamid, for
 *  matching a reaction to the message it targets. */
export async function latestAssistantTurn(
  clientId: string,
): Promise<{ content: string; wa_message_id: string | null } | null> {
  const res = await pool.query(
    `select content, wa_message_id from conversations
      where client_id = $1 and role = 'assistant'
      order by created_at desc limit 1`,
    [clientId],
  );
  return res.rows[0] ?? null;
}

export async function recentTranscriptExcerpt(clientId: string, n = 6): Promise<string> {
  const turns = await lastTurns(clientId, n);
  return turns.map((t) => `${t.role}: ${t.content}`.slice(0, 300)).join("\n");
}

/**
 * Like lastTurns but ALSO returns the 'tool' turns (the tool calls + results
 * Awa made), so the agent loop can replay what she DID, not only what she
 * SAID. Without this the model is amnesiac about its own actions across turns
 * and re-derives or re-issues them from a partial view (prod 13/07: a stale
 * 6-digit code re-submitted, a service_id hallucinated, payment buttons
 * re-sent). Kept separate from lastTurns so the human-facing handoff excerpt
 * stays free of tool noise.
 */
export async function lastTurnsForReplay(clientId: string, n = 30): Promise<Turn[]> {
  const res = await pool.query(
    `select role, content, created_at
       from (select role, content, created_at from (
               select role, content, created_at
                 from conversations
                where client_id = $1 and role in ('user', 'assistant', 'tool')
               union all
               select 'assistant' as role,
                      '[MESSAGE HUMAIN DE L''ÉQUIPE REVIVE — contexte, pas une réponse d''Awa]' ||
                      E'\n' || body as content,
                      coalesce(sent_at, created_at) as created_at
                 from admin_outbound_messages
                where client_id = $1 and status = 'sent'
             ) history order by created_at desc limit $2) t
      order by created_at asc`,
    [clientId, n],
  );
  return res.rows;
}

// ---------- agent tool circuit breaker ----------

export async function recordAgentToolFailure(args: {
  clientId: string;
  toolName: string;
  errorCode: string;
  resourceKey: string;
  ttlHours?: number;
}): Promise<{ failureCount: number; alreadyTripped: boolean }> {
  const ttlHours = args.ttlHours ?? 2;
  await pool.query(`delete from agent_tool_failures where expires_at <= now()`);
  const res = await pool.query(
    `insert into agent_tool_failures
       (client_id, tool_name, error_code, resource_key, failure_count, expires_at)
     values ($1,$2,$3,$4,1,now() + ($5 || ' hours')::interval)
     on conflict (client_id, tool_name, error_code, resource_key) do update
       set failure_count = case
             when agent_tool_failures.expires_at <= now() then 1
             else agent_tool_failures.failure_count + 1
           end,
           first_failed_at = case
             when agent_tool_failures.expires_at <= now() then now()
             else agent_tool_failures.first_failed_at
           end,
           last_failed_at = now(),
           expires_at = now() + ($5 || ' hours')::interval,
           tripped_at = case
             when agent_tool_failures.expires_at <= now() then null
             else agent_tool_failures.tripped_at
           end
     returning failure_count, tripped_at is not null as already_tripped`,
    [args.clientId, args.toolName, args.errorCode, args.resourceKey, String(ttlHours)],
  );
  return {
    failureCount: Number(res.rows[0]?.failure_count ?? 1),
    alreadyTripped: Boolean(res.rows[0]?.already_tripped),
  };
}

export async function clearAgentToolFailure(args: {
  clientId: string;
  toolName: string;
  resourceKey: string;
}): Promise<void> {
  await pool.query(
    `delete from agent_tool_failures
      where client_id=$1 and tool_name=$2 and resource_key=$3`,
    [args.clientId, args.toolName, args.resourceKey],
  );
}

/** Atomically marks this failure as handled; false means another turn won. */
export async function markAgentToolFailureTripped(args: {
  clientId: string;
  toolName: string;
  errorCode: string;
  resourceKey: string;
}): Promise<boolean> {
  const res = await pool.query(
    `update agent_tool_failures
        set tripped_at=now()
      where client_id=$1 and tool_name=$2 and error_code=$3 and resource_key=$4
        and tripped_at is null
      returning client_id`,
    [args.clientId, args.toolName, args.errorCode, args.resourceKey],
  );
  return (res.rowCount ?? 0) > 0;
}

export async function pauseAwaForTechnicalHandoff(
  clientId: string,
  hours = 12,
): Promise<void> {
  await pool.query(
    `update clients
        set human_takeover_until=now() + ($2 || ' hours')::interval,
            human_takeover_by='awa-technical-failure',
            human_takeover_at=now(),
            updated_at=now()
      where id=$1`,
    [clientId, String(hours)],
  );
}

/** Create one open technical follow-up per client + equivalent failure stage. */
export async function ensureOpenTechnicalHandoff(
  clientId: string,
  stage: string,
  reason: string,
): Promise<boolean> {
  const excerpt = await recentTranscriptExcerpt(clientId);
  const category = `Relais technique Awa [${stage.slice(0, 120)}]`;
  const dedupKey = `technical:${clientId}:${stage.slice(0, 160)}`;
  const res = await pool.query(
    `insert into handoffs (client_id, reason, transcript_excerpt, technical_dedup_key)
     values ($1, $2, $3, $4)
     on conflict (technical_dedup_key)
       where status='OPEN' and technical_dedup_key is not null do nothing
     returning id`,
    [clientId, `${category}: ${reason.slice(0, 700)}`, excerpt, dedupKey],
  );
  if ((res.rowCount ?? 0) > 0) {
    await recordBookingFunnelEvent({
      clientId,
      stage: "handoff",
      allowCreateJourney: false,
      metadata: { reason_category: "Relais technique Awa" },
    }).catch((error) => console.error("Failed to record technical handoff funnel event:", error));
  }
  return (res.rowCount ?? 0) > 0;
}

// ---------- last interactive choices ----------

export async function savePresentedChoices(
  clientId: string,
  choices: readonly { id: string; title: string }[],
  ttlHours = 2,
): Promise<void> {
  if (choices.length === 0) return;
  const presentationId = crypto.randomUUID();
  await pool.query(`delete from presented_choices where expires_at <= now()`);
  await pool.query(
    `insert into presented_choices
       (client_id, presentation_id, choice_id, title, expires_at)
     select $1, $2, item.id, item.title, now() + ($4 || ' hours')::interval
       from jsonb_to_recordset($3::jsonb) as item(id text, title text)`,
    [clientId, presentationId, JSON.stringify(choices), String(ttlHours)],
  );
}

export async function latestPresentedChoices(
  clientId: string,
): Promise<{ choice_id: string; title: string }[]> {
  const res = await pool.query(
    `select choice_id, title
       from presented_choices
      where client_id=$1 and expires_at > now()
        and presentation_id = (
          select presentation_id
            from presented_choices
           where client_id=$1 and expires_at > now()
           order by presented_at desc, presentation_id desc
           limit 1
        )
      order by presented_at, choice_id`,
    [clientId],
  );
  return res.rows;
}

/**
 * Content of the client's most recent assistant turn, or null. Lets the
 * inbound handler see that the last thing Awa sent was an interactive list
 * even after its presented_choices rows expired (2h TTL).
 */
export async function lastAssistantTurnContent(clientId: string): Promise<string | null> {
  const res = await pool.query(
    `select content from conversations
      where client_id=$1 and role='assistant'
      order by created_at desc limit 1`,
    [clientId],
  );
  return res.rows[0]?.content ?? null;
}

// ---------- webhook idempotency ----------

/**
 * Returns true if this webhook id was already processed (duplicate delivery).
 * Insert-and-check in one step: the row is recorded HERE, so callers that
 * dedupe before doing work (WhatsApp inbound) can never double-handle a
 * message. Not for flows that must stay retriable on failure — see
 * wasProcessed/markProcessed.
 */
export async function alreadyProcessed(id: string, source: string): Promise<boolean> {
  const res = await pool.query(
    `insert into processed_webhooks (id, source) values ($1, $2)
     on conflict (id) do nothing
     returning id`,
    [id, source],
  );
  return res.rowCount === 0;
}

/** Read-only idempotency check — does NOT record the id (see markProcessed). */
export async function wasProcessed(id: string): Promise<boolean> {
  const res = await pool.query(`select 1 from processed_webhooks where id = $1`, [id]);
  return (res.rowCount ?? 0) > 0;
}

/**
 * Record a webhook id as processed. Idempotent. Call this AFTER the work
 * completed successfully, so a transient failure leaves the id unrecorded and
 * the provider's retry can run the work again (the atomic state transitions
 * make re-processing a no-op once the booking is terminal).
 */
export async function markProcessed(id: string, source: string): Promise<void> {
  await pool.query(
    `insert into processed_webhooks (id, source) values ($1, $2)
     on conflict (id) do nothing`,
    [id, source],
  );
}

// ---------- pending bookings ----------

export async function createDraftBooking(args: {
  clientId: string;
  serviceId: string;
  serviceName: string;
  eventId: string;
  slotJson: unknown;
  slotStart: string;
  slotEnd: string | null;
  amountXof: number;
  participants: number;
  extrasJson?: unknown;
  extrasAmountXof?: number;
  orderNote?: string | null;
  /** Links this attempt to a multi-session commitment item (reversed FK). */
  commitmentItemId?: string | null;
  /** Optional transaction client (e.g. inside the per-client commitment lock). */
  tx?: pg.Pool | pg.PoolClient;
  campaignCode?: string | null;
}): Promise<PendingBooking> {
  const db = args.tx ?? pool;
  const res = await db.query(
    `insert into pending_bookings
       (client_id, service_id, service_name, event_id, slot_json, slot_start, slot_end, amount_xof, participants,
        extras_json, extras_amount_xof, order_note, commitment_item_id, campaign_code, status)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, 'DRAFT')
     returning *`,
    [
      args.clientId,
      args.serviceId,
      args.serviceName,
      args.eventId,
      JSON.stringify(args.slotJson),
      args.slotStart,
      args.slotEnd,
      args.amountXof,
      args.participants,
      args.extrasJson ? JSON.stringify(args.extrasJson) : null,
      args.extrasAmountXof ?? 0,
      args.orderNote ?? null,
      args.commitmentItemId ?? null,
      args.campaignCode ?? null,
    ],
  );
  return res.rows[0];
}

export async function setAwaitingPayment(
  bookingId: string,
  waveSessionId: string,
  paymentLink: string,
  expiresAt: Date,
  paymentMethod: string = "wave",
): Promise<PendingBooking | null> {
  return (await transition(pool, bookingId, "AWAITING_PAYMENT", {
    wave_session_id: waveSessionId,
    payment_link: paymentLink,
    link_expires_at: expiresAt,
    payment_method: paymentMethod,
  })) as PendingBooking | null;
}

export async function findBookingById(id: string): Promise<PendingBooking | null> {
  const res = await pool.query(`select * from pending_bookings where id = $1`, [id]);
  return res.rows[0] ?? null;
}

/**
 * Atomically claim a PAID-but-unfulfilled booking for fulfillment. Returns the
 * row if THIS caller won the claim, or null if the booking is already
 * fulfilled, terminal, or being fulfilled by someone else (a fresh lease).
 * This single conditional UPDATE is what makes it safe for a Wave webhook
 * retry and the reconciliation sweep to both try to fulfill — only one wins.
 */
export async function claimBookingForFulfillment(id: string): Promise<PendingBooking | null> {
  const res = await pool.query(
    `update pending_bookings
        set fulfilling_at = now(), updated_at = now()
      where id = $1 and status = 'PAID' and wix_booking_id is null
        and (fulfilling_at is null or fulfilling_at < now() - interval '2 minutes')
      returning *`,
    [id],
  );
  return res.rows[0] ?? null;
}

/**
 * PAID bookings that were never turned into a Wix booking and are past the
 * grace period — a crash between the PAID transition and the Wix booking
 * leaves these, and nothing else recovers them. Excludes rows under an active
 * fulfillment lease.
 */
export async function stuckPaidBookings(
  graceMinutes = 3,
  limit = 20,
): Promise<PendingBooking[]> {
  const res = await pool.query(
    `select * from pending_bookings
      where status = 'PAID' and wix_booking_id is null
        and updated_at < now() - make_interval(mins => $1)
        and (fulfilling_at is null or fulfilling_at < now() - interval '2 minutes')
      order by updated_at asc limit $2`,
    [graceMinutes, limit],
  );
  return res.rows;
}

/**
 * Claim post-booking order/payment synchronization. This is deliberately
 * independent from the seat-fulfillment lease: failures here are retried but
 * can never move a BOOKED reservation to REFUND_NEEDED.
 */
export async function claimBookingForWixOrderSync(
  id: string,
): Promise<PendingBooking | null> {
  const res = await pool.query(
    `update pending_bookings
        set wix_order_sync_at = now(), updated_at = now()
      where id = $1 and status = 'BOOKED' and wix_booking_id is not null
        and (amount_xof > 0 or payment_method = 'membership')
        and wix_payment_recorded_at is null
        and (wix_order_sync_at is null or wix_order_sync_at < now() - interval '2 minutes')
      returning *`,
    [id],
  );
  return res.rows[0] ?? null;
}

export async function saveWixOrderId(bookingId: string, wixOrderId: string): Promise<void> {
  await pool.query(
    `update pending_bookings
        set wix_order_id = $2, wix_order_sync_error = null, updated_at = now()
      where id = $1 and status = 'BOOKED'`,
    [bookingId, wixOrderId],
  );
}

export async function markWixPaymentRecorded(bookingId: string): Promise<void> {
  await pool.query(
    `update pending_bookings
        set wix_payment_recorded_at = now(), wix_order_sync_at = null,
            wix_order_sync_error = null, updated_at = now()
      where id = $1 and status = 'BOOKED'`,
    [bookingId],
  );
}

export async function releaseWixOrderSync(bookingId: string, error: string): Promise<void> {
  await pool.query(
    `update pending_bookings
        set wix_order_sync_at = null, wix_order_sync_error = $2, updated_at = now()
      where id = $1 and status = 'BOOKED' and wix_payment_recorded_at is null`,
    [bookingId, error.slice(0, 1000)],
  );
}

/**
 * Recent BOOKED rows missing their Wix order/payment record. The 48-hour cap
 * repairs current incidents (including a same-day booking) without importing
 * the entire historical backlog on first deployment.
 */
export async function bookingsMissingWixPaymentRecord(
  graceMinutes = 3,
  maxAgeHours = 48,
  // Wix throttles Create Order aggressively. Process one recovery per sweep so
  // several missing orders cannot consume the same rate-limit window.
  limit = 1,
): Promise<PendingBooking[]> {
  const res = await pool.query(
    `select * from pending_bookings
      where status = 'BOOKED' and wix_booking_id is not null
        and (amount_xof > 0 or payment_method = 'membership')
        and wix_payment_recorded_at is null
        and created_at > now() - make_interval(hours => $2)
        and updated_at < now() - make_interval(mins => $1)
        and (wix_order_sync_at is null or wix_order_sync_at < now() - interval '2 minutes')
      order by updated_at asc limit $3`,
    [graceMinutes, maxAgeHours, limit],
  );
  return res.rows;
}

/** One active AWAITING_PAYMENT per client (SPEC §6): expire any previous link. */
export async function expireActiveBookings(clientId: string): Promise<void> {
  await pool.query(
    `update pending_bookings
        set status = 'EXPIRED', updated_at = now()
      where client_id = $1 and status in ('DRAFT', 'AWAITING_PAYMENT')`,
    [clientId],
  );
}

/** TTL sweep — AWAITING_PAYMENT past link_expires_at → EXPIRED. */
export async function expireStaleBookings(): Promise<number> {
  const res = await pool.query(
    `update pending_bookings
        set status = 'EXPIRED', updated_at = now()
      where status = 'AWAITING_PAYMENT' and link_expires_at < now()
      returning id, client_id, payment_method, link_expires_at`,
  );
  await Promise.all(
    res.rows.map((b) =>
      recordBookingFunnelEvent({
        clientId: b.client_id,
        bookingId: b.id,
        stage: "expired",
        paymentMethod: b.payment_method,
        occurredAt: new Date(b.link_expires_at),
        idempotencyKey: `booking:${b.id}:expired`,
        metadata: { reason: "ttl" },
      }).catch((error) => console.error("Failed to record booking expiry funnel event:", error)),
    ),
  );
  const stale = res.rowCount ?? 0;
  // Orphan DRAFTs (session created then crash before setAwaitingPayment, or
  // abandoned mid-flow): never sat in AWAITING so the TTL above never saw them.
  const drafts = await pool.query(
    `update pending_bookings
        set status = 'EXPIRED', updated_at = now()
      where status = 'DRAFT' and created_at < now() - interval '1 hour'`,
  );
  return stale + (drafts.rowCount ?? 0);
}

/**
 * REFUND_NEEDED rows that never got a successful reception/client notify.
 * Only recent rows (past a short grace, within a 2h window) — never the whole
 * historical backlog (that re-spammed clients on first deploy of this column).
 */
export async function stuckUnnotifiedRefunds(
  graceMinutes = 2,
  maxAgeHours = 2,
  limit = 20,
): Promise<PendingBooking[]> {
  const res = await pool.query(
    `select * from pending_bookings
      where status = 'REFUND_NEEDED' and refund_notified_at is null
        and updated_at < now() - make_interval(mins => $1)
        and updated_at > now() - make_interval(hours => $2)
      order by updated_at asc limit $3`,
    [graceMinutes, maxAgeHours, limit],
  );
  return res.rows;
}

export async function markRefundNotified(bookingId: string): Promise<void> {
  await pool.query(
    `update pending_bookings set refund_notified_at = now(), updated_at = now()
      where id = $1 and status = 'REFUND_NEEDED'`,
    [bookingId],
  );
}

/**
 * EXPIRED links worth a one-shot "want a fresh link?" nudge. Deliberately
 * narrow so the nudge is never noise:
 *   - the link expired by TTL, recently (a link expired days ago on an idle
 *     conversation must stay silent — also protects against a deploy replaying
 *     the whole backlog);
 *   - the client has NOT moved on: no newer booking attempt of any status, no
 *     active plan-purchase link (expireActiveBookings marks replaced links
 *     EXPIRED with a future link_expires_at, so the recent-TTL window alone
 *     would eventually match them once their TTL passes), and no client
 *     message since the expiry (they re-engaged — Awa handles it in the
 *     conversation, a parallel nudge would be spam);
 *   - never nudged before (expiry_nudged_at is the one-shot flag).
 */
export async function expiredLinksToNudge(
  windowMinutes = 30,
  limit = 20,
): Promise<(PendingBooking & { wa_phone: string; language: string | null })[]> {
  const res = await pool.query(
    `select b.*, c.wa_phone, c.language
       from pending_bookings b
       join clients c on c.id = b.client_id
      where b.status = 'EXPIRED'
        and b.expiry_nudged_at is null
        and b.payment_link is not null
        and b.link_expires_at < now()
        and b.link_expires_at > now() - make_interval(mins => $1)
        and b.slot_start > now()
        and not exists (select 1 from pending_bookings n
                         where n.client_id = b.client_id and n.created_at > b.created_at)
        and not exists (select 1 from pending_plan_orders p
                         where p.client_id = b.client_id
                           and p.status in ('DRAFT', 'AWAITING_PAYMENT'))
        and not exists (select 1 from conversations m
                         where m.client_id = b.client_id and m.role = 'user'
                           and m.created_at > b.link_expires_at)
      order by b.link_expires_at asc
      limit $2`,
    [windowMinutes, limit],
  );
  return res.rows;
}

/**
 * Atomically claim the right to send the expiry nudge for one booking.
 * Returns false if another sweep already claimed it (one-shot guarantee).
 */
export async function claimExpiryNudge(bookingId: string): Promise<boolean> {
  const res = await pool.query(
    `update pending_bookings set expiry_nudged_at = now(), updated_at = now()
      where id = $1 and expiry_nudged_at is null`,
    [bookingId],
  );
  return (res.rowCount ?? 0) > 0;
}

export async function activeAwaitingPayment(clientId: string): Promise<PendingBooking | null> {
  const res = await pool.query(
    `select * from pending_bookings
      where client_id = $1 and status = 'AWAITING_PAYMENT' and link_expires_at > now()
      order by created_at desc limit 1`,
    [clientId],
  );
  return res.rows[0] ?? null;
}

/**
 * Plan-order twin of expiredLinksToNudge: a plan/Key payment link that just
 * expired UNPAID and the client went silent. Same one-shot posture
 * (expiry_nudged_at), same "client re-engaged → Awa handles it, don't nudge"
 * guard. Kept narrow to the recent-TTL window so we never nudge an ancient row,
 * and skips orders already superseded by a refresh (retry_of_order_id) or a
 * newer draft/awaiting order. Returns the join fields the nudge + OM alert need.
 */
export async function expiredPlanOrdersToNudge(
  windowMinutes = 30,
  limit = 20,
): Promise<(PlanOrder & { wa_phone: string; language: string | null })[]> {
  const res = await pool.query(
    `select p.*, c.wa_phone, c.language
       from pending_plan_orders p
       join clients c on c.id = p.client_id
      where p.status = 'EXPIRED'
        and p.paid_at is null
        and p.expiry_nudged_at is null
        and p.payment_link is not null
        and p.link_expires_at < now()
        and p.link_expires_at > now() - make_interval(mins => $1)
        and not exists (select 1 from pending_plan_orders r where r.retry_of_order_id = p.id)
        and not exists (select 1 from pending_plan_orders n
                         where n.client_id = p.client_id and n.created_at > p.created_at)
        and not exists (select 1 from conversations m
                         where m.client_id = p.client_id and m.role = 'user'
                           and m.created_at > p.link_expires_at)
      order by p.link_expires_at asc
      limit $2`,
    [windowMinutes, limit],
  );
  return res.rows;
}

/**
 * Atomically claim the right to nudge one expired plan order (one-shot,
 * claim-before-send like claimExpiryNudge). Returns false if already claimed.
 */
export async function claimPlanOrderExpiryNudge(orderId: string): Promise<boolean> {
  const res = await pool.query(
    `update pending_plan_orders set expiry_nudged_at = now(), updated_at = now()
      where id = $1 and expiry_nudged_at is null`,
    [orderId],
  );
  return (res.rowCount ?? 0) > 0;
}

/** Most recent verified class-payment rail. Membership deductions are not a mobile-money preference. */
export async function lastSuccessfulBookingPaymentMethod(clientId: string): Promise<string | null> {
  const res = await pool.query(
    `select payment_method from pending_bookings
      where client_id=$1
        and status in ('PAID','BOOKED','REFUND_NEEDED','REFUNDED','CANCELLED')
        and payment_method in ('wave','orange_money','maxit')
      order by updated_at desc limit 1`,
    [clientId],
  );
  return res.rows[0]?.payment_method ?? null;
}

/**
 * Recent payments of this client that could not be fulfilled (refund pending
 * or just processed) — injected into Awa's context so she NEVER denies a
 * payment the client actually made.
 */
export async function recentRefunds(clientId: string): Promise<PendingBooking[]> {
  const res = await pool.query(
    `select * from pending_bookings
      where client_id = $1 and status in ('REFUND_NEEDED', 'REFUNDED')
        and updated_at > now() - interval '48 hours'
      order by updated_at desc limit 3`,
    [clientId],
  );
  return res.rows;
}

/**
 * A recurring booking pattern for this client — same class, same weekday, same
 * time, booked at least twice — so Awa can offer it as a one-tap shortcut ("ton
 * Pilates Fusion du vendredi 10h, comme d'habitude ?"). Only a HINT: the real
 * slot always comes from a fresh check_availability, prices/16h are recomputed
 * server-side. Null when there is no clear habit.
 */
export interface BookingHabit {
  service_id: string;
  service_name: string;
  weekday: number; // 0=Sun … 6=Sat (Dakar == UTC)
  hour: number;
  minute: number;
  occurrences: number;
}

/** Pure pattern picker (tested without a DB). Most frequent (service, weekday,
 * time) with ≥2 occurrences; ties broken by the most recent booking (rows are
 * expected in slot_start-descending order). */
export function computeBookingHabit(
  rows: { service_id: string; service_name: string; slot_start: Date | string }[],
): BookingHabit | null {
  const groups = new Map<string, BookingHabit>();
  for (const r of rows) {
    const d = new Date(r.slot_start);
    if (Number.isNaN(d.getTime())) continue;
    const weekday = d.getUTCDay();
    const hour = d.getUTCHours();
    const minute = d.getUTCMinutes();
    const key = `${r.service_id}|${weekday}|${hour}|${minute}`;
    const g = groups.get(key);
    if (g) g.occurrences++;
    else
      groups.set(key, {
        service_id: r.service_id,
        service_name: r.service_name,
        weekday,
        hour,
        minute,
        occurrences: 1,
      });
  }
  let best: BookingHabit | null = null;
  for (const g of groups.values()) {
    // First qualifying group already reflects recency (rows are newest-first),
    // so only replace on a STRICTLY higher count — keeps the most recent tie.
    if (g.occurrences >= 2 && (!best || g.occurrences > best.occurrences)) best = g;
  }
  return best;
}

export async function bookingHabit(clientId: string): Promise<BookingHabit | null> {
  const res = await pool.query(
    `select service_id, service_name, slot_start
       from pending_bookings
      where client_id = $1 and status = 'BOOKED'
      order by slot_start desc limit 60`,
    [clientId],
  );
  return computeBookingHabit(res.rows);
}

export async function upcomingBooked(clientId: string): Promise<PendingBooking[]> {
  const res = await pool.query(
    `select * from pending_bookings
      where client_id = $1 and status = 'BOOKED' and slot_start > now()
      order by slot_start asc`,
    [clientId],
  );
  return res.rows;
}

/** Count of Awa-booked upcoming classes (cheap flag for dynamic context). */
export async function countUpcomingBooked(clientId: string): Promise<number> {
  const res = await pool.query(
    `select count(*)::int as n from pending_bookings
      where client_id = $1 and status = 'BOOKED' and slot_start > now()`,
    [clientId],
  );
  return res.rows[0]?.n ?? 0;
}

/**
 * Recent paid items eligible for an on-demand receipt image (server-sourced
 * amounts only). Includes fulfilled Wave class bookings and voluntary
 * non-refunded cancellations, activated plan orders, and paid bar orders —
 * last 90 days, max 10 each type.
 */
export type ReceiptCandidate = {
  kind: "booking" | "plan" | "cafe";
  id: string;
  label: string;
  detail: string | null;
  amountXof: number;
  paymentRef: string;
  paidVia: string;
  paidAt: Date;
};

export async function recentReceiptCandidates(clientId: string): Promise<ReceiptCandidate[]> {
  const [bookings, plans, cafes] = await Promise.all([
    pool.query(
      `select id, service_name, slot_start, amount_xof, wave_session_id, payment_method, updated_at, created_at
         from pending_bookings
        where client_id = $1 and (status = 'BOOKED' or forfeited_at is not null)
          and (payment_method = 'wave' or amount_xof > 0)
          and updated_at > now() - interval '90 days'
        order by updated_at desc limit 10`,
      [clientId],
    ),
    pool.query(
      `select id, plan_name, amount_xof, wave_session_id, payment_method, updated_at, created_at
         from pending_plan_orders
        where client_id = $1 and status in ('ACTIVATED', 'PAID')
          and updated_at > now() - interval '90 days'
        order by updated_at desc limit 10`,
      [clientId],
    ),
    pool.query(
      `select id, service_name, extras_json, amount_xof, wave_session_id, payment_method, updated_at, created_at
         from pending_cafe_orders
        where client_id = $1 and status = 'PAID'
          and updated_at > now() - interval '90 days'
        order by updated_at desc limit 10`,
      [clientId],
    ),
  ]);

  const out: ReceiptCandidate[] = [];
  for (const b of bookings.rows) {
    out.push({
      kind: "booking",
      id: b.id,
      label: b.service_name,
      detail: b.slot_start ? String(b.slot_start) : null,
      amountXof: b.amount_xof,
      paymentRef: b.wave_session_id || b.id,
      paidVia: paymentMethodLabel(b.payment_method),
      paidAt: new Date(b.updated_at ?? b.created_at),
    });
  }
  for (const p of plans.rows) {
    out.push({
      kind: "plan",
      id: p.id,
      label: `Abonnement — ${p.plan_name}`,
      detail: null,
      amountXof: p.amount_xof,
      paymentRef: p.wave_session_id || p.id,
      paidVia: paymentMethodLabel(p.payment_method),
      paidAt: new Date(p.updated_at ?? p.created_at),
    });
  }
  for (const c of cafes.rows) {
    let cafeLabel = "Commande bar";
    try {
      const items = Array.isArray(c.extras_json) ? c.extras_json : [];
      const names = items
        .map((x: { name?: string; qty?: number }) =>
          x?.name ? `${x.qty && x.qty > 1 ? `${x.qty}× ` : ""}${x.name}` : null,
        )
        .filter(Boolean);
      if (names.length) cafeLabel = `Bar — ${names.join(", ")}`;
    } catch {
      /* keep default */
    }
    out.push({
      kind: "cafe",
      id: c.id,
      label: cafeLabel,
      detail: c.service_name ? `avec ${c.service_name}` : null,
      amountXof: c.amount_xof,
      paymentRef: c.wave_session_id || c.id,
      paidVia: paymentMethodLabel(c.payment_method),
      paidAt: new Date(c.updated_at ?? c.created_at),
    });
  }
  out.sort((a, b) => b.paidAt.getTime() - a.paidAt.getTime());
  return out.slice(0, 15);
}

/**
 * The client's most recently CREATED upcoming confirmed booking — the class a
 * post-booking bar order should attach to when the model doesn't pass an
 * explicit booking_id (the Wave flow books server-side in the webhook, so the
 * model never sees that id; it just knows "the class they just paid for").
 */
export async function latestUpcomingBooking(clientId: string): Promise<PendingBooking | null> {
  const res = await pool.query(
    `select * from pending_bookings
      where client_id = $1 and status = 'BOOKED' and slot_start > now()
      order by created_at desc
      limit 1`,
    [clientId],
  );
  return res.rows[0] ?? null;
}

export async function markCancelled(bookingId: string): Promise<void> {
  await transition(pool, bookingId, "CANCELLED");
}

/** Voluntary direct-payment cancellation: release the seat, retain the payment. */
export async function markCancelledWithoutRefund(bookingId: string): Promise<void> {
  await transition(pool, bookingId, "CANCELLED", { forfeited_at: new Date() });
}

/** Persist a successful Wix direct reschedule without touching its payment. */
export async function updateBookedSlot(args: {
  bookingId: string;
  clientId: string;
  eventId: string;
  slotJson: unknown;
  slotStart: string;
  slotEnd: string | null;
}): Promise<boolean> {
  const res = await pool.query(
    `update pending_bookings
        set event_id=$3, slot_json=$4, slot_start=$5, slot_end=$6, updated_at=now()
      where id=$1 and client_id=$2 and status='BOOKED' and wix_booking_id is not null`,
    [
      args.bookingId,
      args.clientId,
      args.eventId,
      JSON.stringify(args.slotJson),
      args.slotStart,
      args.slotEnd,
    ],
  );
  return res.rowCount === 1;
}

/**
 * Record a membership-paid booking. Inserted directly as BOOKED: the
 * "payment" is the plan credit, redeemed and validated by Wix's checkout
 * before this row is created — the payment-first invariant holds, the
 * verification just lives in Wix instead of Wave.
 */
export async function createMembershipBooking(args: {
  clientId: string;
  serviceId: string;
  serviceName: string;
  eventId: string;
  slotJson: unknown;
  slotStart: string;
  slotEnd: string | null;
  wixBookingId: string;
  benefitTransactionId?: string | null;
  /** Spots booked on this plan in one go (group booking). Defaults to 1. */
  participants?: number;
}): Promise<PendingBooking> {
  const res = await pool.query(
    `insert into pending_bookings
       (client_id, service_id, service_name, event_id, slot_json, slot_start, slot_end,
        amount_xof, participants, status, payment_method, wix_booking_id, benefit_transaction_id)
     values ($1, $2, $3, $4, $5, $6, $7, 0, $10, 'BOOKED', 'membership', $8, $9)
     on conflict (wix_booking_id) do update set wix_booking_id=excluded.wix_booking_id
     returning *`,
    [
      args.clientId,
      args.serviceId,
      args.serviceName,
      args.eventId,
      JSON.stringify(args.slotJson),
      args.slotStart,
      args.slotEnd,
      args.wixBookingId,
      args.benefitTransactionId ?? null,
      Math.max(1, Math.floor(args.participants ?? 1)),
    ],
  );
  return res.rows[0];
}

/** One of this client's own bookings, by our booking id (for cancel_booking). */
export async function findClientBooking(
  clientId: string,
  bookingId: string,
): Promise<PendingBooking | null> {
  const res = await pool.query(
    `select * from pending_bookings where id = $1 and client_id = $2`,
    [bookingId, clientId],
  );
  return res.rows[0] ?? null;
}

/** All upcoming BOOKED rows across all clients — for the cancellation sweep. */
export async function allUpcomingBooked(): Promise<
  (PendingBooking & { wa_phone: string; language: string | null })[]
> {
  const res = await pool.query(
    `select b.*, c.wa_phone, c.language
       from pending_bookings b
       join clients c on c.id = b.client_id
      where b.status = 'BOOKED' and b.slot_start > now() and b.wix_booking_id is not null
      order by b.slot_start asc`,
  );
  return res.rows;
}

// ---------- plan orders (abonnements vendus par Awa) ----------

export interface PlanOrder {
  id: string;
  created_at: Date;
  updated_at: Date;
  client_id: string;
  plan_id: string;
  plan_name: string;
  amount_xof: number;
  status: string;
  wave_session_id: string | null;
  payment_link: string | null;
  link_expires_at: Date | null;
  wix_order_id: string | null;
  member_id: string | null;
  starts_at: Date | null;
  payment_method: string;
  fulfilling_at: Date | null;
  reception_notified_at: Date | null;
  campaign_code: string | null;
  service_id: string | null;
  service_name: string | null;
  event_id: string | null;
  slot_json: unknown;
  slot_start: Date | null;
  slot_end: Date | null;
  wix_booking_id: string | null;
  benefit_transaction_id: string | null;
  linked_booking_id: string | null;
  discovery_booking_status: string | null;
  discovery_booking_error: string | null;
  is_key: boolean;
  key_family: "REFORMER" | "AQUABIKE";
  key_invitation_count: number | null;
  paid_at: Date | null;
  continuity_source_kind: "KEY" | "LEGACY_REFORMER" | null;
  continuity_source_order_id: string | null;
  continuity_source_plan_id: string | null;
  continuity_expires_at: Date | null;
  continuity_remaining: number | null;
  continuity_alerted_at: Date | null;
  retry_of_order_id: string | null;
  fulfillment_failure_count: number;
  technical_failure_at: Date | null;
}

/**
 * Atomic conditional status update — same safety pattern as the bookings
 * state machine (duplicate Wave webhooks race on the PAID transition).
 */
async function transitionPlanOrder(
  id: string,
  to: string,
  fromStates: string[],
  extra: Record<string, unknown> = {},
): Promise<PlanOrder | null> {
  const extraKeys = Object.keys(extra);
  const setClauses = ["status = $2", "updated_at = now()"];
  const params: unknown[] = [id, to, fromStates];
  extraKeys.forEach((k, i) => {
    setClauses.push(`${k} = $${4 + i}`);
    params.push(extra[k]);
  });
  const res = await pool.query(
    `update pending_plan_orders set ${setClauses.join(", ")}
      where id = $1 and status = any($3) returning *`,
    params,
  );
  return res.rows[0] ?? null;
}

export async function createDraftPlanOrder(args: {
  clientId: string;
  planId: string;
  planName: string;
  amountXof: number;
  memberId: string | null;
  /** Chained renewal: when the new plan should start (null = immediately). */
  startsAt?: Date | null;
  campaignCode?: string | null;
  serviceId?: string | null;
  serviceName?: string | null;
  eventId?: string | null;
  slotJson?: unknown;
  slotStart?: string | Date | null;
  slotEnd?: string | Date | null;
  isKey?: boolean;
  keyFamily?: "REFORMER" | "AQUABIKE" | null;
  keyInvitationCount?: number | null;
  continuitySourceKind?: "KEY" | "LEGACY_REFORMER" | null;
  continuitySourceOrderId?: string | null;
  continuitySourcePlanId?: string | null;
  continuityExpiresAt?: Date | null;
  continuityRemaining?: number | null;
  retryOfOrderId?: string | null;
}): Promise<PlanOrder> {
  const campaignCode = args.campaignCode ?? null;
  const discoveryBookingStatus: string | null =
    args.eventId ? "PENDING" : null;
  const res = await pool.query(
    `insert into pending_plan_orders
       (client_id, plan_id, plan_name, amount_xof, member_id, starts_at, campaign_code,
        service_id, service_name, event_id, slot_json, slot_start, slot_end,
        discovery_booking_status, is_key, key_family, key_invitation_count,
        continuity_source_kind, continuity_source_order_id,
        continuity_source_plan_id, continuity_expires_at, continuity_remaining,
        retry_of_order_id,
        status)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
             $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, 'DRAFT') returning *`,
    [
      args.clientId, args.planId, args.planName, args.amountXof, args.memberId, args.startsAt ?? null,
      campaignCode, args.serviceId ?? null, args.serviceName ?? null, args.eventId ?? null,
      args.slotJson === undefined ? null : JSON.stringify(args.slotJson), args.slotStart ?? null, args.slotEnd ?? null,
      discoveryBookingStatus,
      args.isKey ?? false,
      args.keyFamily ?? "REFORMER",
      args.keyInvitationCount ?? null,
      args.continuitySourceKind ?? null,
      args.continuitySourceOrderId ?? null,
      args.continuitySourcePlanId ?? null,
      args.continuityExpiresAt ?? null,
      args.continuityRemaining ?? null,
      args.retryOfOrderId ?? null,
    ],
  );
  return res.rows[0];
}

export async function finishDiscoveryPlanBooking(args: {
  planOrderId: string;
  wixBookingId: string;
  benefitTransactionId: string | null;
  bookingId: string;
}): Promise<void> {
  await pool.query(
    `update pending_plan_orders
        set wix_booking_id=$2, benefit_transaction_id=$3, linked_booking_id=$4,
            discovery_booking_status='BOOKED', discovery_booking_error=null,
            fulfilling_at=null, updated_at=now()
      where id=$1`,
    [args.planOrderId, args.wixBookingId, args.benefitTransactionId, args.bookingId],
  );
}

export async function deferDiscoveryPlanBooking(
  planOrderId: string,
  status: "SLOT_UNAVAILABLE" | "FAILED",
  error: string,
): Promise<void> {
  await pool.query(
    `update pending_plan_orders
        set discovery_booking_status=$2, discovery_booking_error=$3,
            fulfilling_at=null, updated_at=now()
      where id=$1`,
    [planOrderId, status, error.slice(0, 800)],
  );
}

export async function saveInitialPlanBookingWixId(
  planOrderId: string,
  wixBookingId: string,
): Promise<void> {
  await pool.query(
    `update pending_plan_orders
        set wix_booking_id=coalesce(wix_booking_id,$2), updated_at=now()
      where id=$1`,
    [planOrderId, wixBookingId],
  );
}

export async function saveInitialPlanBenefitTransaction(
  planOrderId: string,
  transactionId: string,
): Promise<void> {
  await pool.query(
    `update pending_plan_orders
        set benefit_transaction_id=coalesce(benefit_transaction_id,$2), updated_at=now()
      where id=$1`,
    [planOrderId, transactionId],
  );
}

export async function recordPlanFulfillmentFailure(
  id: string,
  error: string,
): Promise<number> {
  const res = await pool.query(
    `update pending_plan_orders
        set fulfillment_failure_count=fulfillment_failure_count+1,
            discovery_booking_error=$2, fulfilling_at=null, updated_at=now()
      where id=$1 returning fulfillment_failure_count`,
    [id, error.slice(0, 800)],
  );
  return Number(res.rows[0]?.fulfillment_failure_count ?? 1);
}

export async function markPlanTechnicalFailure(id: string, error: string): Promise<void> {
  await pool.query(
    `update pending_plan_orders
        set technical_failure_at=coalesce(technical_failure_at,now()),
            discovery_booking_error=$2, fulfilling_at=null, updated_at=now()
      where id=$1`,
    [id, error.slice(0, 800)],
  );
}

export async function setPlanOrderAwaitingPayment(
  id: string,
  waveSessionId: string,
  paymentLink: string,
  expiresAt: Date,
  paymentMethod: string = "wave",
): Promise<PlanOrder | null> {
  return transitionPlanOrder(id, "AWAITING_PAYMENT", ["DRAFT"], {
    wave_session_id: waveSessionId,
    payment_link: paymentLink,
    link_expires_at: expiresAt,
    payment_method: paymentMethod,
  });
}

export async function markPlanOrderPaid(
  id: string,
  paidAt = new Date(),
): Promise<PlanOrder | null> {
  // DRAFT included: verified payment can land before setAwaitingPayment
  // (crash between session create and AWAITING). Same money-first rule as bookings.
  return transitionPlanOrder(id, "PAID", ["AWAITING_PAYMENT", "EXPIRED", "DRAFT"], {
    paid_at: paidAt,
  });
}

export async function finalizePaidKeyContinuity(args: {
  id: string;
  startsAt: Date;
  invitationCount: number;
  sourceKind?: "KEY" | "LEGACY_REFORMER" | null;
  sourceOrderId?: string | null;
  sourcePlanId?: string | null;
  sourceExpiresAt?: Date | null;
  sourceRemaining?: number | null;
}): Promise<PlanOrder | null> {
  const res = await pool.query(
    `update pending_plan_orders
        set starts_at=$2, key_invitation_count=$3,
            continuity_source_kind=$4, continuity_source_order_id=$5,
            continuity_source_plan_id=$6, continuity_expires_at=$7,
            continuity_remaining=$8, updated_at=now()
      where id=$1 and status in ('PAID','SCHEDULED')
      returning *`,
    [
      args.id,
      args.startsAt,
      args.invitationCount,
      args.sourceKind ?? null,
      args.sourceOrderId ?? null,
      args.sourcePlanId ?? null,
      args.sourceExpiresAt ?? null,
      args.sourceRemaining ?? null,
    ],
  );
  return res.rows[0] ?? null;
}

export async function markPlanContinuityAlerted(id: string): Promise<void> {
  await pool.query(
    `update pending_plan_orders
        set continuity_alerted_at=coalesce(continuity_alerted_at,now()), updated_at=now()
      where id=$1`,
    [id],
  );
}

export async function markPlanOrderActivated(
  id: string,
  wixOrderId: string,
): Promise<PlanOrder | null> {
  return transitionPlanOrder(id, "ACTIVATED", ["PAID", "SCHEDULED"], {
    wix_order_id: wixOrderId,
    fulfilling_at: null,
    fulfillment_failure_count: 0,
    discovery_booking_error: null,
  });
}

export async function markPlanOrderScheduled(id: string): Promise<PlanOrder | null> {
  return transitionPlanOrder(id, "SCHEDULED", ["PAID"], {
    fulfilling_at: null,
  });
}

export async function findPlanOrderById(id: string): Promise<PlanOrder | null> {
  const res = await pool.query(`select * from pending_plan_orders where id = $1`, [id]);
  return res.rows[0] ?? null;
}

/**
 * Claim a PAID plan order that still needs work: either auto-activation
 * (member + no wix_order_id) or manual reception notify (no reception_notified_at).
 */
export async function claimPlanOrderForFulfillment(id: string): Promise<PlanOrder | null> {
  const res = await pool.query(
    `update pending_plan_orders
        set fulfilling_at = now(), updated_at = now()
      where id = $1
        and (
          (status = 'PAID' and ((member_id is not null and wix_order_id is null) or reception_notified_at is null))
          or (status = 'SCHEDULED' and starts_at <= now() and member_id is not null and wix_order_id is null)
          or (status = 'ACTIVATED' and event_id is not null and discovery_booking_status = 'PENDING')
        )
        and technical_failure_at is null
        and (fulfilling_at is null or fulfilling_at < now() - interval '2 minutes')
      returning *`,
    [id],
  );
  return res.rows[0] ?? null;
}

export async function markPlanOrderReceptionNotified(id: string): Promise<void> {
  await pool.query(
    `update pending_plan_orders
        set reception_notified_at = now(), updated_at = now(), fulfilling_at = null
      where id = $1`,
    [id],
  );
}

export async function clearPlanOrderFulfilling(id: string): Promise<void> {
  await pool.query(
    `update pending_plan_orders set fulfilling_at = null, updated_at = now() where id = $1`,
    [id],
  );
}

/** PAID plans never activated / never notified — grace period like bookings. */
export async function stuckPaidPlanOrders(
  graceMinutes = 3,
  limit = 20,
): Promise<PlanOrder[]> {
  const res = await pool.query(
    `select * from pending_plan_orders
      where (
          (status = 'PAID' and ((member_id is not null and wix_order_id is null) or reception_notified_at is null))
          or (status = 'SCHEDULED' and starts_at <= now() and member_id is not null and wix_order_id is null)
          or (status = 'ACTIVATED' and event_id is not null and discovery_booking_status = 'PENDING')
        )
        and technical_failure_at is null
        and updated_at < now() - make_interval(mins => $1)
        and (fulfilling_at is null or fulfilling_at < now() - interval '2 minutes')
      order by updated_at asc limit $2`,
    [graceMinutes, limit],
  );
  return res.rows;
}

/** One active plan payment link per client — expire any previous one. */
export async function expireActivePlanOrders(clientId: string): Promise<void> {
  await pool.query(
    `update pending_plan_orders set status = 'EXPIRED', updated_at = now()
      where client_id = $1 and status in ('DRAFT', 'AWAITING_PAYMENT')`,
    [clientId],
  );
}

/** TTL sweep — plan links past expiry → EXPIRED (+ orphan DRAFTs > 1h). */
export async function expireStalePlanOrders(): Promise<number> {
  const res = await pool.query(
    `update pending_plan_orders set status = 'EXPIRED', updated_at = now()
      where status = 'AWAITING_PAYMENT' and link_expires_at < now()`,
  );
  const drafts = await pool.query(
    `update pending_plan_orders set status = 'EXPIRED', updated_at = now()
      where status = 'DRAFT' and created_at < now() - interval '1 hour'`,
  );
  return (res.rowCount ?? 0) + (drafts.rowCount ?? 0);
}

export async function activeAwaitingPlanOrder(clientId: string): Promise<PlanOrder | null> {
  const res = await pool.query(
    `select * from pending_plan_orders
      where client_id = $1 and status = 'AWAITING_PAYMENT' and link_expires_at > now()
      order by created_at desc limit 1`,
    [clientId],
  );
  return res.rows[0] ?? null;
}

export async function latestRecentExpiredPlanOrder(
  clientId: string,
  days = 7,
): Promise<PlanOrder | null> {
  const res = await pool.query(
    `select * from pending_plan_orders
      where client_id=$1 and status='EXPIRED'
        and coalesce(link_expires_at,updated_at) >= now() - ($2 * interval '1 day')
      order by created_at desc limit 1`,
    [clientId, days],
  );
  return res.rows[0] ?? null;
}

export async function hasScheduledKeyOrder(
  clientId: string,
  family?: "REFORMER" | "AQUABIKE" | null,
): Promise<boolean> {
  const result = await pool.query(
    `select 1 from pending_plan_orders
      where client_id=$1 and is_key and status='SCHEDULED' and starts_at > now()
        and ($2::text is null or key_family=$2)
      limit 1`,
    [clientId, family ?? null],
  );
  return (result.rowCount ?? 0) > 0;
}

// ---------- bar-only orders (menu order alongside a membership booking) ----------

export interface CafeOrder {
  id: string;
  client_id: string;
  linked_booking_id: string | null;
  service_name: string | null;
  slot_start: Date | null;
  extras_json: unknown;
  amount_xof: number;
  order_note: string | null;
  status: string;
  wave_session_id: string | null;
  payment_link: string | null;
  link_expires_at: Date | null;
  payment_method: string;
  fulfilling_at: Date | null;
  fulfilled_at: Date | null;
  /** Web orders (/commander): fulfillment mode. NULL = WhatsApp order (unchanged). */
  service_mode: CafeServiceMode | null;
  delivery_address: string | null;
  /** First name typed on the page — the ticket uses this, NOT the CRM name. */
  customer_name: string | null;
  /** Idempotency key of the public POST (double-tap / retry → same order). */
  client_request_id: string | null;
}

export type CafeServiceMode = "SUR_PLACE" | "A_EMPORTER" | "RETRAIT" | "LIVRAISON";

async function transitionCafeOrder(
  id: string,
  to: string,
  fromStates: string[],
  extra: Record<string, unknown> = {},
): Promise<CafeOrder | null> {
  const extraKeys = Object.keys(extra);
  const setClauses = ["status = $2", "updated_at = now()"];
  const params: unknown[] = [id, to, fromStates];
  extraKeys.forEach((k, i) => {
    setClauses.push(`${k} = $${4 + i}`);
    params.push(extra[k]);
  });
  const res = await pool.query(
    `update pending_cafe_orders set ${setClauses.join(", ")}
      where id = $1 and status = any($3) returning *`,
    params,
  );
  return res.rows[0] ?? null;
}

export async function createDraftCafeOrder(args: {
  clientId: string;
  linkedBookingId: string | null;
  serviceName: string | null;
  slotStart: Date | string | null;
  extrasJson: unknown;
  amountXof: number;
  orderNote: string | null;
  serviceMode?: CafeServiceMode | null;
  deliveryAddress?: string | null;
  customerName?: string | null;
  clientRequestId?: string | null;
}): Promise<CafeOrder> {
  const res = await pool.query(
    `insert into pending_cafe_orders
       (client_id, linked_booking_id, service_name, slot_start, extras_json, amount_xof, order_note, status,
        service_mode, delivery_address, customer_name, client_request_id)
     values ($1, $2, $3, $4, $5, $6, $7, 'DRAFT', $8, $9, $10, $11) returning *`,
    [
      args.clientId,
      args.linkedBookingId,
      args.serviceName,
      args.slotStart ?? null,
      JSON.stringify(args.extrasJson),
      args.amountXof,
      args.orderNote,
      args.serviceMode ?? null,
      args.deliveryAddress ?? null,
      args.customerName ?? null,
      args.clientRequestId ?? null,
    ],
  );
  return res.rows[0];
}

/** Idempotency for the public /commander POST: the live order already created
 *  for this request id (a double-tap / retry / second tab must not create a 2nd). */
export async function findActiveCafeOrderByRequestId(requestId: string): Promise<CafeOrder | null> {
  const res = await pool.query(
    `select * from pending_cafe_orders
      where client_request_id = $1 and status in ('DRAFT','AWAITING_PAYMENT')
      order by created_at desc limit 1`,
    [requestId],
  );
  return res.rows[0] ?? null;
}

export async function setCafeOrderAwaitingPayment(
  id: string,
  waveSessionId: string,
  paymentLink: string,
  expiresAt: Date,
  paymentMethod: string = "wave",
): Promise<CafeOrder | null> {
  return transitionCafeOrder(id, "AWAITING_PAYMENT", ["DRAFT"], {
    wave_session_id: waveSessionId,
    payment_link: paymentLink,
    link_expires_at: expiresAt,
    payment_method: paymentMethod,
  });
}

export async function markCafeOrderPaid(id: string): Promise<CafeOrder | null> {
  return transitionCafeOrder(id, "PAID", ["AWAITING_PAYMENT", "EXPIRED", "DRAFT"]);
}

export async function claimCafeOrderForFulfillment(id: string): Promise<CafeOrder | null> {
  const res = await pool.query(
    `update pending_cafe_orders
        set fulfilling_at = now(), updated_at = now()
      where id = $1 and status = 'PAID' and fulfilled_at is null
        and (fulfilling_at is null or fulfilling_at < now() - interval '2 minutes')
      returning *`,
    [id],
  );
  return res.rows[0] ?? null;
}

export async function markCafeOrderFulfilled(id: string): Promise<void> {
  await pool.query(
    `update pending_cafe_orders
        set fulfilled_at = now(), fulfilling_at = null, updated_at = now()
      where id = $1`,
    [id],
  );
}

export async function stuckPaidCafeOrders(
  graceMinutes = 3,
  limit = 20,
): Promise<CafeOrder[]> {
  const res = await pool.query(
    `select * from pending_cafe_orders
      where status = 'PAID' and fulfilled_at is null
        and updated_at < now() - make_interval(mins => $1)
        and (fulfilling_at is null or fulfilling_at < now() - interval '2 minutes')
      order by updated_at asc limit $2`,
    [graceMinutes, limit],
  );
  return res.rows;
}

/** The client's live unpaid bar link, for the per-message dynamic context. */
export async function activeAwaitingCafeOrder(clientId: string): Promise<CafeOrder | null> {
  const res = await pool.query(
    `select * from pending_cafe_orders
      where client_id = $1 and status = 'AWAITING_PAYMENT' and link_expires_at > now()
      order by created_at desc limit 1`,
    [clientId],
  );
  return res.rows[0] ?? null;
}

export async function findCafeOrderById(id: string): Promise<CafeOrder | null> {
  const res = await pool.query(`select * from pending_cafe_orders where id = $1`, [id]);
  return res.rows[0] ?? null;
}

/** One active bar link per client — expire any previous one. */
export async function expireActiveCafeOrders(clientId: string): Promise<void> {
  await pool.query(
    `update pending_cafe_orders set status = 'EXPIRED', updated_at = now()
      where client_id = $1 and status in ('DRAFT', 'AWAITING_PAYMENT')`,
    [clientId],
  );
}

/** TTL sweep — bar links past expiry → EXPIRED (+ orphan DRAFTs > 1h). */
export async function expireStaleCafeOrders(): Promise<number> {
  const res = await pool.query(
    `update pending_cafe_orders set status = 'EXPIRED', updated_at = now()
      where status = 'AWAITING_PAYMENT' and link_expires_at < now()`,
  );
  const drafts = await pool.query(
    `update pending_cafe_orders set status = 'EXPIRED', updated_at = now()
      where status = 'DRAFT' and created_at < now() - interval '1 hour'`,
  );
  return (res.rowCount ?? 0) + (drafts.rowCount ?? 0);
}

// ---------- waitlist (full slots the client asked to be pinged about) ----------

export interface WaitlistEntry {
  id: string;
  client_id: string;
  service_id: string;
  service_name: string;
  event_id: string;
  slot_start: Date;
  status: string;
  notified_at: Date | null;
}

/** Idempotent join: one WAITING entry per client+event (unique partial index). */
export async function joinWaitlist(args: {
  clientId: string;
  serviceId: string;
  serviceName: string;
  eventId: string;
  slotStart: string;
}): Promise<{ entry: WaitlistEntry; already: boolean }> {
  const existing = await pool.query(
    `select * from waitlist_entries where client_id = $1 and event_id = $2 and status = 'WAITING'`,
    [args.clientId, args.eventId],
  );
  if (existing.rows[0]) return { entry: existing.rows[0], already: true };
  const res = await pool.query(
    `insert into waitlist_entries (client_id, service_id, service_name, event_id, slot_start)
     values ($1, $2, $3, $4, $5) returning *`,
    [args.clientId, args.serviceId, args.serviceName, args.eventId, args.slotStart],
  );
  return { entry: res.rows[0], already: false };
}

/** Cancel this client's WAITING entries (all of them, or one class's). */
export async function leaveWaitlist(clientId: string, serviceId?: string): Promise<number> {
  const res = serviceId
    ? await pool.query(
        `update waitlist_entries set status = 'CANCELLED'
          where client_id = $1 and service_id = $2 and status = 'WAITING'`,
        [clientId, serviceId],
      )
    : await pool.query(
        `update waitlist_entries set status = 'CANCELLED' where client_id = $1 and status = 'WAITING'`,
        [clientId],
      );
  return res.rowCount ?? 0;
}

export async function listClientWaitlist(clientId: string): Promise<WaitlistEntry[]> {
  const res = await pool.query(
    `select * from waitlist_entries
      where client_id = $1 and status = 'WAITING' and slot_start > now()
      order by slot_start asc`,
    [clientId],
  );
  return res.rows;
}

/** All WAITING entries for future slots — the sweep's work list. */
export async function pendingWaitlistEntries(): Promise<
  (WaitlistEntry & { wa_phone: string; language: string | null })[]
> {
  const res = await pool.query(
    `select w.*, c.wa_phone, c.language from waitlist_entries w
      join clients c on c.id = w.client_id
      where w.status = 'WAITING' and w.slot_start > now()
      order by w.slot_start asc limit 200`,
  );
  return res.rows;
}

/** Entries whose class started without a spot freeing up → EXPIRED (silent). */
export async function expirePastWaitlistEntries(): Promise<number> {
  const res = await pool.query(
    `update waitlist_entries set status = 'EXPIRED'
      where status = 'WAITING' and slot_start <= now()`,
  );
  return res.rowCount ?? 0;
}

/**
 * One-shot claim BEFORE sending the nudge (same stance as the expiry nudge):
 * only the caller that flips WAITING→NOTIFIED sends the message.
 */
export async function claimWaitlistNotify(id: string): Promise<boolean> {
  const res = await pool.query(
    `update waitlist_entries set status = 'NOTIFIED', notified_at = now()
      where id = $1 and status = 'WAITING'`,
    [id],
  );
  return (res.rowCount ?? 0) > 0;
}

/** The send failed after the claim — recorded for the logs, never retried. */
export async function markWaitlistNotifyFailed(id: string): Promise<void> {
  await pool.query(`update waitlist_entries set status = 'NOTIFY_FAILED' where id = $1`, [id]);
}

// ---------- slot cache (server-side validation of model-provided event_ids) ----------

/**
 * Short deterministic alias for an event_id. WhatsApp interactive row ids are
 * capped at 200 chars while Wix event_ids can exceed 300 — the alias is what
 * present_options puts in clickable rows, and getCachedSlot resolves both.
 */
export function slotChoiceKey(eventId: string): string {
  return `slot_${crypto.createHash("sha256").update(eventId).digest("hex").slice(0, 32)}`;
}

export async function cacheSlots(
  clientId: string,
  serviceId: string,
  slots: { eventId: string; slot: unknown }[],
): Promise<void> {
  for (const s of slots) {
    await pool.query(
      `insert into slot_cache (client_id, event_id, service_id, slot_json, choice_key, cached_at)
       values ($1, $2, $3, $4, $5, now())
       on conflict (client_id, event_id)
       do update set slot_json = excluded.slot_json, service_id = excluded.service_id,
                     choice_key = excluded.choice_key, cached_at = now()`,
      [clientId, s.eventId, serviceId, JSON.stringify(s.slot), slotChoiceKey(s.eventId)],
    );
  }
}

/** Look up a served slot by its full event_id OR by its short choice_key. */
export async function getCachedSlot(
  clientId: string,
  eventIdOrKey: string,
): Promise<{ event_id: string; service_id: string; slot_json: unknown } | null> {
  const res = await pool.query(
    `select event_id, service_id, slot_json from slot_cache
      where client_id = $1 and (event_id = $2 or choice_key = $2)
        and cached_at > now() - interval '2 hours'`,
    [clientId, eventIdOrKey],
  );
  return res.rows[0] ?? null;
}

// ---------- handoffs ----------

export async function recordHandoff(clientId: string, reason: string): Promise<void> {
  const excerpt = await recentTranscriptExcerpt(clientId);
  await pool.query(
    `insert into handoffs (client_id, reason, transcript_excerpt) values ($1, $2, $3)`,
    [clientId, reason, excerpt],
  );
  await recordBookingFunnelEvent({
    clientId,
    stage: "handoff",
    allowCreateJourney: false,
    metadata: { reason_category: reason.split(":", 1)[0]?.slice(0, 80) || "unspecified" },
  }).catch((error) => console.error("Failed to record booking handoff funnel event:", error));
}

export async function recordSystemAudit(
  action: string,
  targetType: string,
  targetId: string,
  detail: Record<string, unknown> = {},
): Promise<void> {
  await pool.query(
    `insert into admin_audit_log
       (admin_user, admin_role, action, target_type, target_id, detail_json)
     values ('awa-system','admin',$1,$2,$3,$4::jsonb)`,
    [action, targetType, targetId, JSON.stringify(detail)],
  );
}

/**
 * True if a handoff whose reason starts with `reasonPrefix` was recorded for
 * this client in the last `hours` hours — dedupe guard so automatic handoffs
 * (e.g. "abonnement introuvable") don't spam reception when the client
 * repeats their claim in the same conversation.
 */
export async function recentHandoffExists(
  clientId: string,
  reasonPrefix: string,
  hours: number,
): Promise<boolean> {
  const res = await pool.query(
    `select 1 from handoffs
      where client_id = $1 and reason like $2 || '%'
        and created_at > now() - ($3 || ' hours')::interval
      limit 1`,
    [clientId, reasonPrefix, String(hours)],
  );
  return (res.rowCount ?? 0) > 0;
}
