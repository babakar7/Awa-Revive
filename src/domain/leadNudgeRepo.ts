import { pool } from "../db/index.js";

/**
 * Persistence for the MANUAL silent-lead follow-up. Reception reviews candidates
 * in /admin/relances and, per lead, either sends one nudge or dismisses it. The
 * send path re-checks every volatile guard atomically at click time, so a lead
 * who replied, paid, or fell under human takeover between page load and click is
 * never messaged. dedup_key makes each lead one-shot (a send OR a dismiss).
 * See LEAD-FOLLOWUP-PLAN.md.
 */

export interface SilentLeadCandidate {
  client_id: string;
  campaign_key: string;
  wa_phone: string;
  name: string | null;
  language: string | null;
  trigger_at: Date;
}

export interface LeadNudgeContact {
  wa_phone: string;
  name: string | null;
  language: string | null;
}

export interface RecentLeadNudge {
  client_id: string;
  wa_phone: string;
  name: string | null;
  outcome: string;
  detail: string | null;
  assigned_at: Date;
  sent_at: Date | null;
}

export function silentLeadDedupKey(clientId: string): string {
  return `LEAD_SILENT:${clientId}`;
}

const CANDIDATE_CTES = `
  with lead as (
    select cl.client_id, cl.campaign_key, cl.trigger_message_id,
           cl.created_at as lead_created_at
      from campaign_leads cl
     where cl.campaign_key = $1
  ),
  trig as (
    select l.client_id, l.campaign_key,
           coalesce(
             (select t.created_at from conversations t
               where t.client_id = l.client_id
                 and t.wa_message_id = l.trigger_message_id
               order by t.created_at asc limit 1),
             l.lead_created_at
           ) as trigger_at
      from lead l
  )`;

/**
 * Guards shared verbatim by the review list, the badge count, and the send
 * claim — so what reception sees is exactly what the atomic claim will accept.
 * Param positions: $1 campaignKey, $2 maxAgeHours, $3 delayMinutes.
 */
const SILENT_LEAD_GUARDS = `
        c.is_test = false
        -- last inbound (== the trigger, since never replied) still inside the
        -- 24h WhatsApp window: free text can't be delivered past it
        and t.trigger_at > now() - make_interval(hours => $2)
        -- never replied: no user turn strictly after the trigger turn
        and not exists (select 1 from conversations u
                         where u.client_id = t.client_id and u.role = 'user'
                           and u.created_at > t.trigger_at)
        -- Awa answered the ad message...
        and exists (select 1 from conversations a
                     where a.client_id = t.client_id and a.role = 'assistant'
                       and a.created_at > t.trigger_at)
        -- ...and has been silent since (so we don't surface a live conversation)
        and not exists (select 1 from conversations a
                         where a.client_id = t.client_id and a.role = 'assistant'
                           and a.created_at > now() - make_interval(mins => $3))
        -- no payment funnel EVER (any status incl. EXPIRED): the expired-link
        -- nudge / normal flow already owns follow-up there
        and not exists (select 1 from pending_plan_orders p where p.client_id = t.client_id)
        and not exists (select 1 from pending_bookings b
                         where b.client_id = t.client_id and b.payment_link is not null)
        -- never talk over a human or a paused Awa
        and (c.human_takeover_until is null or c.human_takeover_until <= now())
        and (c.awa_disengaged_until is null or c.awa_disengaged_until <= now())
        and not exists (select 1 from handoffs h
                         where h.client_id = t.client_id and h.status = 'OPEN')
        and not exists (select 1 from agent_tool_failures f
                         where f.client_id = t.client_id
                           and f.tripped_at is not null and f.expires_at > now())
        -- one-shot: already sent or already dismissed
        and not exists (select 1 from outbound_nudges n
                         where n.dedup_key = 'LEAD_SILENT:' || t.client_id::text)`;

/**
 * Ad leads that clicked, got Awa's pitch, and never wrote back — the review
 * list. Ordered oldest-click-first so reception treats the leads closest to the
 * 24h window boundary first.
 */
export async function silentLeadCandidates(args: {
  campaignKey: string;
  delayMinutes: number;
  maxAgeHours: number;
  limit?: number;
}): Promise<SilentLeadCandidate[]> {
  const res = await pool.query(
    `${CANDIDATE_CTES}
     select t.client_id, t.campaign_key, c.wa_phone, c.name, c.language, t.trigger_at
       from trig t
       join clients c on c.id = t.client_id
      where ${SILENT_LEAD_GUARDS}
      order by t.trigger_at asc
      limit $4`,
    [args.campaignKey, args.maxAgeHours, args.delayMinutes, args.limit ?? 100],
  );
  return res.rows;
}

/** How many leads are waiting in the review list (sidebar badge). */
export async function countSilentLeadCandidates(args: {
  campaignKey: string;
  delayMinutes: number;
  maxAgeHours: number;
}): Promise<number> {
  const res = await pool.query(
    `${CANDIDATE_CTES}
     select count(*)::int as n
       from trig t join clients c on c.id = t.client_id
      where ${SILENT_LEAD_GUARDS}`,
    [args.campaignKey, args.maxAgeHours, args.delayMinutes],
  );
  return res.rows[0]?.n ?? 0;
}

/**
 * Atomically claim the right to send a manual nudge to one lead. Re-checks every
 * volatile guard at click time (same clause as the review list) — a reply that
 * arrived since the page loaded makes the SELECT return no row and nothing is
 * claimed. Returns the contact to message, or null when the claim was refused.
 */
export async function claimManualLeadNudge(args: {
  clientId: string;
  campaignKey: string;
  by: string;
  delayMinutes: number;
  maxAgeHours: number;
}): Promise<LeadNudgeContact | null> {
  const res = await pool.query(
    `with lead as (
       select cl.client_id, cl.campaign_key, cl.trigger_message_id,
              cl.created_at as lead_created_at
         from campaign_leads cl
        where cl.client_id = $4 and cl.campaign_key = $1
        limit 1
     ),
     trig as (
       select l.client_id, l.campaign_key,
              coalesce(
                (select t.created_at from conversations t
                  where t.client_id = l.client_id
                    and t.wa_message_id = l.trigger_message_id
                  order by t.created_at asc limit 1),
                l.lead_created_at
              ) as trigger_at
         from lead l
     ),
     claim as (
       insert into outbound_nudges
         (dedup_key, client_id, campaign_key, kind, arm, outcome, detail)
       select 'LEAD_SILENT:' || t.client_id::text, t.client_id, t.campaign_key,
              'LEAD_SILENT', 'MANUAL', 'CLAIMED', $5
         from trig t
         join clients c on c.id = t.client_id
        where ${SILENT_LEAD_GUARDS}
       on conflict (dedup_key) do nothing
       returning client_id
     )
     select c.wa_phone, c.name, c.language
       from claim
       join clients c on c.id = claim.client_id`,
    [args.campaignKey, args.maxAgeHours, args.delayMinutes, args.clientId, `manual:${args.by}`],
  );
  return res.rows[0] ?? null;
}

/**
 * Reception chose NOT to nudge this lead: record a one-shot dismissal so it
 * drops off the list for good. Unconditional beyond the campaign-lead existence
 * check — a human's skip is always honored. Returns false if already actioned.
 */
export async function dismissSilentLead(args: {
  clientId: string;
  campaignKey: string;
  by: string;
}): Promise<boolean> {
  const res = await pool.query(
    `insert into outbound_nudges
       (dedup_key, client_id, campaign_key, kind, arm, outcome, detail)
     select 'LEAD_SILENT:' || cl.client_id::text, cl.client_id, cl.campaign_key,
            'LEAD_SILENT', 'MANUAL', 'SUPPRESSED', $3
       from campaign_leads cl
      where cl.client_id = $1::uuid and cl.campaign_key = $2
     on conflict (dedup_key) do nothing
     returning dedup_key`,
    [args.clientId, args.campaignKey, `manual_skip:${args.by}`],
  );
  return (res.rowCount ?? 0) > 0;
}

/** Move a claimed nudge to its delivery outcome. SENT stamps sent_at + wamid. */
export async function completeOutboundNudge(args: {
  dedupKey: string;
  outcome: "SENT" | "FAILED";
  detail?: string | null;
  waMessageId?: string | null;
}): Promise<void> {
  await pool.query(
    `update outbound_nudges
        set outcome = $2,
            detail = coalesce($3, detail),
            wa_message_id = coalesce($4, wa_message_id),
            sent_at = case when $2 = 'SENT' then now() else sent_at end
      where dedup_key = $1`,
    [args.dedupKey, args.outcome, args.detail?.slice(0, 300) ?? null, args.waMessageId ?? null],
  );
}

/**
 * Async Meta delivery failure (accepted 200 then dropped — closed window,
 * 131047). Flips SENT → FAILED so the delivery-rate view stays honest. Returns
 * rows updated.
 */
export async function markOutboundNudgeFailedByWamid(
  waMessageId: string,
  reason: string,
): Promise<number> {
  try {
    const res = await pool.query(
      `update outbound_nudges set outcome = 'FAILED', detail = $2
        where wa_message_id = $1 and outcome = 'SENT'`,
      [waMessageId, reason.slice(0, 300)],
    );
    return res.rowCount ?? 0;
  } catch {
    return 0;
  }
}

/** Recently actioned leads (sent + skipped) for the page's history panel. */
export async function listRecentLeadNudges(limit = 30): Promise<RecentLeadNudge[]> {
  const res = await pool.query(
    `select n.client_id, c.wa_phone, c.name, n.outcome, n.detail, n.assigned_at, n.sent_at
       from outbound_nudges n
       join clients c on c.id = n.client_id
      where n.kind = 'LEAD_SILENT'
      order by n.assigned_at desc
      limit $1`,
    [limit],
  );
  return res.rows;
}
