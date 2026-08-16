/**
 * Idempotent schema — safe to run on every boot.
 * Matches SPEC §5 (data model), plus:
 *   - pending_bookings.slot_json: the full slot object returned by Wix
 *     availability, passed back verbatim on Create Booking.
 *   - slot_cache: server-side record of slots shown to each client, so
 *     event_ids coming from the model are validated against what we actually
 *     served (SPEC §9 prompt-injection stance).
 */
export const SCHEMA_SQL = `
create table if not exists clients (
  id uuid primary key default gen_random_uuid(),
  wa_phone text unique not null,
  name text,
  language text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists pending_bookings (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients(id),
  service_id text not null,
  service_name text not null,
  event_id text not null,
  slot_json jsonb,
  slot_start timestamptz not null,
  slot_end timestamptz,
  amount_xof integer not null,
  status text not null default 'DRAFT',
  wave_session_id text,
  payment_link text,
  link_expires_at timestamptz,
  wix_booking_id text,
  payer_phone text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table pending_bookings
  add column if not exists participants integer not null default 1;

alter table pending_bookings
  add column if not exists payment_method text not null default 'wave';

-- Accounting timestamps are intentionally separate from updated_at: the
-- latter changes during fulfillment and is only an explicitly-labelled
-- fallback for old rows. paid_at is written only by a verified payment path.
alter table pending_bookings add column if not exists paid_at timestamptz;
alter table pending_bookings add column if not exists refunded_at timestamptz;
alter table pending_bookings add column if not exists refund_amount_xof integer;
alter table pending_bookings drop constraint if exists pending_bookings_refund_amount_check;
alter table pending_bookings add constraint pending_bookings_refund_amount_check
  check (refund_amount_xof is null or refund_amount_xof > 0);

-- A Wix booking can be observed again after a webhook/tool retry. Keeping its
-- external id unique makes local persistence idempotent while still allowing
-- any number of not-yet-created bookings (NULL values).
create unique index if not exists idx_pending_bookings_wix_booking
  on pending_bookings (wix_booking_id);

create index if not exists idx_pending_bookings_confirmed_slot
  on pending_bookings (slot_start, client_id) where status='BOOKED';

-- Voluntary cancellation of a mobile-money booking: the seat is released but
-- the payment is retained under the studio's no-refund policy. This marker
-- distinguishes it from a reception/Wix cancellation that may have another
-- accounting outcome.
alter table pending_bookings
  add column if not exists forfeited_at timestamptz;

-- Benefit Programs transaction of a membership redemption — needed to
-- re-credit the plan session if the booking is later cancelled.
alter table pending_bookings
  add column if not exists benefit_transaction_id text;

-- Exact pricing-plan name whose credit paid for a membership booking. Keep the
-- snapshot on the booking: the client's active plans can change later, so the
-- admin must not infer this label from today's Wix memberships.
alter table pending_bookings
  add column if not exists membership_plan_name text;

-- Bar order bundled into the booking payment. extras_json is the
-- server-resolved snapshot (names + unit prices frozen at order time);
-- amount_xof stays the GRAND total (class + extras).
alter table pending_bookings
  add column if not exists extras_json jsonb;
alter table pending_bookings
  add column if not exists extras_amount_xof integer not null default 0;
alter table pending_bookings
  add column if not exists order_note text;
alter table pending_bookings
  add column if not exists campaign_code text;

-- Server-owned campaign marker. It makes the custom checkout order readable
-- in Wix for reception without changing the underlying booked service.
alter table pending_bookings
  add column if not exists campaign_code text;

-- Fulfillment lease: set when a worker starts turning a PAID booking into a
-- Wix booking, so a webhook retry and the reconciliation sweep can't both
-- fulfill the same booking (double-booking). A stale lease (>2 min) is
-- reclaimable — it means the previous attempt crashed mid-flight.
alter table pending_bookings
  add column if not exists fulfilling_at timestamptz;

-- Wix custom checkout requires a separate eCommerce order after the booking
-- is confirmed. Keep an independent retry lease because order recording is
-- post-BOOKED and must never turn a paid, reserved seat into a refund.
alter table pending_bookings add column if not exists wix_order_id text;
alter table pending_bookings add column if not exists wix_payment_recorded_at timestamptz;
alter table pending_bookings add column if not exists wix_order_sync_at timestamptz;
alter table pending_bookings add column if not exists wix_order_sync_error text;
create index if not exists idx_pending_bookings_wix_order_sync
  on pending_bookings (status, wix_payment_recorded_at, updated_at);

-- One-shot follow-up after a payment link expires unused ("ton lien a expiré,
-- tu en veux un nouveau ?"). Set when the nudge is sent — never nudge twice.
alter table pending_bookings
  add column if not exists expiry_nudged_at timestamptz;

alter table clients
  add column if not exists email_prompted_at timestamptz;

alter table clients
  add column if not exists claimed_email text;

-- Last time a capability shortcut menu was delivered (vague openers).
-- "Once per conversation" ≈ suppress for 24h after a successful send.
alter table clients
  add column if not exists capability_menu_at timestamptz;

-- NULL = informal default. Once set to vous, inbound processing never
-- automatically downgrades the client's French register.
alter table clients add column if not exists fr_register text;
alter table clients drop constraint if exists clients_fr_register_check;
alter table clients add constraint clients_fr_register_check
  check (fr_register is null or fr_register in ('tu','vous'));

-- Last time the post-booking bar menu offer was delivered. Caps the offer at
-- once per ~24h: a client paying several sessions back-to-back must not get
-- the same "incontournables" list after every single confirmation (observed
-- 20/07: 3 identical lists in 12 minutes). NULL = never shown (offer allowed).
alter table clients
  add column if not exists cafe_offer_at timestamptz;

-- Team/test numbers: someone from the studio testing Awa, not a real lead.
-- Flagged clients are badged in the admin, excluded from campaign audiences,
-- and never trigger the new-conversation ping to the owner. Toggled from the
-- conversation page (source of truth); the initial team list is seeded once.
alter table clients
  add column if not exists is_test boolean not null default false;

-- Explicit human takeover for the admin conversation workspace. Awa is
-- paused only while human_takeover_until is in the future; the timestamp is
-- the automatic 12h safety release, so a forgotten takeover cannot strand a
-- client indefinitely. Manual resume clears all three fields.
alter table clients add column if not exists human_takeover_until timestamptz;
alter table clients add column if not exists human_takeover_by text;
alter table clients add column if not exists human_takeover_at timestamptz;

-- Awa self-disengagement from a clearly non-serious / suggestive contact.
-- Distinct from human takeover: here NOBODY replies — Awa simply stops. She
-- stays silent while awa_disengaged_until is in the future (automatic ~24h
-- release so a contact is never stranded forever); the reason is shown only in
-- the admin badge (silent to the team, no reception ping). Manual resume clears
-- all three fields.
alter table clients add column if not exists awa_disengaged_until timestamptz;
alter table clients add column if not exists awa_disengaged_at timestamptz;
alter table clients add column if not exists awa_disengaged_reason text;
alter table clients add column if not exists awa_disengaged_kind text;
alter table clients drop constraint if exists clients_awa_disengaged_kind_check;
alter table clients add constraint clients_awa_disengaged_kind_check
  check (awa_disengaged_kind is null or awa_disengaged_kind in ('manual','nonserious','no_intent','sexual'));

-- Deterministic guard against rapid conversations made only of greetings,
-- unclear fragments or unreadable voice notes. The count expires after 24 h;
-- a real Revive request resets it immediately.
alter table clients add column if not exists awa_no_intent_streak integer not null default 0;
alter table clients add column if not exists awa_no_intent_last_at timestamptz;

-- One durable attribution/offer record per client and campaign. The offer is
-- redeemable until the first paid campaign booking; expired payment links do
-- not burn it, so Awa can safely create a fresh link for the same cold lead.
create table if not exists campaign_leads (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients(id),
  campaign_key text not null,
  trigger_message_id text,
  matched_by text not null check (matched_by in ('meta_referral','message')),
  source_id text,
  source_type text,
  source_url text,
  headline text,
  ctwa_clid text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (client_id, campaign_key)
);
create unique index if not exists idx_campaign_leads_message
  on campaign_leads (trigger_message_id) where trigger_message_id is not null;
create index if not exists idx_campaign_leads_meta_source
  on campaign_leads (campaign_key, source_id, created_at)
  where matched_by='meta_referral' and source_type='ad' and source_id is not null;

create index if not exists idx_pending_bookings_client_status
  on pending_bookings (client_id, status);
create index if not exists idx_pending_bookings_status_expiry
  on pending_bookings (status, link_expires_at);

-- Class-booking conversion stream. Journeys group a client's consecutive
-- booking intent until a terminal outcome or 24 h of inactivity. Events are
-- deliberately operational only: no transcript text and no payment URL.
create table if not exists booking_funnel_journeys (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients(id),
  status text not null default 'open'
    check (status in ('open','booked','handed_off','failed','inactive')),
  payment_method text,
  is_excluded boolean not null default false,
  backfill_key text unique,
  started_at timestamptz not null default now(),
  last_event_at timestamptz not null default now(),
  closed_at timestamptz,
  terminal_stage text,
  created_at timestamptz not null default now()
);
create index if not exists idx_booking_funnel_journeys_client_open
  on booking_funnel_journeys (client_id, last_event_at desc)
  where status = 'open';
create index if not exists idx_booking_funnel_journeys_started
  on booking_funnel_journeys (started_at desc) where not is_excluded;

create table if not exists booking_funnel_events (
  id bigserial primary key,
  journey_id uuid not null references booking_funnel_journeys(id) on delete cascade,
  client_id uuid not null references clients(id),
  booking_id uuid references pending_bookings(id),
  stage text not null,
  payment_method text,
  failure_code text,
  metadata_json jsonb not null default '{}'::jsonb,
  idempotency_key text unique,
  is_excluded boolean not null default false,
  occurred_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);
create index if not exists idx_booking_funnel_events_journey
  on booking_funnel_events (journey_id, occurred_at);
create index if not exists idx_booking_funnel_events_stage_time
  on booking_funnel_events (stage, occurred_at desc) where not is_excluded;
create index if not exists idx_booking_funnel_events_booking
  on booking_funnel_events (booking_id) where booking_id is not null;

create table if not exists processed_webhooks (
  id text primary key,
  source text not null,
  received_at timestamptz not null default now()
);

-- Orange Money callbacks can arrive a few seconds before the corresponding
-- transaction is visible in Sonatel's authenticated lookup API. Persist the
-- exact transaction/order pair before looking it up so a deploy, crash, or a
-- missing provider retry cannot lose a payment confirmation.
create table if not exists orange_money_verifications (
  transaction_id text primary key,
  order_id text not null,
  amount_xof integer not null,
  customer_id text,
  status text not null default 'PENDING'
    check (status in ('PENDING','SUCCEEDED','FAILED')),
  attempts integer not null default 0,
  next_attempt_at timestamptz not null default now(),
  lease_until timestamptz,
  last_error text,
  alerted_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_om_verifications_due
  on orange_money_verifications (next_attempt_at)
  where status = 'PENDING';

create table if not exists conversations (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients(id),
  role text not null,
  content text not null,
  wa_message_id text,
  created_at timestamptz not null default now()
);

create index if not exists idx_conversations_client_created
  on conversations (client_id, created_at);

-- Coupe-circuit durable de la boucle agent. Deux erreurs techniques identiques
-- sur la même ressource déclenchent un relais humain et une pause d'Awa. La
-- fenêtre vit en base (pas en mémoire) afin de survivre aux redéploiements.
create table if not exists agent_tool_failures (
  client_id uuid not null references clients(id) on delete cascade,
  tool_name text not null,
  error_code text not null,
  resource_key text not null,
  failure_count integer not null default 1 check (failure_count > 0),
  first_failed_at timestamptz not null default now(),
  last_failed_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '2 hours'),
  tripped_at timestamptz,
  primary key (client_id, tool_name, error_code, resource_key)
);
create index if not exists idx_agent_tool_failures_expiry
  on agent_tool_failures (expires_at);

-- Dernière liste réellement présentée au client. Permet de traiter un choix
-- écrit ("12h30", "Wave", titre exact) exactement comme un clic WhatsApp,
-- sans laisser le modèle deviner l'identifiant technique.
create table if not exists presented_choices (
  client_id uuid not null references clients(id) on delete cascade,
  presentation_id uuid not null,
  choice_id text not null,
  title text not null,
  presented_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '2 hours'),
  primary key (client_id, presentation_id, choice_id)
);
create index if not exists idx_presented_choices_recent
  on presented_choices (client_id, presented_at desc);

-- Human replies are kept separately from Awa's turns so pending/failed sends
-- never pollute the model history. request_key makes form retries idempotent;
-- successful rows are merged into both the admin timeline and Awa replay.
create table if not exists admin_outbound_messages (
  id uuid primary key default gen_random_uuid(),
  request_key uuid unique not null,
  client_id uuid not null references clients(id),
  body text not null check (length(trim(body)) between 1 and 1500),
  sent_by text not null,
  status text not null default 'pending'
    check (status in ('pending','sent','failed')),
  wa_message_id text,
  error text,
  created_at timestamptz not null default now(),
  sent_at timestamptz
);
create index if not exists idx_admin_outbound_client_created
  on admin_outbound_messages (client_id, created_at);

create table if not exists handoffs (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients(id),
  reason text,
  transcript_excerpt text,
  created_at timestamptz not null default now()
);

-- Cycle de vie d'un handoff : avant, une ligne était écrite puis oubliée —
-- rien ne disait si quelqu'un avait agi. OPEN → DONE via le bouton « Traité »
-- du dashboard (boucle de résultat, PROGRESS §4.31).
alter table handoffs
  add column if not exists status text not null default 'OPEN';
alter table handoffs
  add column if not exists done_by text;
alter table handoffs
  add column if not exists done_at timestamptz;
alter table handoffs add column if not exists resolution_outcome text;
alter table handoffs add column if not exists resolution_note text;
alter table handoffs add column if not exists technical_dedup_key text;
create unique index if not exists idx_handoffs_open_technical_dedup
  on handoffs (technical_dedup_key)
  where status='OPEN' and technical_dedup_key is not null;

-- Backfill one-shot (borne FIXE = idempotent) : l'historique d'avant la
-- feature est considéré traité — seuls les handoffs neufs vivent le cycle.
update handoffs set status = 'DONE', done_by = 'backfill'
  where status = 'OPEN' and created_at < '2026-07-12';

-- Abonnements vendus par Awa. Même invariant que les cours : l'ordre Wix
-- n'est créé qu'après le webhook Wave vérifié.
-- Statuts : DRAFT → AWAITING_PAYMENT → PAID → ACTIVATED
--           AWAITING_PAYMENT → EXPIRED → PAID (paiement tardif honoré)
--           PAID sans ACTIVATED = activation manuelle réception (pas de membre Wix)
create table if not exists pending_plan_orders (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients(id),
  plan_id text not null,
  plan_name text not null,
  amount_xof integer not null,
  status text not null default 'DRAFT',
  wave_session_id text,
  payment_link text,
  link_expires_at timestamptz,
  wix_order_id text,
  member_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_plan_orders_client_status
  on pending_plan_orders (client_id, status);
create unique index if not exists idx_plan_orders_one_live_payment
  on pending_plan_orders (client_id)
  where status in ('DRAFT','AWAITING_PAYMENT');

-- Date de démarrage voulue du plan (renouvellement anticipé chaîné à la fin de
-- l'abonnement actuel). NULL = démarrage immédiat. Passée à Wix comme startDate
-- à l'activation (ordre PENDING jusqu'à cette date, activé automatiquement).
alter table pending_plan_orders
  add column if not exists starts_at timestamptz;
alter table pending_plan_orders
  add column if not exists is_key boolean not null default false;
alter table pending_plan_orders
  add column if not exists key_invitation_count integer;
alter table pending_plan_orders add column if not exists paid_at timestamptz;
alter table pending_plan_orders add column if not exists continuity_source_kind text
  check (continuity_source_kind is null or continuity_source_kind in ('KEY','LEGACY_REFORMER'));
alter table pending_plan_orders add column if not exists continuity_source_order_id text;
alter table pending_plan_orders add column if not exists continuity_source_plan_id text;
alter table pending_plan_orders add column if not exists continuity_expires_at timestamptz;
alter table pending_plan_orders add column if not exists continuity_remaining integer;
alter table pending_plan_orders add column if not exists continuity_alerted_at timestamptz;
-- Continuity family of a scheduled key order (REFORMER default; AQUABIKE for the
-- Aquabike abonnement). Lets a next Aquabike and a next Clé be scheduled at once.
alter table pending_plan_orders add column if not exists key_family text
  not null default 'REFORMER';
update pending_plan_orders set key_family='REFORMER'
  where is_key and key_family is null;
drop index if exists idx_plan_orders_one_scheduled_key;
create unique index if not exists idx_plan_orders_one_scheduled_key_family
  on pending_plan_orders (client_id, key_family)
  where status='SCHEDULED' and is_key;
create index if not exists idx_plan_orders_paid_client
  on pending_plan_orders (client_id, paid_at, id)
  where paid_at is not null;

-- Bar-only Wave orders: a menu order attached to a booking the client paid
-- with their abonnement (that flow has no payment link, so the bar can't ride
-- along — this is its own small Wave link). No Wix booking is ever created
-- here; on payment we only notify reception to prepare it. Prices come from
-- cafe-menu.md server-side, exactly like the bundled bar path.
-- Statuts : DRAFT → AWAITING_PAYMENT → PAID ; AWAITING_PAYMENT → EXPIRED → PAID.
create table if not exists pending_cafe_orders (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients(id),
  linked_booking_id uuid references pending_bookings(id),
  service_name text,
  slot_start timestamptz,
  extras_json jsonb not null,
  amount_xof integer not null,
  order_note text,
  status text not null default 'DRAFT',
  wave_session_id text,
  payment_link text,
  link_expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_cafe_orders_client_status
  on pending_cafe_orders (client_id, status);

-- Payment rail on plan/cafe orders (bookings already have payment_method).
-- wave | orange_money | maxit
alter table pending_plan_orders
  add column if not exists payment_method text not null default 'wave';
alter table pending_cafe_orders
  add column if not exists payment_method text not null default 'wave';
alter table pending_cafe_orders add column if not exists paid_at timestamptz;

-- Plan/cafe fulfillment lease (same idea as pending_bookings.fulfilling_at):
-- a crash between markPaid and activation/notify left rows in PAID forever
-- with no sweep. Lease + stuck reconcile recovers them.
alter table pending_plan_orders
  add column if not exists fulfilling_at timestamptz;
-- Set when reception is notified for manual activation (no member / offline
-- failed) so retries don't spam. Auto path uses wix_order_id instead.
alter table pending_plan_orders
  add column if not exists reception_notified_at timestamptz;

-- Pack Découverte Meta campaign: étape 1 is a real one-session Wix plan.
-- Persist the selected slot on the plan payment so the verified webhook can
-- activate the plan then redeem it immediately against that exact class.
alter table pending_plan_orders add column if not exists campaign_code text;
alter table pending_plan_orders add column if not exists service_id text;
alter table pending_plan_orders add column if not exists service_name text;
alter table pending_plan_orders add column if not exists event_id text;
alter table pending_plan_orders add column if not exists slot_json jsonb;
alter table pending_plan_orders add column if not exists slot_start timestamptz;
alter table pending_plan_orders add column if not exists slot_end timestamptz;
alter table pending_plan_orders add column if not exists wix_booking_id text;
alter table pending_plan_orders add column if not exists benefit_transaction_id text;
alter table pending_plan_orders add column if not exists linked_booking_id uuid references pending_bookings(id);
-- Backfill the subset of historical membership bookings that was created as
-- the initial class of a locally sold plan. Other historical redemptions did
-- not persist their plan identity and intentionally keep the safe fallback.
update pending_bookings b
   set membership_plan_name=p.plan_name
  from pending_plan_orders p
 where p.linked_booking_id=b.id
   and b.payment_method='membership'
   and nullif(b.membership_plan_name,'') is null;
alter table pending_plan_orders add column if not exists discovery_booking_status text;
alter table pending_plan_orders add column if not exists discovery_booking_error text;
-- Generic initial-session fulfillment (the historical discovery_* columns are
-- retained to avoid a data migration, but now apply to every plan/Key sale).
alter table pending_plan_orders add column if not exists retry_of_order_id uuid
  references pending_plan_orders(id);
alter table pending_plan_orders add column if not exists fulfillment_failure_count integer
  not null default 0;
alter table pending_plan_orders add column if not exists technical_failure_at timestamptz;
-- One-shot "your link expired, no payment received" follow-up for plan orders,
-- mirroring pending_bookings.expiry_nudged_at. Also the flag behind the OM/Max
-- It reception alert on expiry (a lost Sonatel callback is otherwise invisible:
-- real case Maryeme 01/08 — paid, callback never arrived, order silently EXPIRED).
alter table pending_plan_orders add column if not exists expiry_nudged_at timestamptz;

alter table pending_cafe_orders
  add column if not exists fulfilling_at timestamptz;
-- Set when reception + client confirmations for a paid bar order are done
-- (or attempted). PAID + fulfilled_at IS NULL = stuck, reclaimable.
alter table pending_cafe_orders
  add column if not exists fulfilled_at timestamptz;

-- Commandes WEB (/commander, QR vestiaires). NULL = commande WhatsApp historique
-- (comportement inchangé). service_mode pilote le fulfillment : SUR_PLACE /
-- A_EMPORTER / RETRAIT → ticket BAR ; LIVRAISON → livraison auto-créée.
-- customer_name = prénom SAISI sur la page (figé — le ticket ne relit pas le CRM,
-- un client déjà nommé qui tape un autre prénom obtient bien le prénom saisi).
-- client_request_id = idempotence du POST public (double tap / retry / 2 onglets
-- renvoient le même ordre et le même lien).
alter table pending_cafe_orders add column if not exists service_mode text;
alter table pending_cafe_orders add column if not exists delivery_address text;
alter table pending_cafe_orders add column if not exists customer_name text;
alter table pending_cafe_orders add column if not exists client_request_id text;
create unique index if not exists idx_cafe_orders_client_request
  on pending_cafe_orders (client_request_id) where client_request_id is not null;

-- REFUND_NEEDED with no successful client/reception notify (crash mid-markRefund).
-- Sweep re-notifies rows where this is null.
alter table pending_bookings
  add column if not exists refund_notified_at timestamptz;

-- ONE-SHOT backfill (13/07 incident): the column shipped NULL for every
-- historical REFUND_NEEDED. The 60s sweep then re-WhatsApp'd the "place prise /
-- remboursement 24h" template to clients (Syndel, Linsey, …) who already got
-- it (or whose case was closed). Treat anything already REFUND_NEEDED before
-- the feature as "already notified" so the sweep only retries true mid-flight
-- crashes going forward.
update pending_bookings
  set refund_notified_at = coalesce(updated_at, created_at)
  where status in ('REFUND_NEEDED', 'REFUNDED')
    and refund_notified_at is null
    and created_at < '2026-07-13T18:00:00Z';

-- Waitlist for full class slots: the client explicitly asked to be pinged if
-- a spot frees up. The 5-min sweep re-checks availability; a freed spot sends
-- ONE WhatsApp nudge (claim WAITING→NOTIFIED before sending, one-shot). No
-- booking is ever created from here — the client answers and the normal
-- payment-first flow applies (first come, first served).
-- Statuts : WAITING → NOTIFIED | NOTIFY_FAILED | CANCELLED | EXPIRED.
create table if not exists waitlist_entries (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients(id),
  service_id text not null,
  service_name text not null,
  event_id text not null,
  slot_start timestamptz not null,
  status text not null default 'WAITING',
  created_at timestamptz not null default now(),
  notified_at timestamptz
);

create index if not exists idx_waitlist_status_start
  on waitlist_entries (status, slot_start);
create unique index if not exists idx_waitlist_one_waiting
  on waitlist_entries (client_id, event_id) where status = 'WAITING';

-- Native Wix waitlist mirror. Awa's local row remains the durable fallback
-- because Wix's waitlist API is Developer Preview. When present, these ids
-- make the client visible in Wix's session Waitlist tab and let us remove the
-- pending Wix booking when Awa notifies, expires or removes the entry.
alter table waitlist_entries add column if not exists wix_registration_id text;
alter table waitlist_entries add column if not exists wix_waitlist_booking_id text;
alter table waitlist_entries add column if not exists wix_left_at timestamptz;
alter table waitlist_entries add column if not exists wix_sync_error text;
alter table waitlist_entries add column if not exists wix_sync_attempted_at timestamptz;
create unique index if not exists idx_waitlist_wix_registration
  on waitlist_entries (wix_registration_id) where wix_registration_id is not null;
create index if not exists idx_waitlist_wix_cleanup
  on waitlist_entries (status, wix_left_at)
  where wix_registration_id is not null and wix_left_at is null;

create table if not exists slot_cache (
  client_id uuid not null references clients(id),
  event_id text not null,
  service_id text not null,
  slot_json jsonb not null,
  choice_key text,
  cached_at timestamptz not null default now(),
  primary key (client_id, event_id)
);

-- Clé courte et déterministe d'un event_id (sha256 tronqué) : les ids de
-- lignes WhatsApp interactives sont limités à 200 caractères alors que les
-- event_ids Wix peuvent dépasser 300 — la clé courte sert d'alias cliquable.
alter table slot_cache
  add column if not exists choice_key text;

-- Liaison d'un numéro WhatsApp à une fiche Wix existante (client migré dont
-- la fiche porte un autre numéro — cas Dieynaba/Rokhaya). Self-service par
-- code envoyé à l'email de la fiche, repli réception en 1 clic (/admin/crm).
-- Le code n'est JAMAIS stocké en clair (sha256(code:id)) ni renvoyé au modèle.
-- Statuts : AWAITING_EMAIL → AWAITING_CODE → VERIFIED (self-service)
--           AWAITING_* → NEEDS_RECEPTION → LINKED | DISMISSED (admin)
create table if not exists link_requests (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients(id),
  claimed_email text,
  claimed_name text,
  wix_contact_id text,
  code_hash text,
  code_expires_at timestamptz,
  attempts int not null default 0,
  emails_sent int not null default 0,
  status text not null default 'AWAITING_EMAIL',
  detail text,
  linked_contact_id text,
  linked_by text,
  reception_notified_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Name the client gave for a NEW account (create-account linking path). On an
-- existing DB the table above already exists, so this ALTER is what adds it.
alter table link_requests
  add column if not exists claimed_name text;

create index if not exists idx_link_requests_status
  on link_requests (status, created_at);
create unique index if not exists idx_link_requests_one_open
  on link_requests (client_id)
  where status in ('AWAITING_EMAIL','AWAITING_CODE','NEEDS_RECEPTION');

-- Engagement multi-séances : un client qui veut payer N séances à la carte
-- (une par lien). Persiste le plan À TRAVERS les paiements, ce que la
-- conversation seule ne fait pas (échec « Amy Ndiaye » : 3/5 payées, silence).
-- Le SERVEUR fait avancer la progression sur la transition BOOKED partagée ;
-- jamais la formulation d'Awa. Périmètre v1 : séances Wave/OM/Max It payées à
-- l'unité — les réservations sur abonnement (book_with_membership) en sont
-- exclues (pas d'interruption de paiement, donc pas de mode d'échec Amy).
create table if not exists multi_session_commitments (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients(id),
  service_id text not null,
  service_name text not null,
  requested_count integer not null,
  status text not null default 'ACTIVE'
    check (status in ('ACTIVE','COMPLETED','ABANDONED','EXPIRED')),
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
-- Au plus un engagement ACTIF par client (même motif que link_requests).
create unique index if not exists idx_ms_commitments_one_active
  on multi_session_commitments (client_id)
  where status = 'ACTIVE';

-- Une ligne PAR séance de l'engagement. Porte l'INTENTION (créneau agréé,
-- résolu en event_id Wix + date via slot_cache). L'état paiement/réservation
-- n'est PAS dupliqué ici : il se dérive des tentatives dans pending_bookings
-- (FK inversée commitment_item_id ci-dessous), donc zéro dérive possible.
create table if not exists multi_session_commitment_items (
  id uuid primary key default gen_random_uuid(),
  commitment_id uuid not null references multi_session_commitments(id),
  position integer not null,
  event_id text not null,
  slot_start timestamptz not null,
  intent_status text not null default 'PLANNED'
    check (intent_status in ('PLANNED','NEEDS_RESELECTION','CANCELLED')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists idx_ms_commitment_items_position
  on multi_session_commitment_items (commitment_id, position);
create index if not exists idx_ms_commitment_items_commitment
  on multi_session_commitment_items (commitment_id);

-- FK inversée : chaque tentative de paiement d'une séance pointe vers son item.
-- Plusieurs tentatives historiques par item (1er lien expiré → 2e lien payé)
-- sans perdre l'audit trail. NULL pour les bookings hors engagement (standalone).
alter table pending_bookings
  add column if not exists commitment_item_id uuid;
-- Invariant serveur : au plus UNE tentative « bloquante » par item — refuse une
-- nouvelle tentative tant qu'une existe en DRAFT/AWAITING_PAYMENT/PAID/BOOKED/
-- REFUND_NEEDED. Les tentatives EXPIRED/REFUNDED/CANCELLED (terminales non
-- bloquantes) laissent l'item re-tentable.
create unique index if not exists idx_pending_bookings_one_active_per_item
  on pending_bookings (commitment_item_id)
  where commitment_item_id is not null
    and status in ('DRAFT','AWAITING_PAYMENT','PAID','BOOKED','REFUND_NEEDED');
create index if not exists idx_pending_bookings_commitment_item
  on pending_bookings (commitment_item_id)
  where commitment_item_id is not null;

-- Groupes de doublons marqués « traités » depuis /admin/crm (typiquement des
-- fiches 100 % comptes membres que Wix refuse de fusionner — réglés à la main
-- dans Wix ou assumés). Masqués de la page tant que leur composition ne change
-- pas : la signature est un hash des ids de fiches triés, donc une fiche
-- ajoutée/supprimée fait réapparaître le groupe.
create table if not exists crm_dismissed_duplicates (
  phone_key text not null,
  group_signature text not null,
  dismissed_by text,
  dismissed_at timestamptz not null default now(),
  primary key (phone_key, group_signature)
);
-- Migrate legacy last-9-digit keys to the shared canonical form (221 + 9). The
-- group signature is a hash of the contact-id set, independent of the key
-- format, so re-keying a Senegalese group preserves its dismissal exactly.
-- Foreign last-9 keys can't be reconstructed to full international; they are
-- left as dead keys that simply never match a current canonical group, so
-- those groups reappear in the audit — the deliberate, safe outcome.
do $$
begin
  if to_regclass('public.crm_dismissed_duplicates') is not null then
    update crm_dismissed_duplicates d
       set phone_key = '221' || d.phone_key
     where d.phone_key ~ '^7[0-9]{8}$'
       and not exists (
         select 1 from crm_dismissed_duplicates e
          where e.phone_key = '221' || d.phone_key
            and e.group_signature = d.group_signature
       );
  end if;
end $$;

-- Boucle de résultat (§4.31) : chaque conversation retombée au silence (>45
-- min) est classée par un appel LLM — le client a-t-il obtenu ce qu'il
-- voulait ? Les impasses/échecs alimentent la file « À reprendre » du
-- dashboard ; les dropoff (départ volontaire) ne servent qu'aux statistiques
-- (status DONE d'office). Une review par point de conversation (unique).
-- outcome : resolved | handed_off | dropoff | deadend | technical_failure
-- severity : normal | severe (frustration explicite, abonnée bloquée, plainte)
create table if not exists conversation_reviews (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients(id),
  last_message_at timestamptz not null,
  outcome text not null,
  need_category text not null,
  severity text not null default 'normal',
  summary text,
  suggested_action text,
  status text not null default 'OPEN',
  done_by text,
  done_at timestamptz,
  reception_notified_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists idx_conversation_reviews_status
  on conversation_reviews (status, outcome, created_at);
create unique index if not exists idx_conversation_reviews_point
  on conversation_reviews (client_id, last_message_at);
alter table conversation_reviews add column if not exists resolution_outcome text;
alter table conversation_reviews add column if not exists resolution_note text;

-- Petit registre clé/valeur applicatif (ex : date du dernier digest quotidien
-- envoyé — la garde vit en DB pour survivre aux restarts/redéploiements).
create table if not exists app_state (
  key text primary key,
  value text not null,
  updated_at timestamptz not null default now()
);

-- Durable audit trail for consequential admin actions. Details contain only
-- operational metadata (never passwords/tokens); target links let the owner
-- jump back to the affected record.
create table if not exists admin_audit_log (
  id bigserial primary key,
  admin_user text not null,
  admin_role text not null,
  action text not null,
  target_type text,
  target_id text,
  detail_json jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists idx_admin_audit_created
  on admin_audit_log (created_at desc);

-- Rappel de renouvellement envoyé (J-3 avant la fin d'un abonnement, via
-- template Meta approuvé). Clé = l'ordre Wix : un rappel par période de plan.
-- Un renouvellement crée un NOUVEL ordre Wix, donc un nouveau droit au rappel.
-- Même posture one-shot que expiry_nudged_at : on claime AVANT l'envoi.
create table if not exists renewal_nudges (
  wix_order_id text primary key,
  client_id uuid references clients(id),
  sent_at timestamptz not null default now(),
  kind text not null default 'RENEWAL',
  outcome text not null default 'SENT'
    check (outcome in ('SENT','SUPPRESSED','FAILED')),
  detail text
);
alter table renewal_nudges add column if not exists kind text not null default 'RENEWAL';
alter table renewal_nudges add column if not exists outcome text not null default 'SENT';
alter table renewal_nudges add column if not exists detail text;

-- Copie locale des champs édités depuis /admin/profile (profil WhatsApp
-- Business). Meta n'a pas de champ "horaires" natif : on le garde ici séparé
-- de la description pour que le formulaire reste éditable, et on le compose
-- dans la description envoyée à Meta (composeBusinessDescription). Ligne
-- unique (id=1) ; si vide, le formulaire se préremplit depuis Meta en direct.
create table if not exists whatsapp_profile (
  id smallint primary key default 1 check (id = 1),
  description text,
  address text,
  hours text,
  updated_by text,
  updated_at timestamptz not null default now()
);

-- Moteur de notifications staff (rappels automatiques éditables depuis
-- /admin/notifications). AUCUN nom de cours ni numéro en dur dans le code :
-- les règles et contacts sont saisis par le gérant. Tout est décidé côté
-- serveur (planning Wix + horloge), le modèle n'intervient jamais.

-- Répertoire staff : gardien, coachs, réception. Pour un coach, "name" DOIT
-- correspondre au nom de la ressource Wix (slot.coach) pour la résolution
-- automatique du destinataire. muted = jamais notifié (ex : Yass, toujours au
-- studio) — l'occurrence est quand même journalisée en 'suppressed'.
create table if not exists staff_contacts (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  phone text not null,
  role text not null default 'staff',
  muted boolean not null default false,
  created_at timestamptz not null default now()
);

-- Règles de notification. kind :
--   'class_reminder'  → X min avant chaque cours dont le nom contient
--                       class_pattern (vide = tous), au gardien (phone) ou au
--                       coach du cours (recipient_kind). suppress_gap_minutes :
--                       ne pas notifier si un cours du même motif s'est terminé
--                       <= N min avant (enchaînement dos à dos).
--   'fixed_schedule'  → chaque jour de days_of_week (CSV 0-6, 0=dimanche) à
--                       send_time (HH:MM, Dakar = UTC toute l'année).
create table if not exists notification_rules (
  id uuid primary key default gen_random_uuid(),
  label text not null,
  kind text not null,
  enabled boolean not null default true,
  -- Ciblage exact d'un service Wix (prioritaire sur les motifs de nom).
  -- Pas de FK : le catalogue vit dans Wix, pas dans Postgres.
  service_id text,
  class_pattern text,
  exclude_pattern text,
  lead_minutes int,
  suppress_gap_minutes int,
  recipient_kind text not null default 'phone',
  recipient_phone text,
  days_of_week text,
  send_time text,
  message_template text not null default '',
  -- class_reminder : ne cibler que les cours collectifs (type Wix CLASS/COURSE),
  -- pas les rendez-vous individuels (APPOINTMENT). Défaut false = tous.
  group_only boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table notification_rules
  add column if not exists group_only boolean not null default false;
alter table notification_rules
  add column if not exists exclude_pattern text;
alter table notification_rules
  add column if not exists service_id text;

-- Journal de tout envoi. source ∈ rule | reception | owner_alert | new_chat | technical |
-- delivery | invoice | gift_card | staff_planning | ops_ticket | test.
-- new_chat = ping owner (NEW_CHAT_NOTIFY_PHONE) uniquement — ne pas confondre
-- avec reception. owner_alert = copie OWNER_PHONE d'une alerte réception qui
-- demande une intervention humaine (domain/ownerAlertRules.ts).
-- dedup_key = clé de claim (unique partiel) : une occurrence n'est jamais
-- envoyée deux fois, même après redémarrage ou sweeps concurrents. status :
--   claimed → réservé, envoi pas encore confirmé (reclaimable après 2 min si
--             coincé : un envoi perdu pour « mettre les vélos à l'eau » est pire
--             qu'un doublon, contrairement aux relances marketing) ;
--   sent | sent_template | failed | suppressed.
create table if not exists notification_log (
  id bigserial primary key,
  rule_id uuid,
  source text not null,
  dedup_key text,
  recipient_phone text,
  body text,
  event_start timestamptz,
  event_end timestamptz,
  status text not null,
  error text,
  -- wamid Meta renvoyé a l'envoi : permet au webhook statuses de repasser une
  -- ligne sent vers failed quand Meta signale un echec en asynchrone (fenetre
  -- 24h fermee acceptee en 200 puis rejetee) — sinon l echec est invisible.
  wa_message_id text,
  created_at timestamptz not null default now()
);
alter table notification_log add column if not exists wa_message_id text;
create index if not exists idx_notification_log_wamid
  on notification_log (wa_message_id) where wa_message_id is not null;

create unique index if not exists idx_notification_log_dedup
  on notification_log (dedup_key) where dedup_key is not null;
create index if not exists idx_notification_log_created
  on notification_log (created_at desc);
-- Repli anti-doublon dos à dos : retrouver la fin des cours déjà notifiés d'une
-- règle quand le planning Wix ne renvoie plus la séance précédente (déjà commencée).
create index if not exists idx_notification_log_rule_event
  on notification_log (rule_id, event_start);

-- Commandes bar LIVRAISON : la réception saisit une commande passée au téléphone,
-- la cuisine est notifiée (WhatsApp + lien magique « ✅ prête »), un SLA déclenche
-- une alerte réception, et le client est prévenu quand la commande part. Le
-- client choisit Wave / OM / Max It / espèces via Awa ; aucun départ n'est
-- permis tant que le choix espèces ou un paiement mobile confirmé ne l'autorise.
-- Statuts : IN_KITCHEN → OUT_FOR_DELIVERY → DELIVERED ; les 2 états ouverts →
-- CANCELLED (IN_KITCHEN→DELIVERED reste permis si la réception clôt une commande
-- dont le départ n'a jamais été tapé — pas de ping route alors). L'étape READY a
-- été fusionnée dans le départ (07/2026) : prête = partie, un seul geste cuisine.
-- Les colonnes ready_*/client_notify_*/pickup_alerted_at subsistent en prod
-- (inutilisées). items_json = snapshot figé (shape ExtraLine) : prix résolus
-- côté serveur depuis le menu à la création, jamais rejoués après. Le token
-- du lien magique n'est JAMAIS stocké : seul son sha256 (ready_token_hash) l'est.
-- Le client reçoit 2 pings : confirmation (création) et en route (départ) —
-- chacun suivi en « pending → sent|sent_template|... » et réconcilié par le
-- sweep 60 s (un crash entre commit et envoi ne perd pas la notification).
create table if not exists delivery_orders (
  id uuid primary key default gen_random_uuid(),
  client_name text not null,
  client_phone text not null,            -- digits wa_id (normalisé à l'insert)
  address text not null,
  note text,
  items_json jsonb not null,
  amount_xof integer not null check (amount_xof > 0),
  status text not null default 'IN_KITCHEN'
    check (status in ('IN_KITCHEN','READY','DELIVERED','CANCELLED')),
  sla_minutes integer not null default 20 check (sla_minutes between 5 and 180),
  ready_token_hash text not null unique,
  created_by text,
  kitchen_notify_status text not null default 'pending',
  kitchen_notified_at timestamptz,       -- posé seulement si ≥1 vrai contact cuisine atteint
  kitchen_notify_attempts integer not null default 0,
  client_notify_status text not null default 'pending',
  client_notified_at timestamptz,
  client_notify_attempts integer not null default 0,
  alerted_at timestamptz,                -- alerte SLA one-shot (SET ... WHERE NULL)
  ready_at timestamptz,
  ready_by text,                         -- 'kitchen-link' | 'admin-<user>'
  delivered_at timestamptz,
  delivered_by text,
  cancelled_at timestamptz,
  cancelled_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_delivery_orders_status
  on delivery_orders (status, created_at);

-- v2 : OUT_FOR_DELIVERY + ping confirmation (création) + ping départ + SLA
-- enlèvement. created_notify_status ajouté default 'sent' PUIS default repassé à
-- 'pending' → les commandes déjà ouvertes au moment du déploiement ne reçoivent
-- pas de confirmation rétroactive ; les nouvelles lignes partent bien 'pending'.
alter table delivery_orders add column if not exists created_notify_status text not null default 'sent';
alter table delivery_orders alter column created_notify_status set default 'pending';
alter table delivery_orders add column if not exists created_notified_at timestamptz;
alter table delivery_orders add column if not exists created_notify_attempts integer not null default 0;
alter table delivery_orders add column if not exists created_notify_wamid text;
alter table delivery_orders add column if not exists route_notify_status text not null default 'pending';
alter table delivery_orders add column if not exists route_notified_at timestamptz;
alter table delivery_orders add column if not exists route_notify_attempts integer not null default 0;
alter table delivery_orders add column if not exists route_notify_wamid text;
alter table delivery_orders add column if not exists is_test boolean not null default false;
alter table delivery_orders add column if not exists wix_contact_id text;
-- Backward-compatible cutover: orders created under the former "cash at the
-- door" flow stay dispatchable. This block runs only when the column is first
-- introduced; new orders created afterwards retain PENDING_CHOICE.
do $$
begin
  if not exists (
    select 1 from information_schema.columns
     where table_schema='public' and table_name='delivery_orders' and column_name='payment_status'
  ) then
    alter table delivery_orders add column payment_status text not null default 'PENDING_CHOICE';
    update delivery_orders
       set payment_status=case
         when status='DELIVERED' then 'PAID'
         when status in ('IN_KITCHEN','OUT_FOR_DELIVERY','READY') then 'CASH_DUE'
         else 'PENDING_CHOICE'
       end;
  end if;
end $$;
alter table delivery_orders add column if not exists payment_method text;
alter table delivery_orders add column if not exists active_payment_attempt_id uuid;
alter table delivery_orders add column if not exists payment_ref text;
alter table delivery_orders add column if not exists paid_at timestamptz;
alter table delivery_orders add column if not exists payment_issue text;
update delivery_orders
   set payment_method=coalesce(payment_method,'cash')
 where payment_method is null and payment_status in ('CASH_DUE','PAID');
update delivery_orders
   set payment_ref=coalesce(payment_ref,'legacy-cash:' || id::text),
       paid_at=coalesce(paid_at,delivered_at,updated_at)
 where status='DELIVERED' and payment_status='PAID' and payment_method='cash';
alter table delivery_orders drop constraint if exists delivery_orders_payment_status_check;
alter table delivery_orders add constraint delivery_orders_payment_status_check
  check (payment_status in ('PENDING_CHOICE','AWAITING_PAYMENT','CASH_DUE','PAID','REFUND_NEEDED'));
alter table delivery_orders drop constraint if exists delivery_orders_payment_method_check;
alter table delivery_orders add constraint delivery_orders_payment_method_check
  check (payment_method is null or payment_method in ('wave','orange_money','maxit','cash'));
alter table delivery_orders add column if not exists out_for_delivery_at timestamptz;
alter table delivery_orders add column if not exists out_for_delivery_by text;   -- 'kitchen-link' | 'admin-<user>'
alter table delivery_orders add column if not exists pickup_alerted_at timestamptz; -- alerte enlèvement one-shot
update delivery_orders
   set status='OUT_FOR_DELIVERY',
       out_for_delivery_at=coalesce(out_for_delivery_at,ready_at,updated_at),
       out_for_delivery_by=coalesce(out_for_delivery_by,ready_by,'legacy-ready')
 where status='READY';
alter table delivery_orders drop constraint if exists delivery_orders_status_check;
alter table delivery_orders add constraint delivery_orders_status_check
  check (status in ('IN_KITCHEN','OUT_FOR_DELIVERY','DELIVERED','CANCELLED'));
create index if not exists idx_delivery_orders_created_wamid
  on delivery_orders (created_notify_wamid) where created_notify_wamid is not null;
create index if not exists idx_delivery_orders_route_wamid
  on delivery_orders (route_notify_wamid) where route_notify_wamid is not null;

-- Livraisons programmées. scheduled_for est l'heure d'ARRIVÉE promise au
-- client (timestamptz, saisie/affichage Africa/Dakar) ; kitchen_notify_at est
-- l'heure d'activation calculée depuis le délai cuisine choisi. Les anciennes
-- commandes et les livraisons « maintenant » gardent les deux colonnes NULL.
-- activated_at est la garde durable utilisée par toutes les mutations
-- opérationnelles : une commande future ne peut ni partir, ni être clôturée,
-- ni être renvoyée à la cuisine avant l'activation.
alter table delivery_orders add column if not exists scheduled_for timestamptz;
alter table delivery_orders add column if not exists kitchen_notify_at timestamptz;
alter table delivery_orders add column if not exists activated_at timestamptz;
update delivery_orders
   set activated_at=created_at
 where activated_at is null and scheduled_for is null;
alter table delivery_orders alter column activated_at set default now();

-- Rappel réception au moment de l'activation. Le default initial sent
-- empêche tout rappel rétroactif au déploiement ; les créations programmées
-- écrivent explicitement pending, y compris si leur activation est immédiate.
alter table delivery_orders add column if not exists activation_notify_status text not null default 'sent';
alter table delivery_orders add column if not exists activation_notified_at timestamptz;
alter table delivery_orders add column if not exists activation_notify_attempts integer not null default 0;
alter table delivery_orders add column if not exists activation_notify_wamid text;

-- Avertissement client après reprogrammation. Il n'est remis à pending que
-- lorsque l'heure d'arrivée change (un changement du seul délai cuisine reste
-- interne), et conserve donc le paiement déjà choisi/reçu.
alter table delivery_orders add column if not exists reschedule_notify_status text not null default 'sent';
alter table delivery_orders add column if not exists reschedule_notified_at timestamptz;
alter table delivery_orders add column if not exists reschedule_notify_attempts integer not null default 0;
alter table delivery_orders add column if not exists reschedule_notify_wamid text;

-- Contact opérationnel facultatif pour la remise. La cliente reste propriétaire
-- de la commande et destinataire du parcours Awa/paiement ; ce contact reçoit
-- uniquement l'alerte de départ et sert de numéro à appeler au livreur.
alter table delivery_orders add column if not exists recipient_name text;
alter table delivery_orders add column if not exists recipient_phone text;
alter table delivery_orders add column if not exists recipient_route_notify_status text not null default 'sent';
alter table delivery_orders add column if not exists recipient_route_notified_at timestamptz;
alter table delivery_orders add column if not exists recipient_route_notify_attempts integer not null default 0;
alter table delivery_orders add column if not exists recipient_route_notify_wamid text;
alter table delivery_orders drop constraint if exists delivery_orders_recipient_pair_check;
alter table delivery_orders add constraint delivery_orders_recipient_pair_check
  check (
    (recipient_name is null and recipient_phone is null)
    or
    (nullif(btrim(recipient_name), '') is not null
      and nullif(btrim(recipient_phone), '') is not null)
  );
create index if not exists idx_delivery_orders_recipient_route_wamid
  on delivery_orders (recipient_route_notify_wamid)
  where recipient_route_notify_wamid is not null;

alter table delivery_orders drop constraint if exists delivery_orders_schedule_pair_check;
alter table delivery_orders add constraint delivery_orders_schedule_pair_check
  check (
    (scheduled_for is null and kitchen_notify_at is null)
    or
    (scheduled_for is not null and kitchen_notify_at is not null
      and kitchen_notify_at <= scheduled_for)
  );
alter table delivery_orders drop constraint if exists delivery_orders_activation_guard_check;
alter table delivery_orders add constraint delivery_orders_activation_guard_check
  check (status not in ('OUT_FOR_DELIVERY','DELIVERED') or activated_at is not null);
create index if not exists idx_delivery_orders_scheduled_activation
  on delivery_orders (kitchen_notify_at)
  where status='IN_KITCHEN' and scheduled_for is not null and activated_at is null;
create index if not exists idx_delivery_orders_reschedule_wamid
  on delivery_orders (reschedule_notify_wamid) where reschedule_notify_wamid is not null;

-- Livraisons issues d'une commande WEB payée (/commander). Paiement HYBRIDE : les
-- ARTICLES sont payés en ligne (payment_status='PAID'), les FRAIS de livraison
-- restent dus en espèces au livreur (delivery_fee_status='CASH_DUE'). delivery_fee_xof
-- NULL = pas de montant fixe (le livreur applique le tarif du moment). source_cafe_order_id
-- UNIQUE rend la création idempotente : un rejeu de fulfillment (bail expiré) ne crée
-- jamais une 2ᵉ livraison. Colonnes NULL = livraison staff/WhatsApp historique (inchangée).
alter table delivery_orders add column if not exists source_cafe_order_id uuid;
alter table delivery_orders add column if not exists delivery_fee_xof integer;
alter table delivery_orders add column if not exists delivery_fee_status text;
alter table delivery_orders drop constraint if exists delivery_orders_delivery_fee_status_check;
alter table delivery_orders add constraint delivery_orders_delivery_fee_status_check
  check (delivery_fee_status is null or delivery_fee_status in ('CASH_DUE','PAID'));
create unique index if not exists idx_delivery_orders_source_cafe
  on delivery_orders (source_cafe_order_id) where source_cafe_order_id is not null;

-- Chaque lien mobile possède sa propre référence fournisseur. Cela permet de
-- reconnaître un ancien lien payé tardivement après un changement de moyen et
-- d'éviter de confondre ce paiement avec l'essai actuellement affiché par Awa.
create table if not exists delivery_payment_attempts (
  id uuid primary key default gen_random_uuid(),
  delivery_order_id uuid not null references delivery_orders(id),
  client_id uuid not null references clients(id),
  method text not null check (method in ('wave','orange_money','maxit')),
  amount_xof integer not null check (amount_xof > 0),
  status text not null default 'DRAFT'
    check (status in ('DRAFT','AWAITING_PAYMENT','EXPIRED','FAILED','PAID','REFUND_NEEDED')),
  session_id text,
  payment_link text,
  link_expires_at timestamptz,
  payer_phone text,
  paid_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_delivery_payment_attempts_order
  on delivery_payment_attempts (delivery_order_id, created_at desc);
create unique index if not exists idx_delivery_payment_attempts_active
  on delivery_payment_attempts (delivery_order_id)
  where status in ('DRAFT','AWAITING_PAYMENT');

-- Factures réception : un client demande une facture (aujourd'hui → handoff, la
-- réception n'avait aucun outil). Elle la crée ici, l'imprime (PDF navigateur) et
-- peut l'envoyer au client en image WhatsApp. IMMUABLE une fois émise (intégrité
-- comptable) : aucune route update/delete — une erreur = on émet une nouvelle
-- facture (trou de numérotation accepté). lines_json = snapshot figé, totaux
-- recalculés côté serveur à la création (jamais depuis le formulaire). Pas de TVA.
create table if not exists invoices (
  id uuid primary key default gen_random_uuid(),
  number text unique not null,          -- FAC-YYYY-NNNN (compteur atomique app_state)
  client_name text not null,
  client_phone text,                    -- digits wa_id ; null = envoi WhatsApp impossible
  client_ref text,                      -- société / « à l'attention de » sous le nom
  lines_json jsonb not null,            -- [{label, qty, unit_xof, total_xof}]
  total_xof integer not null check (total_xof > 0),
  note text,
  source_kind text,                     -- booking | plan | cafe | delivery | manual
  source_id uuid,
  payment_method text,
  payment_ref text,
  paid_at timestamptz,
  sent_at timestamptz,
  sent_status text,                     -- sent | failed | window_closed
  created_by text,
  created_at timestamptz not null default now()
);
create index if not exists idx_invoices_created on invoices (created_at desc);

-- Devis événements privés (privatisation studio, cours privés, etc.). Créés
-- depuis l'admin, modifiables et re-générables en PDF téléchargeable — pas un
-- document comptable figé comme la facture. Numéro DEV-YYYY-NNNN via compteur
-- atomique app_state. items_json = lignes de prestation ; amount_xof null =
-- « Inclus / 0 ». conditions = une puce par ligne. Total recalculé côté serveur
-- au rendu (jamais stocké seul, jamais pris du formulaire). Pas de TVA.
create table if not exists quotes (
  id uuid primary key default gen_random_uuid(),
  number text unique not null,           -- DEV-YYYY-NNNN
  client_name text not null,
  client_company text,                   -- société / structure du client
  client_role text,                      -- « Fondatrice », « Directrice »…
  client_phone text,
  event_title text not null,             -- « Événement privé "Pilates & Cookies" »
  description text,
  event_date date,
  event_time text,                       -- libre : « À partir de 11h (demi-journée) »
  participants text,                     -- libre : « 7 personnes »
  location text not null default 'Revive Ventures, Almadies',
  items_json jsonb not null,             -- [{label, detail, amount_xof|null}]
  conditions text not null,              -- une condition par ligne
  validity_days integer not null default 15,
  issued_on date not null default current_date,
  status text not null default 'DRAFT',  -- DRAFT | SENT | ACCEPTED | EXPIRED
  created_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_quotes_created on quotes (created_at desc);

-- Cartes cadeaux : visuel PNG généré par la réception (offre libre + POUR + DE)
-- sur le template de marque. Objet marketing, PAS comptable (pas de numéro) ;
-- l'activation du plan offert au destinataire reste un geste manuel dans Wix.
-- Immuable comme les factures : une erreur = on en refait une (pas d'update).
create table if not exists gift_cards (
  id uuid primary key default gen_random_uuid(),
  offer_line1 text not null,        -- « PACK DECOUVERTE »
  offer_line2 text,                 -- « 3 SEANCES REFORMER »
  recipient_name text not null,     -- POUR
  from_name text not null,          -- DE
  send_phone text,                  -- digits wa_id ; null = pas d'envoi WhatsApp
  sent_at timestamptz,
  sent_status text,                 -- sent | failed | window_closed
  created_by text,
  created_at timestamptz not null default now()
);
create index if not exists idx_gift_cards_created on gift_cards (created_at desc);

-- Menu du bar : source de vérité en DB (éditable via /admin/menu). Seedé au
-- premier boot depuis cafe-menu.md (table vide → import ; ensuite le fichier
-- n'est plus lu). Un id n'est JAMAIS réutilisé ni supprimé : retirer un article
-- = enabled=false (les commandes passées référencent l'id dans leurs snapshots
-- extras_json/items_json). Prix TOUJOURS résolus serveur (computeExtras).
create table if not exists cafe_menu_items (
  id text primary key,                       -- slug MAJUSCULES_UNDERSCORE, auto-généré, immuable
  name text not null,
  price_xof integer not null check (price_xof > 0),
  category text not null,
  description text,
  recipe_ingredients text,                  -- interne équipe, jamais envoyé à Awa / clients
  recipe_steps text,                        -- préparation interne, texte libre
  no_recipe_needed boolean not null default false, -- article sans fiche recette (ex. suppléments) ; exclu du compteur « À compléter »
  favourite boolean not null default false,  -- « incontournables » (liste WhatsApp post-résa, cap 10)
  enabled boolean not null default true,     -- false = retiré du menu (restaurable)
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table cafe_menu_items add column if not exists recipe_ingredients text;
alter table cafe_menu_items add column if not exists recipe_steps text;
-- Choix intégré à un article (ex. Brunch Mykonos : jus d'orange ou boisson
-- chaude). option_label = le libellé du choix (« Boisson »), option_choices =
-- les options séparées par « | » (« Jus d'orange | Boisson chaude »). Null =
-- article sans choix. À la saisie d'une commande le choix devient obligatoire.
alter table cafe_menu_items add column if not exists option_label text;
alter table cafe_menu_items add column if not exists option_choices text;
-- Plusieurs questions indépendantes par article, conservées dans l'ordre.
-- Les deux colonnes historiques ci-dessus restent le miroir du premier groupe
-- pour les anciens consommateurs et formulaires.
alter table cafe_menu_items add column if not exists option_groups jsonb not null default '[]'::jsonb;
-- Backfill one-shot des choix déjà documentés dans cafe-menu.md (guardé sur
-- null → ne réécrit pas un choix édité ensuite via /admin/menu).
update cafe_menu_items set option_label = 'Boisson',
       option_choices = 'Jus d''orange | Boisson chaude'
  where id = 'BRUNCH_MYKONOS' and option_label is null;
update cafe_menu_items set option_label = 'Lait',
       option_choices = 'Lait d''avoine | Lait de vache'
  where id in ('MATCHA_VANILLE','MATCHA_PISTACHE','MATCHA_MANGUE','MATCHA_MADD','MATCHA_CAFE')
    and option_label is null;
-- Article sans fiche recette (suppléments…) : badge neutre sur /admin/menu au
-- lieu de « à compléter ». Pas de backfill ici (booléen non null-guardable, un
-- UPDATE au boot re-flaguerait un article décoché) → one-off manuel en prod.
alter table cafe_menu_items add column if not exists no_recipe_needed boolean not null default false;

-- Photo commerciale facultative, optimisée à l'import. Les octets restent
-- séparés des requêtes menu ordinaires : celles-ci ne joignent que version.
-- La version change à chaque remplacement et rend l'URL publique immuable.
create table if not exists cafe_menu_item_photos (
  item_id text primary key references cafe_menu_items(id) on delete cascade,
  image_bytes bytea not null,
  mime_type text not null check (mime_type = 'image/webp'),
  width integer not null check (width > 0),
  height integer not null check (height > 0),
  source_bytes bytea,
  source_width integer check (source_width > 0),
  source_height integer check (source_height > 0),
  focal_x double precision not null default 0.5 check (focal_x between 0 and 1),
  focal_y double precision not null default 0.5 check (focal_y between 0 and 1),
  version text not null unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table cafe_menu_item_photos add column if not exists source_bytes bytea;
alter table cafe_menu_item_photos add column if not exists source_width integer;
alter table cafe_menu_item_photos add column if not exists source_height integer;
alter table cafe_menu_item_photos add column if not exists focal_x double precision not null default 0.5;
alter table cafe_menu_item_photos add column if not exists focal_y double precision not null default 0.5;

-- Liste CANONIQUE des catégories du bar (avant : catégorie = simple texte libre
-- sur chaque article → typos « SMOOTHIES »/« Smoothies »). La fiche article
-- choisit désormais dans cette liste (menu déroulant), gérée sur
-- /admin/menu/categories (ajout / renommage cascade / suppression si inutilisée).
-- Les articles gardent la catégorie en texte (pas de FK) ; renommer met à jour
-- les deux. Unicité insensible à la casse.
create table if not exists menu_categories (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  sort_order integer not null default 0,
  created_at timestamptz not null default now()
);
create unique index if not exists idx_menu_categories_name_ci on menu_categories (lower(name));
-- Seed idempotent depuis les catégories déjà utilisées par des articles :
-- sort_order = ordre d'apparition (min sort_order des articles de la catégorie).
-- Une catégorie supprimée (donc sans article) ne sera pas ré-ajoutée.
insert into menu_categories (name, sort_order)
  select category, min(sort_order) from cafe_menu_items group by category
  on conflict (lower(name)) do nothing;

-- ═══ Planning hebdo du personnel (accueil / bar / entretien) ═══
-- Un scénario = une ligne staff_schedules ; UN SEUL est 'published' à la fois
-- (invariant appliqué côté app par un UPDATE CASE unique — pas d'index unique
-- partiel : sa vérification par ligne peut échouer transitoirement pendant
-- l'UPDATE multi-lignes de publication).
-- weekday : 0=lundi … 6=dimanche (≠ notification_rules.days_of_week où
-- 0=dimanche) — la grille commence lundi comme la feuille du gérant.
-- Un seul créneau CONTINU par personne et par jour ; pas de ligne = repos.
-- Pause déjeuner 13h30–14h30 non payée : déduite au calcul (seulement si le
-- créneau dépasse 14h30), pas stockée.
create table if not exists staff_schedules (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  status text not null default 'draft',   -- draft | published
  created_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists staff_shifts (
  id uuid primary key default gen_random_uuid(),
  schedule_id uuid not null references staff_schedules(id) on delete cascade,
  staff_id uuid not null references staff_contacts(id) on delete cascade,
  weekday smallint not null check (weekday between 0 and 6),
  start_min smallint not null check (start_min >= 0),
  end_min smallint not null check (end_min <= 1440),
  check (start_min < end_min),
  unique (schedule_id, staff_id, weekday)
);
create index if not exists idx_staff_shifts_schedule on staff_shifts (schedule_id);

-- ═══ Planning hebdo des cours (bac à sable — jamais poussé vers Wix) ═══
-- Un scénario = une ligne class_plan_schedules ; UN SEUL 'published' à la fois
-- (même invariant app que staff_schedules : UPDATE CASE unique, pas d'index
-- partiel). weekday : 0=lundi … 6=dimanche, comme staff_shifts.
-- Coach et cours en TEXTE libre : les coachs ne sont pas forcément dans Wix
-- (nouvelles recrues) et c'est un bac à sable — rien n'est écrit dans Wix. Les
-- ids Wix (coach_wix_id, class_wix_id) sont un bonus informatif renseigné à
-- l'import du calendrier réel. Unicité (weekday, start_min, coach) appliquée
-- côté app (le texte libre rendrait une contrainte DB fragile).
create table if not exists class_plan_schedules (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  status text not null default 'draft' check (status in ('draft','published')),
  created_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists class_plan_slots (
  id uuid primary key default gen_random_uuid(),
  schedule_id uuid not null references class_plan_schedules(id) on delete cascade,
  weekday smallint not null check (weekday between 0 and 6),
  start_min smallint not null check (start_min between 0 and 1439),
  duration_min smallint not null default 50 check (duration_min between 15 and 240),
  coach_name text not null,
  class_name text not null,
  coach_wix_id text,
  class_wix_id text
);
create index if not exists idx_class_plan_slots_schedule on class_plan_slots (schedule_id);

-- ═══ États mensuels de paiement des coachs Reformer ═══
-- Les profils portent le tarif courant. Chaque état en prend une copie
-- complète : une modification ultérieure du profil ou de Wix ne change jamais
-- un PDF validé. is_current matérialise l'unique version active du couple
-- coach/mois ; les versions précédentes restent consultables.
create table if not exists coach_payment_profiles (
  id uuid primary key default gen_random_uuid(),
  slug text unique not null,
  display_name text not null,
  wix_resource_id text,
  email text,
  formula_type text not null check (formula_type in ('monthly_ratio','per_session')),
  base_amount_xof integer check (base_amount_xof is null or base_amount_xof >= 0),
  base_session_count integer check (base_session_count is null or base_session_count > 0),
  per_session_xof integer check (per_session_xof is null or per_session_xof >= 0),
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists coach_payment_statements (
  id uuid primary key default gen_random_uuid(),
  coach_profile_id uuid not null references coach_payment_profiles(id),
  month date not null check (month = date_trunc('month', month)::date),
  version integer not null check (version > 0),
  revises_statement_id uuid references coach_payment_statements(id),
  is_current boolean not null default true,
  status text not null default 'draft' check (status in ('draft','validated','paid')),
  coach_name_snapshot text not null,
  coach_email_snapshot text,
  wix_resource_id_snapshot text,
  tariff_json jsonb not null,
  sync_status text not null default 'pending' check (sync_status in ('pending','ok','failed','unlinked')),
  sync_error text,
  synced_at timestamptz,
  course_count integer not null default 0 check (course_count >= 0),
  base_total_xof integer not null default 0 check (base_total_xof >= 0),
  adjustment_total_xof integer not null default 0,
  total_xof integer not null default 0,
  validated_at timestamptz,
  validated_by text,
  paid_at timestamptz,
  paid_by text,
  created_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (coach_profile_id, month, version)
);
create unique index if not exists idx_coach_payment_one_current
  on coach_payment_statements (coach_profile_id, month) where is_current;
create index if not exists idx_coach_payment_statements_month
  on coach_payment_statements (month desc, coach_profile_id, version desc);

create table if not exists coach_payment_courses (
  id uuid primary key default gen_random_uuid(),
  statement_id uuid not null references coach_payment_statements(id) on delete cascade,
  source text not null check (source in ('wix','manual')),
  wix_event_id text,
  service_id text,
  service_name text not null,
  starts_at timestamptz not null,
  ends_at timestamptz,
  participant_count integer check (participant_count is null or participant_count >= 0),
  wix_status text,
  coach_resource_id text,
  coach_name text,
  included boolean not null default true,
  manual_decision boolean not null default false,
  manual_reason text,
  raw_snapshot jsonb,
  created_at timestamptz not null default now(),
  check (source <> 'manual' or (manual_reason is not null and length(trim(manual_reason)) > 0))
);
alter table coach_payment_courses
  add column if not exists participant_count integer
  check (participant_count is null or participant_count >= 0);
alter table coach_payment_courses add column if not exists wix_status text;
alter table coach_payment_courses
  add column if not exists manual_decision boolean not null default false;
create unique index if not exists idx_coach_payment_wix_event
  on coach_payment_courses (statement_id, wix_event_id)
  where source = 'wix' and wix_event_id is not null;
create index if not exists idx_coach_payment_courses_statement
  on coach_payment_courses (statement_id, starts_at);

create table if not exists coach_payment_adjustments (
  id uuid primary key default gen_random_uuid(),
  statement_id uuid not null references coach_payment_statements(id) on delete cascade,
  kind text not null check (kind in ('bonus','deduction')),
  amount_xof integer not null check (amount_xof > 0),
  reason text not null check (length(trim(reason)) > 0),
  created_at timestamptz not null default now()
);
create index if not exists idx_coach_payment_adjustments_statement
  on coach_payment_adjustments (statement_id, created_at);

create table if not exists coach_payment_send_log (
  id bigserial primary key,
  statement_id uuid not null references coach_payment_statements(id),
  recipient_email text not null,
  status text not null check (status in ('success','error')),
  error text,
  sent_by text,
  attempted_at timestamptz not null default now()
);
create index if not exists idx_coach_payment_send_log_statement
  on coach_payment_send_log (statement_id, attempted_at desc);

-- Jours fériés payés (studio ouvert) : chaque séance donnée ce jour-là
-- (calendrier de Dakar) est majorée de 50 %. Ne pilote que les brouillons ;
-- un état validé conserve les drapeaux et montants figés à la validation,
-- donc la suppression dure d'un jour férié ne touche jamais un état figé.
create table if not exists coach_payment_holidays (
  id uuid primary key default gen_random_uuid(),
  holiday_date date not null unique,
  label text not null check (length(trim(label)) > 0 and length(label) <= 100),
  created_by text,
  created_at timestamptz not null default now()
);
alter table coach_payment_statements
  add column if not exists holiday_course_count integer not null default 0
  check (holiday_course_count >= 0);
alter table coach_payment_statements
  add column if not exists holiday_bonus_xof integer not null default 0
  check (holiday_bonus_xof >= 0);
alter table coach_payment_courses
  add column if not exists holiday boolean not null default false;

-- Les deux rémunérations initiales demandées. ON CONFLICT préserve toute
-- modification faite ensuite dans l'écran Réglages.
insert into coach_payment_profiles
  (slug, display_name, formula_type, base_amount_xof, base_session_count, per_session_xof)
values
  ('yass', 'Yass', 'per_session', null, null, 9500),
  ('leslie', 'Leslie', 'per_session', null, null, 9000)
on conflict (slug) do nothing;

-- Migration ciblée de l'ancien tarif initial de Yass. La garde sur les trois
-- anciennes valeurs préserve toute configuration personnalisée ultérieure.
update coach_payment_profiles
set formula_type = 'per_session',
    base_amount_xof = null,
    base_session_count = null,
    per_session_xof = 9500,
    updated_at = now()
where slug = 'yass'
  and formula_type = 'monthly_ratio'
  and base_amount_xof = 800000
  and base_session_count = 84
  and per_session_xof is null;

-- Seed one-shot du planning actuel (feuille Word de Babakar, 07/2026). Sentinelle
-- app_state : ne tourne qu'UNE fois, ne ressuscite jamais des données supprimées.
-- phone='' volontaire (numéros à saisir dans /admin/notifications#contacts ;
-- l'envoi garde le garde-fou « numéro manquant »). migrate() = une seule query
-- multi-statements ⇒ transaction implicite : les inserts se voient entre eux.
insert into staff_contacts (name, phone, role)
select v.name, '', v.role
from (values
  ('Meryl','accueil'),('Linsey','accueil'),('Syndel','accueil'),
  ('Ama','bar'),('Jacqueline','bar'),
  ('Fatou','entretien'),('Arame','entretien')
) as v(name, role)
where not exists (select 1 from app_state where key = 'staff_planning_seed_done')
  and not exists (select 1 from staff_contacts c where lower(c.name) = lower(v.name));

insert into staff_schedules (name, status, created_by)
select 'Planning actuel', 'published', 'seed'
where not exists (select 1 from app_state where key = 'staff_planning_seed_done')
  and not exists (select 1 from staff_schedules);

-- weekday 0=Lun 1=Mar 2=Mer 3=Jeu 5=Sam ; Ven(4) & Dim(6) = repos (aucune ligne).
-- Minutes : 8h00=480 9h15=555 10h00=600 10h30=630 11h30=690 13h35=815 17h05=1025 18h00=1080 19h35=1175.
insert into staff_shifts (schedule_id, staff_id, weekday, start_min, end_min)
select s.id, c.id, v.weekday, v.start_min, v.end_min
from staff_schedules s
cross join (values
  ('Meryl',0,555,1175),('Meryl',1,555,1175),('Meryl',2,690,1175),('Meryl',3,555,1175),('Meryl',5,555,815),
  ('Linsey',0,555,1175),('Linsey',1,555,1175),('Linsey',2,690,1175),('Linsey',3,555,1175),('Linsey',5,555,815),
  ('Syndel',0,555,1175),('Syndel',1,555,1175),('Syndel',2,690,1175),('Syndel',3,555,1175),('Syndel',5,555,815),
  ('Ama',0,555,1080),('Ama',1,555,1080),('Ama',2,690,1080),('Ama',3,555,1080),('Ama',5,555,815),
  ('Jacqueline',0,600,1175),('Jacqueline',1,600,1175),('Jacqueline',2,690,1175),('Jacqueline',3,600,1175),('Jacqueline',5,555,815),
  ('Fatou',0,480,1025),('Fatou',1,480,1025),('Fatou',2,630,1025),('Fatou',3,480,1025),('Fatou',5,480,815),
  ('Arame',0,600,1175),('Arame',1,600,1175),('Arame',2,630,1175),('Arame',3,600,1175),('Arame',5,480,815)
) as v(name, weekday, start_min, end_min)
join staff_contacts c on lower(c.name) = lower(v.name)
where s.name = 'Planning actuel' and s.created_by = 'seed'
  and not exists (select 1 from app_state where key = 'staff_planning_seed_done')
  and not exists (select 1 from staff_shifts sh where sh.schedule_id = s.id);

insert into app_state (key, value) values ('staff_planning_seed_done', '1')
on conflict (key) do nothing;

-- Historical class-funnel backfill. One journey per old pending booking is
-- intentional: pre-link intent was not observable before this stream existed.
insert into booking_funnel_journeys
  (client_id, status, payment_method, is_excluded, backfill_key,
   started_at, last_event_at, closed_at, terminal_stage)
select b.client_id,
       case
         when b.status in ('BOOKED','CANCELLED') and b.wix_booking_id is not null then 'booked'
         when b.status in ('REFUND_NEEDED','REFUNDED') then 'failed'
         when greatest(b.created_at, b.updated_at) < now() - interval '24 hours' then 'inactive'
         else 'open'
       end,
       b.payment_method,
       c.is_test,
       'booking:' || b.id::text,
       b.created_at,
       greatest(b.created_at, b.updated_at),
       case
         when b.status in ('BOOKED','CANCELLED','REFUND_NEEDED','REFUNDED')
           or greatest(b.created_at, b.updated_at) < now() - interval '24 hours'
         then greatest(b.created_at, b.updated_at)
       end,
       case
         when b.status in ('BOOKED','CANCELLED') and b.wix_booking_id is not null then 'booked'
         when b.status in ('REFUND_NEEDED','REFUNDED') then 'technical_failure'
       end
  from pending_bookings b join clients c on c.id = b.client_id
 where (b.payment_link is not null or b.wix_booking_id is not null)
   and not exists (select 1 from booking_funnel_events e where e.booking_id=b.id)
on conflict (backfill_key) do nothing;

insert into booking_funnel_events
  (journey_id, client_id, booking_id, stage, payment_method, metadata_json,
   idempotency_key, is_excluded, occurred_at)
select j.id, b.client_id, b.id, 'payment_link_created', b.payment_method,
       jsonb_build_object('source','backfill','amount_xof',b.amount_xof,'participants',b.participants),
       'backfill:' || b.id::text || ':payment_link_created', c.is_test, b.created_at
  from pending_bookings b
  join clients c on c.id = b.client_id
  join booking_funnel_journeys j on j.backfill_key = 'booking:' || b.id::text
 where b.payment_link is not null
on conflict (idempotency_key) do nothing;

insert into booking_funnel_events
  (journey_id, client_id, booking_id, stage, payment_method, metadata_json,
   idempotency_key, is_excluded, occurred_at)
select j.id, b.client_id, b.id, 'expired', b.payment_method,
       jsonb_build_object('source','backfill'),
       'backfill:' || b.id::text || ':expired', c.is_test,
       least(coalesce(b.link_expires_at,b.updated_at), b.updated_at)
  from pending_bookings b
  join clients c on c.id = b.client_id
  join booking_funnel_journeys j on j.backfill_key = 'booking:' || b.id::text
 where b.status = 'EXPIRED'
on conflict (idempotency_key) do nothing;

insert into booking_funnel_events
  (journey_id, client_id, booking_id, stage, payment_method, metadata_json,
   idempotency_key, is_excluded, occurred_at)
select j.id, b.client_id, b.id, 'booked', b.payment_method,
       jsonb_build_object('source','backfill','participants',b.participants),
       'backfill:' || b.id::text || ':booked', c.is_test, b.updated_at
  from pending_bookings b
  join clients c on c.id = b.client_id
  join booking_funnel_journeys j on j.backfill_key = 'booking:' || b.id::text
 where b.status in ('BOOKED','CANCELLED') and b.wix_booking_id is not null
on conflict (idempotency_key) do nothing;

insert into booking_funnel_events
  (journey_id, client_id, booking_id, stage, payment_method, failure_code,
   metadata_json, idempotency_key, is_excluded, occurred_at)
select j.id, b.client_id, b.id, 'technical_failure', b.payment_method,
       'wix_booking_failed', jsonb_build_object('source','backfill','refund_required',true),
       'backfill:' || b.id::text || ':technical_failure', c.is_test, b.updated_at
  from pending_bookings b
  join clients c on c.id = b.client_id
  join booking_funnel_journeys j on j.backfill_key = 'booking:' || b.id::text
 where b.status in ('REFUND_NEEDED','REFUNDED')
on conflict (idempotency_key) do nothing;

-- ═══ Opérations temps réel : tickets cuisine + appareils PWA (Phase 1 iPad) ═══
-- Couche cuisine-facing UNIFIÉE (aujourd'hui alimentée par les livraisons ;
-- les commandes salle « TABLE » viendront en Phase 2). Un ticket = ce que la
-- cuisine voit et fait avancer NEW → PREPARING → READY → COMPLETED, sans jamais
-- décider du cycle client/paiement (ça reste sur delivery_orders). Le ticket
-- naît à l'ACTIVATION de la livraison (immédiate pour une commande « maintenant »,
-- différée pour une programmée) : la cuisine ne voit jamais une commande future.
create table if not exists kitchen_tickets (
  id uuid primary key default gen_random_uuid(),
  source text not null check (source in ('DELIVERY','TABLE','BAR')),
  -- Lien vers la commande source. Pour une livraison : delivery_order_id (unique
  -- → un seul ticket par commande, idempotence de la création/réconciliation).
  delivery_order_id uuid references delivery_orders(id) on delete cascade,
  -- Idempotence des créations issues d'un appareil (Phase 2 salle) : un rejeu de
  -- requête (double-tap, reconnexion) retourne le ticket existant.
  client_request_id text,
  -- Snapshot figé des articles (shape ExtraLine[] + note par ligne éventuelle) et
  -- note générale : le ticket reste lisible même si la commande change ensuite.
  items_json jsonb not null,
  note text,
  amount_xof integer not null check (amount_xof >= 0),
  -- Rendu figé pour la carte iPad, sans jointure : livraison → nom client / adresse ;
  -- salle (Phase 2) → code table / espace + prénom.
  heading text not null default '',
  subheading text,
  status text not null default 'NEW'
    check (status in ('NEW','PREPARING','READY','COMPLETED','CANCELLED')),
  -- Prise en charge côté cuisine (réassignable). Champs orthogonaux au statut.
  claimed_by text,
  claimed_at timestamptz,
  cancel_reason text,
  is_test boolean not null default false,
  -- Accusé d'affichage iPad : posé au premier ACK de l'appareil (sous ~15 s en
  -- régime normal). NULL passé fallback_due_at ⇒ « cuisine hors ligne ».
  ipad_ack_at timestamptz,
  -- Filet WhatsApp : échéance d'envoi du ticket cuisine legacy si pas d'ACK iPad.
  -- fallback_claimed_at = claim atomique (un seul envoi entre timer et sweep).
  fallback_due_at timestamptz,
  fallback_claimed_at timestamptz,
  ready_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
-- BAR tickets were added after the original DELIVERY/TABLE constraint. Reapply
-- the named constraint idempotently so existing databases accept the new source.
alter table kitchen_tickets drop constraint if exists kitchen_tickets_source_check;
alter table kitchen_tickets add constraint kitchen_tickets_source_check
  check (source in ('DELIVERY','TABLE','BAR'));
create unique index if not exists idx_kitchen_tickets_delivery
  on kitchen_tickets (delivery_order_id) where delivery_order_id is not null;
create unique index if not exists idx_kitchen_tickets_client_request
  on kitchen_tickets (client_request_id) where client_request_id is not null;
-- File cuisine : tickets ouverts triés par ancienneté (mélange TABLE/DELIVERY).
create index if not exists idx_kitchen_tickets_open
  on kitchen_tickets (created_at)
  where status in ('NEW','PREPARING','READY');
-- Sweep fallback : tickets non accusés dont l'échéance est due.
create index if not exists idx_kitchen_tickets_fallback_due
  on kitchen_tickets (fallback_due_at)
  where ipad_ack_at is null and fallback_claimed_at is null and fallback_due_at is not null;
-- Rattrapage : heading/subheading (rendu figé iPad) ont été ajoutés APRÈS la
-- première création de la table en prod ; create-table-if-not-exists ne les
-- pose donc pas sur une table préexistante → le sweep cuisine plantait chaque
-- minute (42703, colonne heading manquante). Ces alter idempotents rattrapent
-- l'écart. NE PAS retirer.
alter table kitchen_tickets add column if not exists heading text not null default '';
-- Future on-site orders are recorded immediately for the table/session subtotal,
-- but stay out of Cuisine until the 15-minute preparation window. Existing and
-- ordinary immediate tickets are backfilled/created as activated.
alter table kitchen_tickets add column if not exists scheduled_for timestamptz;
alter table kitchen_tickets add column if not exists activated_at timestamptz;
update kitchen_tickets
   set activated_at=created_at
 where activated_at is null and scheduled_for is null;
alter table kitchen_tickets alter column activated_at set default now();
create index if not exists idx_kitchen_tickets_table_activation
  on kitchen_tickets (scheduled_for)
  where source='TABLE' and status='NEW' and scheduled_for is not null and activated_at is null;
alter table kitchen_tickets add column if not exists subheading text;

-- Appareils appairés (iPad cuisine, téléphones accueil, propriétaire). Le token
-- de session n'est JAMAIS stocké en clair : seul son sha256. Révocation = poser
-- revoked_at (les sessions serveur sont donc réellement invalidables, contrairement
-- au cookie admin HMAC stateless). Le pairing se fait via un code court éphémère
-- (haché lui aussi) généré depuis l'admin.
create table if not exists ops_devices (
  id uuid primary key default gen_random_uuid(),
  label text not null,
  role text not null check (role in ('cuisine','accueil','owner')),
  -- Code de pairing : sha256 du code court affiché à l'admin, à usage unique et
  -- à durée limitée. Effacé (null) une fois l'appareil appairé.
  pair_code_hash text,
  pair_expires_at timestamptz,
  -- Session de l'appareil appairé : sha256 du token porté par le cookie device.
  session_token_hash text,
  paired_at timestamptz,
  revoked_at timestamptz,
  last_seen_at timestamptz,
  created_at timestamptz not null default now()
);
create unique index if not exists idx_ops_devices_session
  on ops_devices (session_token_hash) where session_token_hash is not null;
create unique index if not exists idx_ops_devices_paircode
  on ops_devices (pair_code_hash) where pair_code_hash is not null;

-- Journal d'événements temps réel : source de vérité pour le fan-out SSE ET le
-- rattrapage à la reconnexion (l'appareil renvoie le dernier id vu → on rejoue
-- les événements manquants). bigserial = curseur monotone simple pour Last-Event-ID.
create table if not exists ops_events (
  id bigserial primary key,
  channel text not null,            -- 'cuisine' (Phase 1) ; 'accueil' viendra
  kind text not null,               -- 'ticket_new' | 'ticket_update' | 'ticket_removed' | 'ping'
  payload_json jsonb not null,
  created_at timestamptz not null default now()
);
create index if not exists idx_ops_events_channel on ops_events (channel, id);

-- ═══ Phase 2 : commandes salle (service.revive.sn) ═══
-- Espaces de la salle : pas de tables numérotées, on repère un groupe par un
-- code court (C-24) et, optionnellement, un point sur un schéma versionné de
-- l'espace. La personne qui sert n'est pas forcément celle qui a pris la commande.
create table if not exists service_areas (
  id uuid primary key default gen_random_uuid(),
  -- Préfixe du code court (C = Canapé, T = Terrasse, P = Pergola). 1–2 lettres.
  code text not null,
  name text not null,
  -- Image du schéma de l'espace (Phase 2b) ; versionnée pour qu'un schéma retouché
  -- ne déplace jamais les repères des sessions déjà ouvertes.
  diagram_url text,
  diagram_version integer not null default 1,
  sort_order integer not null default 0,
  active boolean not null default true,
  created_at timestamptz not null default now()
);
create unique index if not exists idx_service_areas_code on service_areas (upper(code));
-- Seed idempotent des trois espaces (éditables ensuite en base).
insert into service_areas (code, name, sort_order) values
  ('C', 'Canapé', 1), ('T', 'Terrasse', 2), ('P', 'Pergola', 3)
  on conflict (upper(code)) do nothing;

-- Session de service = un groupe installé dans un espace. Porte le code court
-- (repère humain, unique PARMI LES SESSIONS OUVERTES → réutilisable après clôture),
-- la position optionnelle sur le schéma (x/y proportionnels ∈ [0,1]) et le prénom.
-- INVARIANT : aucun montant n'y fait foi — le POS reste la seule compta, les totaux
-- Resabot sont indicatifs. La clôture est refusée tant qu'un ticket cuisine reste
-- ouvert (voir serviceSessionRepo.closeSession).
create table if not exists service_sessions (
  id uuid primary key default gen_random_uuid(),
  area_id uuid not null references service_areas(id),
  short_code text not null,           -- 'C-24'
  seq integer not null,               -- numéro dans le code (petit, réutilisé après clôture)
  diagram_version integer,            -- figée à l'ouverture
  pos_x real, pos_y real,             -- proportionnel ∈ [0,1], nullable (repère optionnel)
  first_name text,
  opened_by text,                     -- label de l'appareil accueil
  status text not null default 'OPEN' check (status in ('OPEN','CLOSED')),
  opened_at timestamptz not null default now(),
  closed_at timestamptz,
  closed_by text
);
-- Code court unique UNIQUEMENT parmi les sessions ouvertes (libéré à la clôture).
create unique index if not exists idx_service_sessions_open_code
  on service_sessions (short_code) where status = 'OPEN';
create index if not exists idx_service_sessions_open
  on service_sessions (opened_at) where status = 'OPEN';

-- Emplacements FIXES de la salle (config physique existante) : chaque espace a
-- des places stables (« Canapé 1 », « T3 »…) posées une fois sur la carte de
-- l'espace (pos_x/pos_y proportionnels ∈ [0,1]). L'accueil touche l'emplacement
-- réel pour prendre la commande — pas de « créer une table ». Le label de
-- l'emplacement EST le code du ticket cuisine.
create table if not exists service_spots (
  id uuid primary key default gen_random_uuid(),
  area_id uuid not null references service_areas(id),
  label text not null,                -- 'Canapé', 'Terrasse' (aujourd'hui 1 place/espace)
  capacity integer,                   -- couverts habituels (affichage)
  capacity_max integer,               -- couverts max en ajoutant des chaises (nullable)
  pos_x real not null default 0.5,    -- position sur la carte de l'espace ∈ [0,1]
  pos_y real not null default 0.5,
  sort_order integer not null default 0,
  active boolean not null default true,
  created_at timestamptz not null default now()
);
-- ALTER additifs (create table if not exists n'ajoute PAS de colonne à une table
-- déjà créée par un boot antérieur) : capacités d'affichage.
alter table service_spots add column if not exists capacity integer;
alter table service_spots add column if not exists capacity_max integer;
create index if not exists idx_service_spots_area on service_spots (area_id, sort_order) where active;
-- Seed idempotent : UNE place par espace (config actuelle — un canapé, une table
-- terrasse extensible, la pergola). Ne ré-insère jamais si l'espace a déjà une place.
insert into service_spots (area_id, label, capacity, capacity_max, sort_order)
select a.id, a.name,
       case a.code when 'C' then 4 when 'T' then 6 when 'P' then 10 else 4 end,
       case a.code when 'T' then 8 else null end,
       a.sort_order
  from service_areas a
 where not exists (select 1 from service_spots s where s.area_id = a.id);

-- Une session occupe un emplacement fixe (spot_id). short_code = label de
-- l'emplacement (figé à l'ouverture) ; pos_x/pos_y recopiés du spot. Au plus UNE
-- session ouverte par emplacement (index partiel ci-dessous — garde anti-course).
alter table service_sessions add column if not exists spot_id uuid references service_spots(id);
create unique index if not exists idx_service_sessions_open_spot
  on service_sessions (spot_id) where status = 'OPEN' and spot_id is not null;

-- Abonnements Web Push par appareil accueil (alerte « commande prête » écran
-- verrouillé). Invalidés sur 410 Gone au moment de l'envoi.
create table if not exists push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  device_id uuid not null references ops_devices(id) on delete cascade,
  endpoint text not null,
  p256dh text not null,
  auth text not null,
  created_at timestamptz not null default now()
);
create unique index if not exists idx_push_subscriptions_endpoint on push_subscriptions (endpoint);

-- Extension de kitchen_tickets aux commandes salle (source 'TABLE') :
--  · session_id : la session de service d'origine (NULL pour une livraison) ;
--  · serve_by / serve_claimed_at : claim atomique « Je prends » par l'accueil au
--    moment de servir (orthogonal à claimed_by, qui reste « qui a préparé »).
alter table kitchen_tickets add column if not exists session_id uuid references service_sessions(id) on delete set null;
alter table kitchen_tickets add column if not exists serve_by text;
alter table kitchen_tickets add column if not exists serve_claimed_at timestamptz;
-- Escalade propriétaire : posé une fois quand un ticket salle PRÊT reste non pris
-- trop longtemps (claim atomique anti double-envoi).
alter table kitchen_tickets add column if not exists serve_escalated_at timestamptz;
-- « À emporter » : le client est assis à un espace (sur place) mais veut sa
-- commande dans un emballage à emporter — la cuisine doit le voir pour emballer.
-- Distinct d'une livraison (source DELIVERY). Défaut = sur place.
alter table kitchen_tickets add column if not exists takeaway boolean not null default false;
-- « Urgent » : l'accueil peut escalader une commande salle à tout moment (client
-- qui s'impatiente) → elle remonte en tête de l'écran cuisine. NULL = normal.
alter table kitchen_tickets add column if not exists urgent_at timestamptz;
create index if not exists idx_kitchen_tickets_session
  on kitchen_tickets (session_id) where session_id is not null;
-- Clés de la Maison. Wix remains the only ledger for Reformer/bonus session
-- balances; this registry stores only cross-order relationships and policies
-- Wix cannot represent (extension, invitation rights, guarantee, sync state).
create table if not exists key_registry (
  id uuid primary key default gen_random_uuid(),
  paid_order_id text unique not null,
  bonus_order_id text unique,
  client_id uuid references clients(id),
  wix_contact_id text,
  wix_member_id text,
  key_type text not null check (key_type in ('INVITEE','HABITUEE','RESIDENTE','AQUABIKE','SUR_MESURE')),
  plan_id text not null,
  -- Continuity family: one active/scheduled key per family per client. Reformer
  -- Clés + sur-mesure = 'REFORMER'; the Aquabike abonnement = 'AQUABIKE'.
  family text not null default 'REFORMER' check (family in ('REFORMER','AQUABIKE')),
  -- Nullable: the sur-mesure plan has no "cours en plus" (Mat/Step are covered
  -- by its own session pool), so it registers no bonus order.
  bonus_plan_id text,
  starts_at timestamptz not null,
  original_ends_at timestamptz not null,
  effective_ends_at timestamptz not null,
  status text not null default 'ACTIVE'
    check (status in ('SCHEDULED','ACTIVE','ENDED','REFUNDED','CANCELLED')),
  previous_key_id uuid references key_registry(id),
  extension_used_at timestamptz,
  guarantee_requested_at timestamptz,
  guarantee_status text
    check (guarantee_status is null or guarantee_status in ('PENDING','APPROVED','REFUSED')),
  guarantee_detail_json jsonb not null default '{}'::jsonb,
  bonus_status text not null default 'PENDING'
    check (bonus_status in ('PENDING','ACTIVE','FAILED','MANUAL_REQUIRED')),
  bonus_attempts integer not null default 0,
  bonus_next_retry_at timestamptz,
  bonus_claimed_at timestamptz,
  bonus_last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_key_registry_bonus_repair
  on key_registry (bonus_status, bonus_next_retry_at);
create index if not exists idx_key_registry_member
  on key_registry (wix_member_id, effective_ends_at desc);
alter table key_registry add column if not exists purchased_at timestamptz;
-- key_type / bonus_plan_id / family generalization for the Aquabike + sur-mesure
-- plans. Idempotent — safe to re-run against an existing prod table.
alter table key_registry drop constraint if exists key_registry_key_type_check;
alter table key_registry add constraint key_registry_key_type_check
  check (key_type in ('INVITEE','HABITUEE','RESIDENTE','AQUABIKE','SUR_MESURE'));
alter table key_registry alter column bonus_plan_id drop not null;
alter table key_registry add column if not exists family text not null default 'REFORMER';
alter table key_registry drop constraint if exists key_registry_family_check;
alter table key_registry add constraint key_registry_family_check
  check (family in ('REFORMER','AQUABIKE'));
-- One SCHEDULED key per (client, family): a next Aquabike and a next Clé may be
-- scheduled at once, but never two of the same family. Replaces the old global
-- one-scheduled-per-client index.
drop index if exists idx_key_registry_one_scheduled;
create unique index if not exists idx_key_registry_one_scheduled_family
  on key_registry (coalesce(client_id::text, wix_member_id), family)
  where status = 'SCHEDULED';
alter table key_registry add column if not exists continuity_source_kind text
  check (continuity_source_kind is null or continuity_source_kind in ('KEY','LEGACY_REFORMER'));
alter table key_registry add column if not exists continuity_source_order_id text;
alter table key_registry add column if not exists continuity_source_plan_id text;
alter table key_registry add column if not exists continuity_expires_at timestamptz;
alter table key_registry add column if not exists invitations_granted integer not null default 0;
alter table key_registry add column if not exists continuity_alerted_at timestamptz;

create table if not exists key_invitations (
  id uuid primary key default gen_random_uuid(),
  key_id uuid not null references key_registry(id),
  ordinal integer not null check (ordinal > 0),
  status text not null default 'GRANTED'
    check (status in ('GRANTED','ASSIGNED','USED','VOID')),
  friend_first_name text,
  friend_phone text,
  wix_invitation_order_id text unique,
  wix_booking_id text unique,
  assigned_at timestamptz,
  used_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (key_id, ordinal)
);
-- PENDING_REVIEW: invitation earned from a client's FIRST early Key renewal,
-- locked until she leaves a Google review (see google_review_gates). Invisible
-- to redemption (availableInvitationForKey filters GRANTED/ASSIGNED only).
alter table key_invitations drop constraint if exists key_invitations_status_check;
alter table key_invitations add constraint key_invitations_status_check
  check (status in ('GRANTED','PENDING_REVIEW','ASSIGNED','USED','VOID'));

-- One-time Google-review gate: the FIRST time a client renews a Key before
-- expiry, the invitation(s) she earns start PENDING_REVIEW and activate when
-- she sends a screenshot of her published review. One row per client for life
-- (PK) — subsequent early renewals grant unconditionally. Created at verified
-- payment time; key_id is linked later at provisioning (a SCHEDULED renewal's
-- Key row does not exist yet). Never applies to counter purchases (Wix webhook)
-- because the condition is only announced by Awa during her sale.
create table if not exists google_review_gates (
  client_id uuid primary key references clients(id),
  plan_order_id text not null,
  key_id uuid references key_registry(id),
  requested_at timestamptz not null default now(),
  ask_sent_at timestamptz,
  activated_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Once a bonus/invitation booking is confirmed, its right is consumed even if
-- somebody later cancels it directly in Wix. Awa therefore blocks cancellation
-- and rescheduling from this immutable policy marker; reception alone may
-- replace a class Revive cancelled.
create table if not exists key_benefit_bookings (
  wix_booking_id text primary key,
  local_booking_id uuid references pending_bookings(id),
  key_id uuid not null references key_registry(id),
  invitation_id uuid references key_invitations(id),
  kind text not null check (kind in ('BONUS','INVITATION')),
  created_at timestamptz not null default now()
);
create unique index if not exists idx_key_benefit_local_booking
  on key_benefit_bookings (local_booking_id) where local_booking_id is not null;

-- Usage events only (never a balance): links each normal Reformer booking to
-- the exact paid Key order selected in Benefit Programs. Required for the
-- L'Invitée guarantee and visit choreography.
create table if not exists key_reformer_bookings (
  wix_booking_id text primary key,
  local_booking_id uuid references pending_bookings(id),
  key_id uuid not null references key_registry(id),
  slot_start timestamptz not null,
  created_at timestamptz not null default now()
);
create unique index if not exists idx_key_reformer_local_booking
  on key_reformer_bookings (local_booking_id) where local_booking_id is not null;

create table if not exists key_nudges (
  dedup_key text primary key,
  key_id uuid references key_registry(id),
  client_id uuid references clients(id),
  kind text not null,
  outcome text not null check (outcome in ('SENT','SUPPRESSED','FAILED')),
  detail text,
  created_at timestamptz not null default now()
);

-- Wix remains the source of truth for attendance. This local projection keeps
-- the admin leaderboard fast and retains the last successful snapshot during
-- a temporary Wix outage.
create table if not exists wix_attendance_records (
  attendance_id text primary key,
  booking_id text not null,
  wix_contact_id text,
  client_name text,
  client_phone text,
  client_phone_key text,
  service_id text,
  service_name text,
  event_id text,
  session_start timestamptz,
  status text not null,
  number_of_attendees integer not null default 1,
  synced_at timestamptz not null default now()
);
create index if not exists idx_wix_attendance_rank
  on wix_attendance_records (status, session_start desc);
create index if not exists idx_wix_attendance_contact
  on wix_attendance_records (wix_contact_id);
create index if not exists idx_wix_attendance_phone
  on wix_attendance_records (client_phone_key);

-- General Wix booking mirror (renamed from wix_confirmed_booking_records,
-- which only held CONFIRMED rows for the leaderboard). It now mirrors EVERY
-- status so reception-made bookings surface in the admin; the attendance
-- leaderboard keeps filtering to confirmed rows. A cancellation becomes a
-- status update, never a delete; invalidated_at tombstones a row only after a
-- complete, non-truncated full scan proves it is really gone from Wix.
do $$
begin
  if to_regclass('public.wix_confirmed_booking_records') is not null
     and to_regclass('public.wix_booking_records') is null then
    alter table wix_confirmed_booking_records rename to wix_booking_records;
    alter index if exists idx_wix_confirmed_booking_rank rename to idx_wix_booking_rank;
    alter index if exists idx_wix_confirmed_booking_contact rename to idx_wix_booking_contact;
    alter index if exists idx_wix_confirmed_booking_phone rename to idx_wix_booking_phone;
  end if;
end $$;

create table if not exists wix_booking_records (
  booking_id text primary key,
  wix_contact_id text,
  client_name text,
  client_phone text,
  client_phone_key text,
  service_id text,
  service_name text,
  session_start timestamptz,
  synced_at timestamptz not null default now()
);
-- Enrichment for the unified admin (idempotent — also fills a table that was
-- renamed in from the confirmed-only shape).
alter table wix_booking_records add column if not exists status text;
alter table wix_booking_records add column if not exists payment_status text;
alter table wix_booking_records add column if not exists number_of_participants integer;
alter table wix_booking_records add column if not exists created_date timestamptz;
alter table wix_booking_records add column if not exists updated_date timestamptz;
alter table wix_booking_records add column if not exists wix_order_id text;
alter table wix_booking_records add column if not exists plan_order_id text;
alter table wix_booking_records add column if not exists membership_plan_name text;
alter table wix_booking_records add column if not exists benefit_transaction_id text;
alter table wix_booking_records add column if not exists matched_client_id uuid references clients(id);
alter table wix_booking_records add column if not exists match_basis text;
alter table wix_booking_records drop constraint if exists wix_booking_records_match_basis_check;
alter table wix_booking_records add constraint wix_booking_records_match_basis_check
  check (match_basis is null or match_basis in ('awa_booking','contact_id','phone'));
alter table wix_booking_records add column if not exists last_seen_at timestamptz;
alter table wix_booking_records add column if not exists invalidated_at timestamptz;
alter table wix_booking_records add column if not exists raw jsonb;

create index if not exists idx_wix_booking_rank
  on wix_booking_records (session_start desc);
create index if not exists idx_wix_booking_contact
  on wix_booking_records (wix_contact_id);
create index if not exists idx_wix_booking_phone
  on wix_booking_records (client_phone_key);
create index if not exists idx_wix_booking_status
  on wix_booking_records (status, session_start desc);
create index if not exists idx_wix_booking_matched_client
  on wix_booking_records (matched_client_id) where matched_client_id is not null;
create index if not exists idx_wix_booking_order
  on wix_booking_records (wix_order_id) where wix_order_id is not null;

-- General mirror of Wix Pricing Plans orders (subscriptions/Keys bought
-- directly in Wix, no Awa involvement). Keyed by order id; updated_date guards
-- upserts against a stale webhook overwriting a fresher sync.
create table if not exists wix_plan_order_records (
  order_id text primary key,
  plan_id text,
  plan_name text,
  member_id text,
  wix_contact_id text,
  buyer_name text,
  buyer_phone text,
  buyer_phone_key text,
  amount_xof integer,
  currency text,
  payment_status text,
  order_status text,
  start_date timestamptz,
  end_date timestamptz,
  created_date timestamptz,
  updated_date timestamptz,
  wix_pay_order_id text,
  matched_client_id uuid references clients(id),
  match_basis text,
  last_seen_at timestamptz,
  invalidated_at timestamptz,
  raw jsonb,
  synced_at timestamptz not null default now()
);
alter table wix_plan_order_records drop constraint if exists wix_plan_order_records_match_basis_check;
alter table wix_plan_order_records add constraint wix_plan_order_records_match_basis_check
  check (match_basis is null or match_basis in ('awa_order','contact_id','phone'));
create index if not exists idx_wix_plan_order_created
  on wix_plan_order_records (created_date desc);
create index if not exists idx_wix_plan_order_contact
  on wix_plan_order_records (wix_contact_id);
create index if not exists idx_wix_plan_order_matched_client
  on wix_plan_order_records (matched_client_id) where matched_client_id is not null;
create index if not exists idx_wix_plan_order_pay_order
  on wix_plan_order_records (wix_pay_order_id) where wix_pay_order_id is not null;

create table if not exists wix_attendance_sync_state (
  singleton boolean primary key default true check (singleton),
  last_started_at timestamptz,
  last_succeeded_at timestamptz,
  last_error text,
  record_count integer not null default 0
);
insert into wix_attendance_sync_state (singleton)
  values (true)
  on conflict (singleton) do nothing;
-- Watermark + backfill state for the general bookings/plan-orders sync.
alter table wix_attendance_sync_state add column if not exists last_incremental_at timestamptz;
alter table wix_attendance_sync_state add column if not exists last_incremental_error text;
alter table wix_attendance_sync_state add column if not exists last_updated_date_seen timestamptz;
alter table wix_attendance_sync_state add column if not exists last_full_reconciled_at timestamptz;
alter table wix_attendance_sync_state add column if not exists last_truncated_at timestamptz;
alter table wix_attendance_sync_state add column if not exists booking_record_count integer not null default 0;
alter table wix_attendance_sync_state add column if not exists plan_order_count integer not null default 0;
alter table wix_attendance_sync_state add column if not exists backfill_started_at timestamptz;
alter table wix_attendance_sync_state add column if not exists backfill_completed_at timestamptz;

-- Unified accounting ledger. Awa rows remain projections of their source
-- tables; only Wix transactions and genuinely manual movements are persisted.
create table if not exists manual_payment_movements (
  id uuid primary key default gen_random_uuid(),
  movement_type text not null check (movement_type in ('payment','refund')),
  occurred_at timestamptz not null,
  amount_xof integer not null,
  method text not null check (method in ('wave','orange_money','maxit','cash','card','other')),
  label text not null,
  provider_reference text,
  source_kind text,
  source_id text,
  client_name text,
  client_phone text,
  note text not null,
  reverses_movement_id uuid references manual_payment_movements(id),
  created_by text not null,
  idempotency_key uuid not null unique,
  created_at timestamptz not null default now(),
  check ((movement_type='payment' and amount_xof > 0) or
         (movement_type='refund' and amount_xof < 0))
);
create unique index if not exists idx_manual_payment_provider_ref
  on manual_payment_movements (method, provider_reference)
  where provider_reference is not null;
create index if not exists idx_manual_payment_occurred
  on manual_payment_movements (occurred_at desc);

create table if not exists wix_payment_movements (
  id uuid primary key default gen_random_uuid(),
  wix_order_id text not null,
  source text not null check (source in ('ecom','plan')),
  movement_type text not null check (movement_type in ('payment','refund')),
  wix_entry_id text not null,
  provider_status text not null,
  occurred_at timestamptz not null,
  amount_xof integer not null,
  currency text not null,
  buyer_name text,
  buyer_phone text,
  label text not null,
  provider_method text,
  raw_method text,
  offline boolean not null default false,
  raw jsonb not null,
  synced_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  invalidated_at timestamptz,
  unique (wix_order_id, movement_type, wix_entry_id),
  check ((movement_type='payment' and amount_xof >= 0) or
         (movement_type='refund' and amount_xof <= 0))
);
create index if not exists idx_wix_payment_occurred
  on wix_payment_movements (occurred_at desc, wix_order_id);

-- Some Wix WEB orders carry only buyerInfo.contactId; their billing name and
-- phone stay blank even though the CRM contact is complete. These columns make
-- the Contacts enrichment durable and trigger one full historical catch-up
-- after this migration (existing rows start with a null sync timestamp).
alter table wix_payment_movements add column if not exists buyer_contact_id text;
alter table wix_payment_movements add column if not exists buyer_identity_synced_at timestamptz;
-- Canonical phone key of the buyer, for unified client matching in the admin.
-- Backfilled from buyer_phone by the payment sync's next full pass.
alter table wix_payment_movements add column if not exists buyer_phone_key text;
create index if not exists idx_wix_payment_buyer_phone_key
  on wix_payment_movements (buyer_phone_key) where buyer_phone_key is not null;

-- Wix Bookings ids this order paid for, read from the order's line-item
-- catalogReference.catalogItemId (the Bookings app id identifies a class line).
-- The order carries this reference; the booking mirror does not, so this is the
-- only reliable booking↔payment link. booking_ids_synced_at is a convergent
-- sentinel (null = not yet parsed → triggers a full pass; a non-null timestamp
-- with an empty array = parsed, no class line → stops re-triggering), same
-- pattern as buyer_identity_synced_at.
alter table wix_payment_movements add column if not exists wix_booking_ids text[];
alter table wix_payment_movements add column if not exists booking_ids_synced_at timestamptz;
create index if not exists idx_wix_payment_booking_ids
  on wix_payment_movements using gin (wix_booking_ids);

create table if not exists wix_payment_sync_diagnostics (
  fingerprint text primary key,
  kind text not null,
  wix_order_id text,
  payload jsonb not null,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  occurrences integer not null default 1
);

create table if not exists payment_method_tag_events (
  id bigserial primary key,
  target_kind text not null check (target_kind='wix'),
  target_id uuid not null references wix_payment_movements(id),
  method text not null check (method in ('wave','orange_money','maxit','cash','card','other','exclu')),
  note text,
  tagged_by text not null,
  created_at timestamptz not null default now()
);
create index if not exists idx_payment_method_tag_current
  on payment_method_tag_events (target_kind, target_id, created_at desc, id desc);

create table if not exists wix_payment_sync_state (
  singleton boolean primary key default true check (singleton),
  last_started_at timestamptz,
  last_succeeded_at timestamptz,
  last_updated_date_seen timestamptz,
  last_full_reconciled_at timestamptz,
  last_error text,
  record_count integer not null default 0
);
insert into wix_payment_sync_state (singleton) values (true)
  on conflict (singleton) do nothing;

-- Only an actual funnel payment confirmation is authoritative enough to
-- backfill paid_at. updated_at stays null here and is labelled estimated at
-- read time instead of being smuggled into this column.
update pending_bookings b
   set paid_at = (
     select min(e.occurred_at) from booking_funnel_events e
      where e.booking_id=b.id and e.stage='payment_confirmed' and not e.is_excluded
   )
 where b.paid_at is null and exists (
   select 1 from booking_funnel_events e
    where e.booking_id=b.id and e.stage='payment_confirmed' and not e.is_excluded
 );

-- Fermetures studio (jours fériés, Maggal, travaux…). Éditables via /admin/closures
-- sans redéploiement (précédent cafe_menu_items). Wix garde les créneaux ces
-- jours-là ; le serveur les filtre à partir d'ici. Demi-journée possible via
-- l'intervalle [starts_at, ends_at). Soft-disable (enabled=false), jamais de
-- suppression destructive.
create table if not exists studio_closures (
  id uuid primary key default gen_random_uuid(),
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  reason text not null,                       -- ex. « Maggal de Touba » (montré au client)
  note text,                                  -- interne, jamais envoyé au client
  enabled boolean not null default true,
  created_by text,
  updated_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint studio_closures_range check (ends_at > starts_at)
);
create index if not exists idx_studio_closures_window on studio_closures (starts_at, ends_at) where enabled;

-- Base de connaissances FAQ, alimentée depuis la résolution d'un handoff (évite
-- 3 handoffs pour la même question). Seules les entrées published+enabled sont
-- injectées au prompt, comme des données factuelles délimitées (jamais des
-- instructions). Éditable via /admin/faq.
create table if not exists faq_entries (
  id uuid primary key default gen_random_uuid(),
  question text not null,
  answer text not null,
  status text not null default 'draft' check (status in ('draft','published')),
  enabled boolean not null default true,
  source_handoff uuid references handoffs(id),
  created_by text,
  updated_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_faq_published on faq_entries (status, enabled);

-- Journal des relances PROACTIVES sortantes (lead pub silencieux). Distinct des
-- nudges lien-expiré, qui vivent sur pending_bookings /
-- pending_plan_orders.expiry_nudged_at — ce journal n'est PAS rétroactif.
--
-- Envoi MANUEL : la réception relit les leads silencieux dans /admin/relances et
-- décide, un par un, d'envoyer la relance ou d'ignorer le lead. dedup_key rend
-- l'action one-shot par client (une relance OU un skip, jamais les deux).
--   arm     = 'MANUAL' (déclenché à la main). 'TREATMENT'/'HOLDOUT' réservés à
--             une éventuelle campagne randomisée future.
--   outcome = CLAIMED (réservé le temps de l'envoi) → SENT | FAILED, ou
--             SUPPRESSED pour un skip. Un SENT rejeté par Meta en asynchrone
--             repasse FAILED (taux de livraison honnête).
create table if not exists outbound_nudges (
  dedup_key text primary key,        -- 'LEAD_SILENT:<client_id>'
  client_id uuid not null references clients(id),
  campaign_key text,
  kind text not null,                -- 'LEAD_SILENT'
  arm text not null check (arm in ('TREATMENT','HOLDOUT','MANUAL')),
  outcome text not null check (outcome in ('CLAIMED','SENT','FAILED','SUPPRESSED')),
  detail text,
  wa_message_id text,
  assigned_at timestamptz not null default now(),
  sent_at timestamptz
);
-- La table a pu être créée avant l'ajout de 'MANUAL' (relance A auto initiale).
alter table outbound_nudges drop constraint if exists outbound_nudges_arm_check;
alter table outbound_nudges add constraint outbound_nudges_arm_check
  check (arm in ('TREATMENT','HOLDOUT','MANUAL'));
-- Résolution rapide d'un statut Meta 'failed' async → la ligne à repasser FAILED.
create index if not exists idx_outbound_nudges_wamid
  on outbound_nudges (wa_message_id) where wa_message_id is not null;
create index if not exists idx_outbound_nudges_kind_assigned
  on outbound_nudges (kind, assigned_at);

-- Durable, daily read-only projection of Meta Ads Insights.
create table if not exists ad_insights_daily (
  day date not null,
  ad_id text not null,
  ad_name text,
  adset_id text,
  adset_name text,
  campaign_id text not null,
  campaign_name text,
  spend numeric(12,2) not null default 0,
  impressions integer not null default 0,
  clicks integer not null default 0,
  link_clicks integer not null default 0,
  results integer not null default 0,
  account_currency text,
  synced_at timestamptz not null default now(),
  primary key (day, ad_id)
);
create index if not exists idx_ad_insights_day on ad_insights_daily (day);
create index if not exists idx_ad_insights_campaign
  on ad_insights_daily (campaign_id, day);

create table if not exists ad_insights_sync_state (
  id smallint primary key default 1 check (id = 1),
  last_started_at timestamptz,
  last_succeeded_at timestamptz,
  last_error text,
  record_count integer not null default 0,
  account_timezone text,
  account_currency text,
  account_status integer,
  updated_at timestamptz not null default now()
);
insert into ad_insights_sync_state (id) values (1) on conflict (id) do nothing;

-- Rebonds d'emails transactionnels remontés par le webhook Brevo (boîte
-- pleine, adresse invalide, blocage). Consulté avant tout renvoi d'un code de
-- vérification vers la même adresse : renvoyer vers une boîte morte faisait
-- boucler « je n'ai pas reçu » sans issue (cas réel kaeva18@, 05-07/08).
create table if not exists email_bounces (
  id uuid primary key default gen_random_uuid(),
  email text not null,
  event text not null,
  reason text,
  message_id text,
  occurred_at timestamptz not null default now()
);
create index if not exists idx_email_bounces_email
  on email_bounces (email, occurred_at desc);

-- Une seule alerte WhatsApp proactive « ton code a rebondi » par demande de
-- vérification (claim atomique, même motif que reception_notified_at).
alter table link_requests
  add column if not exists bounce_notified_at timestamptz;
`;
