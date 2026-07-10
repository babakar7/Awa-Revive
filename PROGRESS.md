# PROGRESS — Revive Bookings ("Awa")

> Journal d'avancement destiné à un agent (ou humain) qui reprend le projet.
> Dernière mise à jour : **10 juillet 2026**. Compléments : `README.md` (setup,
> archi détaillée), `PHASE2.md` (backlog priorisé), `WIX-WEBHOOK-PLAN.md`
> (chantier EN VEILLE — ne pas implémenter), `business-info.md` (source de
> vérité métier d'Awa, chargée au boot), `cafe-menu.md` (menu du café, source
> de vérité des prix café, chargé au boot).

## 1. Le projet en une minute

**Awa** est un agent IA sur WhatsApp qui répond aux clients du studio
fitness/bien-être **Revive** (Dakar) et réserve leurs cours dans **Wix
Bookings**, avec paiement préalable via **Wave** (mobile money) ou via leur
**abonnement** Wix. Stack : Node 20 / TypeScript / Fastify / Postgres /
`@anthropic-ai/sdk` (modèle `claude-sonnet-5`, effort low, prompt caching).

**Invariant central : aucune réservation n'est créée dans Wix avant qu'un
paiement Wave soit vérifié par webhook signé** (ou qu'une séance d'abonnement
soit décomptée par Wix). Le modèle propose, le serveur décide : prix depuis le
catalogue Wix uniquement, event_ids validés contre `slot_cache` (anti
prompt-injection), règle des 16h vérifiée côté serveur.

## 2. État : TOUT LE PÉRIMÈTRE PHASE 1+ EST EN PRODUCTION ET VALIDÉ E2E

Production : `https://resabot-production.up.railway.app` (Railway, service +
Postgres), déployée depuis GitHub (`babakar7/Awa-Revive`, push sur main =
déploiement). Numéro WhatsApp prod : **+221 78 953 66 76** (WABA 1738439110507790,
phone_number_id 1175926012276896). Tests : 90 unitaires (`npm test`, rapides,
sans réseau) + 14 d'intégration sur le chemin de paiement
(`npm run test:integration`, Postgres jetable via Docker, APIs externes
mockées) — exécutés en CI GitHub Actions à chaque push.

Flux validés en conditions réelles (argent réel / site Wix réel) :

| Flux | Validé | Notes |
|---|---|---|
| Résa + paiement Wave E2E | ✅ 03/07 | lien → paiement → webhook → résa Wix CONFIRMED → confirmation WhatsApp (~15 s) |
| Créneaux pleins | ✅ | slots `full:true` montrés mais jamais réservables (pas en slot_cache) |
| Résas de groupe (N places, 1 nom, 1 lien) | ✅ | `participants` 1-10, prix × N |
| Remboursement (cours rempli pendant paiement) | ✅ | `REFUND_NEEDED` + email réception + `refund:done` |
| Rattachement contact CRM par téléphone | ✅ | e164 unique, tiebreak prénom si doublons, sinon null (prudence) |
| Client non relié → demande d'email en chat + email réception | ✅ | one-shot par client ; le client répond DANS le chat (jamais "envoie à la réception") |
| Abonnements : détection auto + résa sans paiement | ✅ 05-06/07 | voir §4 — Benefit Programs, PAS le checkout eCommerce |
| Annulation par Awa (règle 16h) | ✅ 06/07 | abonnement → re-crédit auto ; Wave → client contacte la réception pour remboursement |
| Handoffs (« je peux vous appeler ? », plaintes…) | ✅ | numéro réception + email auto à support@revive.sn |
| Notifications réception (email Brevo + WhatsApp) | ✅ | dual-channel non-bloquant, voir §4.6 |
| Annulation côté réception (dashboard Wix) | ✅ | sweep 5 min = synchro **silencieuse** ; Wix notifie le client lui-même |
| Typing indicator | ✅ | rafraîchi à chaque itération d'outil (Meta l'éteint à ~25 s) |

## 3. Carte du code

```
src/
  index.ts            boot : assertConfig, migrate (idempotent), sweepers (TTL + relance lien expiré +
                      réconciliation 60s, annulations 5min)
  server.ts           Fastify, raw-body parser, /healthz, pages retour paiement
  config.ts           env (liste TOUTES les vars manquantes d'un coup) ; SMTP optionnel
  db/schema.ts        SCHEMA_SQL idempotent (create + alter if not exists)
  domain/
    stateMachine.ts   DRAFT→AWAITING_PAYMENT→PAID→BOOKED ; EXPIRED→PAID (paiement tardif) ;
                      BOOKED→CANCELLED | REFUND_NEEDED ; REFUND_NEEDED→REFUNDED.
                      transition() = UPDATE atomique WHERE status=ANY(sources)
    repo.ts           accès DB (clients, bookings, conversations, handoffs, slot_cache)
    cancellationSync.ts  sweep 5 min : BOOKED vs statuts Wix → CANCELLED silencieux (pas de message client)
    expiryNudge.ts    relance one-shot quand un lien de paiement expire sans paiement (fr/en/wo) — voir §4.18
  lib/
    whatsapp.ts       signature X-Hub-256, sendText (3 retries), typing indicator (loggé si rejeté)
    wave.ts           checkout session (+ Wave-Signature sortante, OBLIGATOIRE sur ce compte), verif webhook
    wix.ts            services (cache 10 min), dispos, contacts, bookings (create/confirm/decline/cancel),
                      Benefit Programs (findEligibleBenefit / redeem / revert) — voir §4
    cafeMenu.ts       menu café : parse cafe-menu.md au boot (prix côté serveur uniquement),
                      computeExtras (résolution ids+qty → lignes tarifées, rejet des ids inconnus)
    notify.ts         notifyReception() : email Brevo + WhatsApp réception, fire-and-forget
                      (retourne AVANT l'envoi) ; fallback template si fenêtre 24h fermée (131047)
    rateLimit.ts      20 msg/min/numéro (1 avertissement client par fenêtre) ; serialize.ts : file par client
    membershipContext.ts  cache abonnements 10 min (plans + classes couvertes + solde) partagé agent/outils/webhook,
                      invalidé quand le solde change — voir §4.18
  agent/
    systemPrompt.ts   prompt stable caché + dynamicContext (date, langue, lien actif, abonnements)
    tools.ts          list_classes, check_availability, create_payment_link, create_cafe_payment_link,
                      list_plans, create_plan_payment_link, check_membership, book_with_membership,
                      get_my_bookings, cancel_booking, record_email, handoff_to_human, present_options
    index.ts          boucle d'outils (max 8), détection de langue fr/en/wo (stopwords), cache abonnements 10 min
  webhooks/
    whatsapp.ts       GET handshake + POST signé → dedupe → rate limit → file par client
    wave.ts           CHEMIN CRITIQUE : signature (fenêtre anti-rejeu 5 min) → 200 rapide →
                      PAID atomique → claim de fulfillment (bail fulfilling_at 2 min) →
                      re-vérif places → création+confirmation Wix → BOOKED → confirmation WhatsApp →
                      idempotence marquée APRÈS traitement (échec = retry Wave rejouable) ;
                      reconcileStuckBookings() : rattrape les PAID jamais réservés (crash) — voir §4.14
scripts/              simulate-wave-webhook, daily-summary, mark-refunded (refund:done), test-email
test/                 90 tests unitaires purs (signatures, state machine, langue…) — pas de DB/réseau
test/integration/     14 tests d'intégration du chemin de paiement : Postgres jetable (docker run,
                      globalSetup maison — PAS testcontainers, incompatible Node 20.17), mock fetch
                      Wix/Wave/Meta/Brevo qui THROW sur tout appel inattendu — voir §4.15
```

## 4. Décisions & pièges découverts (à lire absolument avant de toucher au code)

1. **Abonnements = API Benefit Programs, PAS le checkout eCommerce.** Un
   checkout créé avec l'API key est anonyme (`buyerInfo.openAccess`) →
   `eligibleMemberships` toujours vide. La voie qui marche :
   `POST /benefit-programs/v1/pools/eligible-pools` puis `/benefits/redeem`
   (namespace `@wix/pricing-plans`, `itemReference.externalId` = **service id**,
   `providerAppId` = app Bookings `13d21c63-...`, beneficiary
   `{identityType:"MEMBER", memberId}` — **identityType explicite obligatoire**,
   sans lui la réponse est vide sans erreur). `idempotencyKey` = booking id.
   Le revert (`/balances/changes/{txId}/revert`) re-crédite la séance —
   `benefit_transaction_id` est stocké sur la ligne booking pour ça.
2. **Ordre du flux abonnement** : éligibilité AVANT création de la résa (un
   refus ne laisse aucun orphelin) ; en cas d'échec après création → decline
   automatique ; si le confirm calendrier échoue après déduction → email
   réception (jamais faire échouer la résa du client à ce stade).
3. **Wave** : le compte a la **signature des requêtes SORTANTES enforced**
   (`Wave-Signature`, secret `wave_sn_AKS_...`) — distincte du secret webhook
   (`wave_sn_WHS_...`). Pas de webhook de remboursement chez Wave → clôture
   manuelle par `npm run refund:done -- <booking_id>`.
4. **Meta/WhatsApp** : les webhooks s'abonnent PAR WABA
   (`POST /{waba}/subscribed_apps`) — un numéro sur un nouveau WABA = re-souscrire,
   sinon bot muet. Typing indicator éteint par Meta à ~25 s → ré-armé à chaque
   itération de la boucle d'outils. Fenêtre 24 h : messages libres uniquement ;
   hors fenêtre il faudrait des templates approuvés (aucun template custom
   n'existe, `business_verification_status` encore "pending" — 250 conv/jour
   possibles quand même le jour où on en aura besoin).
5. **Fuseau horaire** : Dakar = GMT+0 = UTC. Les outils renvoient des champs
   pré-formatés (`start_dakar`, `slot_start_dakar`) que le modèle relaie tels
   quels ; interdiction (prompt) de convertir ou de mentionner GMT/UTC — le
   modèle s'était inventé une conversion fausse.
6. **Notifications réception = DEUX canaux (10/07)**, `notifyReception()` retourne
   AVANT tout envoi (fire-and-forget — un `await` avait bloqué une réponse
   WhatsApp 2 minutes).
   - **Email via l'API HTTP de Brevo** (`api.brevo.com/v3/smtp/email`,
     `BREVO_API_KEY`, expéditeur `EMAIL_FROM`, dest. `RECEPTION_EMAIL` =
     support@revive.sn). **Pourquoi Brevo et pas SMTP : Railway bloque le SMTP
     sortant** → nodemailer timeoutait systématiquement (`Connection timeout`).
     Namecheap SMTP et Resend écartés (Resend : MX sur sous-domaine impossible
     chez Wix DNS). Test : `npm run email:test`.
   - **WhatsApp vers `RECEPTION_PHONE`** (Cloud API, depuis la vérif Meta
     approuvée). Texte libre d'abord ; si la fenêtre 24h est fermée (erreur Meta
     131047) ET qu'un template est configuré (`WA_RECEPTION_TEMPLATE`, 2 variables
     {{1}} sujet / {{2}} détail aplati), repli auto sur ce template. La réception
     n'écrit jamais à Awa → sans template approuvé le WhatsApp ne passe qu'après
     un message entrant récent ; l'email reste le canal fiable. Test :
     `npm run whatsapp:test`.
7. **Annulations côté réception** : la réception coche "notifier le client"
   dans Wix → c'est Wix qui notifie. Awa ne message PLUS le client sur
   annulation externe (décision produit 05/07) ; le sweep ne fait que la
   synchro DB. Conséquence : le chantier webhooks Wix (`WIX-WEBHOOK-PLAN.md`)
   est EN VEILLE — la fraîcheur temps réel n'a plus d'usage visible
   (`get_my_bookings` re-vérifie les statuts Wix en direct à chaque demande).
8. **Annulation par Awa (06/07)** : outil `cancel_booking`, uniquement les
   résas prises via Awa, ≥ 16h avant le cours (recalculé côté serveur à la
   consultation ET à l'exécution — le modèle ne peut pas contourner).
   Abonnement → revert automatique du crédit ; Wave → `REFUND_NEEDED` + le
   client doit CONTACTER LA RÉCEPTION pour le remboursement (Awa ne promet ni
   rappel ni délai) + email réception en parallèle. < 16h → refus poli, sans
   JAMAIS suggérer d'exemples d'excuses valables (consigne explicite de
   Babakar). Le report et les annulations partielles de groupe = handoff.
9. **Emojis** : teinte de peau medium-dark (🏾) partout — codé en dur dans les
   templates + règle de style dans le prompt.
10. **Détection de langue** : scoring de stopwords fr/en/wo (accents
    normalisés), vainqueur net requis, défaut fr.
11. **Vente d'abonnements (07/07)** : catalogue = Pricing Plans non archivés,
    non cachés, prix > 0 (les plans promo à 0 sont invendables par Awa).
    Paiement Wave d'abord (table `pending_plan_orders`, mêmes règles TTL/
    idempotence que les résas ; le webhook Wave route par client_reference :
    booking d'abord, sinon plan order). Activation = `POST
    /pricing-plans/v2/checkout/orders/offline` `{planId, memberId, paid:true}`
    — **membre Wix obligatoire** ; member_id résolu et stocké À LA CRÉATION
    du lien ; sans compte membre → statut reste PAID + email réception pour
    activation manuelle + message client adapté. Toutes les formules Revive
    sont one_time (pas de récurrence à gérer).
12. **Orange Money (08/07) — BLOQUÉ chez Sonatel.** Flux connu et validé par
    des intégrations tierces : token `POST {host}/oauth/token` (form ou Basic,
    client_credentials), paiement `POST /api/eWallet/v4/qrcode` (Bearer +
    `{amount:{unit:"XOF",value}, callbackSuccessUrl, callbackCancelUrl,
    code:<MERCHANT_CODE>, metadata:{order}, name, validity}`), host sandbox
    `api.sandbox.orange-sonatel.com`. App "Awa revive" approuvée + 4 APIs
    approuvées (oauth, PAYMENT-OM, QR CODE-OM, NOTIFICATION), identifiant
    passerelle `awa-revive-928bb260-...-sandbox`, MAIS toute demande de token
    répond `invalid_client` (toutes combinaisons host/chemin/format testées,
    clés régénérées 2×) → provisioning défaillant côté Sonatel, ticket support
    envoyé par Babakar. Il manquera aussi le **merchant code** (champ `code`)
    à récupérer. Clés dans `.env` (OM_SANDBOX_*). Reprendre ici quand le token
    passe ; architecture cible = clone du chemin Wave (webhook NOTIFICATION ou
    vérif de statut avant confirmation).
13. **Menu café (10/07)** : commande café adossée à une résa, dans le MÊME lien
    Wave (`amount_xof` = grand total cours + café). `cafe-menu.md` (éditable par
    le propriétaire : `- ID | Nom | prix | description`, IDs stables, lu AU BOOT
    comme business-info ; fichier invalide = boot en échec, fichier absent =
    café désactivé proprement) est la source de vérité des prix — même posture
    anti-injection que slot_cache : le modèle ne passe que des `item_id` + `qty`
    (param `extras` de create_payment_link, max 15 lignes, qty 1-10) et le
    serveur résout tout via `computeExtras` (id inconnu → rejet avec la liste
    des ids valides, pas de clamp silencieux). Stockage sur la ligne booking :
    `extras_json`, `extras_amount_xof`, `order_note` (timing, lait, allergies —
    défaut « prête après le cours »). Après paiement : notification réception
    « ☕ Commande café payée » + détail dans la confirmation client (fr/en/wo) ;
    en cas de remboursement, la note réception précise que la commande ne doit
    PAS être préparée, et cancel_booking signale que le total remboursé inclut
    le café. Règles prompt : pas de café sans résa ni sur résa par abonnement
    (pas de lien → comptoir), proposition UNE seule fois par résa, menu présenté
    progressivement (jamais en bloc), modification avant paiement = nouveau lien
    (l'ancien est annulé), après paiement → comptoir. `get_my_bookings` expose
    la commande (`cafe_order`).

14. **Durcissement du chemin de paiement (10/07 après-midi)**, suite à une
    revue de code complète. (a) L'id d'idempotence webhook Wave est enregistré
    **APRÈS** le traitement réussi (avant, un crash entre l'insert et le PAID
    rendait tous les retries Wave muets → paiement perdu en silence). Le
    doublon de livraison reste sûr : c'est la transition PAID atomique + le
    claim qui protègent, pas le dedupe. (b) Nouveau **bail de fulfillment**
    (`fulfilling_at`, claim atomique, périmé à 2 min) : un retry webhook et le
    sweep de réconciliation peuvent tenter en même temps, un seul gagne.
    (c) **Sweep de réconciliation** (60 s, dans le sweeper TTL) : tout PAID
    sans `wix_booking_id` vieux de ≥ 3 min est repris → BOOKED ou
    REFUND_NEEDED. (d) Fenêtre **anti-rejeu 5 min** sur la signature Wave
    (opt-in dans verifyWaveSignature — les tests unitaires signent avec des
    timestamps fixes). (e) **Timeouts 15 s** sur TOUS les fetch sortants
    (Wix/Wave/Meta) — un hang Wix bloquait la file entière d'un client.
    (f) Historique **coalescé** dans l'agent : deux tours de même rôle
    fusionnés (un envoi WhatsApp raté ne casse plus l'alternance
    user/assistant exigée par l'API). (g) Divers : cache abonnements invalidé
    à l'activation d'un plan, avertissement client au rate-limit (1×/fenêtre),
    safeEqual admin sur digests SHA-256 (pas de fuite de longueur),
    cancellationSweeper clearInterval au shutdown.
15. **Tests d'intégration + CI (10/07)**. `test/integration/` : Postgres
    jetable par run (`docker run postgres:16-alpine`, globalSetup maison —
    testcontainers ABANDONNÉ, son undici exige Node ≥ 20.18.1 et la machine
    est en 20.17.0), env posé dans globalSetup AVANT l'import de config.ts
    (dotenv n'écrase jamais l'existant), mock fetch installé UNE fois par
    suite (les notifications fire-and-forget en vol toucheraient les vraies
    APIs avec un restore par test) et qui throw sur toute URL non mockée.
    14 scénarios : signature, happy path, paiement tardif honoré, doublons
    (même event id ET event id différent), 3 causes de remboursement,
    récupération de PAID bloqué (retry, sweep, bail actif/périmé),
    retriabilité. AUCUN secret réel requis. CI GitHub Actions
    (`.github/workflows/ci.yml`) : tsc + unit + intégration à chaque push ;
    « Wait for CI » à activer côté Railway pour bloquer les déploiements
    rouges (pas seulement les signaler).
16. **Messages interactifs cliquables (10/07)** — outil `present_options`
    ([tools.ts](src/agent/tools.ts)) : Awa envoie un message natif WhatsApp
    cliquable (≤3 options courtes → boutons ; sinon liste, max 10 lignes) et le
    tool le DÉLIVRE lui-même. Le webhook entrant traite `type:"interactive"`
    ([whatsapp.ts](src/webhooks/whatsapp.ts)) et injecte le clic comme
    `[choix cliqué] <titre> (id: <id>)`. Après un `sent:true`, Awa répond la
    sentinelle `<NO_REPLY>` pour ne pas doubler le message ; la boucle agent
    n'honore la sentinelle QUE si un interactif est réellement parti (jamais de
    client sans réponse — [index.ts](src/agent/index.ts)). Les créneaux Wix ont
    un alias court `choice_id` (sha256 tronqué, colonne `slot_cache.choice_key`)
    car les `event_id` dépassent la limite de 200 car. des ids de ligne WhatsApp ;
    `create_payment_link`/`book_with_membership` acceptent l'un ou l'autre. Flux
    café sans va-et-vient : **1 clic = 1 article, jamais « combien ? »** ; les
    quantités passent par le texte libre (« mets-en 2 »). Le clic reste OPTIONNEL,
    le texte libre toujours accepté. `buildInteractivePayload` est pur et testé.
17. **Fenêtres de dates pré-calculées (10/07)** — bug réel : Awa proposait « la
    semaine prochaine » avec un décalage d'une semaine (arithmétique de dates du
    LLM peu fiable). Correctif : `dynamicContext` ([systemPrompt.ts](src/agent/systemPrompt.ts))
    calcule et injecte les fenêtres prêtes à l'emploi (aujourd'hui, demain,
    7 jours, cette/la semaine prochaine, ce/le week-end prochain), en ISO
    `T00:00:00Z → T23:59:59Z` (bornes journée pleines — une borne à `date` nue =
    minuit coupait le dimanche). Awa passe ces valeurs telles quelles à
    `check_availability` (interdit de calculer elle-même) et annonce la période
    dans son message. Dakar = GMT+0 = UTC, donc le calcul calendaire UTC == Dakar.

18. **Trio UX (10/07 nuit)** — relance lien expiré, report en un geste, solde
    d'abonnement visible.
    - **Relance lien expiré** ([expiryNudge.ts](src/domain/expiryNudge.ts), depuis
      le sweeper 60 s) : UNE relance WhatsApp (« ton lien a expiré, tu en veux un
      nouveau ? », fr/en/wo) quand un lien expire par TTL sans paiement.
      Garde-fous : `expiry_nudged_at` (one-shot, claim atomique AVANT envoi),
      fenêtre 30 min (un déploiement ne rejoue jamais le backlog), cours pas
      encore commencé, silence si le client a une ligne booking plus récente ou
      un lien d'achat de plan actif — piège : un lien REMPLACÉ (expireActiveBookings)
      garde un `link_expires_at` futur et retomberait dans la fenêtre à son TTL ;
      c'est le filtre « pas de ligne plus récente » qui le bloque. Toujours dans
      la fenêtre 24 h Meta (le client a écrit quelques minutes avant le lien).
      Relance loggée comme tour assistant + consigne Context notes : si le client
      répond oui, re-check_availability et nouveau lien direct, sans re-questions.
    - **Report en un geste** (prompt, section Rescheduling) : annulation + re-résa
      orchestrées dans UNE conversation, ≥ 16h uniquement (sinon handoff). Le
      NOUVEAU créneau est choisi AVANT toute annulation. Abonnement →
      cancel_booking + book_with_membership dans le même tour, confirmation
      unique. Wave → OK explicite du client sur « remboursement via réception +
      nouveau paiement » AVANT le cancel, puis cancel + create_payment_link dans
      le même tour, un seul message (annulation + consignes remboursement + lien).
      handoff_to_human ne mentionne plus le report que pour < 16h / groupes partiels.
    - **Solde d'abonnement visible** : `planRemainingSessions` ([wix.ts](src/lib/wix.ts))
      lit `balance.available` du pool éligible via le MÊME endpoint Benefit
      Programs déjà éprouvé (pas d'API pools-query non vérifiée). Piège
      multi-plans : eligible-pools répond pour un SERVICE, le pool peut
      appartenir à un autre plan → match par nom de plan, sinon « unknown ».
      Injecté dans le contexte dynamique de CHAQUE message + `remaining_sessions`
      dans check_membership. Le cache abonnements vit désormais dans
      [membershipContext.ts](src/lib/membershipContext.ts) (extrait de agent/index
      pour éviter un import circulaire tools→agent) et est invalidé à chaque
      changement de solde : book_with_membership, cancel_booking (re-crédit),
      activation de plan. Un solde null = « vérifié à la résa », JAMAIS 0 ni un
      chiffre inventé (consignes prompt + note d'outil).

19. **get_my_bookings élargi + menu aux abonnés + rappel 16h abonnement (10/07 nuit)**.
    - **get_my_bookings élargi** : en plus des résas prises via Awa (table locale),
      liste aussi celles prises au comptoir ou sur le site, via
      `listContactUpcomingBookings(contactId)` ([wix.ts](src/lib/wix.ts),
      extended-bookings query filtrée par `booking.contactDetails.contactId`).
      Sortie changée en `{ bookings: [...] }`, chaque entrée porte `booked_via`
      « awa » (annulable/reportable ici, avec booking_id) ou « studio » (lecture
      seule → « pour la modifier, contacte la réception »). Dédup par
      `wix_booking_id` (les résas Awa apparaissent aussi dans Wix). ⚠️ La forme
      exacte de la réponse extended-bookings (`bookedEntity.slot.startDate`,
      `.title`) est à VÉRIFIER sur une vraie réponse Wix — code défensif : toute
      forme inattendue → liste vide, jamais d'exception (get_my_bookings retombe
      sur les seules résas Awa).
    - **Menu aux abonnés** (nouveau tool `create_cafe_payment_link` + table
      `pending_cafe_orders`) : une résa par abonnement n'a pas de lien de
      paiement, donc le café voyage désormais dans SON PROPRE petit lien Wave
      (café seul). Awa propose le menu APRÈS book_with_membership (qui renvoie
      maintenant `booking_id`), et si le client commande, crée le lien café —
      prix 100 % serveur via `computeExtras`, rattaché au booking par
      `linked_booking_id` (même contrôle de propriété que cancel_booking : résa
      du client, BOOKED, membership, à venir). AUCUNE création Wix : le webhook
      Wave route booking → plan → café order ([wave.ts](src/webhooks/wave.ts)
      `processCafePayment`), marque PAID, notifie la réception « ☕ commande café
      payée (résa abonnement) » et envoie la confirmation client
      (`cafeConfirmationMessage`, fr/en/wo). TTL/expiration : un lien café actif
      par client (`expireActiveCafeOrders`), sweep TTL dans le sweeper 60 s.
      Toujours pas de café sans AUCUNE résa (comptoir).
    - **Rappel 16h abonnement** : les confirmations Wave l'affichaient déjà
      (`confirmationMessage`), pas les résas par abonnement (rédigées par le
      modèle). La note de succès de book_with_membership demande maintenant à
      Awa de rappeler « annulation gratuite jusqu'à 16h avant le cours ». Pas de
      template Meta : c'est un message dans la fenêtre 24h.

20. **Résa en un tap (10/07 nuit)** — pour les habitués. `computeBookingHabit`
    ([repo.ts](src/domain/repo.ts), fonction PURE testée) détecte, dans les
    résas `BOOKED` passées, le motif (cours + jour de semaine + heure) répété
    ≥ 2 fois le plus fréquent ; `bookingHabit(clientId)` l'expose. Injecté dans
    le contexte dynamique : quand le client exprime une intention de résa SANS
    nommer cours ni heure, Awa peut proposer d'abord un raccourci
    present_options (« Comme d'habitude, Pilates Fusion le vendredi à 10:00 ? »
    → [Oui ✅] [Un autre créneau] [Un autre cours]). Garde-fou strict : ce n'est
    qu'un raccourci — sur « Oui », Awa relance TOUJOURS check_availability
    (fenêtre 7 j) pour trouver le créneau ouvert correspondant, jamais de lien
    créé directement depuis l'habitude ; prix/16h/dispo recalculés serveur comme
    d'habitude. Si le client a déjà nommé un cours/une heure, l'habitude est
    ignorée. 5 tests unitaires (106 au total).

21. **Book-first, menu-after — le café n'est PLUS jamais dans le lien du cours (10/07)**.
    Changement de fond après un bug observé en prod : Awa sautait parfois la
    proposition de menu (conflit de prompt « crée le lien tout de suite » vs
    « propose le menu avant le lien ») et bundlait un catalogue de catégories.
    Cause racine : la proposition n'était QU'UNE règle de prompt, non enforced,
    et elle se percutait avec la règle dure de création du lien. Nouveau modèle,
    unifié avec le flux abonnement : **on réserve/paie le cours d'abord, on
    propose le café ensuite, en lien Wave SÉPARÉ.**
    - `create_payment_link` = cours SEUL : params `extras`/`order_note` retirés,
      bloc extras supprimé, le lien ne porte plus jamais de café
      ([tools.ts](src/agent/tools.ts)). Plus aucune tension avec la règle dure.
    - **Flux Wave** : après paiement confirmé, le webhook envoie la confirmation
      PUIS propose le menu automatiquement — present_options 2 boutons
      [Voir le menu 🥤 (cafe_after_booking_yes)] / [Non merci 🙏🏾 (…_no)]
      ([wave.ts](src/webhooks/wave.ts) `proposeCafeMenuAfterBooking`, copy fr/en/wo,
      non bloquant, tour loggé). Le tap revient dans le modèle, qui présente les
      incontournables puis crée le lien café. Guard : sauté si la résa portait
      déjà des extras (legacy).
    - `create_cafe_payment_link` ouvert aux résas **Wave OU abonnement** (garde =
      résa du client, BOOKED, à venir — la contrainte `membership` a sauté).
      `linked_booking_id` désormais OPTIONNEL : vide ⇒ rattaché à la dernière
      résa à venir du client (`repo.latestUpcomingBooking`, tri `created_at desc`)
      — indispensable côté Wave où le booking naît dans le webhook, le modèle n'a
      jamais ce booking_id.
    - **Flux abonnement inchangé** : Awa déclenche l'offre elle-même dans le tour
      (book_with_membership renvoie booking_id → menu → create_cafe_payment_link).
    - Compromis assumé (validé produit) : la conversion café baisse (2ᵉ paiement
      Wave) mais le chemin de réservation n'a plus aucune friction et le bug de
      skip disparaît par construction. Build + 106 tests OK.
    - ⚠️ Reste : le lien café-seul en attente n'est PAS surfacé dans le contexte
      dynamique (comme avant pour l'abonnement) — si le client demande « c'est
      toujours valable ? » pour un lien café, Awa n'a pas l'info live. À ajouter
      si le café devient très fréquent.

## 5. Chronologie condensée

- **03/07** : build initial complet (spec → prod Railway), premier paiement
  réel E2E, persona Awa, business-info.md, groupes, full slots, cache prompt.
- **04/07** : contact-matching CRM, abonnements v1 (eCommerce — ne marchait
  pas encore), REFUNDED + refund:done, sync annulations, capture email
  post-résa, SMTP Namecheap (Resend abandonné : DNS Wix), PHASE2.md.
- **05/07** : fix fuseau horaire (champs *_dakar), emails non-bloquants
  (2 min → instantané), emojis 🏾, message d'annulation raccourci puis
  SUPPRIMÉ (Wix notifie), plan webhooks Wix rédigé puis mis en veille,
  **bug abonnement diagnostiqué et refait sur Benefit Programs** — résa par
  abonnement validée E2E (solde 5→4).
- **06/07** : **annulation par Awa** (cancel_booking, 16h, re-crédit auto,
  remboursement via réception) validée E2E (re-crédit 4→5), typing indicator
  rafraîchi, remboursement test 50 FCFA clôturé, token retiré de `specs`.
- **07/07** : **vente d'abonnements** (list_plans + create_plan_payment_link,
  table pending_plan_orders, activation auto par offline order si compte
  membre / manuelle par réception sinon — voir §4.11). Prompt durci après
  observations en réel : ne pas supposer la variante d'un cours (Foundation
  vs Sculpt...), ne JAMAIS annoncer une action sans la faire ("je te fais le
  lien" sans lien interdit), une confirmation suffit. business-info : carte
  bancaire/paiement au studio retirés du vocabulaire d'Awa (client ne peut
  pas payer Wave → handoff). **Bug groupe découvert en réel** : paiement de
  5 places accepté puis résa Wix refusée (policy maxParticipantsPerBooking=3)
  → remboursement avec message trompeur. Correctifs : cap lu en live et
  vérifié AVANT paiement, messages de remboursement par cause (technique vs
  place prise vs manque de places), contexte dynamique "remboursement en
  cours" (Awa ne nie plus jamais un paiement). Babakar a monté la limite Wix
  à 8/résa.
- **08/07** : intégration **Orange Money** préparée mais BLOQUÉE côté Sonatel
  (voir §4.12).
- **10/07** : **bug créneau passé découvert en réel** (Syndel, 09/07) : lien
  de paiement regénéré à 12h39 pour le cours de 12h00 (slot_cache de 10h58
  réutilisé), payé aussitôt → création Wix impossible → remboursement avec
  message « souci technique » trompeur. Correctifs déployés :
  check_availability filtre (et ne cache plus) les créneaux déjà commencés,
  create_payment_link refuse un slot commencé (`slot_already_started`), et le
  webhook Wave rembourse avec un message honnête « paiement arrivé après le
  début du cours » (reason `class_started`, fr/en/wo) au lieu de « souci
  technique ». Reste : rembourser les 10 FCFA de Syndel (session
  cos-25xy8a9s81dc2, booking 3a3753e3-89b4-4342-9002-3bc89661e3fe).
  Même jour : **dashboard admin `/admin`** (voir §6) et **menu café** — Awa
  prend des commandes café dans le même lien Wave que la résa, prix depuis
  `cafe-menu.md` côté serveur uniquement (voir §4.13).
- **10/07 (après-midi)** : **revue de code complète + durcissement du chemin
  de paiement** (§4.14) — le plus grave : un crash pendant le traitement d'un
  webhook Wave pouvait perdre un paiement en silence (idempotence marquée trop
  tôt) ; corrigé + bail de fulfillment + sweep de réconciliation + anti-rejeu +
  timeouts partout. **Harnais de tests d'intégration** (14 scénarios sur le
  chemin de paiement, Postgres Docker, §4.15) — dès le premier run il a
  attrapé une mauvaise hypothèse (le happy path envoie 2 messages : confirmation
  + demande d'email client non relié). **Repo GitHub** (`babakar7/Awa-Revive`)
  connecté à Railway (push = déploiement) + **CI** à chaque push. Vu en prod
  après déploiement : un webhook Wave orphelin (client_reference absent de la
  DB — résidu des resets de test du matin, retry Wave inoffensif, à vérifier
  dans le portail) et des POST Wix sur `/webhooks/wix` inexistant (404 — Wix
  configuré côté site, endpoint jamais construit, chantier §4.7 en veille).
  Même jour (fin) : **bug « Reformer Women Only » corrigé** — ce cours était
  écrit en dur dans `business-info.md` ET `systemPrompt.ts` (exemple de variante
  Reformer) alors qu'aucun service correspondant n'existe dans le catalogue Wix
  (Foundation / Sculpt / Intense uniquement) → Awa le proposait à tort. Les deux
  mentions supprimées, déployé en prod. Leçon : ne JAMAIS nommer un cours
  spécifique dans business-info — le catalogue vient TOUJOURS de `list_classes`
  (live Wix) ; business-info ne contient que les règles métier que Wix n'expose
  pas (niveaux, tenue, prérequis). Même jour : **auto-deploy GitHub → Railway
  activé** (repo `babakar7/Awa-Revive`, branche `main`) — voir §7.
  Même jour (soir) : **email réception basculé SMTP → Brevo** (Railway bloque le
  SMTP) + **2e canal WhatsApp réception** avec repli template hors fenêtre 24h
  (§4.6) ; **messages interactifs cliquables** `present_options` + flux café
  1 clic = 1 article (§4.16) ; **fix « semaine prochaine »** = fenêtres de dates
  pré-calculées côté serveur (§4.17). **Décision transcription vocale** : la
  clientèle écrit surtout en fr/en (wolof marginal) → OpenAI `gpt-4o-mini-transcribe`
  retenu (banc d'essai wolof superflu), `OPENAI_API_KEY` posée ; implémentation
  PAS encore faite (intercepter les messages `audio` → download média Meta →
  transcription → injecter comme `[note vocale] …`, avec repli poli si échec).
- **10/07 (nuit)** : **trio UX** (§4.18) — relance one-shot après expiration
  d'un lien de paiement (sweeper + `expiry_nudged_at`), report en un geste
  (cancel + rebook orchestrés dans le prompt, nouveau créneau choisi avant
  d'annuler, OK explicite côté Wave), solde d'abonnement visible partout
  (contexte dynamique + check_membership, cache extrait dans
  `membershipContext.ts` et invalidé à chaque variation). 4 tests unitaires
  ajoutés (94 au total) ; intégration 14/14 verte.
- **10/07 (nuit, suite)** : **get_my_bookings élargi** (résas comptoir/site via
  contactId Wix, dédup, lecture seule), **menu proposé aux abonnés** (lien Wave
  café-seul `create_cafe_payment_link` + table `pending_cafe_orders`, route
  webhook café, confirmation client), **rappel 16h ajouté aux résas abonnement**
  (§4.19). 7 tests unitaires ajoutés (101 au total) ; intégration 14/14 verte.
  ⚠️ La forme de la réponse extended-bookings (get_my_bookings élargi) reste à
  confirmer sur de vraies données Wix.
- **10/07 (nuit, fin)** : **résa en un tap** (§4.20) — détection d'habitude
  (cours + jour + heure récurrents) proposée en raccourci cliquable, sans jamais
  court-circuiter check_availability. 5 tests unitaires (106 au total).

## 6. Reste à faire

**Tests E2E en attente :**
- [ ] Rembourser 50 FCFA du test groupe raté (portail Wave, session
  cos-25wmbc6bg1y6y) puis cliquer « ✅ Remboursement effectué » dans /admin
  (ou `refund:done -- af3124b4-e6da-4108-911c-322000b604ca` en secours).
- [ ] Achat d'abonnement via Awa ("test fusion" 50 FCFA) — flux vente jamais
  encore exercé en réel.
- [ ] Re-test groupe : 5 places Fusion (le cap Wix est maintenant 8).
- [ ] Test optionnel du refus < 16h (seul chemin annulation pas observé en réel).
- [ ] Commande café adossée à une résa (extras dans le lien Wave) — flux
  jamais encore validé E2E ; vérifier aussi l'email réception « commande café
  payée » et le détail dans la confirmation client.
- [ ] Relance lien expiré : laisser expirer un lien de 10 FCFA sans payer →
  UNE relance ~1 min après le TTL, puis répondre « oui » et vérifier qu'Awa
  refait le lien directement.
- [ ] Report en un geste : déplacer une résa abonnement (re-crédit + re-résa
  même tour) et une résa Wave (OK explicite avant annulation).
- [ ] Solde d'abonnement : « il me reste combien de séances ? » → chiffre
  cohérent avec Wix, décrémenté après une résa, re-crédité après annulation.
- [ ] get_my_bookings élargi : réserver une place au comptoir/site avec le
  numéro du testeur, puis « mes cours ? » → la résa studio apparaît en lecture
  seule. **Vérifier la forme réelle de la réponse extended-bookings** (nom du
  cours + heure) et ajuster `listContactUpcomingBookings` si besoin.
- [ ] Menu aux abonnés : réserver par abonnement puis commander un smoothie →
  lien Wave café-seul, paiement, confirmation client + email réception «☕ résa
  abonnement».
- [ ] Résa en un tap : après ≥2 résas d'un même cours/jour/heure, un nouveau
  « je veux réserver » doit proposer le raccourci « comme d'habitude ? » ; sur
  « oui », vérifier qu'Awa relance bien check_availability (pas de lien direct).

**Avant lancement (essentiellement côté Babakar, dans Wix) :**
- [ ] **Remettre `ADMIN_USERS` en prod** — le dashboard `/admin` est
  actuellement OUVERT sans login (choix explicite de Babakar pour la phase de
  test, 10/07). Indispensable avant toute communication publique.
- [ ] Activer **« Wait for CI »** sur le service Railway (Settings → Deploy)
  pour que les commits rouges ne se déploient pas (la CI seule ne fait que
  signaler).
- [ ] Vérifier dans le portail Wave la session du webhook orphelin du 10/07
  (client_reference `d5396719-ad49-...` — probablement un test de 10 FCFA
  d'avant reset de DB).
- [ ] Supprimer le plan "test fusion" + ses ordres ; masquer/supprimer
  "test service" ; remettre le vrai prix sur Pilates Fusion (10 FCFA de test) ;
  nettoyer les contacts test1/test2 (portent le vrai numéro de Babakar) et
  fusionner les doublons. → Ensuite : passe de vérif finale par l'API
  (catalogue/prix/contacts/plans).
- [ ] Relecture du wolof par un locuteur natif.
- [ ] Brief réceptionniste (emails d'Awa : handoffs, remboursements, comptes à
  lier, abonnements à activer) + plan de communication du numéro.
- [ ] Orange Money : reprendre à la réponse du support Sonatel (§4.12).

- [x] **Dashboard admin Awa** → **FAIT (10/07)** : `/admin` en production —
  Basic Auth 2 comptes (`ADMIN_USERS` : babakar + reception), vue d'ensemble
  (« à traiter » : remboursements avec bouton de pointage, abonnements à
  activer, handoffs 7 j + stats jour/7 j), conversations (recherche + fil
  complet avec appels d'outils repliés), réservations/abonnements filtrables,
  registre handoffs. Aucune action monétaire automatique (décision ferme).
  Code : `src/admin/` (auth.ts, queries.ts, routes.ts) — HTML server-rendered,
  zéro dépendance. `refund:done` conservé en secours CLI.

**Backlog Phase 2** (voir `PHASE2.md`) — tête de liste suggérée :
`get_my_bookings` élargi aux résas comptoir/site (lookup par contactId),
remboursements automatiques via l'API Wave (`POST /v1/checkout/sessions/:id/refund`),
vente d'abonnements par Awa, Orange Money, rappels de séance (templates Meta),
report en un geste, transcription vocale (décidée : OpenAI `gpt-4o-mini-transcribe`,
`OPENAI_API_KEY` déjà posée — reste à coder, voir chronologie 10/07 soir).

## 7. Runbook ops

- Déploiement : **auto-deploy actif** — `git push` sur `main` (repo
  `babakar7/Awa-Revive`) rebuild et redéploie tout seul sur Railway. Faire
  `npm run build && npm test` AVANT de pousser (et
  `npm run test:integration` si le chemin de paiement est touché — Docker
  requis, ~6 s). La CI GitHub Actions rejoue tout à chaque push ; tant que
  « Wait for CI » n'est pas activé côté Railway, elle SIGNALE mais ne bloque
  pas. Fallback manuel :
  `railway up --detach` (indépendant de GitHub ; ne PAS combiner avec un push
  pour un même changement = double build). Santé : `GET /healthz` ; logs :
  `railway logs`. La migration tourne au boot. (Historique : l'auto-deploy
  affichait « no project member has access to this repo » — résolu le 10/07 en
  connectant le repo au compte Railway, pas juste via l'install de la GitHub App.)
- Vars d'env : locales dans `.env` (secrets réels), prod via
  `railway variable set KEY=VALUE` (`--stdin` pour valeurs à espaces).
- DB prod (lecture/requêtes) :
  `docker run --rm postgres:16-alpine psql "$DATABASE_PUBLIC_URL" -c "..."`
  (URL publique : `railway variables --service Postgres --kv`).
- Remboursement : portail Wave → puis
  `DATABASE_URL=<url_publique> npm run refund:done -- <booking_id>`
  (`--list` pour voir les REFUND_NEEDED).
- Résumé quotidien : `npm run summary`. Test SMTP : `npx tsx scripts/test-email.ts`.
- Simulateur Wave local : `npm run simulate:wave` (`--bad-signature` pour le 401).
- `business-info.md` est lu AU BOOT → redéployer/redémarrer après édition.
