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

create index if not exists idx_pending_bookings_client_status
  on pending_bookings (client_id, status);
create index if not exists idx_pending_bookings_status_expiry
  on pending_bookings (status, link_expires_at);

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

-- Petit registre clé/valeur applicatif (ex : date du dernier digest quotidien
-- envoyé — la garde vit en DB pour survivre aux restarts/redéploiements).
create table if not exists app_state (
  key text primary key,
  value text not null,
  updated_at timestamptz not null default now()
);

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

-- Journal de tout envoi (règle, réception, test). dedup_key = clé de claim
-- (unique partiel) : une occurrence n'est jamais envoyée deux fois, même après
-- redémarrage ou sweeps concurrents. status :
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
  created_at timestamptz not null default now()
);

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
`;
