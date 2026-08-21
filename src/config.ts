import "dotenv/config";

function required(name: string): string {
  const v = process.env[name];
  if (!v || v.trim() === "") {
    missing.push(name);
    return "";
  }
  return v.trim();
}

function optional(name: string, fallback: string): string {
  const v = process.env[name];
  return v && v.trim() !== "" ? v.trim() : fallback;
}

const missing: string[] = [];

export const config = {
  // Meta / WhatsApp Cloud API
  WA_PHONE_NUMBER_ID: required("WA_PHONE_NUMBER_ID"),
  WA_ACCESS_TOKEN: required("WA_ACCESS_TOKEN"),
  WA_APP_SECRET: required("WA_APP_SECRET"),
  WA_VERIFY_TOKEN: required("WA_VERIFY_TOKEN"),
  // Read-only Meta Ads reporting. Optional so ads configuration can never
  // prevent the WhatsApp service from booting.
  META_ADS_TOKEN: optional("META_ADS_TOKEN", ""),
  META_AD_ACCOUNT_ID: optional("META_AD_ACCOUNT_ID", ""),
  META_GRAPH_VERSION: optional("META_GRAPH_VERSION", "v25.0"),
  // Comma-separated `campaign_id:campaign_key` pairs. The ads domain parses
  // this fail-closed and disables only the Meta projection when malformed.
  AD_CAMPAIGN_MAP: optional("AD_CAMPAIGN_MAP", ""),
  // Approved Utility template used to notify reception when the 24h window is
  // closed (free-form text then fails with error 131047). Empty = no fallback.
  // Must have exactly 2 body variables: {{1}} subject, {{2}} flattened detail.
  WA_RECEPTION_TEMPLATE: optional("WA_RECEPTION_TEMPLATE", ""),
  WA_RECEPTION_TEMPLATE_LANG: optional("WA_RECEPTION_TEMPLATE_LANG", "fr"),
  // Approved CLIENT-facing template for the pre-expiry renewal nudge (sent
  // outside the 24h window, so a free-text send would fail with 131047). Empty
  // = the renewal push is disabled (the in-conversation offer still works).
  // 3 body variables: {{1}} first name, {{2}} plan name, {{3}} end date.
  WA_RENEWAL_TEMPLATE: optional("WA_RENEWAL_TEMPLATE", ""),
  WA_RENEWAL_TEMPLATE_LANG: optional("WA_RENEWAL_TEMPLATE_LANG", "fr"),
  // Days before a plan's end date to send the renewal nudge.
  RENEWAL_NUDGE_DAYS: parseInt(optional("RENEWAL_NUDGE_DAYS", "3"), 10),
  // Approved CLIENT-facing Utility template when a waitlisted spot frees up
  // OUTSIDE the 24h free-text window (Meta 131047). Empty = free-text only
  // (NOTIFY_FAILED outside the window). 2 body variables: {{1}} class name,
  // {{2}} date/time. Free text is tried first; template only on 131047.
  // Language code must match Meta exactly (en, en_US, fr, …).
  WA_WAITLIST_TEMPLATE: optional("WA_WAITLIST_TEMPLATE", ""),
  WA_WAITLIST_TEMPLATE_LANG: optional("WA_WAITLIST_TEMPLATE_LANG", "en"),
  // Meta App ID — only needed for the resumable upload flow used to change
  // the WhatsApp Business profile photo. Empty = photo edit disabled in
  // /admin/profile; description/address/hours still work.
  WA_APP_ID: optional("WA_APP_ID", ""),
  // Approved KITCHEN ticket template with a dynamic URL button (departure link).
  // Kitchen staff are ~always outside the 24h window, so this is sent template-
  // FIRST (free-text fallback only if unset/unapproved). 5 body variables:
  // {{1}} client name, {{2}} phone, {{3}} address, {{4}} items one-line,
  // {{5}} total FCFA; the URL button's own {{1}} = the magic-link token. FR body
  // under the `en` language code (same convention as the others).
  WA_KITCHEN_TICKET_TEMPLATE: optional("WA_KITCHEN_TICKET_TEMPLATE", ""),
  WA_KITCHEN_TICKET_TEMPLATE_LANG: optional("WA_KITCHEN_TICKET_TEMPLATE_LANG", "en"),
  // Generic CLIENT-facing "order update" template, used as the 131047 fallback
  // for BOTH the creation-confirmation and the "out for delivery" pings (one
  // template instead of two Meta approvals). 2 body variables: {{1}} first name,
  // {{2}} update text. Empty = those pings degrade gracefully outside the 24h
  // window. FR body under the `en` language code (same convention as the others).
  WA_DELIVERY_UPDATE_TEMPLATE: optional("WA_DELIVERY_UPDATE_TEMPLATE", ""),
  WA_DELIVERY_UPDATE_TEMPLATE_LANG: optional("WA_DELIVERY_UPDATE_TEMPLATE_LANG", "en"),
  // Minutes after a delivery order is created before reception gets a "late"
  // alert if it hasn't departed (snapshotted per order at creation, so orders
  // in flight keep their SLA).
  DELIVERY_SLA_MINUTES: parseInt(optional("DELIVERY_SLA_MINUTES", "20"), 10),
  // Frais de livraison des commandes WEB (/commander) : réglés EN ESPÈCES au
  // livreur à l'arrivée, jamais encaissés en ligne. 0/vide = pas de montant fixe
  // affiché (« frais réglés en espèces au livreur », le livreur applique le tarif
  // du moment) ; >0 = montant fixe affiché au client avant paiement et porté sur
  // la commande (« frais : X F à remettre au livreur »).
  DELIVERY_FEE_XOF: parseInt(optional("DELIVERY_FEE_XOF", "0"), 10),
  // Heure limite (minutes depuis minuit, Dakar) au-delà de laquelle le mode
  // Livraison de /commander est refusé (la cuisine ferme les livraisons). 1080 = 18h.
  DELIVERY_ORDER_CUTOFF_MIN: parseInt(optional("DELIVERY_ORDER_CUTOFF_MIN", "1080"), 10),
  // Base URL publique de la page de commande client (/commander) — sert à
  // construire les URLs de retour de paiement. Distincte de BASE_URL (callbacks Awa).
  COMMANDER_PUBLIC_BASE_URL: optional("COMMANDER_PUBLIC_BASE_URL", "https://menu.revive.sn"),

  // ── Opérations temps réel (PWA cuisine, Phase 1) ──
  // Hôtes des interfaces PWA (dispatch host-aware, cf. menu.revive.sn). L'iPad
  // cuisine et, plus tard, les téléphones accueil vivent sur ces sous-domaines,
  // tous pointant sur ce même service Railway.
  CUISINE_HOST: optional("CUISINE_HOST", "cuisine.revive.sn"),
  SERVICE_HOST: optional("SERVICE_HOST", "service.revive.sn"),
  OWNER_HOST: optional("OWNER_HOST", "owner.revive.sn"),
  // Deux modes du canal WhatsApp interne cuisine :
  //  - parallel (pilote) : le ticket WhatsApp part SYSTÉMATIQUEMENT, en plus de
  //    l'iPad, pour comparer les deux canaux.
  //  - fallback (après pilote) : le WhatsApp ne part QUE si l'iPad n'a pas accusé
  //    réception du ticket avant OPS_KITCHEN_FALLBACK_SECONDS.
  INTERNAL_NOTIFY_MODE: optional("INTERNAL_NOTIFY_MODE", "parallel"),
  // Délai de grâce (s) avant l'envoi du WhatsApp de secours en mode fallback :
  // le compteur démarre à la création du ticket (= activation de la livraison).
  OPS_KITCHEN_FALLBACK_SECONDS: parseInt(optional("OPS_KITCHEN_FALLBACK_SECONDS", "15"), 10),
  // DEV UNIQUEMENT : auto-appaire un écran cuisine « Aperçu (dev) » à la première
  // visite, sans code — pour tester le kiosque sans iPad. NE JAMAIS activer en
  // prod (rendrait le kiosque accessible sans appairage). Vide/0 = désactivé.
  OPS_DEV_AUTOPAIR: optional("OPS_DEV_AUTOPAIR", "") === "1" || optional("OPS_DEV_AUTOPAIR", "") === "true",
  // Web Push (VAPID) pour l'alerte « commande prête » écran verrouillé des
  // téléphones accueil. Les trois vides = push désactivé (la PWA marche quand même,
  // sans notification en arrière-plan). La clé publique est exposée au client ;
  // la privée signe les envois. Générer une paire : `web-push.generateVAPIDKeys()`.
  VAPID_PUBLIC_KEY: optional("VAPID_PUBLIC_KEY", ""),
  VAPID_PRIVATE_KEY: optional("VAPID_PRIVATE_KEY", ""),
  VAPID_SUBJECT: optional("VAPID_SUBJECT", "mailto:support@revive.sn"),
  // Secondes qu'un ticket salle PRÊT peut rester non pris avant d'escalader vers
  // le propriétaire (WhatsApp). L'accueil est prévenu par push/écran d'abord.
  OPS_SERVE_ESCALATE_SECONDS: parseInt(optional("OPS_SERVE_ESCALATE_SECONDS", "90"), 10),
  // Minutes avant qu'un ticket cuisine TABLE/BAR encore ouvert soit auto-clôturé
  // (marqué prêt + terminé) : passé ce délai il a en réalité été servi ou oublié —
  // le tableau ne doit jamais accumuler de cartes rassies. 0 = désactivé.
  OPS_TICKET_AUTOCLOSE_MINUTES: parseInt(optional("OPS_TICKET_AUTOCLOSE_MINUTES", "120"), 10),

  // Préavis minimum (minutes) avant le début d'un cours en-deçà duquel l'annulation
  // automatique des cours vides n'est plus tentée — le coach est déjà en route/au
  // studio (décision Babakar 17/08/2026 : 120 min ; cf. AUTO-CANCEL-EMPTY-CLASSES-PLAN.md §1).
  AUTO_CANCEL_MIN_NOTICE_MINUTES: parseInt(
    optional("AUTO_CANCEL_MIN_NOTICE_MINUTES", "120"),
    10,
  ),

  // Wix
  WIX_API_KEY: required("WIX_API_KEY"),
  WIX_SITE_ID: required("WIX_SITE_ID"),
  // Earliest date covered by the accounting ledger and Wix backfill.
  PAYMENTS_LEDGER_START_DATE: optional("PAYMENTS_LEDGER_START_DATE", "2026-07-01"),
  // Coach payroll attendance exclusion (chantier coach-attendance). Default OFF =
  // alert-only: courses with no reservation or all-no-show are computed and shown
  // but still counted/paid, so the owner can validate the rule on a real month
  // before it reduces any amount. Flip to "true" to actually drop those courses
  // from pay. Cancelled courses are excluded regardless of this flag (unchanged).
  COACH_PAYMENT_ATTENDANCE_ENFORCE:
    optional("COACH_PAYMENT_ATTENDANCE_ENFORCE", "false") === "true",

  // Wave
  WAVE_API_KEY: required("WAVE_API_KEY"),
  WAVE_WEBHOOK_SECRET: required("WAVE_WEBHOOK_SECRET"),
  // Request-signing secret (wave_sn_AKS_...). If the Wave account has request
  // signing enforced, outbound API calls must carry a Wave-Signature header.
  WAVE_SIGNING_SECRET: optional("WAVE_SIGNING_SECRET", ""),

  // Orange Money / Max It (Sonatel). All three must be set to enable the rails;
  // empty = Wave-only (today's behaviour). Merchant code is 6 digits.
  OM_CLIENT_ID: optional("OM_CLIENT_ID", ""),
  OM_CLIENT_SECRET: optional("OM_CLIENT_SECRET", ""),
  OM_MERCHANT_CODE: optional("OM_MERCHANT_CODE", ""),
  OM_API_BASE: optional("OM_API_BASE", "https://api.orange-sonatel.com"),

  // Anthropic (the SDK also reads ANTHROPIC_API_KEY itself)
  ANTHROPIC_API_KEY: required("ANTHROPIC_API_KEY"),
  CLAUDE_MODEL: optional("CLAUDE_MODEL", "claude-sonnet-5"),

  // Voice-note transcription via OpenAI (optional — without the key, voice
  // notes get the polite "text only" reply, as before).
  OPENAI_API_KEY: optional("OPENAI_API_KEY", ""),
  TRANSCRIPTION_MODEL: optional("TRANSCRIPTION_MODEL", "gpt-4o-mini-transcribe"),

  // Email notifications to reception (optional — logged as warnings when unset).
  // Brevo HTTP API: Railway blocks outbound SMTP, so plain SMTP times out there.
  // The sender must be verified in the Brevo dashboard (Senders & Domains).
  BREVO_API_KEY: optional("BREVO_API_KEY", ""),
  // Secret du webhook Brevo (rebonds d'emails) : /webhooks/brevo?token=…
  // Vide → endpoint inerte. Voir src/webhooks/brevo.ts.
  BREVO_WEBHOOK_TOKEN: optional("BREVO_WEBHOOK_TOKEN", ""),
  EMAIL_FROM: optional("EMAIL_FROM", "Awa - Revive <support@revive.sn>"),
  RECEPTION_EMAIL: optional("RECEPTION_EMAIL", "support@revive.sn"),

  // Admin dashboard accounts. Format: "user1:password1,user2:password2".
  // Unset → built-in fallback login revive/revive@5000 (see admin/auth.ts) — the
  // dashboard is never served without a login.
  ADMIN_USERS: optional("ADMIN_USERS", ""),

  // Separate owner account: one login grants the whole dashboard, including
  // coach compensation. OWNER_PAYMENTS_PASSWORD remains a temporary fallback
  // so existing deployments migrate without losing owner access.
  OWNER_ADMIN_USER: optional("OWNER_ADMIN_USER", "owner"),
  OWNER_ADMIN_PASSWORD: optional(
    "OWNER_ADMIN_PASSWORD",
    optional("OWNER_PAYMENTS_PASSWORD", ""),
  ),
  // Deprecated compatibility alias; prefer OWNER_ADMIN_PASSWORD.
  OWNER_PAYMENTS_PASSWORD: optional("OWNER_PAYMENTS_PASSWORD", ""),

  // App
  DATABASE_URL: required("DATABASE_URL"),
  BASE_URL: required("BASE_URL"),
  RECEPTION_PHONE: optional("RECEPTION_PHONE", "+221784644329"),
  // Babakar's own WhatsApp. Used when a delivery kitchen ticket has no bar
  // contact ON SHIFT (published staff planning): the warning goes to reception
  // AND here, so the owner sees stranded orders. Template-first send (this
  // number ~never messages Awa, its 24h window is closed).
  OWNER_PHONE: optional("OWNER_PHONE", "+221774982711"),
  // Copie propriétaire de TOUTE alerte qui demande une intervention humaine
  // (remboursement, activation manuelle, handoff, conversation plantée…).
  // Classement dans domain/ownerAlertRules.ts ; envoi template-first vers
  // OWNER_PHONE. "false" coupe la copie sans toucher aux alertes réception.
  OWNER_ALERT_ENABLED: optional("OWNER_ALERT_ENABLED", "true") === "true",
  // Template Utility dédié aux alertes propriétaire. Vide ⇒ on réutilise le
  // template réception (2 variables : titre, corps), déjà approuvé par Meta —
  // c'est ce qui garantit la livraison hors fenêtre 24 h.
  WA_OWNER_ALERT_TEMPLATE: optional(
    "WA_OWNER_ALERT_TEMPLATE",
    optional("WA_RECEPTION_TEMPLATE", ""),
  ),
  WA_OWNER_ALERT_TEMPLATE_LANG: optional(
    "WA_OWNER_ALERT_TEMPLATE_LANG",
    optional("WA_RECEPTION_TEMPLATE_LANG", "fr"),
  ),
  // WhatsApp number to ping whenever someone STARTS a conversation with Awa
  // (a new lead, or a returning client after a quiet gap). Empty = disabled.
  // Free-text lands only inside the 24h window; outside it we fall back to the
  // reception Utility template (WA_RECEPTION_TEMPLATE) so it still arrives.
  NEW_CHAT_NOTIFY_PHONE: optional("NEW_CHAT_NOTIFY_PHONE", "+221774982711"),
  // A message counts as a NEW conversation when the client had no activity in
  // the last N hours (so a back-and-forth within one session pings only once).
  NEW_CHAT_NOTIFY_GAP_HOURS: parseInt(optional("NEW_CHAT_NOTIFY_GAP_HOURS", "6"), 10),
  PACK_DISCOVERY_META_SOURCE_IDS: optional("PACK_DISCOVERY_META_SOURCE_IDS", "").split(",").map((id) => id.trim()).filter(Boolean),
  PACK_DISCOVERY_SERVICE_IDS: optional("PACK_DISCOVERY_SERVICE_IDS", "").split(",").map((id) => id.trim()).filter(Boolean),
  // First 10,000 FCFA / one-session plan for Meta Pack Découverte leads. Empty
  // leaves the existing direct-booking campaign flow in place until rollout.
  PACK_DISCOVERY_STEP1_PLAN_ID: optional("PACK_DISCOVERY_STEP1_PLAN_ID", ""),
  PACK_DISCOVERY_CONTINUATION_PLAN_IDS: optional("PACK_DISCOVERY_CONTINUATION_PLAN_IDS", "").split(",").map((id) => id.trim()).filter(Boolean),
  // Manual silent-lead follow-up (/admin/relances): reception reviews leads who
  // clicked a Pack Découverte ad, got Awa's pitch, and never replied, then sends
  // one nudge per lead. These two bound the review list.
  // Silence after Awa's last message before a lead surfaces — so we never show a
  // conversation the client is still reading/typing into.
  LEAD_NUDGE_DELAY_MINUTES: parseInt(optional("LEAD_NUDGE_DELAY_MINUTES", "180"), 10),
  // Hard cap on the last-inbound age: past this, free text can't be delivered
  // inside the 24h WhatsApp window (Meta error 131047). Keep < 24h.
  LEAD_NUDGE_MAX_AGE_HOURS: parseInt(optional("LEAD_NUDGE_MAX_AGE_HOURS", "22"), 10),
  // Explicit boundary for plans Awa may expose and sell. Wix `public:false`
  // only hides a plan from the website and is not an internal-plan marker.
  // Empty is tolerated outside production for local/unit tests; production
  // refuses to boot without an allowlist.
  AWA_SELLABLE_PLAN_IDS: optional("AWA_SELLABLE_PLAN_IDS", "").split(",").map((id) => id.trim()).filter(Boolean),
  // Clés de la Maison. Sales are governed separately by
  // AWA_SELLABLE_PLAN_IDS; this switch controls provisioning/lifecycle only.
  KEYS_AUTOMATION_ENABLED: optional("KEYS_AUTOMATION_ENABLED", "false") === "true",
  // Alerte staff « 1re séance L'Invitée » (matcha de bienvenue offert) :
  // WhatsApp à l'accueil en service à l'heure du cours + owner, ~1 h avant le
  // cours (domain/firstSessionAlert.ts). "false" coupe le sweep sans toucher
  // aux autres alertes.
  INVITEE_FIRST_SESSION_ALERT_ENABLED:
    optional("INVITEE_FIRST_SESSION_ALERT_ENABLED", "true") === "true",
  INVITEE_PLAN_ID: optional("INVITEE_PLAN_ID", ""),
  INVITEE_BONUS_PLAN_ID: optional("INVITEE_BONUS_PLAN_ID", ""),
  HABITUEE_PLAN_ID: optional("HABITUEE_PLAN_ID", ""),
  HABITUEE_BONUS_PLAN_ID: optional("HABITUEE_BONUS_PLAN_ID", ""),
  RESIDENTE_PLAN_ID: optional("RESIDENTE_PLAN_ID", ""),
  RESIDENTE_BONUS_PLAN_ID: optional("RESIDENTE_BONUS_PLAN_ID", ""),
  INVITATION_PLAN_ID: optional("INVITATION_PLAN_ID", ""),
  // Plans sur mesure taillés chacun pour une cliente précise (leurs cours dans
  // un même pool Wix). Type REFORMER, pas de bonus (les autres cours sont déjà
  // couverts par le plan), 1 invitation Reformer par cycle. Liste séparée par
  // virgules ; SUR_MESURE_PLAN_ID (singulier, historique) reste accepté et
  // fusionné. Vide = dark (vendu comme plan normal, aucune automation Clé).
  // Awa ne les propose jamais spontanément.
  SUR_MESURE_PLAN_IDS: [
    ...new Set(
      [optional("SUR_MESURE_PLAN_ID", ""), ...optional("SUR_MESURE_PLAN_IDS", "").split(",")]
        .map((id) => id.trim())
        .filter(Boolean),
    ),
  ],
  // L'Abonnement Aquabike : famille de Clé distincte. Son bonus = 1 séance
  // Reformer sur le créneau calme 12h30 ; son invitation = 1 cours Aquabike
  // (lun–ven, toute heure) pour une amie jamais venue à Revive. Toutes vides
  // = type dark. L'invitation utilise un plan Wix SÉPARÉ, connecté uniquement
  // aux services Aquabike : l'ordre Invitation est créé avant vérification du
  // bénéfice et conservé pour retry en cas d'échec ; un plan partagé
  // Reformer/Aquabike rendrait ce crédit résiduel utilisable sur les deux
  // disciplines, directement dans Wix, hors garde-fous Awa.
  AQUABIKE_ABO_PLAN_ID: optional("AQUABIKE_ABO_PLAN_ID", ""),
  AQUABIKE_BONUS_PLAN_ID: optional("AQUABIKE_BONUS_PLAN_ID", ""),
  AQUABIKE_INVITATION_PLAN_ID: optional("AQUABIKE_INVITATION_PLAN_ID", ""),
  AQUABIKE_SERVICE_IDS: optional("AQUABIKE_SERVICE_IDS", "").split(",").map((id) => id.trim()).filter(Boolean),
  KEY_REFORMER_SERVICE_IDS: optional("KEY_REFORMER_SERVICE_IDS", "").split(",").map((id) => id.trim()).filter(Boolean),
  KEY_BONUS_SERVICE_IDS: optional("KEY_BONUS_SERVICE_IDS", "").split(",").map((id) => id.trim()).filter(Boolean),
  LEGACY_REFORMER_PLAN_IDS: optional("LEGACY_REFORMER_PLAN_IDS", "").split(",").map((id) => id.trim()).filter(Boolean),
  // Both the retired full Pack Découverte and the new L'Invitée count toward
  // the once-per-person discovery entitlement.
  INVITEE_HISTORY_PLAN_IDS: optional("INVITEE_HISTORY_PLAN_IDS", "").split(",").map((id) => id.trim()).filter(Boolean),
  INVITATION_SLOT_HOUR: parseInt(optional("INVITATION_SLOT_HOUR", "12"), 10),
  INVITATION_SLOT_MINUTE: parseInt(optional("INVITATION_SLOT_MINUTE", "30"), 10),
  // Massage subscriber rate (server-decided, never the model). Holders of a
  // qualifying abonnement pay MASSAGE_MEMBER_RATE_XOF for the services listed in
  // MASSAGE_SERVICE_IDS instead of the Wix catalog price; everyone else pays the
  // catalog price. The whole feature is INERT until both lists are set — an
  // empty MASSAGE_SERVICE_IDS or MASSAGE_MEMBER_PLAN_IDS means "no member rate",
  // so it ships dark and is switched on with Railway vars once the massage Class
  // exists. NOTE: only linked (verified) members are ever detected, so the rate
  // can never be claimed — it applies from the client's real active plan only.
  // When a new custom (sur-mesure) plan of >=3x/week is created, add its id here
  // too (see the sur-mesure checklist).
  MASSAGE_SERVICE_IDS: optional("MASSAGE_SERVICE_IDS", "").split(",").map((id) => id.trim()).filter(Boolean),
  MASSAGE_MEMBER_PLAN_IDS: optional("MASSAGE_MEMBER_PLAN_IDS", "").split(",").map((id) => id.trim()).filter(Boolean),
  MASSAGE_MEMBER_RATE_XOF: parseInt(optional("MASSAGE_MEMBER_RATE_XOF", "25000"), 10),
  // Clés lifecycle templates. Each feature stays dark until its exact Meta
  // template name is configured; language codes must match Meta approval.
  WA_KEY_INVITEE_J5_TEMPLATE: optional("WA_KEY_INVITEE_J5_TEMPLATE", ""),
  WA_KEY_INVITEE_J5_TEMPLATE_LANG: optional("WA_KEY_INVITEE_J5_TEMPLATE_LANG", "fr"),
  WA_KEY_THIRD_SESSION_TEMPLATE: optional("WA_KEY_THIRD_SESSION_TEMPLATE", ""),
  WA_KEY_THIRD_SESSION_TEMPLATE_LANG: optional("WA_KEY_THIRD_SESSION_TEMPLATE_LANG", "fr"),
  WA_KEY_MEMBER_J5_TEMPLATE: optional("WA_KEY_MEMBER_J5_TEMPLATE", ""),
  WA_KEY_MEMBER_J5_TEMPLATE_LANG: optional("WA_KEY_MEMBER_J5_TEMPLATE_LANG", "fr"),
  WA_KEY_INVITATION_J10_TEMPLATE: optional("WA_KEY_INVITATION_J10_TEMPLATE", ""),
  WA_KEY_INVITATION_J10_TEMPLATE_LANG: optional("WA_KEY_INVITATION_J10_TEMPLATE_LANG", "en"),
  WA_KEY_MEMBER_J5_INVITATION_TEMPLATE: optional("WA_KEY_MEMBER_J5_INVITATION_TEMPLATE", ""),
  WA_KEY_MEMBER_J5_INVITATION_TEMPLATE_LANG: optional("WA_KEY_MEMBER_J5_INVITATION_TEMPLATE_LANG", "en"),
  WA_KEY_FINISHED_TEMPLATE: optional("WA_KEY_FINISHED_TEMPLATE", ""),
  WA_KEY_FINISHED_TEMPLATE_LANG: optional("WA_KEY_FINISHED_TEMPLATE_LANG", "fr"),
  // Aquabike-family lifecycle templates. The Clé templates above are Reformer/
  // Clé-worded, so the AQUABIKE family uses its own set (invitation = an Aquabike
  // class; renewal/finished = the Aquabike abonnement). Empty = that Aquabike
  // reminder stays dark (the send is skipped), never a wrong-worded Clé message.
  WA_AQUABIKE_INVITATION_J10_TEMPLATE: optional("WA_AQUABIKE_INVITATION_J10_TEMPLATE", ""),
  WA_AQUABIKE_INVITATION_J10_TEMPLATE_LANG: optional("WA_AQUABIKE_INVITATION_J10_TEMPLATE_LANG", "en"),
  WA_AQUABIKE_MEMBER_J5_TEMPLATE: optional("WA_AQUABIKE_MEMBER_J5_TEMPLATE", ""),
  WA_AQUABIKE_MEMBER_J5_TEMPLATE_LANG: optional("WA_AQUABIKE_MEMBER_J5_TEMPLATE_LANG", "en"),
  WA_AQUABIKE_MEMBER_J5_INVITATION_TEMPLATE: optional("WA_AQUABIKE_MEMBER_J5_INVITATION_TEMPLATE", ""),
  WA_AQUABIKE_MEMBER_J5_INVITATION_TEMPLATE_LANG: optional("WA_AQUABIKE_MEMBER_J5_INVITATION_TEMPLATE_LANG", "en"),
  WA_AQUABIKE_FINISHED_TEMPLATE: optional("WA_AQUABIKE_FINISHED_TEMPLATE", ""),
  WA_AQUABIKE_FINISHED_TEMPLATE_LANG: optional("WA_AQUABIKE_FINISHED_TEMPLATE_LANG", "en"),
  // J-5 conversion of a legacy Reformer subscriber to a Key. Kept separate
  // from WA_RENEWAL_TEMPLATE because closed legacy plans must not be renewed.
  WA_LEGACY_KEY_CONVERSION_TEMPLATE: optional("WA_LEGACY_KEY_CONVERSION_TEMPLATE", ""),
  WA_LEGACY_KEY_CONVERSION_TEMPLATE_LANG: optional("WA_LEGACY_KEY_CONVERSION_TEMPLATE_LANG", "fr"),
  // Wix in-site backend forwards Order Purchased as JSON over HTTPS with this
  // shared secret. Native Wix RS256 JWTs remain supported as a fallback.
  WIX_WEBHOOK_SHARED_SECRET: optional("WIX_WEBHOOK_SHARED_SECRET", ""),
  WIX_WEBHOOK_PUBLIC_KEY: optional("WIX_WEBHOOK_PUBLIC_KEY", ""),
  // Guarded admin-to-client messaging. Keep false until takeover behavior has
  // been verified in production with the Meta number.
  ADMIN_HUMAN_REPLY_ENABLED: optional("ADMIN_HUMAN_REPLY_ENABLED", "false") === "true",
  // Optional fixed client-facing template for follow-up outside WhatsApp's
  // 24h free-text window. It must have no body variables.
  WA_ADMIN_FOLLOWUP_TEMPLATE: optional("WA_ADMIN_FOLLOWUP_TEMPLATE", ""),
  WA_ADMIN_FOLLOWUP_TEMPLATE_LANG: optional("WA_ADMIN_FOLLOWUP_TEMPLATE_LANG", "fr"),
  // Background recovery of messages deferred during a human takeover. Keep
  // dark until the migration and production relay checks have been validated.
  AWA_AUTO_RESUME_DEFERRED_ENABLED: optional("AWA_AUTO_RESUME_DEFERRED_ENABLED", "false") === "true",
  // Where the "Envoyer un test" button on /admin/notifications sends its preview
  // message. Defaults to Babakar's number so tests never surprise the guardian
  // or a coach. Empty = the test button is disabled.
  NOTIF_TEST_PHONE: optional("NOTIF_TEST_PHONE", "+221774982711"),
  // Story Instagram quotidienne : numéro WhatsApp qui reçoit l'image des cours
  // du lendemain chaque soir (le gérant la poste ensuite). Défaut = le numéro de
  // test (celui de Babakar). Vide = envoi désactivé. Heure d'envoi (Dakar == UTC).
  STORY_PHONE: optional("STORY_PHONE", optional("NOTIF_TEST_PHONE", "+221774982711")),
  STORY_HOUR: parseInt(optional("STORY_HOUR", "18"), 10),
  // Approved media template with a dynamic IMAGE header. Unlike a plain image
  // message, it is deliverable even when STORY_PHONE has not messaged Awa in 24h.
  WA_STORY_TEMPLATE: optional("WA_STORY_TEMPLATE", "story_quotidienne"),
  WA_STORY_TEMPLATE_LANG: optional("WA_STORY_TEMPLATE_LANG", "en"),
  PAYMENT_LINK_TTL_MINUTES: parseInt(optional("PAYMENT_LINK_TTL_MINUTES", "20"), 10),
  // Brand rule: the studio is "Revive" — never "Revive Pilates" in client copy.
  STUDIO_ADDRESS: optional("STUDIO_ADDRESS", "Revive, Almadies, Dakar"),
  PORT: parseInt(optional("PORT", "3000"), 10),
  TIMEZONE: "Africa/Dakar",
};

/**
 * Call at boot. Throws with the full list of missing vars so setup problems
 * surface once, clearly, instead of as scattered runtime failures.
 */
export function assertConfig(): void {
  if (process.env.NODE_ENV === "production" && config.AWA_SELLABLE_PLAN_IDS.length === 0) {
    missing.push("AWA_SELLABLE_PLAN_IDS");
  }
  if (config.KEYS_AUTOMATION_ENABLED) {
    const keyConfig: Array<[string, unknown]> = [
      ["INVITEE_PLAN_ID", config.INVITEE_PLAN_ID],
      ["INVITEE_BONUS_PLAN_ID", config.INVITEE_BONUS_PLAN_ID],
      ["HABITUEE_PLAN_ID", config.HABITUEE_PLAN_ID],
      ["HABITUEE_BONUS_PLAN_ID", config.HABITUEE_BONUS_PLAN_ID],
      ["RESIDENTE_PLAN_ID", config.RESIDENTE_PLAN_ID],
      ["RESIDENTE_BONUS_PLAN_ID", config.RESIDENTE_BONUS_PLAN_ID],
      ["INVITATION_PLAN_ID", config.INVITATION_PLAN_ID],
      ["KEY_REFORMER_SERVICE_IDS", config.KEY_REFORMER_SERVICE_IDS.length],
      ["KEY_BONUS_SERVICE_IDS", config.KEY_BONUS_SERVICE_IDS.length],
      ["LEGACY_REFORMER_PLAN_IDS", config.LEGACY_REFORMER_PLAN_IDS.length],
      ["INVITEE_HISTORY_PLAN_IDS", config.INVITEE_HISTORY_PLAN_IDS.length],
      [
        "WIX_WEBHOOK_AUTH",
        config.WIX_WEBHOOK_SHARED_SECRET.length >= 32 || Boolean(config.WIX_WEBHOOK_PUBLIC_KEY),
      ],
    ];
    for (const [name, value] of keyConfig) {
      if (!value) missing.push(name);
    }
  }
  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variables:\n  - ${missing.join("\n  - ")}\n` +
        `Fill them in .env (see .env.example). Use placeholder values only for ` +
        `integrations you are not exercising locally.`,
    );
  }
}
