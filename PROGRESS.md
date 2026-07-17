# PROGRESS — Revive Bookings ("Awa")

> Journal d'avancement destiné à un agent (ou humain) qui reprend le projet.
> Dernière mise à jour : **15 juillet 2026** — **admin IA redesign** (inbox
> « À faire », sidebar groupée, recherche client globale, badges), cf. §4.34.
> Avant : notifications staff §4.32, livraisons bar, handoffs `wa.me`, lot
> exactitude & fermeture.
> Compléments : `README.md`, `PHASE2.md`, `ORANGE-MONEY-PLAN.md` (plan OM),
> `OM-LINKS-HOW-TO.md` (créer un lien de test), `WIX-WEBHOOK-PLAN.md` (EN VEILLE),
> `business-info.md`, `cafe-menu.md` (menu du bar),
> `PLAN-PACK-DECOUVERTE-ACTIVATION.md`.

## 1. Le projet en une minute

**Awa** est un agent IA sur WhatsApp qui répond aux clients du studio
fitness/bien-être **Revive** (Dakar) et réserve leurs cours dans **Wix
Bookings**, avec paiement préalable via **Wave**, **Orange Money / Max It**
(mobile money) ou via leur **abonnement** Wix. Stack : Node 20 / TypeScript /
Fastify / Postgres /
`@anthropic-ai/sdk` (modèle `claude-sonnet-5`, effort low, prompt caching).

**Invariant central : aucune réservation n'est créée dans Wix avant qu'un
paiement soit vérifié** (Wave : webhook signé ; OM/Max It : callback +
verify-by-lookup API ; ou séance d'abonnement décomptée par Wix). Le modèle
propose, le serveur décide : prix depuis le catalogue Wix uniquement, event_ids
validés contre `slot_cache` (anti prompt-injection), règle des 16h vérifiée
côté serveur.

## 2. État : TOUT LE PÉRIMÈTRE PHASE 1+ EST EN PRODUCTION ET VALIDÉ E2E

Production : `https://resabot-production.up.railway.app` (Railway, service +
Postgres), déployée depuis GitHub (`babakar7/Awa-Revive`, push sur main =
déploiement). Numéro WhatsApp prod : **+221 78 953 66 76** (WABA 1738439110507790,
phone_number_id 1175926012276896). Tests : ~287 unitaires (`npm test`, rapides,
sans réseau) + **34 d'intégration** sur les chemins de paiement Wave + OM, la santé DB et les escalades de liaison
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
| Annulation par Awa (règle 16h) | ✅ 06/07 | abonnement → re-crédit auto ; paiement Awa → remboursement enregistré sous 24h, réception prévenue |
| Handoffs (« je peux vous appeler ? », plaintes…) | ✅ | lien `wa.me` prénom + motif + email auto ; numéro brut ajouté seulement pour un appel explicite |
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
    cafeMenu.ts       menu du bar : parse cafe-menu.md au boot (prix côté serveur uniquement),
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
test/                 ~287 tests unitaires purs (signatures, state machine, langue…) — pas de DB/réseau
test/integration/     34 tests d'intégration (15 Wave + 15 OM/Max It + 1 healthz + 3 liaisons) : Postgres jetable (docker run,
                      globalSetup maison — PAS testcontainers, incompatible Node 20.17), mock fetch
                      Wix/Wave/OM/Meta/Brevo qui THROW sur tout appel inattendu — voir §4.12 / §4.15
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
   Abonnement → revert automatique du crédit ; paiement Awa (Wave/OM/Max It) →
   `REFUND_NEEDED`, remboursement enregistré pour traitement sous 24h +
   réception prévenue en parallèle (le client ne répète pas sa demande).
   < 16h → refus poli, sans
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
12. **Orange Money / Max It (13/07) — LIVE en prod.**
    ~~BLOQUÉ Sonatel (08/07 invalid_client)~~ **supersédé** puis **activé**.
    - **API** : OAuth `POST {OM_API_BASE}/oauth/token` form-urlencoded
      (client_id/secret/grant_type) ; QR `POST /api/eWallet/v4/qrcode` avec
      header **`X-Callback-Url`** = Awa webhook (per-request, comme le site
      `orangecheckout.jsw` — pas de registration merchant-level) ; `code`
      merchant **number** `553651` ; `metadata: {order, channel:"awa"}` echo
      sur le webhook ; `validity` en **secondes** (minutes × 60) ; réponse
      `deepLinks.OM` + `deepLinks.MAXIT` (+ `qrId`). Même deep link famille
      sugu.orange-sonatel.com — deux choix produit comme le site.
    - **Code** : `src/lib/orangeMoney.ts` ; webhook `POST /webhooks/orange-money`
      (`src/webhooks/orangeMoney.ts`) ; fulfillment partagé
      `src/domain/fulfillment.ts` (extrait de wave.ts) ; tools
      `payment_method` wave|orange_money|maxit sur create_payment_link /
      create_plan_payment_link / create_cafe_payment_link ; colonnes
      `payment_method` aussi sur plan/café. **Verify-by-lookup** obligatoire
      (`GET /api/eWallet/v1/transactions?transactionId=`) avant PAID/fulfill
      (callback non signé — anti-forgery). Idempotence `om:{transactionId}`
      marquée APRÈS fulfill (comme Wave).
    - **UX** : present_options 3 boutons Payer Wave / Orange Money / Max It
      (ids pay_wave / pay_om / pay_maxit) si méthode non nommée ; un lien HTTPS
      dans WhatsApp (pas d'image QR).
    - **Ops** : env Railway posés (`OM_CLIENT_ID`, `OM_CLIENT_SECRET`,
      `OM_MERCHANT_CODE=553651`, `OM_API_BASE=https://api.orange-sonatel.com`) ;
      `BASE_URL=https://resabot-production.up.railway.app`. Script test
      `npm run om:create-link -- 100` → écrit `om-last-links.txt` (gitignored) ;
      how-to `OM-LINKS-HOW-TO.md`. Plan détaillé `ORANGE-MONEY-PLAN.md`.
    - **Validé** : paiements manuels 100 F via liens OM **et** Max It OK
      (Babakar). Perf : 1er lien après deploy lent (token OAuth cold) →
      **warm token au boot + keep-alive 3 min** + logs
      `[om] createQrPayment token=…ms qr=…ms` (`86042b6`).
    - **Tests d'intégration OM (13/07)** : [test/integration/orange-money-webhook.test.ts](test/integration/orange-money-webhook.test.ts)
      (15 cas) sur Postgres jetable + fetch mock — même harness que Wave.
      Couvre : ack 200 sans signature, ignore non-MERCHANT / non-SUCCESS /
      payload incomplet, happy path callback → OAuth → GET transactions →
      BOOKED + confirmation WhatsApp, anti-forgery (lookup sans SUCCESS,
      montant bas, mauvais partner, order mismatch), idempotence
      `om:{transactionId}` (doublon + 2e txn après BOOKED), lookup en 500
      **non** marqué processed puis retry OK, REFUND_NEEDED si créneau plein.
      Env dummy dans globalSetup (`OM_CLIENT_*`, `OM_MERCHANT_CODE=553651`,
      `OM_API_BASE=https://api.orange-sonatel.test`) ; mock étendu dans
      [helpers.ts](test/integration/helpers.ts) (`deliverOmWebhook`, état
      `om.transactions` / `failLookup`). Suite intégration : **30** tests
      (15 Wave incl. DRAFT→BOOKED + 15 OM).
    - **Poller search transactions ABANDONNÉ (13/07, `5df41cb`)**. Probe live
      merchant `553651` : `GET …/transactions?fromDateTime&toDateTime` →
      HTTP 200, SUCCESS listés (amount, partner, customer, type), mais
      **`metadata.order` jamais présent** (souvent `idempotencyKey` seul, ou
      champs Wix site ; `reference` toujours null). Impossible de joindre un
      paiement listé à un pending Awa sans risque de mauvais rattachement.
      Code retiré : `reconcileAwaitingOmPayments`, `searchSuccessfulTransactions`,
      `awaitingOmPaymentCandidates` ; plus dans le sweep 60 s. **Filet OM =
      webhook callback + verify-by-lookup `transactionId` uniquement** ;
      recoupement manuel portail si callback perdu. Rouvrir seulement si
      Sonatel echo le metadata du QR create (`order` / `channel: awa`).
    - **Reste** : E2E résa Awa complète (choix dans le chat → pay → ✅ WhatsApp)
      à confirmer si pas déjà fait ; ack/retry Sonatel si payload atypique
      (logs `OM webhook received`).
13. **Menu du bar (10/07)** : commande bar adossée à une résa, dans le MÊME lien
    Wave (`amount_xof` = grand total cours + bar). `cafe-menu.md` (éditable par
    le propriétaire : `- ID | Nom | prix | description`, IDs stables, lu AU BOOT
    comme business-info ; fichier invalide = boot en échec, fichier absent =
    bar désactivé proprement) est la source de vérité des prix — même posture
    anti-injection que slot_cache : le modèle ne passe que des `item_id` + `qty`
    (param `extras` de create_payment_link, max 15 lignes, qty 1-10) et le
    serveur résout tout via `computeExtras` (id inconnu → rejet avec la liste
    des ids valides, pas de clamp silencieux). Stockage sur la ligne booking :
    `extras_json`, `extras_amount_xof`, `order_note` (timing, lait, allergies —
    défaut « prête après le cours »). Après paiement : notification réception
    « ☕ Commande bar payée » + détail dans la confirmation client (fr/en/wo) ;
    en cas de remboursement, la note réception précise que la commande ne doit
    PAS être préparée, et cancel_booking signale que le total remboursé inclut
    le bar. Règles prompt : pas de bar sans résa ni sur résa par abonnement
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
    Wave — 15 scénarios : signature, happy path, paiement tardif, DRAFT→BOOKED
    (orphelin), doublons, 3 causes de remboursement, PAID bloqué (retry/sweep/
    bail), retriabilité. OM/Max It — 15 scénarios (13/07) : voir §4.12
    (verify-by-lookup, anti-forgery, idempotence `om:…`, retry après lookup 500 ;
    **pas** de poller search — abandonné). Total intégration **30**. AUCUN secret
    réel requis. CI GitHub Actions (`.github/workflows/ci.yml`) : tsc + unit +
    intégration à chaque push ; « Wait for CI » à activer côté Railway pour
    bloquer les déploiements rouges (pas seulement les signaler).
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
    bar sans va-et-vient : **1 clic = 1 article, jamais « combien ? »** ; les
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
      paiement, donc le bar voyage désormais dans SON PROPRE petit lien Wave
      (bar seul). Awa propose le menu APRÈS book_with_membership (qui renvoie
      maintenant `booking_id`), et si le client commande, crée le lien bar —
      prix 100 % serveur via `computeExtras`, rattaché au booking par
      `linked_booking_id` (même contrôle de propriété que cancel_booking : résa
      du client, BOOKED, membership, à venir). AUCUNE création Wix : le webhook
      Wave route booking → plan → bar order ([wave.ts](src/webhooks/wave.ts)
      `processCafePayment`), marque PAID, notifie la réception « ☕ commande bar
      payée (résa abonnement) » et envoie la confirmation client
      (`cafeConfirmationMessage`, fr/en/wo). TTL/expiration : un lien bar actif
      par client (`expireActiveCafeOrders`), sweep TTL dans le sweeper 60 s.
      Toujours pas de bar sans AUCUNE résa (comptoir).
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

21. **Book-first, menu-after — le bar n'est PLUS jamais dans le lien du cours (10/07)**.
    Changement de fond après un bug observé en prod : Awa sautait parfois la
    proposition de menu (conflit de prompt « crée le lien tout de suite » vs
    « propose le menu avant le lien ») et bundlait un catalogue de catégories.
    Cause racine : la proposition n'était QU'UNE règle de prompt, non enforced,
    et elle se percutait avec la règle dure de création du lien. Nouveau modèle,
    unifié avec le flux abonnement : **on réserve/paie le cours d'abord, on
    propose le bar ensuite, en lien Wave SÉPARÉ.**
    - `create_payment_link` = cours SEUL : params `extras`/`order_note` retirés,
      bloc extras supprimé, le lien ne porte plus jamais de bar
      ([tools.ts](src/agent/tools.ts)). Plus aucune tension avec la règle dure.
    - **Flux Wave** : après paiement confirmé, le webhook envoie la confirmation
      PUIS propose le menu automatiquement — present_options 2 boutons
      [Voir le menu 🥤 (cafe_after_booking_yes)] / [Non merci 🙏🏾 (…_no)]
      ([wave.ts](src/webhooks/wave.ts) `proposeCafeMenuAfterBooking`, copy fr/en/wo,
      non bloquant, tour loggé). Le tap revient dans le modèle, qui présente les
      incontournables puis crée le lien bar. Guard : sauté si la résa portait
      déjà des extras (legacy).
    - `create_cafe_payment_link` ouvert aux résas **Wave OU abonnement** (garde =
      résa du client, BOOKED, à venir — la contrainte `membership` a sauté).
      `linked_booking_id` désormais OPTIONNEL : vide ⇒ rattaché à la dernière
      résa à venir du client (`repo.latestUpcomingBooking`, tri `created_at desc`)
      — indispensable côté Wave où le booking naît dans le webhook, le modèle n'a
      jamais ce booking_id.
    - **Flux abonnement inchangé** : Awa déclenche l'offre elle-même dans le tour
      (book_with_membership renvoie booking_id → menu → create_cafe_payment_link).
    - Compromis assumé (validé produit) : la conversion bar baisse (2ᵉ paiement
      Wave) mais le chemin de réservation n'a plus aucune friction et le bug de
      skip disparaît par construction. Build + 106 tests OK.
    - ⚠️ Reste : le lien bar-seul en attente n'est PAS surfacé dans le contexte
      dynamique (comme avant pour l'abonnement) — si le client demande « c'est
      toujours valable ? » pour un lien bar, Awa n'a pas l'info live. À ajouter
      si le bar devient très fréquent.
    - **Addendum (10/07 soir)** : test réel → dans le flux abonnement, le modèle
      posait ENCORE une question texte (« tu veux quelque chose du menu ? ») au
      lieu de montrer la liste, malgré le prompt (il imite ses vieilles tournures
      de l'historique). Leçon : une présentation obligatoire ne se confie pas au
      prompt. Désormais **le SERVEUR envoie la liste des incontournables dans les
      DEUX flux** : webhook Wave après la confirmation de paiement, et agent loop
      après un book_with_membership réussi ([index.ts](src/agent/index.ts) —
      flags `membershipBooked`/`cafeMenuShown`, envoi post-réponse, anti-doublon
      si le modèle a déjà montré des items bar). Copy partagée dans
      [cafeOffer.ts](src/lib/cafeOffer.ts) (`sendCafeMenuOffer`, fr/en/wo). Le
      prompt et la note de book_with_membership disent maintenant au modèle de NE
      PAS proposer le menu lui-même.

22. **Résa abonnement multi-personnes (10/07)** — un client peut désormais amener
    PLUSIEURS personnes sur SON propre abonnement en une seule réservation.
    `book_with_membership` accepte un paramètre `participants` (1-10, défaut 1) :
    autant de séances décomptées du plan du client (redeem `count: N`,
    [wix.ts](src/lib/wix.ts)), autant de places dans la résa Wix
    (`createBookingRaw({ participants })`), stockées sur la ligne
    (`createMembershipBooking({ participants })`, [repo.ts](src/domain/repo.ts)).
    **Tout ou rien** (décision produit Babakar) : mêmes gardes serveur que le flux
    Wave de groupe, dans l'ordre AVANT tout décompte — plafond
    `maxParticipantsPerBooking` du service (`group_too_large`), places libres
    re-vérifiées pour N (`isSlotStillOpen(..., N)`), et surtout **solde suffisant
    pour TOUT le groupe** (`participants > benefit.available` →
    `not_enough_sessions`, le prompt renvoie vers Wave pour le total ou un groupe
    plus petit — jamais de couverture partielle du plan). Annulation : le revert
    d'une seule transaction re-crédite déjà les N séances (un redeem = une
    transaction) — messages client/réception passés au pluriel
    (`sessions_recredited`). Un abonnement reste NOMINATIF : le client dépense SES
    séances pour ses invités ; on ne débite jamais l'abonnement d'un tiers (prompt).
    Build + 109 tests unitaires OK. Intégration (webhook Wave) non touchée.

23. **Planning des cours en image (10/07)** — « je veux le planning » a maintenant
    un vrai chemin : nouvel outil `get_class_schedule` qui envoie au client la
    **grille hebdo lundi → dimanche SANS dates** (décision produit Babakar : le
    client veut l'emploi du temps du studio, pas des dispos datées) en **image
    PNG générée à la volée depuis Wix** — jamais d'image statique qui périme
    (même famille de piège que « Reformer Women Only »).
    - **Données** : `queryAvailabilityMulti` ([wix.ts](src/lib/wix.ts)) — le
      filtre availability accepte nativement un tableau de service ids, donc
      UN seul appel Wix pour tous les cours sur 7 jours ; les créneaux sont
      projetés sur les jours de semaine et dédupliqués
      (`buildWeeklyGrid`, pure et testée). Piège évité : l'ancienne
      `queryAvailability` tolérait un `slot.serviceId` absent (repli sur l'arg) ;
      le comportement est préservé en mono-service, en multi une entrée sans
      serviceId est inattribuable → ignorée.
    - **Rendu** : [scheduleImage.ts](src/lib/scheduleImage.ts), `@napi-rs/canvas`
      (pas de Puppeteer — trop lourd pour Railway) + polices DejaVu embarquées
      dans `assets/fonts/` (rendu identique local/CI/Railway, indépendant des
      polices du conteneur ; police absente = throw explicite, jamais un rendu
      au texte invisible). Layout vertical téléphone : bandeau par jour,
      lignes heure — cours — durée. Le rendu est 100 % serveur : le modèle ne
      touche jamais aux données de la grille (posture anti-injection habituelle).
    - **Envoi** : `sendImage` ([whatsapp.ts](src/lib/whatsapp.ts)) — upload
      `POST /{phone}/media` puis message `type:"image"` par media id (pas d'URL
      publique à héberger). L'outil délivre lui-même (comme present_options),
      logge le tour, et demande au modèle UN court suivi « lequel te tente ? ».
    - **Cache 30 min** (grille + PNG, partagés entre clients — la grille est
      sans dates donc sans info par-client). **Repli texte** à chaque étape
      (rendu raté OU envoi raté → le tool renvoie la version texte groupée par
      jour, jamais de client sans réponse).
    - **Prompt** : nouvelle règle 1a (planning global → get_class_schedule) ;
      1b reste le chemin « créneaux d'UN cours ». La grille n'ayant ni dates ni
      places restantes, toute résa repasse par check_availability (les
      event_ids réservables restent ceux servis par check_availability, rien
      ne change côté slot_cache).
    - 9 tests unitaires (118 au total). E2E à faire : demander « le planning »
      en réel et vérifier image + suivi (et le rendu des polices sur Railway).

24. **Quatuor UX (11/07)** — images entrantes lisibles, bar sans résa, dates
    explicites, reçu/facture.
    - **Awa lit les images** ([imageInput.ts](src/lib/imageInput.ts)) : un message
      `image` est téléchargé via l'API média Meta (réutilise
      `downloadWhatsAppMedia` de transcribe.ts) puis DÉCRIT par le modèle
      (appel Anthropic dédié, prompt de description factuelle qui retranscrit
      le texte visible : montants, dates, ids de transaction) ; la description
      est injectée comme tour user `[image reçue] …` (+ `[légende du client] …`
      si le client a mis une légende) — même patron que `[note vocale]`,
      l'historique reste 100 % texte. Échec de lecture → `handleFailedImage`
      (repli poli, fr/en). Le message « média non supporté » ne dit plus « je
      ne lis que le texte » (faux depuis les vocaux).
      **Règle prompt CRITIQUE ajoutée : une capture d'écran de paiement Wave
      est une AFFIRMATION, jamais une preuve** — le cas d'usage n°1 attendu est
      « j'ai payé, regarde 📷 » ; Awa reconnaît la capture, explique que la
      confirmation est automatique, ne confirme JAMAIS une résa sur capture
      (seul le webhook signé compte — invariant paiement-d'abord inchangé).
    - **Commande bar SANS résa, sur demande explicite** (décision produit
      Babakar 11/07) : `create_cafe_payment_link` sans résa à venir crée
      désormais une commande autonome (`linked_booking_id` null — la colonne
      était déjà nullable) au lieu de refuser ; retrait au comptoir, « prête
      dès que possible » par défaut (confirmation client + note réception
      adaptées, sujet « ☕ sans réservation »). Un `linked_booking_id` explicite
      qui ne matche pas reste une erreur (pas de repli silencieux). Côté
      prompt : Awa ne PROPOSE jamais le menu à un client qui ne réserve pas —
      elle répond seulement à une demande explicite.
    - **Dates explicites hors fenêtres** (suite du fix « semaine prochaine »
      §4.17) : le bloc Date windows du contexte dynamique liste maintenant
      AUSSI les 7 prochains jours nommés (« vendredi 12 juillet: … ») et une
      règle pour les dates calendaires explicites (« le 3 août ») : recopier la
      date littérale en fenêtre T00:00:00Z → T23:59:59Z, année courante (ou
      suivante si passée), SANS aucune arithmétique ; les expressions relatives
      restent cantonnées aux fenêtres pré-calculées, sinon demander la date
      concrète au client.
    - **Reçu / facture** : ajouté à la liste handoff du prompt (l'appli Wave
      montre au client son propre historique ; toute facture formelle vient de
      la réception).
    - 9 tests unitaires ajoutés (127 au total : parsing image + légende,
      `imageTurnText`, confirmations bar standalone fr/en/wo) ; intégration
      14/14 verte. E2E à faire : envoyer une vraie capture Wave à Awa, et une
      commande bar sans résa payée en réel.

25. **Quatuor UX bis (11/07)** — liste d'attente, annulation des résas studio,
    coachs visibles, lien bar dans le contexte.
    - **Liste d'attente sur cours complet** ([waitlistSweep.ts](src/domain/waitlistSweep.ts),
      table `waitlist_entries`) : sur un créneau plein que le client veut quand
      même, Awa propose la liste d'attente (outils `join_waitlist` /
      `leave_waitlist`). Le sweep 5 min re-vérifie la dispo (UN appel
      `queryAvailabilityMulti` groupé pour toutes les entrées) et envoie UNE
      relance WhatsApp par entrée quand une place se libère (claim atomique
      WAITING→NOTIFIED AVANT envoi, comme la relance lien expiré ; tous les
      inscrits du créneau sont prévenus, premier arrivé premier servi — AUCUNE
      place n'est retenue, le flux paiement-d'abord reprend normalement).
      **Compromis assumé (décision Babakar 11/07) : pas de template Meta** —
      hors fenêtre 24h l'envoi échoue (131047) → statut NOTIFY_FAILED, loggé,
      jamais retenté. Server-authoritative : join_waitlist re-vérifie le slot
      en live (`findSlot`) — slot inconnu = erreur, slot en fait OUVERT = « pas
      besoin de liste, réserve-le ». Pour ça, check_availability expose
      désormais l'event_id AUSSI sur les créneaux pleins (toujours pas de
      choice_id ni de slot_cache → toujours impayables). Entrées expirées en
      silence quand le cours démarre.
    - **Annulation des résas studio** (décision produit Babakar 11/07) :
      get_my_bookings donne aux résas comptoir/site un `booking_id`
      `studio:<wix id>` et cancel_booking les accepte — propriété re-vérifiée
      en live (l'id doit figurer dans `listContactUpcomingBookings` du contact
      du client), règle 16h identique, annulation Wix, puis **l'argent reste
      humain** : Awa ne connaît pas le mode de paiement (cash ? OM ? plan ?)
      → le client est invité à contacter la réception ET la réception reçoit
      un email « vérifier remboursement/re-crédit ». Jamais de promesse de
      montant ni de délai.
    - **Coachs visibles** : l'availability Wix porte le coach dans
      `slot.resource.name` (VÉRIFIÉ en live le 11/07 — ex. « yves SAGNA » sur
      Aquabike). `WixSlot.coach` extrait dans queryAvailabilityMulti, exposé
      champ `coach` dans check_availability, règle prompt : le nom du coach ne
      vient QUE de là (jamais inventé), coachs différents par créneau = le dire,
      « je veux le cours de X » = filtrer les slots par ce champ.
    - **Lien bar dans le contexte dynamique** (le ⚠️ de §4.21 soldé) :
      `activeAwaitingCafeOrder` injecté à chaque message (articles, total,
      minutes restantes, lien, résa liée ou commande comptoir) + sweep TTL bar
      dans le lazy sweep de l'agent. « Mon lien smoothie est encore bon ? » a
      maintenant une réponse sûre.
    - 4 tests unitaires ajoutés (131 au total) ; intégration 14/14 verte.

26. **Cas Marie (11/07) — bug réel get_my_bookings élargi + leçons.** Marie
    (abonnée, résas Reformer récurrentes prises en réception) a écrit à Awa :
    get_my_bookings a répondu « aucune réservation » et Awa a proposé de lier
    son compte par email alors qu'il était DÉJÀ rattaché. Diagnostic en live :
    - **Bug confirmé et corrigé** (le ⚠️ de §4.19) : le filtre extended-bookings
      `booking.contactDetails.contactId` n'existe pas → 400 Wix, avalé par le
      code défensif → liste toujours vide. Le bon chemin est
      **`contactDetails.contactId`** (sans préfixe booking.). Vérifié aussi :
      `status` filtrable côté serveur ($in CONFIRMED/PENDING), les filtres de
      DATE renvoient 200 avec 0 ligne (silencieusement inutilisables) → le tri
      « à venir » reste client-side ; la page par défaut fait 50, NON triée
      (vieilles résas d'abord) → **pagination obligatoire** (limit 100, offset,
      cap 500) pour les habituées à gros historique (Marie : 81 résas).
    - **Le rapprochement compte/abonnement, lui, MARCHAIT** : contact trouvé
      par e164 (+221774446666 → « Marie KA CISSE »), plan « 1x reformer
      1x yoga » détecté, et « l'Aquabike n'est pas couvert » était factuellement
      juste. Fix prompt : ne JAMAIS proposer la liaison email quand le contexte
      montre déjà un abonnement/des résas (compte forcément rattaché) ; une résa
      introuvable ≠ compte non lié.
    - **Constat ops (à traiter côté studio)** : Marie n'a AUCUNE résa à venir
      dans Wix — ses créneaux récurrents lun/jeu 11h15 ne sont pas réservés
      dans Wix par la réception. Tant que c'est le cas, ni Awa ni le site ne
      peuvent voir/déplacer ces cours, et les places semblent libres pour les
      autres clientes. → Brief réception : matérialiser les récurrences en
      vraies résas Wix.
    - **Fix prompt (2e passe, même jour)** : l'intention réelle de Marie était
      d'ÊTRE réservée pour lundi (pas encore bookée). Nouvelle règle : quand un
      client évoque un cours qu'il croit avoir et que get_my_bookings ne trouve
      rien, ne pas s'arrêter à « introuvable » ni renvoyer vers la réception —
      dire que le créneau n'est pas encore réservé et proposer IMMÉDIATEMENT de
      le réserver (check_availability puis book_with_membership si le plan
      couvre, sinon lien Wave).
    - **Matching des numéros sans e164 (3e passe, même jour)** : audit prod =
      sur 100 contacts, 19 sans téléphone, 13 avec un numéro stocké BRUT sans
      e164 (« 774396392 », « 71 013 62 46 ») → invisibles pour le filtre
      e164Phone $eq. Décision Babakar : un numéro commençant par 7 = sénégalais
      la plupart du temps, il faut matcher aussi sans format international.
      `phoneMatchVariants` ([wix.ts](src/lib/wix.ts), pure, testée) génère les
      écritures possibles (e164, chiffres nus, 00-préfixe ; + local 9 chiffres
      et groupé « 77 444 66 66 » UNIQUEMENT pour +2217…, un local nu serait
      ambigu pour les autres pays) ; findContactIdByPhone retombe sur un
      `info.phones.phone $in variantes` quand l'e164 ne matche pas (champ
      vérifié live : matche la chaîne stockée, espaces compris). Vérifié en
      réel : Adja (brut) et Pelny (espacé) matchent désormais, Marie (e164)
      inchangée. Même prudence qu'avant sur les doublons (tiebreak prénom,
      sinon null). 4 tests (135 au total).

27. **Chasse aux pannes silencieuses + hygiène CRM (11/07)** — suite du cas
    Marie, audit des autres endroits où une API Wix peut échouer/tronquer sans
    bruit.
    - **BOMBE DÉSAMORCÉE — listActiveMemberships sans pagination** : l'endpoint
      orders plafonne limit à 50 (au-delà = erreur) et la prod compte DÉJÀ
      46 commandes de plans ACTIVE → à 4 ventes près, les abonnées au-delà de
      la 1re page devenaient invisibles (« tu n'as pas d'abonnement » à tort,
      paiement Wave demandé en double). Corrigé : boucle offset jusqu'à
      `pagingMetadata.hasNext=false` (cap 1000).
    - **Vérifiés sains** : members query (`filter:{contactId}` — ma sonde avec
      `profile.contactId` 400ait, le code réel est bon, prouvé E2E par Marie) ;
      getBookingStatuses (`id $in`, exercé par le sweep annulations en prod) ;
      chemin Benefit Programs (E2E). **Risque théorique noté** : listServices
      et listPlans sans pagination (~15 services, < 100 plans — inoffensif à
      l'échelle actuelle, à paginer si le catalogue explose).
    - **Audit CRM → alerte réception** (`npm run crm:audit`, `--dry` pour
      stdout ; [scripts/crm-audit.ts](scripts/crm-audit.ts)) : parcourt les
      743 fiches Wix, email à la réception listant **155 fiches sans téléphone**
      (à jamais inmatchables par Awa → ajouter le numéro WhatsApp) et
      **52 numéros portés par plusieurs fiches** (tiebreak prudent d'Awa →
      fusionner dans Wix). Envoyé le 11/07 (Brevo). À relancer après une passe
      de nettoyage, ou périodiquement.

28. **Abonnement revendiqué mais introuvable → réception notifiée automatiquement
    (11/07, cas Dieynaba)**. Cas réel : Dieynaba Ba écrit du 77 638 30 88, sa
    fiche Wix porte 78 638 30 88 (un chiffre d'écart) → `check_membership` =
    `no_matching_contact` (comportement VOULU : l'identité, c'est le numéro
    vérifié ; jamais de match par prénom déclaré, sinon n'importe qui consomme
    les séances d'autrui). Awa a bien proposé « contacte la réception »… mais
    personne n'a été prévenu : la cliente a dit merci et a disparu — **cliente à
    abonnement perdue en silence** (le flux email ne se déclenche qu'après un
    paiement, jamais arrivé). Correctif, même philosophie que le menu (#21) :
    **ce qui est obligatoire est fait par le serveur, pas laissé au modèle**.
    - `check_membership` accepte `claim: true` (le client AFFIRME avoir un
      abonnement). Sur claim + échec (`no_matching_contact` OU fiche sans plan
      actif), l'exécuteur notifie la réception automatiquement
      ([tools.ts](src/agent/tools.ts) `notifyUnverifiedPlanClaim`) : email +
      WhatsApp avec nom, numéro, et le mode d'emploi (chercher la fiche par NOM,
      AJOUTER le numéro WhatsApp au format +221 sans écraser l'ancien). Dédup
      24 h par client via le registre handoffs (`repo.recentHandoffExists`) —
      un client qui insiste ne spamme pas la réception.
    - Le résultat de l'outil dit à Awa quoi répondre : l'équipe est DÉJÀ
      prévenue (pas besoin d'appeler), demander sous quel numéro/email
      l'abonnement est enregistré (email → `record_email`), proposer Wave pour
      les résas urgentes. Prompt §Abonnements aligné.
    - L'entrée handoffs alimente aussi `npm run summary` (registre quotidien).

29. **Page /admin/crm — nettoyage des doublons en un clic (11/07)**. Suite de
    l'audit §4.27 : nouvel onglet « CRM 🗂 » dans le dashboard.
    - **Doublons** : un card par numéro en doublon (52 au 11/07), un SEUL
      bouton « Fusionner ces N fiches » par groupe (même geste que dans Wix —
      demande produit Babakar). La fiche conservée est choisie par le SERVEUR
      (`pickMergeTarget`, pure et testée) et affichée « ✓ conservée » avant le
      clic : 1) la fiche qui porte un abonnement actif 🎫 (Wix ne garantit pas
      qu'un plan survive à une fusion côté source, et refuse les
      contacts-membres comme sources — donc la porteuse du plan reste
      TOUJOURS), 2) sinon la fiche au numéro e164, 3) sinon la plus ancienne.
      Plusieurs fiches à abonnement dans un même groupe = fusion bloquée
      (à trancher dans Wix). Fusion via l'API Merge (fiches sources
      supprimées — irréversible, confirm() explicite).
    - **API Merge vérifiée E2E** sur deux contacts jetables créés/supprimés
      pour l'occasion : le corps réel est `sourceContactIds` +
      `targetContactRevision` (la révision de la cible est OBLIGATOIRE —
      concurrence optimiste). Découverte au passage : Wix REFUSE de créer un
      doublon exact par l'API (409) — les doublons prod viennent des
      orthographes différentes d'un même numéro (brut vs e164), qui échappent
      au contrôle d'unicité.
    - **Garde-fous serveur** (une fusion est irréversible, on ne fait jamais
      confiance au formulaire) : le POST ne reçoit QUE le groupe — la fiche
      conservée est recalculée côté serveur avec la même règle que l'affichage ;
      chaque fiche est re-fetchée par id et la fusion est REFUSÉE si toutes ne
      partagent pas le même numéro normalisé ; échec Wix → bannière d'erreur,
      action loggée avec l'admin user.
    - **Fiches sans téléphone** : listées sur la même page (repliées), à
      compléter dans Wix. Logique partagée script/page extraite dans
      [crmAudit.ts](src/lib/crmAudit.ts) (`auditContacts` pure + testée,
      `phoneKey` = 9 derniers chiffres) ; `npm run crm:audit` (email réception)
      pointe maintenant vers la page. Smoke-test local : page 200, 52 groupes
      rendus, merge vide/numéros différents → refus propre. 8 tests ajoutés
      (139 au total).
    - **⚠️ Contrainte Wix découverte au premier clic réel (Dieynaba Anna Dia,
      11/07)** : Wix répond **428 « Cannot merge contact with membership
      status »** quand une fiche source est un **compte membre** (login site) —
      impossible de fusionner deux membres entre eux, par l'API comme dans le
      dashboard. Refonte `planMerge` ([crmAudit.ts](src/lib/crmAudit.ts), pure,
      testée) : les comptes membres 👤 et porteurs d'abonnement 🎫 ne sont
      JAMAIS des sources — priorité de cible membre+plan > membre > plan >
      e164 > plus ancienne ; le bouton ne fusionne que les fiches fusionnables
      et affiche « reste telle quelle (protégée) » pour les autres ; groupes
      100 % membres = fusion impossible, signalé (9 groupes sur 51 au 11/07 —
      44 fiches membres parmi les doublons !). Détection membres en 1 requête
      batch (`findMemberContactIds`, filtre `contactId $in` vérifié live).
      Fusion Dieynaba rejouée avec succès (fiche WIX_FORMS absorbée, les 2
      comptes membres subsistent — leur fusion est un chantier Wix support/
      manuel). Fix bonus : le log d'échec de fusion loggait `{e}` (objet vide
      en pino) → `{err}`. 145 tests.
    - **Priorisation (11/07, demande Babakar)** : les groupes de doublons
      impliquant un **abonnement actif** sont remontés en tête dans une section
      « 🔴 Prioritaires — une abonnée active n'est pas reconnue » (card orangé,
      badge rouge) : ces clientes paient un plan qu'Awa ne voit pas tant que le
      doublon existe (match ambigu → « pas d'abonnement » → Wave proposé à
      tort). 4 groupes concernés au 11/07. Tri secondaire : les groupes
      fusionnables en un clic avant les groupes 100 % membres.
    - **« ✅ Traité dans Wix » sur les groupes non fusionnables (11/07, demande
      Babakar)** : les groupes 100 % comptes membres (réglés à la main dans
      Wix, ou assumés tels quels) peuvent être marqués traités → masqués de la
      liste, restaurables depuis une section repliée « Groupes marqués
      traités ». Table `crm_dismissed_duplicates` avec **signature du groupe**
      (hash des ids triés, `duplicateGroupSignature`) : si la composition du
      groupe change (fiche ajoutée/fusionnée), la signature change et le groupe
      RÉAPPARAÎT tout seul — un « traité » ne peut pas masquer un problème
      nouveau. Action loggée avec l'admin user, non destructive.
    - **Fiches sans téléphone priorisées par activité (11/07, demande
      Babakar)** : bloc « 🔴 Actives — à compléter en premier » au-dessus des
      fiches dormantes repliées. « Active » = résa à venir 📅, **résa dans les
      30 derniers jours** (badge « résa < 30 j ») OU abonnement 🎫.
      `contactBookingActivity` ([wix.ts](src/lib/wix.ts), ex
      `contactIdsWithUpcomingBookings`) renvoie deux sets `upcoming`/`recent`
      depuis le MÊME batch extended-bookings (`contactId $in`, vérifié live) —
      le cut passé/futur est fait côté serveur (filtre date Wix inutilisable).
      L'ajout des 30 j fait passer les actives de 9 à 33 / 122 dormantes.

30. **Liaison de compte par email vérifié — le client se relie TOUT SEUL (11/07,
    cas Rokhaya)**. Suite du §28 : la notification réception marchait, mais la
    résolution restait manuelle (chercher la fiche dans Wix, éditer le numéro)
    — lent, faillible, cliente bloquée entre-temps, et chaque paiement Wave
    dans cet état crée une fiche doublon. Décision produit (Babakar) : liaison
    self-service par email + code, repli réception en 1 clic.
    - **Flux self-service** : claim d'abonnement introuvable → Awa propose
      « donne-moi l'email de ton compte Revive » (ignorable — un nouveau client
      continue normalement) → `request_email_verification` trouve la fiche par
      email et envoie un **code 6 chiffres à CET email** (Brevo,
      `sendVerificationCodeEmail`) → le client le recopie sur WhatsApp →
      `submit_verification_code` AJOUTE le numéro WhatsApp à la fiche Wix →
      abonnement visible immédiatement (cache membership invalidé). La preuve
      d'identité = l'accès à la boîte mail (équivalent de ce que ferait la
      réception). `record_email` absorbé par le nouveau flux.
    - **Sécurité anti-injection** : le code n'existe qu'en `sha256(code:id)`
      en DB et ne transite QUE par l'email — jamais dans un résultat d'outil ni
      un message d'Awa (un prompt-injecté n'a rien à extraire). Comparaison
      serveur `timingSafeEqual`, TTL 10 min, 5 essais max, 3 emails/24 h par
      client, jamais le nom de la fiche dans un résultat (anti-énumération
      d'emails). Le contact_id est résolu serveur, jamais fourni par le modèle.
    - **Sondes live (contact jetable créé/supprimé)** : le filtre
      `info.emails.email` est filtrable et **insensible à la casse** ($eq
      suffit) ; **PATCH contacts/v4 remplace le tableau `phones` ENTIER**
      (toujours renvoyer les items existants — `appendPhoneItems` pure) ;
      `revision` obligatoire (400 sans, 409 périmée → retry 1×) ; un numéro SN
      envoyé en `countryCode:"SN"` + 9 chiffres locaux → Wix calcule
      `e164Phone` lui-même.
    - **Replis vers la réception** (file `link_requests`, une demande ouverte
      par client via index partiel) : pas d'email, email introuvable ou partagé
      par plusieurs fiches, 5 codes faux, échec technique, ou **silence >30 min**
      (sweep 60 s, `escalateStaleLinkRequests` — le « merci puis disparaît » du
      §28 reste couvert, résistant aux restarts). Dédup notif :
      `reception_notified_at` + registre handoffs 24 h.
    - **Liaison 1 clic** (/admin/crm, section « 🔗 Liaisons en attente ») :
      fiches candidates calculées serveur (`linkCandidates` — email déclaré
      insensible casse/accents OU prénom ≥3 lettres, badge 🎫), bouton « Lier
      cette fiche » avec garde-fous pattern merge (demande re-lue, fiche
      re-fetchée, **refus si le numéro vit déjà sur une AUTRE fiche** = c'est
      une fusion) ; après liaison : cache invalidé + WhatsApp au client
      (best-effort, 131047 → bannière « non prévenu »).
    - **Piège doublon post-paiement** : si un paiement Wave a déjà créé une
      fiche doublon sous le numéro WhatsApp, la vérification réussit mais le
      lookup devient ambigu → statut `verified_pending_merge`, notif réception
      « fusion 1 clic » (section Doublons) — ne JAMAIS dire au client que
      l'abonnement est visible tant que la fusion n'est pas faite.
    - **Audit abonnées injoignables** (`auditActiveSubscribers` pure) : croise
      les orders ACTIVE avec les fiches — fiche manquante, sans téléphone, ou
      numéro illisible pour le matching (`phoneSpellingMatchable`, variantes
      injectées pour éviter un cycle wix↔crmAudit). Section « 🎫 Abonnés
      injoignables » sur /admin/crm + priorité 1 de `npm run crm:audit` :
      exactement la population d'où sortent les cas Rokhaya/Dieynaba, à
      compléter AVANT qu'elles écrivent.
    - Prompt §Abonnements et §Linking réécrits : Awa ne connaît jamais le code
      et ne peut ni l'envoyer ni le confirmer ; après `verified` elle PEUT dire
      que le compte est relié (avant, jamais). 169 tests.
    - ~~⚠️ À faire au prochain déploiement : remettre `ADMIN_USERS` en prod~~
      **Résolu (13/07)** : login fallback en dur `revive`/`revive` quand
      `ADMIN_USERS` est vide ([admin/auth.ts](src/admin/auth.ts)) — la page
      n'est plus jamais servie sans login.

31. **Boucle de résultat — aucun client ne repart les mains vides en silence
    (12/07, demande Babakar : « comment améliorer Awa pour que les clients
    obtiennent toujours ce dont ils ont besoin ? »)**. Diagnostic : aucune
    boucle de résultat — une conversation se terminait et personne ne savait si
    le client avait obtenu satisfaction. Quatre fuites : impasse non tracée,
    abandon, échec technique invisible (console.error), demandes hors périmètre
    non agrégées. Décisions produit : PAS de relance client automatique (la
    récupération passe par la réception) ; un abandon après une réponse
    correcte est un choix libre du client — statistique, pas un problème à
    chasser ; alertes = digest quotidien + notification immédiate des cas
    graves seulement.
    - **Étage 1, filets déterministes** : `FALLBACK_REPLY` → handoff +
      notification réception automatique dédup 24 h
      ([agent/index.ts](src/agent/index.ts) `notifyTechnicalFailure`) ; prompt
      §Escalate : appel `handoff_to_human` OBLIGATOIRE quand Awa ne peut pas
      aider (dire « contacte la réception » sans le tool = personne n'est
      prévenu) ; handoffs avec cycle OPEN→DONE (backfill borné au 12/07),
      bouton « ✅ Traité », badge des ouverts sur la vue d'ensemble.
    - **Étage 2, classificateur** ([conversationReview.ts](src/domain/conversationReview.ts),
      table `conversation_reviews`) : toute conversation silencieuse depuis
      45 min (fenêtre 24 h) est classée par UN appel LLM (tool `report_outcome`
      forcé via tool_choice — jamais de parsing fragile) : `resolved |
      handed_off | dropoff | deadend | technical_failure` + catégorie de besoin
      + gravité + résumé + action suggérée. Les tours `tool` sont dans le
      transcript (l'issue se lit dans les résultats, ex. booked:true). dropoff
      → DONE d'office (stats seulement). Sweep 5 min (index.ts), cas grave non
      résolu → notif réception immédiate avec lien conversation.
    - **Étage 3, file « À reprendre 🔁 »** (/admin/reviews) : uniquement
      impasses + échecs techniques, graves en tête, boutons Traité/Ignorer,
      dernières classifications repliées (contrôle qualité du classement).
      **Digest quotidien 19h** (Dakar=UTC) envoyé par le sweep, garde atomique
      en DB (table `app_state`, survit aux restarts) : classement du jour, file
      à reprendre, handoffs ouverts, top besoins non servis 7 j.
    - **Étage 4, apprentissage** : taux de « clients servis » 7/30 j (resolved
      + handed_off + dropoff, `satisfactionRate` — null si rien de classé,
      jamais un faux 100 %) et top `need_category` des conversations perdues
      sur 30 j — c'est la boussole du backlog : la catégorie qui domine dit
      quelle capacité construire ensuite.
    - **Piège attrapé par l'E2E local** (Postgres jetable + LLM réel, scénario
      « report refusé 16h + motif médical » → deadend/severe, résumé exact) :
      `max(created_at)` passé par un `Date` JS perd les microsecondes → la
      review stockée était « plus vieille » que le dernier message → la même
      conversation se reclassait à CHAQUE sweep (coût LLM infini, dédup notif
      heureusement OK). Fix : le timestamp voyage en `::text` de la sélection à
      l'insertion. Un `reviewed: 1 / second sweep: 0` fait foi. 179 tests.
    - NB : l'E2E a envoyé 2 notifications de test réelles à la réception
      (« TestRokhaya », 12/07 vers 19h40) — à ignorer.

32. **Proposition de liaison dès le 1er contact d'un numéro inconnu (12/07,
    demande Babakar)**. Problème : une abonnée qui écrit depuis un numéro
    ABSENT de sa fiche Wix est invisible pour Awa (`findContactIdByPhone` →
    null → contexte « pas d'abonnement ») et se fait pousser au paiement Wave
    pour un cours que son abonnement couvre. Avant, l'invitation à relier
    n'existait qu'APRÈS un paiement ([wave.ts](src/webhooks/wave.ts)
    `maybeHandleUnlinkedClient`) ou quand la cliente REVENDIQUAIT un abonnement
    (`check_membership claim:true`) — trop tard, ou dépendant de sa prise de
    parole. Décision produit : au TOUT PREMIER message d'un numéro qui ne
    matche aucune fiche unique, Awa glisse UNE ligne facultative « si tu as
    déjà un compte Revive, donne l'email et je relie ton abonnement » — un
    vrai nouveau client l'ignore et continue normalement.
    - **Détection** ([agent/index.ts](src/agent/index.ts)) : `firstContactUnlinked`
      = lookup membership réussi ET `!linked` ET première conversation (aucun
      tour `assistant` dans l'historique) ET one-shot pas encore armé
      (`!email_prompted_at && !claimed_email`). Le lookup live est celui déjà
      fait à chaque message ([membershipContext.ts](src/lib/membershipContext.ts),
      étendu pour renvoyer `{ linked, plans }` — AUCUN appel Wix
      supplémentaire, même cache 10 min).
    - **One-shot PARTAGÉ avec la proposition post-paiement** : on arme le même
      flag `email_prompted_at` (`repo.markEmailPrompted`) à l'injection — la
      question est posée au plus une fois, quel que soit le chemin qui tire en
      premier. `memberships === null` (lookup en échec) = statut inconnu → on
      NE demande JAMAIS (ne jamais dire à une abonnée reliée qu'elle n'a pas de
      compte à cause d'une erreur Wix).
    - **Livraison DÉTERMINISTE (v2, corrigée en prod)** : la v1 était
      prompt-injectée (le modèle devait tisser la phrase). **Test réel raté
      (11/07, Babakar) : « j'aurais bloqué pour Fusion lundi » a routé le modèle
      vers la règle « résa introuvable ≠ non relié → pas d'email talk » (§141) +
      l'offre de re-booker vite (§108), et le hedge « si ça colle » l'a fait
      SAUTER l'invitation — one-shot pourtant consommé à l'injection.** Fix : le
      message est désormais envoyé PAR LE SERVEUR juste après la réponse d'Awa
      ([agent/index.ts](src/agent/index.ts)), même pattern « le serveur envoie,
      jamais le modèle » que le bar post-résa. Le flag `email_prompted_at`
      n'est armé qu'APRÈS un envoi réussi (un `sendText` en échec ne brûle pas
      la chance unique). Le message vit dans [lib/linkAsk.ts](src/lib/linkAsk.ts)
      (`emailAskMessage`, FR/EN/WO), partagé avec la proposition post-paiement
      ([wave.ts](src/webhooks/wave.ts)). Le contexte first-contact devient une
      NOTE (« le système envoie l'invitation, ne l'écris pas toi-même »), plus
      une instruction.
    - **Règle §141 corrigée** : « pas d'email talk » ne vaut que si le compte
      est DÉJÀ matché ; si un résultat d'outil / le contexte signale
      explicitement que le numéro ne matche aucune fiche, une résa manquante
      peut vouloir dire « compte sous un autre numéro » → Awa PEUT proposer la
      liaison. `get_my_bookings` renvoie un `account_note` dans ce cas précis
      (contact introuvable + aucune résa) — filet qui marche même après le
      one-shot consommé (c'est exactement le scénario Fusion raté). L'invariant
      tient : jamais proposer si le contexte montre déjà un abonnement/des résas.
    - **Compromis** : one-shot armé seulement après envoi réussi → au pire un
      échec réseau reporte la question au message suivant (jamais perdue).
    - **Code AVANT paiement — séquencement côté SERVEUR (v3, 2e leçon prod
      11/07)** : test réel — le client donne son email, `request_email_verification`
      renvoie `code_sent`, MAIS Awa (en pleine lancée de résa) a enchaîné sur
      `create_payment_link` et n'a **jamais demandé le code** — le client reçoit
      un code par mail et se retrouve avec un lien Wave à la place. Double faute :
      UX cassée ET risque de faire payer plein tarif une abonnée dont le compte
      (en cours de liaison) couvre peut-être le cours. Décision (invariant « le
      serveur décide ») : `create_payment_link` ET `create_plan_payment_link`
      REFUSENT tant qu'une vérif est vivante — helper pur
      `verificationBlocksPayment(request, now)` = `AWAITING_CODE` && code non
      expiré ([tools.ts](src/agent/tools.ts)). Renvoie `verification_pending`
      qui dit à Awa de demander le code. Override explicite
      `client_declined_verification:true` (le client n'a pas accès au mail /
      préfère payer). Ne bloque PAS `AWAITING_EMAIL` (un claimer qui ignore
      l'offre peut acheter) ni un code expiré (silence >10 min ne gèle pas la
      vente ; sweep >30 min escalade réception). Prompt §Linking : après
      `code_sent`, le message suivant demande le code (aucun lien) ; après
      `verified`, reprendre la résa (check_membership → book_with_membership si
      couvert, sinon lien). Tests `verificationGuard.test.ts` (6). 190 tests.
    - **Message d'invitation corrigé (bug UX, test 11/07)** : disait « l'équipe
      reliera ton historique » — FAUX. Awa relie ELLE-MÊME via le code
      (`submit_verification_code` ajoute le numéro à la fiche, tout seul) ;
      l'équipe n'intervient QUE sur les doublons. `emailAskMessage` (FR/EN/WO)
      reformulé : « donne l'email, je t'envoie un code et je relie ton compte
      tout de suite ».
    - **« Fausse fusion » démasquée** : le `verified_pending_merge` du test ne
      venait PAS d'un vrai doublon de paiement mais de **2 fiches de TEST**
      (test1 `40c382e7`, test2 `fc76f17e`) qui portaient encore `774982711` en
      plus de la vraie fiche `db80edb8`. Nettoyage (PATCH contacts/v4, UA
      `curl/8` obligatoire — le fetch Node est bloqué 403 par Wix/Cloudflare sur
      le fingerprint UA par défaut) : numéro retiré des 2 fiches test → il ne
      résout plus que vers `db80edb8`. La notif « fusion 1 clic » reçue par la
      réception pour ce test est à REJETER dans /admin/crm.
    - **~~Décision auto-merge : NON~~ → INVERSÉE le 11/07 (Babakar) : OUI,
      post-vérification.** Après un 2e test montrant encore une « fusion
      technique » demandée à tort (voir race condition ci-dessous), décision :
      Awa fusionne AUTOMATIQUEMENT les doublons — mais UNIQUEMENT après preuve
      d'identité par code email, jamais à l'aveugle. Le sweep périodique de tous
      les doublons reste écarté (risque de fusionner deux vraies personnes qui
      partagent un numéro).
    - **Bug « fausse fusion » #2 = RACE CONDITION (fix)** : `submit_verification_code`
      ajoutait le numéro à la fiche prouvée (PATCH OK) puis, ~340 ms plus tard,
      re-vérifiait via `findContactIdByPhone` → l'index de recherche Wix n'avait
      PAS encore vu l'écriture → 0 résultat → `resolved (null) !== fiche prouvée`
      → faux `verified_pending_merge`. Cause profonde : `findContactIdByPhone`
      renvoie `null` pour DEUX cas opposés (0 fiche = index en retard ; ≥2 fiches
      = vrai doublon). Fix : nouveau `wix.findContactsByPhone(phone)` (liste
      BRUTE de toutes les fiches). Si 0 autre fiche que la prouvée → `verified`
      direct (l'index rattrapera). Si une autre fiche existe → AUTO-MERGE :
      `planVerifiedMerge(provenId, otherIds, planHolders, memberIds)` (cible
      FORCÉE = fiche prouvée ; sources = fiches ni membre ni porteuse
      d'abonnement) → `mergeContacts` → caches invalidés → le client reçoit
      `verified` avec ses plans, sans attendre l'équipe. Fiche protégée restante
      / échec → fallback `verified_pending_merge` + notif réception. Tests
      `verifiedMerge.test.ts` (5).
    - **Nettoyage en masse des doublons historiques (11/07)** :
      `scripts/merge-duplicates.ts` (`npm run crm:merge -- --dry|--go`) réutilise
      exactement le pipeline admin (`auditContacts` + `planMerge` + `mergeContacts`,
      mêmes garde-fous membres/abonnés). Passe unique en prod : **734 → 699
      fiches, 43 groupes → 8** (35 groupes fusionnés, 0 échec ; 8 restants
      protégés = vraies personnes distinctes partageant un numéro ou comptes
      membres, laissés au jugement humain /admin/crm).
    - **⚠️ Piège fetch Node vs Wix/Cloudflare** : les appels Wix depuis Node
      (fetch/undici) sont bloqués 403 (corps vide) sur le fingerprint du
      User-Agent par défaut ; `curl` passe. Fix : header `User-Agent: resabot/1.0`
      ajouté à `wix.ts headers()` — indispensable pour les scripts ET rend les
      appels serveur robustes.
    - Reproduction : le numéro de test 774982711 a été RESET plusieurs fois
      (fiche Wix supprimée + purge Postgres complète de la ligne `clients` et
      enfants) pour rejouer le flux « numéro non relié ». Tests
      `firstContactLink.test.ts` (emailAskMessage 3 langues + note contexte),
      `verificationGuard.test.ts` (code-avant-paiement) et checklist
      `first-contact-link`. 190 tests.

33. **Invitation de liaison fiabilisée + Awa CRÉE le compte des nouveaux (12/07,
    demande Babakar après 2e test raté)**. Deux problèmes constatés sur le test
    de Babakar (numéro 774982711, nuit 11→12/07) :
    - **(A) L'invitation §32 n'est jamais partie AVANT le paiement.** Cause : la
      garde « première conversation à vie » (`!history.some(assistant)`). Le
      1er message (23:49) aurait dû la déclencher mais l'envoi a raté
      silencieusement ; puis 2 « souci technique » (crédits Anthropic épuisés,
      voir chrono) ont persisté des tours `assistant` → la garde a
      DÉFINITIVEMENT gelé l'invitation. Résultat : le client a payé (00:06)
      PUIS seulement reçu la demande d'email (filet post-paiement wave.ts) —
      exactement le flux qu'on voulait éviter. **Fix** : la garde
      `!history.some(assistant)` est SUPPRIMÉE. Le seul verrou est désormais le
      flag durable `email_prompted_at` (armé après envoi réussi), donc
      l'invitation se REPRÉSENTE à chaque message tant qu'elle n'a pas
      réellement été délivrée. Prédicat extrait et testé :
      `shouldOfferLinking(memberships, client)` dans
      [lib/linkAsk.ts](src/lib/linkAsk.ts). Le champ contexte
      `firstContactUnlinked` devient `unlinkedNeverAsked` (marqueur prompt
      « FIRST CONTACT » → « UNLINKED NUMBER »). L'invitation N'est PAS accrochée
      au tour de repli technique (`replyText === FALLBACK_REPLY` → skip, elle
      repart au message suivant). **Effet de bord assumé** : tout le parc de
      clients non reliés jamais invités recevra UNE invitation à son prochain
      message (souhaitable — ce sont les clients à relier).
    - **(B) Un VRAI nouveau client (rien dans Wix) était une impasse.**
      L'invitation disait « sinon ignore » ; s'il donnait son email,
      `request_email_verification` → candidat `none` → **escalade réception**
      (ticket manuel pour ce qui devrait être une création de compte). Décision
      Babakar : **Awa crée la fiche elle-même, email vérifié par code AVANT
      création** (zéro fiche poubelle), deux points d'entrée (invitation
      élargie + email inconnu). Implémentation :
      - `emailAskMessage` (FR/EN/WO) élargi : « déjà un compte ? donne l'email
        … pas encore ? envoie nom+email et je t'en crée un ».
      - `request_email_verification` : nouveaux inputs `create_account` +
        `client_name`. Candidat `none` sans flag → `email_not_found_offer_creation`
        (PAS d'escalade, PAS de code — on propose la création). Avec
        `create_account:true` + nom → envoi du code, `setAwaitingCode` avec
        `wix_contact_id NULL` (= marqueur création) + `claimed_name`.
      - `submit_verification_code` : code OK et `wix_contact_id NULL` → au lieu
        d'`addPhoneToContact`, `wix.createContact({name, phone, email})` (POST
        contacts/v4). Le balayage post-vérif (fusion des doublons portant le
        numéro) s'applique tel quel → absorbe une éventuelle fiche anonyme
        laissée par une ancienne résa Wave. Renvoie `account_created`.
      - Nouvelle colonne `link_requests.claimed_name` (schema.ts, ALTER + CREATE),
        exposée dans [domain/linkRequests.ts](src/domain/linkRequests.ts).
      - Les escalades réception restent pour `client_has_no_email`, `ambiguous`,
        erreurs de lookup, échec d'envoi email. Le sweep 30 min rattrape un
        `none`-sans-suite silencieux (aucun client perdu).
    - Tests `firstContactLink.test.ts` étendus (shouldOfferLinking : lookup nul,
      linked, déjà prompté, claimed_email, + régression « historique assistant
      n'empêche plus l'offre »). 200 tests, build vert.
    - **⚠️ NON encore validé E2E en prod** au moment de l'écriture (voir runbook
      §7 pour rejouer : reset `email_prompted_at`, email inconnu → création).

34. **Édition du profil WhatsApp Business depuis le dashboard (12/07).**
    Babakar voulait éditer photo/description/adresse/horaires du profil sans
    passer par Meta Business Suite. Endpoint Cloud API
    `POST /{phone-number-id}/whatsapp_business_profile` — même bearer token
    que l'envoi de messages (`WA_ACCESS_TOKEN`/`WA_PHONE_NUMBER_ID`), nouveaux
    helpers `getBusinessProfile`/`updateBusinessProfile`/`uploadProfilePictureHandle`
    dans [src/lib/whatsapp.ts](src/lib/whatsapp.ts). Nouvelle page
    `/admin/profile` (même pattern formulaire→validation→appel API que
    `/admin/crm/link`).
    - **Piège Meta : aucun champ « horaires ».** Le endpoint n'expose que
      `about`/`address`/`description`/`email`/`websites`/photo — pas d'horaires
      d'ouverture. Contournement assumé : un textarea Horaires séparé dans le
      formulaire, composé dans la `description` envoyée à Meta (bloc `🕒
      Horaires` en fin de texte, `composeBusinessDescription`, tronqué à 512
      caractères en gardant le bloc horaires intact — testé unitairement).
      Table `whatsapp_profile` (ligne unique) pour que le formulaire round-trippe
      malgré ce contournement.
    - **Photo = flux à part.** Nécessite l'API resumable upload de Meta,
      scopée à l'**App ID** (pas le phone-number id) → nouvelle var d'env
      optionnelle `WA_APP_ID`. Sans elle, le champ photo est masqué dans le
      formulaire ; description/adresse/horaires restent fonctionnels.
    - **⚠️ NON encore validé E2E en prod** (pas de `WA_ACCESS_TOKEN`/`WA_APP_ID`
      réels disponibles pendant l'implémentation) — à tester en premier après
      déploiement : `/admin/profile`, éditer les 3 champs texte, vérifier le
      reflet côté profil WhatsApp réel, puis tester la photo si `WA_APP_ID` est
      configuré.

35. **Vente d'abonnements : renouvellement self-service + alerte réception pour
    les combinaisons absentes du catalogue (12/07).** Deux décisions produit de
    Babakar :
    - **Renouvellement** : le prompt disait « le renouvellement se gère avec le
      studio » pour les plans récurrents (`billing: "recurring"`) — détour
      inutile. Correction : le client **rachète lui-même** le même plan via Awa
      (`list_plans` + `create_plan_payment_link`) quand l'abonnement est
      terminé. 4 wordings corrigés
      ([systemPrompt.ts:114](src/agent/systemPrompt.ts), 3 endroits dans
      [tools.ts](src/agent/tools.ts) : description de l'outil, note
      `list_plans`, note `create_plan_payment_link`). Toujours vrai : le lien
      Wave ne couvre que la première période — aucun changement côté Wix
      (pas d'auto-renouvellement serveur, juste un nouveau paiement à chaque
      fois).
    - **Combinaison de cours absente du catalogue Wix** : le studio a
      maintenant beaucoup de cours, toutes les combinaisons d'abonnement
      n'existent pas encore. Nouvelle règle prompt
      ([systemPrompt.ts](src/agent/systemPrompt.ts), section « Selling
      abonnements ») : si le plan demandé n'est pas dans `list_plans`, Awa
      appelle `handoff_to_human` avec un motif préfixé **« Créer un
      abonnement : »** + la demande exacte (cours, fréquence, budget évoqué) —
      jamais de prix inventé ni de promesse que la formule existera telle
      quelle. Réutilise le handoff existant ([tools.ts:1770](src/agent/tools.ts) —
      déjà dual-channel email+WhatsApp), donc le sujet de notification devient
      directement actionnable (`🙋🏾 Handoff client — Créer un abonnement : …`)
      sans nouveau canal ni nouvelle table.
    - 205 tests, build vert. **Non testé en réel** (comme le reste de la vente
      d'abonnements, cf. §6) — à vérifier au prochain test de vente.

36. **Renouvellement d'abonnement : date de début choisie + offre en
    conversation + rappel push J-3 (12/07).** Suite de §35.
    - **Chaînage (date de début)** : l'API Wix `checkout/orders/offline` accepte
      un `startDate` optionnel (vérifié doc officielle : date future ⇒ ordre
      PENDING, activé automatiquement à la date — aucun cron côté serveur). Awa
      a un nouvel input `start: "now" | "after_current"` sur
      `create_plan_payment_link` ; en `after_current`, le SERVEUR résout la date
      de fin réelle du plan actif via `wix.latestPlanEndDate(contactId)`
      ([wix.ts](src/lib/wix.ts)) — jamais le modèle (anti-injection). Stockée sur
      `pending_plan_orders.starts_at`, passée à `createOfflinePlanOrder` dans le
      webhook Wave. Sans plan actif → repli « now » annoncé. Confirmation client
      et note réception mentionnent la date de démarrage.
    - **Offre en conversation (sans template)** : la date de fin (`endDate` Wix,
      déjà fetchée) est maintenant plombée jusqu'au contexte par message
      (`MembershipContext.expiresAt` → `dynamicContext` affiche « ends le … (in N
      day(s)) »). Le prompt permet à Awa de proposer le renouvellement UNE fois
      quand un plan finit sous ~7 jours (ou solde 0), avec le choix
      maintenant/à la suite.
    - **Rappel push J-3 (template Meta, DORMANT jusqu'à approbation)** : nouveau
      `src/domain/renewalNudge.ts` calqué sur `expiryNudge` — `renewalNudgeCandidates`
      (fonction pure testée : ordres ACTIVE dont `endDate` ∈ [now, now+N j]),
      sweep dans le tick 5 min de [index.ts](src/index.ts). Envoi hors fenêtre
      24h ⇒ **template obligatoire** (`WA_RENEWAL_TEMPLATE`, 3 vars nom/plan/date) ;
      tant que la var est vide, le sweep est un no-op. One-shot par ordre Wix
      (table `renewal_nudges`, claim AVANT envoi). Le tour assistant est
      persité pour qu'Awa ait le contexte quand le client répond. **Template
      soumis à Meta, EN VÉRIFICATION au 12/07** — poser `WA_RENEWAL_TEMPLATE` sur
      Railway une fois approuvé.
    - 211 tests, build vert. **Non testé en réel** (comme le reste de la vente,
      cf. §6).
    - **⚠️ Bug prod corrigé le 12/07 (même jour) : Awa a proposé de renouveler
      un PACK DÉCOUVERTE** (essai 2 semaines) à une vraie cliente. L'offre de
      renouvellement (contexte + prompt) ET le sweep push ne filtraient pas les
      plans non renouvelables.
    - **Découverte cruciale** : dans Wix, **AUCUN plan n'est `recurring`** — les
      19 plans sont tous `one_time` (paiement unique pour une durée). Un premier
      correctif basé sur `billing === "recurring"` aurait donc désactivé le
      renouvellement pour TOUT. Le bon critère (règle Babakar 12/07) est
      **durée ≥ 1 mois ET pas une carte cadeau** ; les programmes gratuits sont
      déjà écartés (listPlans filtre les plans à 0 F). Fonction pure testée
      `isPlanRenewable(name, durationDays)` dans [wix.ts](src/lib/wix.ts),
      exposée comme `WixPlan.renewable`. Vérifié en live : 16 renouvelables
      (mensuels, combos, carnets), 3 non (2 cartes cadeaux + Pack Découverte).
    - `MembershipContext.renewable` = `p.renewable` du catalogue live (plan
      absent = non renouvelable, prudent). Le contexte marque les plans non
      renouvelables « NOT renewable — NEVER offer to renew » ; le prompt s'y fie
      (carnets = renouvelables, seuls les trials/cartes cadeaux sont exclus) ;
      `renewalNudgeCandidates` prend `renewablePlanIds: Set` et exclut le reste
      (testé). 217 tests.

37. **Sept améliorations UX (13/07)** — plan révisé Babakar (audit UX + revue
    code). **#13 photos menu ABANDONNÉ** (liste WhatsApp sans image ; catalogue
    Commerce = 2e source de prix). Livré :
    - **#12 pages paiement → wa.me** ([server.ts](src/server.ts)) : bouton
      `https://wa.me/221789536676` SANS préfill `?text=` (Awa ne confirme jamais
      sur parole client). Note confirmation automatique conservée.
    - **#6 tips pré-cours** ([classTips.ts](src/lib/classTips.ts)) : matching
      par MOTS-CLÉS (reformer/pilates/fusion/yoga/inversion ; aqua/natation ;
      boxe) — jamais de noms de cours en dur. Branché dans
      `confirmationMessage` + note `book_with_membership`. Inconnu → null.
    - **#18 reçu image À LA DEMANDE** ([receiptImage.ts](src/lib/receiptImage.ts),
      outil `send_receipt`) : canvas même stack que le planning ; montants
      serveur (`recentReceiptCandidates` : BOOKED wave, plans PAID/ACTIVATED,
      bar PAID, 90 j). Multi-paiements → liste de choix. PAS d'auto-envoi
      post-paiement. Facture officielle/entreprise → handoff inchangé.
    - **#9 waitlist template en SECOURS** : free-text d'abord ; sur 131047 +
      `WA_WAITLIST_TEMPLATE` → `sendTemplate` (2 vars, `toTemplateParam`) ;
      NOTIFY_FAILED seulement si les deux échouent. Env vide = comportement
      inchangé. **Babakar crée le template Meta puis pose l'env après
      approbation** (leçon renewal).
    - **#7 « Mes prochains cours »** : `countUpcomingBooked` + flag dans
      `dynamicContext` ; present_options sur ouverture vague si ≥1 résa Awa.
    - **#15 micro-onboarding anti-clash** : `shouldOfferOnboarding` pure —
      exclus si `unlinkedNeverAsked` (liaison prime), si habitude, si lien de
      paiement actif, si déjà ≥1 tour assistant. Options ≤5 mappées aux outils
      existants (pas « Relier mon compte »).
    - **#17 domaine custom** : ops seul — CNAME Wix DNS → Railway custom
      domain ; `BASE_URL=https://bookings.revive.sn` (exemple) ; **webhooks
      Meta/Wave restent sur l'hôte Railway** (pas de ré-inscription). Pages
      paiement restent sur ce service (pas le site Wix).
    - 240 tests unitaires + 14 intégration verts.

- **4.32 — Moteur de notifications staff (14/07).** Rappels automatiques
  éditables depuis `/admin/notifications`, **aucun nom de cours ni numéro en
  dur** : le gérant saisit des *règles* (table `notification_rules`) et des
  *contacts staff* (`staff_contacts`). Deux types de règle : `class_reminder`
  (X min avant chaque cours dont le nom **contient** un motif — substring
  accent/casse-insensible, **pas de regex utilisateur** = anti-ReDoS ; anti
  dos-à-dos : supprime le rappel si un cours du même motif s'est terminé ≤ N min
  avant, ex. « vélos déjà à l'eau ») et `fixed_schedule` (jour(s) + HH:MM,
  Dakar = UTC). Destinataire = numéro fixe (gardien) ou **coach du cours**.
  **Contact coach depuis Wix** : `listStaffResources()` lit
  `/bookings/v1/resources/query` (id/name/**phone**/email, filtré tags `staff` —
  les 7 coachs ont un numéro, l'entrée `business` est exclue) ; le slot porte
  `coachId`, le sweep résout le téléphone par id puis par nom. Un `staff_contacts`
  de même nom reste prioritaire pour **muter** un coach ou surcharger son numéro
  (Wix = annuaire par défaut, admin = surcouche). Filtres de règle :
  `class_pattern` (contient), `exclude_pattern` (ne contient pas, ex. `reformer`),
  `group_only`. Effectif coach = `totalSpots − openSpots` (Wix ; « ? » si
  la capacité n'est pas exposée — **à vérifier en prod**). Option **`group_only`**
  (case « cours collectifs uniquement ») : ne cible que les services Wix de type
  CLASS/COURSE ; seul un `APPOINTMENT` explicite est exclu (type inconnu = gardé,
  pour ne jamais tout couper en silence si Wix change de schéma). Sert la règle
  effectif-coach pour ne pas notifier les rendez-vous individuels (massages…).
  - **Décision serveur only** (invariant CLAUDE.md) : le modèle n'intervient
    jamais ; planning via `wix.queryAvailabilityMulti` (cache module 5 min,
    fallback dernier cache valide), horloge côté serveur.
  - **Claim-before-send durci** (`notification_log`, clé unique partielle
    `dedup_key`) : contrairement aux relances marketing où « un envoi perdu est
    OK », ici un rappel manqué (« mettre les vélos à l'eau ») est pire qu'un
    doublon → une ligne coincée en `claimed` est **reprise après 2 min**
    (crash/5xx entre claim et envoi). 131047 sans template = `failed` (pas de
    retry, visible au journal) ; erreur transitoire = reste `claimed` pour le
    bail. Repli anti dos-à-dos aussi via `notification_log.event_end` quand le
    planning Wix ne renvoie plus la séance précédente déjà commencée.
  - **Sweep dans la boucle 60 s** (précision 15 min avant → granularité ≤ 1 min),
    try/catch isolé pour ne jamais bloquer l'expiration/réconciliation.
  - **Un seul message pour des cours enchaînés** (`buildChain`, `chainKeyFor`) :
    quand un même destinataire enchaîne des cours dos à dos (écart ≤
    `suppress_gap_minutes`), UN message couvre tout le bloc via le placeholder
    **`{classes}`** (liste nom + heure + effectif), les suivants sont
    `suppressed`. Chaînage **par destinataire** : pour une règle coach, seul le
    MÊME coach chaîne (le cours du coach A ne supprime pas celui du coach B — la
    suppression est scoped par `chainKeyFor` = coachId/nom ; le repli log ne
    s'applique qu'aux règles à numéro fixe). Placeholders simples = 1er cours
    (rétro-compat).
  - **Bouton « Envoyer un test »** : envoie TOUJOURS vers `NOTIF_TEST_PHONE`
    (défaut `+221774982711`, le numéro de Babakar), jamais le vrai gardien/coach.
    Valeurs d'exemple (dont `{classes}` à 2 cours). Dédup `test:{uuid}`.
  - **Café → WhatsApp prioritaire** : `notifyReception(subject, body,
    { whatsappFirst:true })` — WhatsApp d'abord, email en secours SI l'envoi WA
    échoue (uniquement pour le bar ; remboursements/handoffs/crash gardent le
    dual-channel, l'email restant le canal fiable). `sendWhatsAppNotification`
    renvoie désormais `'sent' | 'sent_template'` ; chaque envoi réception est
    journalisé (`source='reception'`) et apparaît dans `/admin/notifications`.
  - **Template** : un seul Utility générique 2 variables (`WA_RECEPTION_TEMPLATE`)
    sert réception + gardien + coachs. **APPROUVÉ + posé en prod le 14/07** :
    `WA_RECEPTION_TEMPLATE=awa_notification`, `WA_RECEPTION_TEMPLATE_LANG=en`
    (Babakar a créé le template en ANGLAIS → le code langue doit être `en`, sinon
    échec Meta ; les variables {{1}}/{{2}} restent en français = habillage anglais
    + contenu FR, cosmétique). Un ancien template `awa_reception_notif_interne`
    (lang `en`) était configuré avant — remplacé (réversible via
    `railway variables --set`, tâche agent, pas le gérant). Hors fenêtre 24h sans
    template valide = échec 131047 **mais visible au journal** (avant : silencieux).
  - **Config prod au 14/07** (données en DB, éditables via l'admin) : 2 règles —
    « Aquabikes à l'eau » (numéro fixe gardien, gap 60) et « Effectif coach —
    cours collectifs » (tous cours collectifs SAUF reformer, 3 h avant, au coach
    du cours via Wix, gap 30 = un message par bloc enchaîné). Lead baissé de
    4 h → 3 h le 15/07 (DB only, `lead_minutes=180`). Contact staff :
    **Yass mutée** (toujours au studio). Les 7 coachs Wix ont un numéro.
  - Fichiers : `domain/notificationRules.ts` (pur, testé), `notificationRepo.ts`
    (CRUD + claim + journal), `notificationSweep.ts` (sweep + cache planning +
    contacts coach Wix), `admin/notificationsPage.ts` + routes
    `/admin/notifications`. Logique pure couverte par
    `test/notificationRules.test.ts` (28 cas).

- **4.33 — Création de compte en un aller-retour + escalade réception honnête
  (14/07, incident Rama).** Cliente nouvelle : Awa l'invite (« envoie-moi ton
  nom et ton email et je t'en crée un »), Rama répond nom + email d'un coup, mais
  `request_email_verification` appelé SANS `client_name` → réponse
  `email_not_found_offer_creation` qui exige une 2ᵉ confirmation. Le message
  redemandant « oui ? » était noyé dans le volet réservation ; Rama n'a répondu
  qu'à la résa → le fil création est retombé, **aucun code envoyé, aucun compte
  créé** (`emails_sent = 0`). 30 min après, le sweep a escaladé la demande vide
  en réception avec le texte trompeur **« Abonnement introuvable — client affirme
  en avoir un »** (Rama n'a jamais parlé d'abonnement). Trois correctifs :
  - **Un aller-retour** (`decideNoneCandidateAction`, pur/testé) : si le nom est
    connu (client_name fourni, même sans `create_account:true`), le code part
    directement. La double confirmation ne reste que quand le nom manque. Tool
    description mise à jour : passer `client_name` dès le 1er appel quand le
    client a envoyé nom + email ensemble.
  - **Le paiement n'est plus bloqué pendant une vérif de compte NEUF**
    (`verificationBlocksPayment` : `wix_contact_id` null ⇒ pas d'abonnement à
    protéger). Sans ça, le fix ci-dessus aurait bloqué le lien de paiement de
    Rama. Un doublon de fiche (résa auto-crée une fiche pendant le code en vol)
    reste absorbé par `planVerifiedMerge` post-vérification.
  - **Escalade honnête** (`linkRequests.ts`) : `HANDOFF_PREFIX` neutre (« Compte
    non relié — liaison/création à finaliser »), corps sans mention d'abonnement,
    **email déclaré inclus** pour que la réception sache quoi rattacher. Détail du
    sweep distingué : « vérification jamais démarrée » si `emails_sent = 0` vs
    « jamais terminée » sinon.
  - Tests : `verificationGuard` (compte neuf non bloquant), `emailLinking`
    (`decideNoneCandidateAction`), intégration `linkEscalation` (détails du sweep).
  - **Remédiation prod Rama** : fiche Wix créée/complétée par un agent (email
    `ramathiamndiaye@hotmail.com` ajouté), demande passée LINKED, handoff clos ;
    Babakar re-booke lui-même. Résa Sculpt sam. 18/07 10:15 (2 pers., 24 000 F
    Max It) avait bien abouti — seule la création de compte avait échoué.
  - **AMENDÉ 17/07** : l'invitation de liaison n'est plus poussée au PREMIER
    contact (voir chronologie 17/07). Elle reste envoyée automatiquement par le
    filet post-paiement (`maybeHandleUnlinkedClient`), et le modèle la propose
    au moment utile. `shouldOfferLinking` inchangé (alimente désormais la note
    de contexte + le filet Wave, plus un push au 1er message).

- **4.34 — Livraisons bar (commandes téléphoniques → cuisine → client) (15/07).**
  Nouvelle feature 100 % serveur+admin (le modèle IA n'intervient nulle part) :
  la réception saisit une commande passée au téléphone, la cuisine est notifiée,
  un SLA déclenche une alerte, le client est prévenu quand c'est prêt. **Paiement
  hors système** (encaissé à la livraison) — on ne mémorise que le montant dû.
  - **Table dédiée `delivery_orders`** (PAS `pending_cafe_orders`, centré paiement
    Wave) : statuts `IN_KITCHEN → READY → DELIVERED`, `+CANCELLED`. `items_json` =
    snapshot figé (prix via `computeExtras` côté serveur à la création, invariant).
    CHECK sur statut / `amount_xof > 0` / `sla_minutes` 5–180.
  - **Saisie** : `/admin/livraisons/new` (formulaire, articles groupés par
    catégorie du menu, `qty_<ID>`, total estimé JS affichage-seul) → board
    `/admin/livraisons` (auto-refresh 60 s, compte à rebours SLA vert/ambre/rouge,
    boutons Prête/Livrée/Annuler, historique + prépa moyenne). `layout()` gagne un
    param optionnel `{refreshSeconds}` (board uniquement, jamais le formulaire).
  - **Lien magique cuisine** (`src/deliveryPublic.ts`, hors `/admin`, sans auth) :
    `GET /livraison/:id/:token` **lecture seule** (WhatsApp pré-fetch les liens
    pour l'aperçu — un GET mutant marquerait prête à l'aperçu), `POST` marque prête
    + prévient le client, `303 → GET`. Token **jamais stocké** (seul son sha256),
    comparaison constant-time, **404 uniforme**, garde 48 h, headers durcis
    (no-store, noindex, no-referrer, DENY, CSP). « 🔁 Renvoyer » **rotate** le token
    (l'ancien lien meurt).
  - **Notifs durables-légères** (`kitchen_notify_status` / `client_notify_status` :
    pending → claimed → sent|sent_template|partial|fallback_reception|failed, cap
    3 tentatives) : les routes tentent tout de suite, le **sweep 60 s réconcilie**
    (crash entre commit et envoi ne perd pas la notif). SLA one-shot via
    `alerted_at` (SET WHERE NULL). Cuisine = `staff_contacts` rôle **exact**
    `cuisine` (pas de match flou) ; aucun contact → repli réception avec
    avertissement (`fallback_reception`). Client prêt : `sendText` puis template
    FR `WA_DELIVERY_READY_TEMPLATE` sur 131047 ; sinon badge « 📞 Appeler le
    client ». Journalisé `source='delivery'` (visible /admin/notifications).
  - **Fichiers** : `domain/deliveryRules.ts` (pur, testé), `deliveryRepo.ts` (SQL/
    claims), `deliveryNotify.ts` (WhatsApp + `sweepDeliveries`), `deliveryPublic.ts`,
    `admin/livraisonsPage.ts` + routes `/admin/livraisons`. Tests :
    `test/deliveryOrders.test.ts` (16 purs) + `test/integration/deliveryOrders.test.ts`
    (création+prix, GET-ne-mute-pas, POST prête + 1 seule notif client, mauvais
    token 404, rotate, SLA one-shot, repli réception).
  - **Ops (à faire par Babakar / agent)** : créer un contact rôle **exact**
    `cuisine` dans /admin/notifications ; créer le template Meta `livraison_prete`
    (Utility, 2 variables `{{1}}` prénom `{{2}}` récap+montant, **corps FR** sous
    code langue **`en`** — cf. mémoire templates), puis `railway variables --set
    WA_DELIVERY_READY_TEMPLATE=livraison_prete`. Deux prérequis distincts : fiabilité
    cuisine hors fenêtre 24 h = `WA_RECEPTION_TEMPLATE` (déjà là) ; fiabilité client =
    `WA_DELIVERY_READY_TEMPLATE`. Hors périmètre v1 : 2ᵉ alerte à 2×SLA, édition
    (annuler+recréer), message « livrée » au client, gestion livreur.

- **4.35 — Admin IA redesign (15/07).** La barre plate à 11 onglets était
  illisible (ops urgentes = config = archives). Nouveau chrome **inbox-first** :
  - **`/admin` = « À faire »** : remboursements + abonnements toujours visibles ;
    handoffs ouverts, reviews, liaisons CRM, livraisons en alerte seulement si
    non vides ; stats en bas. Actions 1-clic inchangées (pas de mouvement d'argent).
  - **Sidebar groupée** : Clients (Conversations / Handoffs / À reprendre) ·
    Studio · Bar (Commandes payées / Livraisons) · CRM · Réglages (Notifs staff /
    Profil / Tests). Badges rouges (counts soft-fail).
  - **Recherche client globale** dans le topbar → `/admin/conversations?q=`.
  - Ancres internes CRM (`#liaisons` …) et Notifs (`#regles` / `#contacts` /
    `#journal`). URLs stables.
  - Fichiers : `admin/layout.ts`, `helpers.ts`, `navBadges.ts`, `inboxPage.ts` ;
    `routes.ts` allège le chrome. Suite possible : découper `routes.ts` en
    dossiers domaine (phase code-only, pas de changement UX).

- **4.35 — Fiabilité des envois hors fenêtre 24h + templates ciblés (15/07).**
  Déclencheur : des messages « sent » (bouton test) n'arrivaient jamais. Cause :
  fenêtre 24h fermée → Meta **accepte en 200 puis rejette en asynchrone** via un
  callback `statuses` qu'on ignorait ; le repli template (sur 131047 **synchrone**)
  ne se déclenchait pas → échec **invisible** (faux « sent »).
  - **Template-first pour le staff** (`sendWhatsAppNotification({preferTemplate})`,
    [notify.ts](src/lib/notify.ts)) : coach/gardien/cuisine/test n'ont quasi jamais
    de fenêtre ouverte → template d'abord, repli texte libre si échec. Appliqué au
    sweep des règles ([notificationSweep.ts](src/domain/notificationSweep.ts)) et au
    bouton test. **C'est le correctif qui fait arriver les tests.**
  - **Webhook `statuses`** ([webhooks/whatsapp.ts](src/webhooks/whatsapp.ts)) :
    `parseStatuses` + `markLogFailedByWamid` repassent la ligne `notification_log`
    `sent` → `failed` sur échec async. On stocke le `wamid` à l'envoi (colonne
    `notification_log.wa_message_id` + index) ; `sendText`/`sendTemplate` renvoient
    le wamid. Fini les faux « sent ».
  - **Ticket cuisine = template `ticket_cuisine` + bouton URL dynamique**
    « Marquer prête » (5 variables ; `sendTemplateWithUrlButton`), template-first,
    repli texte libre. **Le lien magique passe à `/livraison/:token`** (recherche
    par hash du token, plus d'id dans l'URL) pour la variable unique du bouton Meta.
  - **Templates Meta** (créés par Babakar, **corps FR sous code langue `en`**) :
    `livraison_prete` (client, 2 var) et `ticket_cuisine` (cuisine, 5 var + bouton).
    Env Railway posés : `WA_DELIVERY_READY_TEMPLATE`, `WA_KITCHEN_TICKET_TEMPLATE`
    (LANG par défaut `en`). Dégradation propre tant que Meta n'a pas approuvé
    (repli texte libre / badge « 📞 Appeler le client »). Rappel :
    `awa_notification` reste le template générique fourre-tout (contenu arbitraire
    des règles staff). Détail préférences : mémoire `meta-templates-english`.
  - Tests : `parseStatuses`, `kitchenTemplateParams` (ordre exact des 5 variables),
    route token-only, flip async `markLogFailedByWamid`.

- **4.36 — Factures admin (16/07).** Un client qui demande une facture entreprise
  partait en handoff sans outil. La réception crée désormais la facture dans
  `/admin/factures` : préremplissage depuis un paiement récent (cours/abo/bar/
  livraison, `recentPaidCandidates`) ou saisie libre (lignes désignation/qté/PU,
  totaux **recalculés serveur**). Deux sorties : **page imprimable** autonome
  (`renderFacturePrint`, PDF via le navigateur) et **image WhatsApp** envoyée au
  client (`renderInvoiceImage`, même stack canvas + charte que les reçus →
  `sendImage`). Charte reprise du devis Revive : en-tête « REVIVE VENTURES »,
  bandeau violet, pastille total. **Pas de TVA, pas d'infos légales** (choix
  Babakar).
  - Table `invoices` **immuable** (aucune route update/delete — une erreur = une
    nouvelle facture). Numérotation `FAC-YYYY-NNNN` via compteur **atomique par an**
    dans `app_state` (`nextInvoiceNumber`, une seule requête ON CONFLICT = atomique,
    pas de transaction ; un échec d'insert brûle un numéro, trou assumé).
  - Envoi : succès → `sent_at`/`sent_status='sent'` + log `source='invoice'` ;
    131047 → `window_closed` + bandeau « le client doit d'abord écrire à Awa » ;
    sinon `failed`. `sendImage` renvoie le wamid (comme sendText/Template) → un
    échec asynchrone est capté par le webhook `statuses` (§4.35).
  - **Refacto admin (autre agent)** pris en compte : nav dans `NAV` de
    `admin/layout.ts` (`layout()` est async, `active` = chemin), pas de `tabs`.
    Onglet Factures dans la section Clients.
  - **Piège testé** : le mock d'intégration ne renvoyait pas d'`id` pour l'upload
    `/media` → `sendImage` throw ; branche `/media` ajoutée à `test/integration/helpers.ts`.
  - Fichiers : `domain/invoiceRules.ts` (pur, testé) + `invoiceRepo.ts`,
    `lib/invoiceImage.ts` (charte copiée de receiptImage), `admin/facturesPage.ts`
    + routes `/admin/factures`. Awa (systemPrompt) rassure : « la réception te
    l'envoie ici sur WhatsApp ». Tests purs (numérotation, parsing lignes, image)
    + intégration (numéros séquentiels + 5 concurrents, validations, pages,
    envoi image + log, sans-numéro).

- **4.37 — Devis admin (16/07).** Nouvelle section `/admin/devis` (nav Studio)
  pour les prestations privées (privatisation studio, événements type « Pilates
  & Cookies »). Contrairement aux factures (immuables), un devis est **éditable
  et re-générable** : formulaire création/édition sans JS client (lignes de
  prestation en champs indexés `item_label_i`/`item_detail_i`/`item_amount_i`,
  montant vide = « Inclus / 0 », lignes vides ignorées), statuts
  Brouillon/Envoyé/Accepté/Expiré, conditions préremplies modifiables
  (acompte 50 %, Wave/OM, validité, préavis 48h).
  - Sortie : **PDF téléchargeable** (`lib/quotePdf.ts`, **pdfkit** — nouvelle
    dépendance, choisie contre pdf-lib pour le word-wrap/`heightOfString` natifs ;
    polices DejaVu bundlées via `registerFont`, chemins relatifs à
    `process.cwd()` → toujours lancer depuis la racine). Route
    `GET /admin/devis/:id/pdf` → `application/pdf` + `content-disposition`
    `Devis_DEV-YYYY-NNNN.pdf`. Mise en page = modèle Babakar : en-tête violet,
    cartes PRESTATAIRE/CLIENT, chips date/horaire/participants/lieu, table
    prestations, bloc TOTAL, conditions, footer. **Piège** : footer positionné
    trop près de la marge basse → pdfkit créait une page 2 vide ; fix =
    `lineBreak: false` + remonter le footer dans la marge.
  - Table `quotes`, numérotation `DEV-YYYY-NNNN` via le même compteur atomique
    `app_state` que les factures (`nextQuoteNumber`). Total **recalculé serveur**
    (`quoteTotal`), jamais pris du formulaire. Fichiers : `domain/quoteRules.ts`
    (pur, testé) + `quoteRepo.ts`, `admin/devisPage.ts` + routes, tests purs
    (parsing, numérotation, PDF commence par `%PDF-`).
  - Livraison volontairement minimale (choix Babakar) : téléchargement seul —
    pas d'envoi WhatsApp, pas de lien public, pas de suivi d'acompte.

- **4.38 — Cartes cadeaux admin (16/07).** La réception fabriquait le visuel de
  carte cadeau à la main dans Canva. Nouvelle section `/admin/cartes-cadeaux`
  (nav Clients) : formulaire → PNG 1748×1240 généré sur le template de marque,
  liste + historique, aperçu inline, téléchargement, **envoi WhatsApp** (réutilise
  `sendImage` + gestion 131047 comme les factures).
  - Rendu (`lib/giftCardImage.ts`, `@napi-rs/canvas`) : on ne dessine PAS
    from scratch — on charge `assets/gift-card-template.png` (l'export Canva
    d'origine avec les 3 zones variables repeintes en crème `250,246,241`) et on
    pose 3 textes par-dessus. Coordonnées/couleurs mesurées au pixel sur l'export
    (offre centrée x≈1247, y 420/508 ; POUR (1282,745) ; DE (1300,840) ; offre
    #353433, valeurs #3a3a3a). Police DejaVu embarquée (approximation assumée,
    la police Canva exacte n'est pas fournie). Auto-réduction si un texte dépasse.
    Le template vierge a été fabriqué par un script one-shot (PIL) puis vérifié
    visuellement contre l'original.
  - L'offre est **libre** (« Carnet de 5 séances » n'existe pas dans Wix) — aucun
    couplage list_plans. Objet marketing : table `gift_cards` sans numéro, immuable
    (pas d'update, comme les factures). L'activation du plan offert au destinataire
    reste un geste réception dans Wix (hors périmètre). Cohérent avec `isGiftCard`
    (Awa ne vend pas de cartes cadeaux, 16/07) : c'est un outil interne.
  - Fichiers : `domain/giftCardRules.ts` (pur, testé) + `giftCardRepo.ts`,
    `lib/giftCardImage.ts`, `admin/cartesCadeauxPage.ts` + routes, `recordGiftCardLog`
    (source='gift_card'). Tests purs (parsing) + image (signature PNG, 1 ligne,
    nom long).

- **4.39 — Vérité paiements + ajout de places à une résa (16/07).** Audit prod :
  Awa affirmait à tort « paiement uniquement par Wave » (OM/Max It sont actifs), et
  2 clients ont voulu « rajouter 2 personnes » à leur résa sans qu'Awa sache le
  faire (handoff perdu).
  - **Partie A (vérité paiements)** : le prompt système disait « payment first via
    Wave », « Payment flow: always Wave », greeting « paiement Wave inclus » — co-cause
    majeure. Corrigé en « mobile money (Wave, Orange Money ou Max It) » aux 4 endroits
    ([systemPrompt.ts](src/agent/systemPrompt.ts)) + section Paiement de
    [business-info.md](business-info.md) (« ne dis JAMAIS Wave uniquement »).
  - **Partie B (`add_spots_to_booking`)** : nouvel outil. Le client dit « ajouter N
    personnes » → **nouvelle ligne `pending_bookings` sur le MÊME event** (résa payée
    et booking Wix jamais touchés) → lien de paiement (Wave/OM/Max It) → le pipeline
    payment-first crée le booking Wix des places sup à la confirmation. Anti-injection
    par **propriété du booking_id** (`findClientBooking`), pas de slot_cache. **Pas de
    règle 16h** (c'est un achat, pas une annulation) mais re-check live des places.
    `studio:` → orienté vers une résa normale ; abonnement → book_with_membership.
    Helper pur `validateAddSpots`, handler assemblé par réutilisation
    (`resolvePaymentMethod`, `wix.getService`/`isSlotStillOpen`, `createDraftBooking`,
    `createClientPaymentSession`). Prompt l.56 réécrit.
  - **Pièges** : garde uuid sur booking_id (même bord rugueux dans `cancel_booking`,
    à traiter un jour) ; le mock d'intégration n'avait pas les endpoints
    `/bookings/v2/services/query` ni Wave checkout (ajoutés — 1er appel d'`executeTool`
    depuis un test d'intégration). Sell-out entre lien et paiement → REFUND_NEEDED
    (pipeline existant). Tests : `addSpots` (pur) + intégration `add-spots` (happy Wave
    + OM, propriété, statut, cours commencé, places insuffisantes, studio, sell-out).

- **4.39 — Menu bar éditable dans l'admin (17/07).** Le menu café était dans
  `cafe-menu.md`, parsé au boot → toute modif = redéploiement. Il passe en DB
  (table `cafe_menu_items`, source de vérité), éditable via `/admin/menu`
  (nav Bar) : ajouter / modifier / retirer un article, cocher « incontournable »,
  sans redéploiement.
  - **Snapshot mémoire** : `lib/cafeMenu.ts` reste pur (plus de `CAFE_MENU`
    const ni de lecture disque à l'import) ; `domain/cafeMenuRepo.ts` charge la
    DB et POUSSE le snapshot via `setCafeMenu(rows)`. `getCafeMenu()` (sync)
    remplace `CAFE_MENU` partout (agent/tools/routes). `computeExtras` inchangé
    (prix toujours résolus serveur). Chaque mutation admin → `refreshCafeMenu()`
    avant le redirect (mono-instance Railway → invalidation in-process suffit).
  - **Prompt caching préservé** : `SYSTEM_PROMPT` const → `systemPrompt()`
    mémoïsée sur `cafeMenuVersion()` — même référence string entre deux éditions
    (préfixe cache Anthropic intact), reconstruite une fois par édition.
  - **Seed** : `initCafeMenu()` au boot (après `migrate()`) importe `cafe-menu.md`
    si la table est vide (favourite=true pour les 9 `FAVOURITE_SEED_IDS`), puis
    charge le snapshot. Ensuite le fichier n'est plus lu.
  - **IDs** auto-générés (slug `MAJUSCULES_UNDERSCORE`, unicité contre TOUS les
    ids y compris archivés). **Retirer = `enabled=false`** (restaurable, jamais
    de hard delete) : un id n'est jamais réutilisé → les snapshots figés des
    commandes passées restent cohérents.
  - Fichiers : `lib/cafeMenu.ts` (refactor), `domain/cafeMenuRepo.ts` (nouveau),
    `agent/systemPrompt.ts` (memo), `admin/menuPage.ts` + routes `/admin/menu`,
    `src/index.ts` (boot). Tests purs (slug, buildPromptText, parseMenuItemForm,
    systemPrompt memo, favourites via snapshot) + intégration (seed idempotent,
    CRUD → refresh → snapshot). Docs : CLAUDE.md, README, en-tête cafe-menu.md.

- **4.40 — Planning du personnel (`/admin/staff`, 17/07).** Babakar gère les
  horaires des 7 employées (accueil/bar/entretien) dans un Word ; il veut éditer,
  tester des ROTATIONS et envoyer à chacune son planning. Nouvel onglet Studio
  « Équipe 🗓 ».
  - **Modèle** : `staff_schedules` (scénarios draft/published) + `staff_shifts`
    (un créneau CONTINU par personne/jour ; weekday **0=lundi**, ≠ notification_rules
    où 0=dimanche ; pas de ligne = repos). Employées = `staff_contacts` réutilisé
    (rôles accueil/bar/entretien ; les coachs Wix restent dehors). **Invariant « un
    seul publié »** appliqué par un **UPDATE CASE unique** (pas d'index unique
    partiel — sa vérif par ligne casse pendant l'update multi-lignes). `replaceShifts`
    = delete + multi-VALUES insert (écrivain unique admin, style sans transaction).
  - **Pause 13h30–14h30 non payée déduite SEULEMENT si le créneau dépasse 14h30**
    (décision : une journée finissant à 13h35 garde ses minutes). Totaux hebdo en
    direct. Feuille de Babakar recalculée : Meryl/Linsey/Syndel 39h25, Ama 33h05,
    Jacqueline 37h10, Fatou 35h25, Arame 39h25.
  - **Grille interactive** (vanilla, zéro dépendance) : clic case → éditeur inline
    (heures + presets + Repos) ; **drag & drop = COPIE** d'un créneau (jamais
    destructif) ; totaux/effectifs recalculés live ; état sale + `beforeunload` ;
    « Enregistrer » POST la grille en JSON (validée serveur, autorité sur les
    totaux). Dupliquer / Renommer / Publier / Supprimer(brouillon). Page imprimable
    A4 paysage (miroir du Word). **Envoi WhatsApp** par employée + « à toutes »
    (template-first, garde-fou « numéro manquant » → répertoire ; journalisé
    `source='staff_planning'`).
  - **Seed one-shot** (sentinelle `app_state`) : les 7 employées (phone `''`,
    numéros à saisir) + « Planning actuel » publié + 35 shifts, au prochain boot.
  - Pièges notés : suppression d'une employée = cascade sur tous les scénarios ;
    risque collision `findStaffByName` si un futur coach Wix est homonyme d'une
    employée sans numéro. Fichiers : `domain/staffPlanningRules.ts` (pur, testé) +
    `staffPlanningRepo.ts`, `admin/staffPage.ts` + routes, `recordStaffPlanningLog`.
    Tests purs (parse/fmt, matrice pause, totaux feuille, validation grille,
    message) + intégration (seed idempotent, grille save/rejet, 1-seul-publié,
    duplicate/delete/print, envois).

## 5. Chronologie condensée

- **17/07 — « Nouveau client par défaut » : la question du compte ne vient plus
  au premier contact.** Sur un simple « Salut », Awa répondait puis le serveur
  poussait aussitôt l'invitation compte/email (« Au fait 😊… je t'en crée un »)
  — trop lourd, feedback gérant. Changement : suppression du push proactif au
  1er contact (`agent/index.ts`, bloc post-réponse retiré). La posture par défaut
  d'un numéro inconnu devient **nouveau client jamais venu** (note `UNLINKED
  NUMBER` reformulée dans `systemPrompt.ts` : « BRAND-NEW by default, do not
  bring up accounts/email on your own »). Le compte ne remonte plus que quand il
  sert : (a) le client mentionne un compte/abonnement/historique, (b) une résa
  via abonnement échoue (`no_matching_contact`), ou (c) **filet post-paiement
  inchangé** (`maybeHandleUnlinkedClient` envoie la même invitation après le 1er
  paiement d'un numéro non relié). Aucun garde-fou paiement/booking affaibli
  (`verificationBlocksPayment`, code-avant-paiement intacts). Auto-présentation
  IA au 1er contact conservée. Tests `firstContactLink` mis à jour (nouveau
  contrat de la note ; `shouldOfferLinking`/`emailAskMessage` toujours verrouillés
  pour le filet Wave).

- **16/07 — 529 Overloaded : retry applicatif espacé (incident premier contact).**
  À 18:56, un NOUVEAU client écrit « Bonsoir vous allez bien ? » → 529
  « Overloaded » Anthropic → les 2 retries du SDK (backoff sub-seconde) n'ont
  pas survécu au pic → fallback « souci technique » + renvoi réception dès le
  premier message. Fix (`agent/index.ts`) : `withOverloadRetry` — 2 retries
  applicatifs espacés (15 s puis 30 s) **uniquement** sur 529/`overloaded_error`
  (les timeouts et autres 5xx continuent d'échouer vite : ils s'empileraient
  avec le timeout 60 s/tentative et bloqueraient la file sérialisée du client).
  Le typing indicator est relancé à chaque retry. Appliqué à la boucle
  principale et à la réponse finale forcée ; le retry max_tokens garde son
  appel simple (il a déjà la réponse partielle en secours). Testé (classifier +
  helper à délais injectés).

- **16/07 — Audit catalogue plans Wix (suite Pack Découverte).** Revue des 28
  plans après l'incident découverte. Trois problèmes de même nature + un piège
  de code :
  - **Descriptions au prix périmé (corrigées via API Wix).** 3 plans dont la
    description affichait un prix ≠ du prix réellement facturé (baisse de tarif
    non répercutée) : Pilates Mat 2x (facturé 80 000, desc disait 150 000),
    Pilates Reformer 3x (144 000 vs 190 000), Aquafitness 2x (80 000 vs 120 000).
    Comme `list_plans` transmet `description` au modèle, Awa recevait deux prix
    contradictoires. Fix : prix retirés des descriptions (le prix vient TOUJOURS
    du champ catalogue). Vérifié : plus aucun plan vendable n'a de prix en desc.
  - **Plan de test « test fusion » (50 F, public) archivé** via API — Awa
    pouvait le proposer.
  - **Cartes cadeaux retirées de la vente Awa (code).** `isGiftCard()` +
    `listPlans()` les écarte (elles s'activeraient sur le compte de l'acheteur).
    Elles restent dans Wix (don manuel/site) et un client qui en possède déjà
    une continue à l'utiliser (redemption via benefit pools, pas via listPlans).
  - **⚠️ Piège de visibilité (documenté, NE PAS « corriger »).** Le filtre de
    `listPlans()` faisait `!p.archived && !p.hidden` : `hidden` n'existe PAS
    dans l'API Wix (no-op confirmé sur 27/27 plans). Le vrai champ est `public`,
    MAIS le corriger en « public seulement » ferait disparaître le **Pack
    Découverte** (`public:false`, vendu via Awa) et casserait le parcours essai.
    Donc : seul `archived` filtre côté Wix ; pour retirer un plan à Awa on
    archive (Wix) ou on ajoute un filtre nommé (comme isGiftCard). Clause
    `!p.hidden` supprimée, intention commentée dans le code.

- **16/07 — Pack Découverte : contenu manquant + anti-spéculation.** Une cliente
  demande le Pack Découverte ; la description Wix ne disait que « Valable 2
  semaines » → Awa répond « nombre de séances non précisé » et **spécule** « en
  général une séance d'essai » (faux : 3 séances / 30 000 F). Fix données :
  description Wix corrigée (« 3 séances / Valable 2 semaines » — le catalogue
  reste la source de vérité, rien en dur dans business-info). Fix règle
  (business-info § découverte) : citer prix + durée + nombre de séances de
  list_plans, et **interdiction de deviner** le contenu d'un plan quand la
  description ne le précise pas (proposer de confirmer via la réception).
  À savoir : au moment de la vente, Wix n'expose PAS le nombre de séances en
  donnée structurée (les benefits/pools ne sont lisibles que par membre, après
  achat) — la description du plan est la seule source ; la soigner dans Wix.

- **13/07 — Handoffs réception en un clic.** Tous les parcours où le client doit
  écrire à la réception donnent un `wa.me` vers `RECEPTION_PHONE`, avec message
  prérempli « prénom + motif » nettoyé et borné. Le client est averti que
  WhatsApp ouvre le message mais exige encore un appui sur Envoyer. Le lien est
  produit côté serveur pour les handoffs, annulations `studio:`, replis
  techniques et activations manuelles ; le modèle ne fabrique plus le contact.
  Le numéro brut reste disponible uniquement quand le client demande à appeler.
  Les reprises déjà automatiques (remboursement Awa, liaison de compte) ne
  demandent toujours aucune répétition au client.

- **13/07 — Lot « exactitude & fermeture » (revue externe, admin reporté).**
  Reçus : `paidVia` vient désormais de `payment_method` pour Wave, Orange Money,
  Max It et abonnement (helper partagé également par les liens/outils). CA admin :
  tous les rails payants + commandes café, abonnements de cours exclus. Relance
  lien expiré : ne prétend plus « rien débité » ; elle distingue absence de
  confirmation et paiement tout juste effectué (FR/EN/WO). Annulation payée via
  Awa : le remboursement est enregistré et traité sous 24h, sans demander au
  client de recontacter la réception ; le cas `studio:` reste inchangé. `/healthz`
  fait un `SELECT 1` borné à 2 s et renvoie 503 si Postgres ne répond pas.
  Verdict des 10 findings : (1) admin fail-closed **reporté par Babakar** ;
  (2) outbox durable **écartée** (dédup reprenable + drain Lot 2, résiduel backlog) ;
  (3) expiration **corrigée côté message** ; (4) reçus **corrigés** ;
  (5) menu vs liaison **choix produit écarté** ; (6) remboursement annulation
  **corrigé** ; (7) images Wolof **écartées** ; (8) revenus **corrigés** ;
  (9) admin mobile **écarté valeur/effort** ; (10) healthz **corrigé**, budget
  global message **écarté** (timeouts/retries Anthropic Lot 2).

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
  Même jour : **dashboard admin `/admin`** (voir §6) et **menu du bar** — Awa
  prend des commandes bar dans le même lien Wave que la résa, prix depuis
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
  (§4.6) ; **messages interactifs cliquables** `present_options` + flux bar
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
  bar-seul `create_cafe_payment_link` + table `pending_cafe_orders`, route
  webhook bar, confirmation client), **rappel 16h ajouté aux résas abonnement**
  (§4.19). 7 tests unitaires ajoutés (101 au total) ; intégration 14/14 verte.
  ⚠️ La forme de la réponse extended-bookings (get_my_bookings élargi) reste à
  confirmer sur de vraies données Wix.
- **10/07 (nuit, fin)** : **résa en un tap** (§4.20) — détection d'habitude
  (cours + jour + heure récurrents) proposée en raccourci cliquable, sans jamais
  court-circuiter check_availability. 5 tests unitaires (106 au total).
- **11/07 (via GitHub mobile)** : **résa abonnement multi-personnes** (§4.22,
  participants sur book_with_membership, all-or-nothing) et **planning des
  cours en image** (§4.23, get_class_schedule, PNG @napi-rs/canvas, cache
  30 min, repli texte). 12 tests ajoutés (118 au total).
- **11/07** : **quatuor UX** (§4.24) — **Awa lit les images** (description par
  le modèle injectée `[image reçue]`, règle « capture ≠ preuve de paiement »),
  **bar sans résa** sur demande explicite (commande autonome, retrait
  comptoir), **dates explicites** (7 jours nommés + règle date littérale dans
  le contexte dynamique), **reçu/facture → handoff**. 9 tests ajoutés (127 au
  total) ; intégration 14/14 verte.
- **11/07 (suite)** : **quatuor UX bis** (§4.25) — **liste d'attente** sur
  cours complet (join/leave_waitlist, sweep 5 min, relance one-shot, pas de
  template = fenêtre 24h assumée), **annulation des résas studio** par Awa
  (id `studio:`, 16h, argent via réception), **coachs visibles** dans
  check_availability (slot.resource.name, vérifié live), **lien bar dans le
  contexte dynamique**. 4 tests ajoutés (131 au total) ; intégration 14/14
  verte.
- **13/07** : **sept UX** (§4.37) — pages paiement wa.me, tips pré-cours par
  mots-clés, reçu image à la demande (`send_receipt`), waitlist template
  fallback 131047, raccourci mes prochains cours, micro-onboarding anti-clash
  liaison/habitude, runbook domaine custom. **Rebrand café → bar**.
  **Capability menus** sur ouverture vague (nouveaux + habitués), once ~24h.
  Puis **Orange Money / Max It** (§4.12) : extract fulfillment, client Sonatel,
  webhook + verify-by-lookup, 3 boutons de paiement, env Railway, paiements
  réels 100 F OK (OM + Max It), `om:create-link` + warm token. Plan :
  `ORANGE-MONEY-PLAN.md`. Puis **règle séance découverte** (business-info) :
  à un NOUVEAU client qui demande une séance découverte/essai, Awa propose le
  pack d'essai du catalogue (« Pack Découverte », vérifié live via list_plans +
  covers_classes) au lieu d'une séance à la carte — constat prod 13/07, une
  cliente découverte s'est vu vendre une à-la-carte 12 000 F sans mention du
  pack. Puis **fiabilisation payment-tunnel** (`buildHistoryMessages` : les
  tours `tool` sont rejoués dans le contexte du modèle → il voit ce qu'il a
  DÉJÀ fait ; garde-fous vérif : `recentlyResolved` refuse de re-vérifier un
  compte résolu < 10 min, message `no_pending_verification` = « déjà fait,
  continue » ; prompt : un paiement en attente ne met jamais la conv en pause,
  ne pas re-renvoyer boutons/lien déjà envoyés). Constat prod 13/07 : Awa
  ignorait une question (« où êtes-vous ? ») en plein paiement et re-poussait
  les boutons + re-soumettait un code périmé. 6 tests `historyReplay`.
- **Activation abonnement pour NOUVEAU client (13/07, étape 1 livrée ;
  étape 2 FERMÉE — no-go).** Contrainte (§11) : l'API offline `createOfflineOrder`
  exige un **member** id ; un vrai nouveau client n'a qu'une **fiche contact**
  (`createContact`) → `member_id` null → après paiement le plan reste PAID +
  activation manuelle réception. **Étape 1 livrée** : `create_plan_payment_link`
  renvoie `activation: manual_after_payment` + consigne quand `memberId` est null,
  pour qu'Awa prévienne le client AVANT paiement (activation par l'équipe juste
  après, pas instantanée). **Étape 2 (création paresseuse d'un member pour
  auto-activer) = NO-GO définitif**, tranché par deux probes live :
  (a) offline order avec contactId nu comme memberId → **400 `MEMBER_DOESNT_EXIST`** ;
  (b) `POST /members/v1/members` puis offline → **200 ACTIF**, MAIS Wix **envoie
  un email au client** (invitation / mot de passe) — inacceptable pour un
  paiement WhatsApp silencieux (le dashboard, lui, laisse ce mail optionnel, mais
  ce contrôle n'existe pas sur l'API). **Décision** : Awa n'auto-active QUE si un
  member existe déjà (`member_id` résolu à la création du lien) ; sinon chemin
  manuel réception (dashboard, mail optionnel). **Pas de `createMember` en prod.**
  Re-valider seulement si Babakar désactive un jour les emails d'invitation côté
  Wix : `npm run wix:probe-member` / `npm run wix:probe-contact-plan`. Détails +
  non-goals : `PLAN-PACK-DECOUVERTE-ACTIVATION.md`.
- **13/07 — Pack Découverte : garde-fou éligibilité (serveur décide).** Le pack
  d'essai est réservé aux clients qui n'ont **jamais fait de Pilates** à Revive
  (présence = booking CONFIRMED/PENDING dont le nom matche `/pilates/i` ;
  aquabike/yoga ne disqualifient pas). `isDiscoveryPlan(name)` (pur, tests) +
  `hasPastPilatesBooking(contactId)` (bookings-reader paginé, toute date ;
  erreur réseau → false, ne jamais bloquer une vente sur un bug) dans
  [wix.ts](src/lib/wix.ts). Gate dans `create_plan_payment_link` : si plan
  découverte + contact relié + historique Pilates → `discovery_not_eligible`
  (pas de lien de paiement ; Awa bascule à-la-carte). Contact non relié → on
  vend sans demander (friction minimale ; ancien client sur nouveau numéro
  accepté comme angle mort). business-info § découverte affiné. Hors v1 :
  flag `discovery_eligible` dans le contexte dynamique (évite un back-track
  UX mais coûte un appel bookings/tour). Hors scope : bloquer sur un pack
  déjà acheté (scoping = présence Pilates, pas l'achat du pack).
- **13/07 — Notif WhatsApp « nouvelle conversation » (Babakar seul, PAS la
  réception).** Un ping WhatsApp part vers `NEW_CHAT_NOTIFY_PHONE` (défaut
  `+221774982711`, configurable, vide = off) dès qu'un client **démarre** une
  conversation avec Awa : nouveau lead OU retour après un silence
  ≥ `NEW_CHAT_NOTIFY_GAP_HOURS` (défaut 6h) → un seul ping par session, pas un
  par message. **Destinataire = ce seul numéro** ; la réception (`notifyReception`,
  handoff/refund/non-relié) n'est PAS concernée par ce déclencheur. Détection :
  `isConversationStart(lastActivityAt, now, gapHours)` (pur, testé) sur
  `repo.lastConversationActivityAt` — appelée AVANT de persister le tour entrant.
  Branché dans `handleInboundText` (texte/bouton/vocal/image) + les 3 handlers
  média-en-échec. Livraison : `sendWhatsAppNotification(phone, …)` factorisé
  depuis l'ancien `sendReceptionWhatsApp` — texte libre d'abord, repli sur le
  template réception `WA_RECEPTION_TEMPLATE` si fenêtre 24h fermée (Meta 131047,
  facturé). **Piège** : sans ce template posé sur Railway, le ping n'arrive que
  si le numéro notifié a écrit à Awa dans les 24h. Fire-and-forget (ne bloque
  jamais la réponse). 5 tests `conversationStart`. Fichiers :
  [notify.ts](src/lib/notify.ts), [index.ts](src/agent/index.ts), config,
  repo, `.env.example`.
- **13/07 — Tests d'intégration Orange Money / Max It (`7fb8487`).** Nouveau
  fichier [orange-money-webhook.test.ts](test/integration/orange-money-webhook.test.ts)
  (15 cas) sur le même harnais Postgres jetable + fetch mock que Wave. Valide
  le chemin **unsigned callback → OAuth → GET transactions (source de vérité)
  → fulfillment partagé → BOOKED** (ou REFUND_NEEDED). Anti-forgery (lookup
  vide / montant / partner / order), idempotence `om:{transactionId}`, lookup
  500 non marqué processed puis retry. Env dummy + mock dans
  [globalSetup.ts](test/integration/globalSetup.ts) /
  [helpers.ts](test/integration/helpers.ts) (`deliverOmWebhook`). Suite
  intégration ensuite **30/30** (15 Wave + 15 OM) en CI. Détail : §4.12.
- **13/07 — LOT 1 : stop perte d'argent silencieuse (`6a70364`).**
  (1.1) Plans + café : `claim*ForFulfillment` + `stuckPaid*` + reconcile dans le
  sweep 60 s (`fulfilling_at`, `reception_notified_at` plan, `fulfilled_at` café)
  — un crash entre PAID et activation/notif ne laisse plus d'orphelin sans
  reprise. (1.2) Après `BOOKED` / `createBooking` Wix, **jamais** de
  `markRefund` : échec WhatsApp → notif réception « confirmé mais client non
  notifié ». (1.3) `DRAFT → PAID` autorisé (session provider créée, crash avant
  `setAwaitingPayment`) + expire DRAFT > 1 h ; test intégration Wave
  DRAFT→BOOKED. (1.5) Webhook OM : existence locale de `order` **avant** lookup
  Sonatel ; rate-limit 1/h des notifs « introuvable ». (1.6) `refund_notified_at`
  + re-notify sweep. Bonus : WhatsApp mark-processed-after-success +
  `drainQueues` au SIGTERM. Fichiers : [fulfillment.ts](src/domain/fulfillment.ts),
  [repo.ts](src/domain/repo.ts), [stateMachine.ts](src/domain/stateMachine.ts),
  [schema.ts](src/db/schema.ts), [orangeMoney.ts](src/lib/orangeMoney.ts) /
  [webhooks/orangeMoney.ts](src/webhooks/orangeMoney.ts), [index.ts](src/index.ts).
- **13/07 — LOT 2 : résilience boucle agent + arrêt propre.** Issu du même audit
  robustesse (3 axes : paiement, infra/ops, boucle agent). (2.5) Client Anthropic
  (boucle + describe-image) avec `timeout: 60_000` + `maxRetries: 2` — un appel
  qui pend ne bloque plus ~10 min la file sérialisée du client (`88ba0e3`).
  (2.6) Filets `uncaughtException` (notif réception + exit contrôlé, Railway
  redémarre) / `unhandledRejection` (log, non fatal) — sur mono-instance une
  erreur non catchée = downtime total (`88ba0e3`). (2.3) Cap `MAX_TOOL_ITERATIONS`
  atteint alors que le modèle veut encore un outil → un DERNIER appel **sans
  outils** force une réponse réelle (lien/résa créés inclus) au lieu du
  « souci technique » mensonger (`3b6d268`). (2.4) `stop_reason: max_tokens`
  détecté → retry budget élargi (2048→4096) : on ne renvoie plus un message ou un
  lien de paiement tronqué ; `extractText` extrait + testé (`3b6d268`). (2.1) Drain
  de la file par client au SIGTERM (`drainQueues`, 25 s) avant exit : un deploy ne
  tue plus les conversations en cours. (2.2) Dédup WhatsApp **reprenable**
  (`wasProcessed` + `markProcessed` APRÈS succès + claim `inFlightMessages`
  synchrone) : un crash en cours de traitement ne perd plus le message (Meta
  retente) — contrairement à l'ancien mark-before. 2.1/2.2 mergés dans `6a70364`
  (réconciliation multi-agents : Lot 1 et Lot 2 éditaient `index.ts`/`whatsapp.ts`
  en parallèle ; commit unique pour ne rien écraser). Fichiers :
  [agent/index.ts](src/agent/index.ts), [lib/imageInput.ts](src/lib/imageInput.ts),
  [lib/serialize.ts](src/lib/serialize.ts), [webhooks/whatsapp.ts](src/webhooks/whatsapp.ts),
  [index.ts](src/index.ts). **Reste de l'audit (non fait)** : Lot 3 (hygiène infra —
  `/healthz` réel, timeouts pool pg, purge tables non bornées, sanitisation textes
  client→réception, alerting sweeps, admin ouvert si `ADMIN_USERS` vide) ; Lot 4
  (doc mono-instance + tests webhook WhatsApp/boucle agent, aujourd'hui à zéro).
- **13/07 — Poller search OM retiré (`5df41cb`).** Suite probe live : list API
  sans `metadata.order` → auto-reconcile impossible. Code poller supprimé du
  sweep ; chemin OM = **callback + lookup `transactionId` uniquement**. Voir
  §4.12 « Poller search transactions ABANDONNÉ ».
- **13/07 — Hotfix re-spam message remboursement (Syndel, Linsey, …).** Cause :
  LOT 1 a ajouté `refund_notified_at` **sans backfill** ; le sweep 60 s
  `reconcileUnnotifiedRefunds` a repris **tous** les `REFUND_NEEDED` historiques
  (colonne NULL) et renvoyé le template « place prise / remboursé sous 24h »
  (`refundMessage` défaut `slot_taken`) comme si c'était un paiement frais.
  Fix : backfill one-shot dans schema (`refund_notified_at = updated_at` pour
  les REFUND_NEEDED/REFUNDED créés avant le deploy) + le sweep ne re-notifie
  que les lignes **récentes** (grace 2 min, max âge 2 h). Leçon : toute colonne
  « notifié ? » doit backfiller l'historique ou borner le temps.
- **12/07** : **boucle de résultat** (§31, aucun client ne repart en silence :
  filets déterministes + classificateur LLM + files admin + digest quotidien),
  puis **proposition de liaison dès le 1er contact d'un numéro inconnu** (§32 —
  une abonnée sur un numéro non relié n'est plus poussée au paiement Wave sans
  qu'Awa lui propose d'abord, une fois, de relier son compte par email). 182
  tests. Puis **invitation avant paiement fiabilisée + Awa crée le compte des
  nouveaux** (§33). Puis **édition du profil WhatsApp Business depuis
  `/admin/profile`** (§34 — description/adresse/photo via l'API Cloud, horaires
  composés dans la description faute de champ dédié côté Meta). Puis **vente
  d'abonnements : renouvellement self-service + alerte réception pour les
  combinaisons absentes du catalogue** (§35). Puis **renouvellement : date de
  début choisie (chaînage Wix startDate) + offre en conversation + rappel push
  J-3 dormant** (§36). 211 tests.

## 6. Reste à faire

**Tests E2E en attente :**
- [ ] Rembourser 50 FCFA du test groupe raté (portail Wave, session
  cos-25wmbc6bg1y6y) puis cliquer « ✅ Remboursement effectué » dans /admin
  (ou `refund:done -- af3124b4-e6da-4108-911c-322000b604ca` en secours).
- [ ] Achat d'abonnement via Awa ("test fusion" 50 FCFA) — flux vente jamais
  encore exercé en réel. En profiter pour vérifier §35 : demander à Awa un
  renouvellement (doit proposer un rachat direct, pas un renvoi au studio) et
  demander une combinaison absente du catalogue (doit déclencher un handoff
  « Créer un abonnement : … » reçu côté réception).
- [ ] §36 chaînage : racheter un plan avec `start:"after_current"` alors qu'un
  plan est actif → vérifier dans Wix que l'ordre est PENDING avec la bonne
  `startDate`, et que la confirmation WhatsApp annonce la date. Sans plan actif
  → repli « démarre maintenant ».
- [ ] §36 rappel push J-3 : APRÈS approbation du template Meta (en vérification
  au 12/07), poser `WA_RENEWAL_TEMPLATE` (+ lang) sur Railway, créer un plan
  test finissant sous 2-3 j → le sweep 5 min envoie UN template (relancer : pas
  de doublon) ; y répondre → Awa enchaîne sur le renouvellement.
- [ ] Re-test groupe : 5 places Fusion (le cap Wix est maintenant 8).
- [ ] Test optionnel du refus < 16h (seul chemin annulation pas observé en réel).
- [ ] Commande bar adossée à une résa (extras dans le lien Wave) — flux
  jamais encore validé E2E ; vérifier aussi l'email réception « commande bar
  payée » et le détail dans la confirmation client.
- [ ] Relance lien expiré : laisser expirer un lien de 10 FCFA sans payer →
  UNE relance ~1 min après le TTL, puis répondre « oui » et vérifier qu'Awa
  refait le lien directement.
- [ ] Images entrantes : envoyer une capture de paiement Wave à Awa → elle
  décrit ce qu'elle voit SANS confirmer la résa (la confirmation reste le
  webhook) ; envoyer une photo quelconque → réponse naturelle ; vérifier le
  repli poli sur une image illisible.
- [ ] Bar sans résa : demander un smoothie sans réserver de cours → lien Wave
  bar seul, confirmation « à récupérer au comptoir », email réception « sans
  réservation ».
- [ ] `/admin/profile` (§34, jamais testé E2E) : éditer description/adresse/
  horaires → vérifier le reflet dans le profil WhatsApp Business réel (app ou
  Meta Business Suite) ; si `WA_APP_ID` configuré, tester aussi le changement
  de photo via URL.
- [ ] Date explicite lointaine : demander « et le [date à +3 semaines] ? » →
  fenêtre correcte (bonne date, bonne année), pas d'arithmétique inventée.
- [ ] Liste d'attente : s'inscrire sur un cours plein, libérer une place dans
  Wix → UNE relance dans les ~5 min, puis « oui » → lien direct. Vérifier
  aussi leave_waitlist et le cas « le slot est en fait ouvert ».
- [ ] Annulation résa studio : réserver au comptoir avec le numéro du testeur,
  annuler via Awa (≥16h) → annulée dans Wix + email réception
  « vérifier remboursement/re-crédit » + message client vers la réception.
- [ ] Coach : « c'est qui le coach d'Aquabike ? » → nom réel depuis les
  créneaux (yves SAGNA attendu), jamais inventé.
- [ ] Lien bar en attente : créer un lien bar, demander « il est encore
  valable ? » → réponse ferme avec les minutes restantes.
- [ ] Report en un geste : déplacer une résa abonnement (re-crédit + re-résa
  même tour) et une résa Wave (OK explicite avant annulation).
- [ ] Solde d'abonnement : « il me reste combien de séances ? » → chiffre
  cohérent avec Wix, décrémenté après une résa, re-crédité après annulation.
- [ ] get_my_bookings élargi : réserver une place au comptoir/site avec le
  numéro du testeur, puis « mes cours ? » → la résa studio apparaît (annulable
  ≥16h via l'id studio:). ~~Vérifier la forme extended-bookings~~ → **FAIT
  (11/07, cas Marie §4.26)** : filtre corrigé (`contactDetails.contactId`),
  pagination ajoutée ; reste à voir une résa studio À VENIR s'afficher en réel.
- [ ] Menu aux abonnés : réserver par abonnement puis commander un smoothie →
  lien Wave bar-seul, paiement, confirmation client + email réception «☕ résa
  abonnement».
- [ ] Résa en un tap : après ≥2 résas d'un même cours/jour/heure, un nouveau
  « je veux réserver » doit proposer le raccourci « comme d'habitude ? » ; sur
  « oui », vérifier qu'Awa relance bien check_availability (pas de lien direct).

**Avant lancement (essentiellement côté Babakar, dans Wix) :**
- [x] **Protéger `/admin`** → **FAIT (13/07)** : login fallback en dur
  `revive`/`revive` quand `ADMIN_USERS` est vide — plus jamais ouvert sans
  login. Optionnel plus tard : poser `ADMIN_USERS` sur Railway pour des comptes
  nominatifs (les logs d'action diraient qui a cliqué) et un mot de passe fort.
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
- [x] **Orange Money / Max It** → **FAIT (13/07)** : code + env Railway + liens
  payants validés (§4.12). Reste éventuel : E2E résa chat complète + poller
  réconciliation OM si webhooks ratés.
- [ ] `npm run om:create-link` : documenter dans README (lien vers
  `OM-LINKS-HOW-TO.md`) si pas déjà clair.

- [x] **Dashboard admin Awa** → **FAIT (10/07)** : `/admin` en production —
  Basic Auth 2 comptes (`ADMIN_USERS` : babakar + reception), vue d'ensemble
  (« à traiter » : remboursements avec bouton de pointage, abonnements à
  activer, handoffs 7 j + stats jour/7 j), conversations (recherche + fil
  complet avec appels d'outils repliés), réservations/abonnements filtrables,
  registre handoffs. Aucune action monétaire automatique (décision ferme).
  Code : `src/admin/` (auth.ts, queries.ts, routes.ts) — HTML server-rendered,
  zéro dépendance. `refund:done` conservé en secours CLI.

**Backlog Phase 2** (voir `PHASE2.md`) — tête de liste suggérée :
remboursements automatiques Wave/OM, notification client quand `refund:done`
clôture réellement un remboursement, rappels de séance (templates Meta),
stats admin, domaine custom bookings.revive.sn. (OM/Max It, get_my_bookings
élargi, vente d'abonnements, report, transcription : déjà en prod ou Phase 1+.)

## 7. Runbook ops

- **Orange Money / Max It** (prod) :
  - Env Railway : `OM_CLIENT_ID`, `OM_CLIENT_SECRET`, `OM_MERCHANT_CODE=553651`,
    `OM_API_BASE=https://api.orange-sonatel.com` (vide = Wave only).
  - Webhook : `POST {BASE_URL}/webhooks/orange-money` (posé via header
    `X-Callback-Url` à la création du QR — pas d'enregistrement merchant).
  - Test lien sans chat : `npm run om:create-link -- 100` puis ouvrir
    `om-last-links.txt` (voir `OM-LINKS-HOW-TO.md`). Logs : `[om] token…`,
    `[om] createQrPayment token=…ms qr=…ms`, `OM webhook received`.
  - Remboursements OM : manuels (portail / réception), comme Wave Phase 1.
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
