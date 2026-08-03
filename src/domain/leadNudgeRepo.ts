import { pool } from "../db/index.js";

/**
 * Persistence for proactive outbound nudges (currently: silent Pack Découverte
 * ad leads). Selection and the atomic claim deliberately repeat the same
 * volatile guards — the claim is authoritative, so a reply, a payment, or a
 * takeover landing between selection and claim cancels the send. `arm` is set
 * once at claim and never mutated (intention-to-treat); `outcome` tracks
 * delivery only. See LEAD-FOLLOWUP-PLAN.md.
 */

export type NudgeArm = "TREATMENT" | "HOLDOUT";

export interface SilentLeadCandidate {
  client_id: string;
  campaign_key: string;
  wa_phone: string;
  name: string | null;
  language: string | null;
}

/**
 * Ad leads that clicked, got Awa's pitch, and never wrote back — ripe for one
 * follow-up inside the 24h window. "Never replied" is anchored on the trigger
 * message (campaign_leads.trigger_message_id → conversations.wa_message_id),
 * NOT on a raw message count: conversations is one stream per client, so an old
 * client who clicks the ad must still qualify. Falls back to the lead's
 * created_at when the trigger turn can't be found (legacy rows, already outside
 * the age bound anyway).
 */
export async function silentLeadCandidates(args: {
  campaignKey: string;
  delayMinutes: number;
  maxAgeHours: number;
  limit?: number;
}): Promise<SilentLeadCandidate[]> {
  const res = await pool.query(
    `with lead as (
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
     )
     select t.client_id, t.campaign_key, c.wa_phone, c.name, c.language
       from trig t
       join clients c on c.id = t.client_id
      where ${SILENT_LEAD_GUARDS}
      order by t.trigger_at asc
      limit $4`,
    [args.campaignKey, args.maxAgeHours, args.delayMinutes, args.limit ?? 25],
  );
  return res.rows;
}

/**
 * Guards shared verbatim by selection and claim. Parameter positions are fixed:
 * $1 campaignKey, $2 maxAgeHours, $3 delayMinutes. Both arms pass the IDENTICAL
 * clause — only the inserted arm/outcome differ — so the holdout samples the
 * same population as treatment.
 */
const SILENT_LEAD_GUARDS = `
        c.is_test = false
        -- last inbound (== the trigger, since never replied) still inside the safe window
        and t.trigger_at > now() - make_interval(hours => $2)
        -- never replied: no user turn strictly after the trigger turn
        and not exists (select 1 from conversations u
                         where u.client_id = t.client_id and u.role = 'user'
                           and u.created_at > t.trigger_at)
        -- Awa answered the ad message...
        and exists (select 1 from conversations a
                     where a.client_id = t.client_id and a.role = 'assistant'
                       and a.created_at > t.trigger_at)
        -- ...and has now been silent for at least the delay
        and not exists (select 1 from conversations a
                         where a.client_id = t.client_id and a.role = 'assistant'
                           and a.created_at > now() - make_interval(mins => $3))
        -- no payment funnel EVER (any status incl. EXPIRED) → the expired-link
        -- nudge / normal flow owns follow-up; A never stacks on it
        and not exists (select 1 from pending_plan_orders p where p.client_id = t.client_id)
        and not exists (select 1 from pending_bookings b
                         where b.client_id = t.client_id and b.payment_link is not null)
        -- real pause gates (mirror the agent's hard gates)
        and (c.human_takeover_until is null or c.human_takeover_until <= now())
        and (c.awa_disengaged_until is null or c.awa_disengaged_until <= now())
        and not exists (select 1 from handoffs h
                         where h.client_id = t.client_id and h.status = 'OPEN')
        and not exists (select 1 from agent_tool_failures f
                         where f.client_id = t.client_id
                           and f.tripped_at is not null and f.expires_at > now())
        -- one-shot
        and not exists (select 1 from outbound_nudges n
                         where n.dedup_key = 'LEAD_SILENT:' || t.client_id::text)`;

/**
 * Atomically claim the right to nudge one lead. Re-checks every volatile guard
 * at claim time inside a single INSERT … SELECT … WHERE — so a reply that
 * arrives between selection and here makes the SELECT return no row and nothing
 * is claimed. Returns true when this call won the claim.
 */
export async function claimSilentLeadNudge(args: {
  clientId: string;
  campaignKey: string;
  arm: NudgeArm;
  delayMinutes: number;
  maxAgeHours: number;
}): Promise<boolean> {
  const res = await pool.query(
    `with lead as (
       select cl.client_id, cl.campaign_key, cl.trigger_message_id,
              cl.created_at as lead_created_at
         from campaign_leads cl
        where cl.client_id = $5 and cl.campaign_key = $1
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
     )
     insert into outbound_nudges
       (dedup_key, client_id, campaign_key, kind, arm, outcome, detail)
     select 'LEAD_SILENT:' || t.client_id::text, t.client_id, t.campaign_key,
            'LEAD_SILENT', $4,
            case when $4 = 'HOLDOUT' then 'SUPPRESSED' else 'CLAIMED' end,
            case when $4 = 'HOLDOUT' then 'holdout' else null end
       from trig t
       join clients c on c.id = t.client_id
      where ${SILENT_LEAD_GUARDS}
     on conflict (dedup_key) do nothing
     returning dedup_key`,
    [args.campaignKey, args.maxAgeHours, args.delayMinutes, args.arm, args.clientId],
  );
  return (res.rowCount ?? 0) > 0;
}

export function silentLeadDedupKey(clientId: string): string {
  return `LEAD_SILENT:${clientId}`;
}

/** Move a claimed nudge to its delivery outcome. SENT stamps sent_at. */
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
 * 131047). Flips SENT → FAILED so the delivery-rate metric stays honest. The
 * arm is intentionally NOT touched: intention-to-treat keeps the lead in the
 * treatment group for the causal comparison. Returns rows updated.
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
