import { pool } from "../db/index.js";
import type { ContinuityFamily, KeyPlanMapping, KeyType } from "./keyRules.js";

export interface KeyRegistry {
  id: string;
  paid_order_id: string;
  bonus_order_id: string | null;
  client_id: string | null;
  wix_contact_id: string | null;
  wix_member_id: string | null;
  key_type: KeyType;
  plan_id: string;
  family: ContinuityFamily;
  bonus_plan_id: string | null;
  starts_at: Date;
  original_ends_at: Date;
  effective_ends_at: Date;
  status: "SCHEDULED" | "ACTIVE" | "ENDED" | "REFUNDED" | "CANCELLED";
  previous_key_id: string | null;
  purchased_at: Date | null;
  continuity_source_kind: "KEY" | "LEGACY_REFORMER" | null;
  continuity_source_order_id: string | null;
  continuity_source_plan_id: string | null;
  continuity_expires_at: Date | null;
  invitations_granted: number;
  extension_used_at: Date | null;
  bonus_status: "PENDING" | "ACTIVE" | "FAILED" | "MANUAL_REQUIRED";
  bonus_attempts: number;
  bonus_next_retry_at: Date | null;
  bonus_last_error: string | null;
}

export async function upsertKey(args: {
  paidOrderId: string;
  clientId?: string | null;
  wixContactId?: string | null;
  wixMemberId?: string | null;
  mapping: KeyPlanMapping;
  startsAt: Date;
  endsAt: Date;
  status: "SCHEDULED" | "ACTIVE";
  previousKeyId?: string | null;
  purchasedAt?: Date | null;
  continuitySourceKind?: "KEY" | "LEGACY_REFORMER" | null;
  continuitySourceOrderId?: string | null;
  continuitySourcePlanId?: string | null;
  continuityExpiresAt?: Date | null;
  invitationsGranted?: number;
}): Promise<KeyRegistry> {
  // A bonus-less key (sur-mesure) is born bonus_status='ACTIVE' so the repair
  // sweep never touches it and admin never reads it as "activation en attente".
  const bonusPlanId = args.mapping.bonus?.planId ?? null;
  const bonusStatus = bonusPlanId ? "PENDING" : "ACTIVE";
  const result = await pool.query(
    `insert into key_registry
       (paid_order_id, client_id, wix_contact_id, wix_member_id, key_type,
        plan_id, family, bonus_plan_id, bonus_status, starts_at, original_ends_at,
        effective_ends_at, status, previous_key_id, purchased_at,
        continuity_source_kind, continuity_source_order_id,
        continuity_source_plan_id, continuity_expires_at, invitations_granted)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$11,$12,$13,$14,$15,$16,$17,$18,$19)
     on conflict (paid_order_id) do update set
       client_id=coalesce(key_registry.client_id, excluded.client_id),
       wix_contact_id=coalesce(key_registry.wix_contact_id, excluded.wix_contact_id),
       wix_member_id=coalesce(key_registry.wix_member_id, excluded.wix_member_id),
       purchased_at=coalesce(key_registry.purchased_at, excluded.purchased_at),
       continuity_source_kind=coalesce(key_registry.continuity_source_kind, excluded.continuity_source_kind),
       continuity_source_order_id=coalesce(key_registry.continuity_source_order_id, excluded.continuity_source_order_id),
       continuity_source_plan_id=coalesce(key_registry.continuity_source_plan_id, excluded.continuity_source_plan_id),
       continuity_expires_at=coalesce(key_registry.continuity_expires_at, excluded.continuity_expires_at),
       invitations_granted=greatest(key_registry.invitations_granted, excluded.invitations_granted),
       updated_at=now()
     returning *`,
    [
      args.paidOrderId,
      args.clientId ?? null,
      args.wixContactId ?? null,
      args.wixMemberId ?? null,
      args.mapping.type,
      args.mapping.planId,
      args.mapping.family,
      bonusPlanId,
      bonusStatus,
      args.startsAt,
      args.endsAt,
      args.status,
      args.previousKeyId ?? null,
      args.purchasedAt ?? null,
      args.continuitySourceKind ?? null,
      args.continuitySourceOrderId ?? null,
      args.continuitySourcePlanId ?? null,
      args.continuityExpiresAt ?? null,
      args.invitationsGranted ?? 0,
    ],
  );
  return result.rows[0];
}

export async function keyCoveringAt(args: {
  clientId?: string | null;
  wixMemberId?: string | null;
  at: Date;
  /** Restrict to one family. Omitted only by legacy callers that predate families. */
  family?: ContinuityFamily | null;
  excludePaidOrderId?: string | null;
}): Promise<KeyRegistry | null> {
  const result = await pool.query(
    `select * from key_registry
      where (($1::uuid is not null and client_id=$1)
          or ($2::text is not null and wix_member_id=$2))
        and starts_at <= $3 and effective_ends_at > $3
        and ($4::text is null or paid_order_id <> $4)
        and ($5::text is null or family=$5)
        and status not in ('REFUNDED','CANCELLED')
      order by effective_ends_at desc
      limit 1`,
    [
      args.clientId ?? null,
      args.wixMemberId ?? null,
      args.at,
      args.excludePaidOrderId ?? null,
      args.family ?? null,
    ],
  );
  return result.rows[0] ?? null;
}

export async function getKeyByPaidOrder(paidOrderId: string): Promise<KeyRegistry | null> {
  const result = await pool.query(`select * from key_registry where paid_order_id=$1`, [paidOrderId]);
  return result.rows[0] ?? null;
}

export async function getKeyById(id: string): Promise<KeyRegistry | null> {
  const result = await pool.query(`select * from key_registry where id=$1`, [id]);
  return result.rows[0] ?? null;
}

export async function listKeysForAdmin(limit = 100): Promise<
  Array<KeyRegistry & { client_name: string | null; wa_phone: string | null }>
> {
  const result = await pool.query(
    `select k.*, c.name as client_name, c.wa_phone
       from key_registry k
       left join clients c on c.id=k.client_id
      order by k.starts_at desc
      limit $1`,
    [limit],
  );
  return result.rows;
}

export async function listActiveKeysForNudges(): Promise<
  Array<
    KeyRegistry & {
      client_name: string | null;
      wa_phone: string;
      available_invitations: number;
    }
  >
> {
  const result = await pool.query(
    `select k.*, c.name as client_name, c.wa_phone,
            (select count(*)::int
               from key_invitations i
              where i.key_id=k.id
                and i.status in ('GRANTED','ASSIGNED')
                and i.wix_booking_id is null) as available_invitations
       from key_registry k
       join clients c on c.id=k.client_id
      where k.status='ACTIVE'
        and k.starts_at <= now() and k.effective_ends_at > now()
      order by k.effective_ends_at asc`,
  );
  return result.rows;
}

/**
 * Claim-before-send for commercial nudges. FAILED is intentionally terminal:
 * one missed reminder is preferable to duplicate client messages.
 */
export async function claimKeyNudge(args: {
  dedupKey: string;
  keyId: string;
  clientId: string;
}): Promise<boolean> {
  const result = await pool.query(
    `insert into key_nudges (dedup_key, key_id, client_id, kind, outcome, detail)
     values ($1,$2,$3,split_part($1, ':', 1),'FAILED','claimed')
     on conflict (dedup_key) do nothing`,
    [args.dedupKey, args.keyId, args.clientId],
  );
  return result.rowCount === 1;
}

export async function completeKeyNudge(
  dedupKey: string,
  outcome: "SENT" | "SUPPRESSED" | "FAILED",
  detail: string,
): Promise<void> {
  await pool.query(
    `update key_nudges set outcome=$2, detail=$3 where dedup_key=$1`,
    [dedupKey, outcome, detail.slice(0, 1000)],
  );
}

export async function activeKeyForClient(args: {
  clientId: string;
  wixMemberId?: string | null;
  family?: ContinuityFamily | null;
}): Promise<KeyRegistry | null> {
  return (await activeKeysForClient(args))[0] ?? null;
}

export async function activeKeysForClient(args: {
  clientId: string;
  wixMemberId?: string | null;
  family?: ContinuityFamily | null;
}): Promise<KeyRegistry[]> {
  const result = await pool.query(
    `select * from key_registry
      where status='ACTIVE'
        and starts_at <= now() and effective_ends_at > now()
        and (client_id=$1 or ($2::text is not null and wix_member_id=$2))
        and ($3::text is null or family=$3)
      order by starts_at desc`,
    [args.clientId, args.wixMemberId ?? null, args.family ?? null],
  );
  return result.rows;
}

/**
 * The client's active key of a specific TYPE — used where the type matters and
 * must not be masked by a more-recently-started key of another family (e.g. the
 * L'Invitée guarantee: an active Aquabike key must never hide the Invitée).
 */
export async function activeKeyOfType(args: {
  clientId: string;
  wixMemberId?: string | null;
  type: KeyType;
}): Promise<KeyRegistry | null> {
  const result = await pool.query(
    `select * from key_registry
      where status='ACTIVE'
        and starts_at <= now() and effective_ends_at > now()
        and (client_id=$1 or ($2::text is not null and wix_member_id=$2))
        and key_type=$3
      order by starts_at desc
      limit 1`,
    [args.clientId, args.wixMemberId ?? null, args.type],
  );
  return result.rows[0] ?? null;
}

/**
 * L'Invitée conversion rule: a paid next Key normally waits for expiry, but
 * becomes due immediately once the third non-cancelled Reformer session has
 * actually started. The old Invitee row remains active until its calendar end
 * so an unused bonus stays available.
 */
export async function releaseScheduledKeysAfterInviteeCompletion(): Promise<string[]> {
  const result = await pool.query(
    `update pending_plan_orders p
        set starts_at=now(), updated_at=now()
      where p.status='SCHEDULED' and p.is_key and p.starts_at > now()
        and p.key_family='REFORMER'
        and exists (
          select 1
            from key_registry k
           where k.client_id=p.client_id
             and k.key_type='INVITEE'
             and k.status='ACTIVE'
             and k.effective_ends_at > now()
             and (
               select count(*)
                 from key_reformer_bookings r
                 join pending_bookings b on b.id=r.local_booking_id
                where r.key_id=k.id and b.status <> 'CANCELLED'
                  and r.slot_start <= now()
             ) >= 3
        )
      returning p.id`,
  );
  return result.rows.map((row) => String(row.id));
}

export async function claimKeyExtension(keyId: string): Promise<KeyRegistry | null> {
  const result = await pool.query(
    `update key_registry
        set extension_used_at=now(), updated_at=now()
      where id=$1 and status='ACTIVE' and effective_ends_at > now()
        and extension_used_at is null
      returning *`,
    [keyId],
  );
  return result.rows[0] ?? null;
}

export async function releaseKeyExtension(keyId: string): Promise<void> {
  await pool.query(
    `update key_registry set extension_used_at=null, updated_at=now() where id=$1`,
    [keyId],
  );
}

export async function completeKeyExtension(keyId: string, newEndDate: Date): Promise<void> {
  await pool.query(
    `update key_registry set effective_ends_at=$2, updated_at=now() where id=$1`,
    [keyId, newEndDate],
  );
}

export async function shiftScheduledNextKey(
  clientId: string | null,
  wixMemberId: string | null,
  days: number,
  family: ContinuityFamily,
): Promise<void> {
  if (!clientId) return;
  // Extending a key only shifts the next key of the SAME family — an Aquabike
  // extension must never move a scheduled Clé, nor the reverse.
  await pool.query(
    `update pending_plan_orders
        set starts_at=starts_at + make_interval(days => $2), updated_at=now()
      where client_id=$1 and is_key and status='SCHEDULED' and starts_at > now()
        and key_family=$3`,
    [clientId, days, family],
  );
}

export async function claimBonusProvisioning(keyId: string): Promise<KeyRegistry | null> {
  const result = await pool.query(
    `update key_registry
        set bonus_claimed_at=now(), updated_at=now()
      where id=$1 and bonus_order_id is null
        and (bonus_claimed_at is null or bonus_claimed_at < now() - interval '2 minutes')
      returning *`,
    [keyId],
  );
  return result.rows[0] ?? null;
}

export async function attachBonusOrder(keyId: string, bonusOrderId: string): Promise<void> {
  await pool.query(
    `update key_registry
        set bonus_order_id=$2, bonus_status='ACTIVE', bonus_last_error=null,
            bonus_claimed_at=null,
            bonus_next_retry_at=null, updated_at=now()
      where id=$1`,
    [keyId, bonusOrderId],
  );
}

export async function markBonusFailure(
  keyId: string,
  error: string,
  nextRetryAt: Date | null,
): Promise<void> {
  await pool.query(
    `update key_registry
        set bonus_attempts=bonus_attempts+1,
            bonus_status=case when $3::timestamptz is null then 'MANUAL_REQUIRED' else 'FAILED' end,
            bonus_last_error=$2, bonus_next_retry_at=$3, bonus_claimed_at=null, updated_at=now()
      where id=$1`,
    [keyId, error.slice(0, 1000), nextRetryAt],
  );
}

export async function dueBonusRepairs(limit = 50): Promise<KeyRegistry[]> {
  const result = await pool.query(
    `select * from key_registry
      where bonus_order_id is null
        and bonus_status in ('PENDING','FAILED')
        and (bonus_next_retry_at is null or bonus_next_retry_at <= now())
      order by created_at asc
      limit $1`,
    [limit],
  );
  return result.rows;
}

export async function keysMissingBonusForClient(clientId: string): Promise<KeyRegistry[]> {
  const result = await pool.query(
    `select * from key_registry
      where client_id=$1
        and status in ('ACTIVE','SCHEDULED')
        and bonus_order_id is null
        and bonus_status in ('PENDING','FAILED')
      order by starts_at asc`,
    [clientId],
  );
  return result.rows;
}

export async function createInvitationRights(
  keyId: string,
  count: number,
  status: "GRANTED" | "PENDING_REVIEW" = "GRANTED",
): Promise<void> {
  for (let ordinal = 1; ordinal <= count; ordinal += 1) {
    await pool.query(
      `insert into key_invitations (key_id, ordinal, status)
       values ($1,$2,$3) on conflict (key_id, ordinal) do nothing`,
      [keyId, ordinal, status],
    );
  }
}

/** Unlock a key's review-gated invitations once the review lands. */
export async function activatePendingInvitations(keyId: string): Promise<number> {
  const result = await pool.query(
    `update key_invitations set status='GRANTED', updated_at=now()
      where key_id=$1 and status='PENDING_REVIEW'`,
    [keyId],
  );
  return result.rowCount ?? 0;
}

/** True if any of the given keys still holds a review-locked invitation. */
export async function hasPendingReviewInvitation(keyIds: string[]): Promise<boolean> {
  if (keyIds.length === 0) return false;
  const result = await pool.query(
    `select 1 from key_invitations
      where key_id = any($1::uuid[]) and status='PENDING_REVIEW'
      limit 1`,
    [keyIds],
  );
  return result.rows.length > 0;
}

export interface ReviewGate {
  client_id: string;
  plan_order_id: string;
  key_id: string | null;
  requested_at: Date;
  ask_sent_at: Date | null;
  activated_at: Date | null;
}

export async function reviewGateForClient(clientId: string): Promise<ReviewGate | null> {
  const result = await pool.query(
    `select * from google_review_gates where client_id=$1`,
    [clientId],
  );
  return result.rows[0] ?? null;
}

/** Create the once-per-lifetime gate. Idempotent — a second call is a no-op. */
export async function insertReviewGate(
  clientId: string,
  planOrderId: string,
): Promise<boolean> {
  const result = await pool.query(
    `insert into google_review_gates (client_id, plan_order_id)
     values ($1,$2) on conflict (client_id) do nothing`,
    [clientId, planOrderId],
  );
  return (result.rowCount ?? 0) > 0;
}

/** Atomically claim the single post-payment "leave a review" message. */
export async function claimReviewAskSend(planOrderId: string): Promise<ReviewGate | null> {
  const result = await pool.query(
    `update google_review_gates set ask_sent_at=now(), updated_at=now()
      where plan_order_id=$1 and ask_sent_at is null
      returning *`,
    [planOrderId],
  );
  return result.rows[0] ?? null;
}

/** Atomically activate the gate; a losing (already-activated) call returns null. */
export async function activateReviewGate(clientId: string): Promise<ReviewGate | null> {
  const result = await pool.query(
    `update google_review_gates set activated_at=now(), updated_at=now()
      where client_id=$1 and activated_at is null
      returning *`,
    [clientId],
  );
  return result.rows[0] ?? null;
}

/** Stamp the Key the gate applies to, once it is provisioned. */
export async function linkReviewGateKey(clientId: string, keyId: string): Promise<void> {
  await pool.query(
    `update google_review_gates set key_id=$2, updated_at=now()
      where client_id=$1 and key_id is null`,
    [clientId, keyId],
  );
}

export interface KeyInvitation {
  id: string;
  key_id: string;
  ordinal: number;
  status: "GRANTED" | "PENDING_REVIEW" | "ASSIGNED" | "USED" | "VOID";
  friend_first_name: string | null;
  friend_phone: string | null;
  wix_invitation_order_id: string | null;
  wix_booking_id: string | null;
}

export async function availableInvitationForKey(keyId: string): Promise<KeyInvitation | null> {
  const result = await pool.query(
    `select * from key_invitations
      where key_id=$1 and status in ('GRANTED','ASSIGNED')
        and wix_booking_id is null
      order by ordinal asc
      limit 1`,
    [keyId],
  );
  return result.rows[0] ?? null;
}

export async function assignInvitation(args: {
  invitationId: string;
  firstName: string;
  phone: string;
}): Promise<KeyInvitation | null> {
  const result = await pool.query(
    `update key_invitations
        set status='ASSIGNED',
            friend_first_name=coalesce(friend_first_name,$2),
            friend_phone=coalesce(friend_phone,$3),
            assigned_at=coalesce(assigned_at,now()),
            updated_at=now()
      where id=$1 and status in ('GRANTED','ASSIGNED')
        and (friend_phone is null or friend_phone=$3)
      returning *`,
    [args.invitationId, args.firstName, args.phone],
  );
  return result.rows[0] ?? null;
}

export async function attachInvitationOrder(
  invitationId: string,
  wixOrderId: string,
): Promise<KeyInvitation | null> {
  const result = await pool.query(
    `update key_invitations
        set wix_invitation_order_id=coalesce(wix_invitation_order_id,$2), updated_at=now()
      where id=$1 and status='ASSIGNED'
      returning *`,
    [invitationId, wixOrderId],
  );
  return result.rows[0] ?? null;
}

export async function markInvitationUsed(args: {
  invitationId: string;
  wixBookingId: string;
}): Promise<void> {
  await pool.query(
    `update key_invitations
        set status='USED', wix_booking_id=$2, used_at=now(), updated_at=now()
      where id=$1 and status='ASSIGNED'`,
    [args.invitationId, args.wixBookingId],
  );
}

export async function latestPreviousKey(args: {
  clientId?: string | null;
  wixMemberId?: string | null;
  before: Date;
  family?: ContinuityFamily | null;
}): Promise<KeyRegistry | null> {
  const result = await pool.query(
    `select * from key_registry
      where (($1::uuid is not null and client_id=$1)
          or ($2::text is not null and wix_member_id=$2))
        and starts_at <= $3
        and ($4::text is null or family=$4)
      order by effective_ends_at desc
      limit 1`,
    [args.clientId ?? null, args.wixMemberId ?? null, args.before, args.family ?? null],
  );
  return result.rows[0] ?? null;
}

export async function markProtectedBenefitBooking(args: {
  wixBookingId: string;
  localBookingId?: string | null;
  keyId: string;
  invitationId?: string | null;
  kind: "BONUS" | "INVITATION";
}): Promise<void> {
  await pool.query(
    `insert into key_benefit_bookings
       (wix_booking_id, local_booking_id, key_id, invitation_id, kind)
     values ($1,$2,$3,$4,$5)
     on conflict (wix_booking_id) do nothing`,
    [
      args.wixBookingId,
      args.localBookingId ?? null,
      args.keyId,
      args.invitationId ?? null,
      args.kind,
    ],
  );
}

export async function protectedBenefitForBooking(
  localBookingId: string,
): Promise<{ kind: "BONUS" | "INVITATION" } | null> {
  const result = await pool.query(
    `select kind from key_benefit_bookings where local_booking_id=$1`,
    [localBookingId],
  );
  return result.rows[0] ?? null;
}

export async function protectedBenefitForWixBooking(
  wixBookingId: string,
): Promise<{ kind: "BONUS" | "INVITATION" } | null> {
  const result = await pool.query(
    `select kind from key_benefit_bookings where wix_booking_id=$1`,
    [wixBookingId],
  );
  return result.rows[0] ?? null;
}

export async function recordKeyReformerBooking(args: {
  wixBookingId: string;
  localBookingId: string;
  keyId: string;
  slotStart: string;
}): Promise<void> {
  await pool.query(
    `insert into key_reformer_bookings
       (wix_booking_id, local_booking_id, key_id, slot_start)
     values ($1,$2,$3,$4)
     on conflict (wix_booking_id) do nothing`,
    [args.wixBookingId, args.localBookingId, args.keyId, args.slotStart],
  );
}

export async function inviteeGuaranteeFacts(keyId: string): Promise<{
  reformerBookings: Array<{ wix_booking_id: string; slot_start: Date }>;
  bonusBookings: number;
}> {
  const [reformer, bonus] = await Promise.all([
    pool.query(
      `select r.wix_booking_id, r.slot_start
         from key_reformer_bookings r
         join pending_bookings b on b.id=r.local_booking_id
        where r.key_id=$1 and b.status <> 'CANCELLED'
        order by r.slot_start asc`,
      [keyId],
    ),
    pool.query(
      `select count(*)::int as count from key_benefit_bookings
        where key_id=$1 and kind='BONUS'`,
      [keyId],
    ),
  ]);
  return {
    reformerBookings: reformer.rows,
    bonusBookings: bonus.rows[0]?.count ?? 0,
  };
}

export async function recordGuaranteeRequest(
  keyId: string,
  detail: Record<string, unknown>,
): Promise<boolean> {
  const result = await pool.query(
    `update key_registry
        set guarantee_requested_at=now(), guarantee_status='PENDING',
            guarantee_detail_json=$2, updated_at=now()
      where id=$1 and key_type='INVITEE' and guarantee_requested_at is null
      returning id`,
    [keyId, JSON.stringify(detail)],
  );
  return result.rowCount === 1;
}
