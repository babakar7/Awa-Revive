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
Postgres). Numéro WhatsApp prod : **+221 78 953 66 76** (WABA 1738439110507790,
phone_number_id 1175926012276896). Tests : 34/34 verts (`npm test`).

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
| Emails réception (SMTP Namecheap) | ✅ | non-bloquants (voir §4) |
| Annulation côté réception (dashboard Wix) | ✅ | sweep 5 min = synchro **silencieuse** ; Wix notifie le client lui-même |
| Typing indicator | ✅ | rafraîchi à chaque itération d'outil (Meta l'éteint à ~25 s) |

## 3. Carte du code

```
src/
  index.ts            boot : assertConfig, migrate (idempotent), sweepers (TTL 60s, annulations 5min)
  server.ts           Fastify, raw-body parser, /healthz, pages retour paiement
  config.ts           env (liste TOUTES les vars manquantes d'un coup) ; SMTP optionnel
  db/schema.ts        SCHEMA_SQL idempotent (create + alter if not exists)
  domain/
    stateMachine.ts   DRAFT→AWAITING_PAYMENT→PAID→BOOKED ; EXPIRED→PAID (paiement tardif) ;
                      BOOKED→CANCELLED | REFUND_NEEDED ; REFUND_NEEDED→REFUNDED.
                      transition() = UPDATE atomique WHERE status=ANY(sources)
    repo.ts           accès DB (clients, bookings, conversations, handoffs, slot_cache)
    cancellationSync.ts  sweep 5 min : BOOKED vs statuts Wix → CANCELLED silencieux (pas de message client)
  lib/
    whatsapp.ts       signature X-Hub-256, sendText (3 retries), typing indicator (loggé si rejeté)
    wave.ts           checkout session (+ Wave-Signature sortante, OBLIGATOIRE sur ce compte), verif webhook
    wix.ts            services (cache 10 min), dispos, contacts, bookings (create/confirm/decline/cancel),
                      Benefit Programs (findEligibleBenefit / redeem / revert) — voir §4
    cafeMenu.ts       menu café : parse cafe-menu.md au boot (prix côté serveur uniquement),
                      computeExtras (résolution ids+qty → lignes tarifées, rejet des ids inconnus)
    notify.ts         notifyReception() : email fire-and-forget (retourne AVANT l'envoi), timeouts 10-30 s
    rateLimit.ts      20 msg/min/numéro ; serialize.ts : file par client
  agent/
    systemPrompt.ts   prompt stable caché + dynamicContext (date, langue, lien actif, abonnements)
    tools.ts          list_classes, check_availability, create_payment_link, check_membership,
                      book_with_membership, get_my_bookings, cancel_booking, record_email, handoff_to_human
    index.ts          boucle d'outils (max 8), détection de langue fr/en/wo (stopwords), cache abonnements 10 min
  webhooks/
    whatsapp.ts       GET handshake + POST signé → dedupe → rate limit → file par client
    wave.ts           CHEMIN CRITIQUE : signature → 200 rapide → idempotence → PAID atomique →
                      re-vérif places → création+confirmation Wix → BOOKED → confirmation WhatsApp
scripts/              simulate-wave-webhook, daily-summary, mark-refunded (refund:done), test-email
test/                 34 tests purs (signatures, state machine, langue) — pas de DB/réseau
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
6. **Emails réception** : `notifyReception()` retourne AVANT l'envoi SMTP (un
   `await` sur l'envoi a déjà bloqué une réponse WhatsApp 2 minutes). SMTP =
   Namecheap Private Email (`mail.privateemail.com:465`, support@revive.sn) ;
   DNS (MX/SPF/DKIM) déjà corrects, rien à configurer.
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

**Avant lancement (essentiellement côté Babakar, dans Wix) :**
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
report en un geste, transcription vocale.

## 7. Runbook ops

- Déploiement : `npm run build && npm test` puis `railway up --detach` ;
  santé : `GET /healthz` ; logs : `railway logs`. La migration tourne au boot.
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
