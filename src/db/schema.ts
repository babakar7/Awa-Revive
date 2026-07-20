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

-- Benefit Programs transaction of a membership redemption — needed to
-- re-credit the plan session if the booking is later cancelled.
alter table pending_bookings
  add column if not exists benefit_transaction_id text;

-- Bar order bundled into the booking payment. extras_json is the
-- server-resolved snapshot (names + unit prices frozen at order time);
-- amount_xof stays the GRAND total (class + extras).
alter table pending_bookings
  add column if not exists extras_json jsonb;
alter table pending_bookings
  add column if not exists extras_amount_xof integer not null default 0;
alter table pending_bookings
  add column if not exists order_note text;

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

-- Date de démarrage voulue du plan (renouvellement anticipé chaîné à la fin de
-- l'abonnement actuel). NULL = démarrage immédiat. Passée à Wix comme startDate
-- à l'activation (ordre PENDING jusqu'à cette date, activé automatiquement).
alter table pending_plan_orders
  add column if not exists starts_at timestamptz;

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

-- Plan/cafe fulfillment lease (same idea as pending_bookings.fulfilling_at):
-- a crash between markPaid and activation/notify left rows in PAID forever
-- with no sweep. Lease + stuck reconcile recovers them.
alter table pending_plan_orders
  add column if not exists fulfilling_at timestamptz;
-- Set when reception is notified for manual activation (no member / offline
-- failed) so retries don't spam. Auto path uses wix_order_id instead.
alter table pending_plan_orders
  add column if not exists reception_notified_at timestamptz;

alter table pending_cafe_orders
  add column if not exists fulfilling_at timestamptz;
-- Set when reception + client confirmations for a paid bar order are done
-- (or attempted). PAID + fulfilled_at IS NULL = stuck, reclaimable.
alter table pending_cafe_orders
  add column if not exists fulfilled_at timestamptz;

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
  sent_at timestamptz not null default now()
);

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

-- Journal de tout envoi. source ∈ rule | reception | new_chat | delivery |
-- invoice | gift_card | staff_planning | test. new_chat = ping owner
-- (NEW_CHAT_NOTIFY_PHONE) uniquement — ne pas confondre avec reception.
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
-- une alerte réception, et le client est prévenu quand c'est prêt. Paiement HORS
-- système (encaissé à la livraison) — on ne mémorise que le montant dû.
-- Statuts : IN_KITCHEN → READY → DELIVERED ; IN_KITCHEN|READY → CANCELLED.
-- items_json = snapshot figé (shape ExtraLine) : prix résolus côté serveur depuis
-- cafe-menu.md à la création, jamais rejoués après. Le token du lien magique n'est
-- JAMAIS stocké : seul son sha256 (ready_token_hash) l'est. Les envois cuisine/
-- client sont suivis en « pending → sent|sent_template|... » et réconciliés par le
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
  favourite boolean not null default false,  -- « incontournables » (liste WhatsApp post-résa, cap 10)
  enabled boolean not null default true,     -- false = retiré du menu (restaurable)
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table cafe_menu_items add column if not exists recipe_ingredients text;
alter table cafe_menu_items add column if not exists recipe_steps text;

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
  coach_resource_id text,
  coach_name text,
  included boolean not null default true,
  manual_reason text,
  raw_snapshot jsonb,
  created_at timestamptz not null default now(),
  check (source <> 'manual' or (manual_reason is not null and length(trim(manual_reason)) > 0))
);
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

-- Les deux rémunérations initiales demandées. ON CONFLICT préserve toute
-- modification faite ensuite dans l'écran Réglages.
insert into coach_payment_profiles
  (slug, display_name, formula_type, base_amount_xof, base_session_count, per_session_xof)
values
  ('yass', 'Yass', 'monthly_ratio', 800000, 84, null),
  ('leslie', 'Leslie', 'per_session', null, null, 9000)
on conflict (slug) do nothing;

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
`;
