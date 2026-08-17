# Plan — Annulation automatique des cours vides

> **STATUT : IMPLÉMENTÉ (17/08/2026, branche `agent/auto-cancel-empty-classes`).**
> Gate de faisabilité Wix (§2) RÉUSSI (probe live) ; préavis minimum : 120 min
> (§9). Détails + écarts dans PROGRESS.md. Reste globalement désactivé tant
> qu'aucune règle n'est activée. Écart notable : annulation **en 2 phases**
> (CANCELLING committé sous verrou puis cancel Wix hors verrou, le garde-fou des
> réservations couvrant la fenêtre) plutôt qu'une transaction unique — permet la
> récupération des `CANCELLING` bloqués sans verrou session-level.
> Rédigé le 17/08/2026 après trois itérations de revue ; toutes les assertions
> sur le code existant ont été vérifiées (cf. §10). Chantier :
> `npm run agent:new -- auto-cancel-empty-classes` — toujours depuis
> `origin/main`, re-vérifier les références après rebase.

## 0. Objectif

Annuler automatiquement l'**occurrence** d'un cours collectif Wix restée vide
après son cutoff, et prévenir par WhatsApp le coach du cours, le owner et le
manager. La série récurrente n'est jamais touchée. Aucune annulation sans
préconditions toutes vérifiées sur données Wix fraîches — **fail-closed
partout** : au moindre doute (capacité inconnue, contact manquant, lecture Wix
en échec), on n'annule pas.

## 1. Règles produit

- **Cutoff** (calculs en `Africa/Dakar`, `config.TIMEZONE`) :
  - cours démarrant **à 09:15 inclus ou avant** → éligible à partir de
    **23:00 la veille** (décision du soir pour que personne ne se lève pour rien) ;
  - cours plus tardif → éligible à partir de **start − 3 h**.
- **Vide en continu 15 minutes** après le cutoff. « Vide » = données Wix
  fraîches exposant une **capacité valide** ET **exactement 0 participant
  confirmé**. Capacité invalide/absente = inconnue = pas d'annulation.
- **Le timer (first_empty_at) est remis à zéro** quand :
  - Wix rapporte ≥ 1 participant ;
  - une réservation locale `AWAITING_PAYMENT` non expirée existe pour la
    session (lien Wave/OM en cours) ;
  - l'écart depuis la précédente observation réussie dépasse **2 minutes**
    (un deploy/crash ne compte jamais comme du vide observé).
- **Fenêtre** : de l'éligibilité jusqu'à `start − AUTO_CANCEL_MIN_NOTICE_MINUTES`
  (préavis minimum ; **décision Babakar 17/08/2026 : 120 min**). Conséquence
  assumée : pour un cours de journée (cutoff start−3h), la fenêtre effective ne
  dure qu'1 h — le cours doit être vide au plus tard à start−2h15 pour boucler
  les 15 min de vide continu.
- Un cours devenant vide trop tard pour boucler 15 min + préavis reste intact.
- **Une seule occurrence annulée**, jamais le planning récurrent.

## 2. Gate de faisabilité Wix — ✅ RÉUSSI (probe live du 17/08/2026)

> **Résultats** (script conservé : [scripts/probe-cancel-event.ts](scripts/probe-cancel-event.ts),
> occurrence jetable « Pilates Fusion » du 22/08 13:30, service caché, créée par
> Babakar, go explicite) :
>
> 1. `POST /calendar/v3/events/{eventId}/cancel` accepté avec la clé API
>    actuelle (« Toutes les autorisations de site » couvre
>    `SCOPE.DC-CALENDAR.MANAGE` — aucun changement de clé nécessaire).
> 2. Occurrence seule : l'événement était `recurrenceType=NONE` ; le probe
>    refuse par garde-fou tout `MASTER`. Re-fetch → `status=CANCELLED`.
> 3. **Propagation confirmée** : le créneau disparaît immédiatement de
>    `availability-calendar/v1/availability/query` (la source d'Awa ET du
>    widget).
> 4. **Course résiduelle bornée** : un Create Booking avec le slot brut capturé
>    AVANT l'annulation → **HTTP 428 `SLOT_NOT_AVAILABLE`** — Wix refuse. Le
>    blast radius du §9 est donc « refus propre », pas « réservation fantôme ».
> 5. Notifications : `participantNotification.notifyParticipants` **par défaut
>    `false`** — Wix n'envoie rien sans demande explicite. Le moteur passera
>    explicitement `false`.
>
> Conclusion : implémentation sur Calendar V3, pas d'endpoint legacy.
> L'adaptateur `cancelClassOccurrence()` reste la seule porte de mutation.

### Protocole d'origine (pour référence)

Avant d'implémenter le moteur, prouver sur une **occurrence jetable
explicitement dédiée** (service de test masqué — jamais un vrai cours ni un
événement maître récurrent) que Calendar V3 Cancel Event
(<https://dev.wix.com/docs/api-reference/business-management/calendar/events-v3/cancel-event>) :

1. annule **seulement cette occurrence** (la série reste active) ;
2. la fait disparaître des requêtes de disponibilité, de `list_classes` et du
   widget public Wix ;
3. **refuse une réservation ultérieure** sur cette occurrence ;
4. et observer les **effets de bord côté participants** : Wix envoie-t-il ses
   propres emails/notifications à l'annulation ? Y a-t-il un toggle
   `participantNotification` ? → détermine le blast radius de la course
   résiduelle §9 et le runbook de récupération.

Si Calendar V3 ne se propage pas à la disponibilité Bookings, tester l'endpoint
legacy d'annulation de session unique sur une autre occurrence jetable, et
isoler l'endpoint retenu derrière le même adaptateur `cancelClassOccurrence()`
— le reste du plan ne change pas.

Prérequis : permission **Manage Calendars** accordée à la clé API Wix avant
activation. Identifiant : **toujours le `slot.eventId` court compatible
Calendar** (déjà normalisé en `rescheduleEventId`, [src/lib/wix.ts:479](src/lib/wix.ts#L479)),
**jamais** le `sessionId` de disponibilité long (334 caractères, incident
Kadiatou, garde-fou [src/lib/wix.ts:2423](src/lib/wix.ts#L2423)). Occurrence
sans `slot.eventId` (champ optionnel côté Wix) → **loggée et ignorée**
(fail-closed).

## 3. Données

- **`auto_cancel_rules`** : service Wix exact, jours de semaine éligibles,
  plage horaire de début, `enabled`, contacts fixes owner + manager
  sélectionnés dans le répertoire existant. Contraintes d'activation : coach
  dynamique du cours + **au moins 2 contacts fixes distincts**, actifs, **non
  muets**, avec numéros valides — sinon l'activation est refusée (visible dans
  l'admin, jamais un no-op silencieux).
- **`auto_cancel_ledger`**, clé **globale** = event ID Calendar de
  l'occurrence : session ID de disponibilité (mapping pour le verrou §4),
  règle appariée, `first_empty_at`, `last_observed_at`, état
  (`OBSERVING` / `CANCELLING` / `CANCELLED` / `FAILED`), `cancelled_at`,
  erreurs. L'unicité globale empêche toute double annulation entre règles
  chevauchantes, redémarrages et workers concurrents.
- Extension de `notification_log` ([src/db/schema.ts:853](src/db/schema.ts#L853)) :
  source `auto_cancel`, **dedup key par destinataire** = event ID d'occurrence
  + numéro normalisé (l'index unique `dedup_key` existe déjà,
  [src/db/schema.ts:874](src/db/schema.ts#L874)).
- Interfaces repo : CRUD des règles, affectation destinataires, claim/reset
  d'observation, lookup paiement actif par session ID, complétion
  d'annulation, claims de livraison.

## 4. Moteur d'annulation

Tourne dans une **section propre (try/catch dédié)** du sweeper 60 s existant
([src/index.ts:110](src/index.ts#L110)) — un hoquet Wix ne doit jamais bloquer
l'expiration/réconciliation, et réciproquement.

1. **Candidats** : occurrences des règles actives dans leur fenêtre §1. Peu de
   candidats simultanés → un fetch Wix frais par candidat et par tick est
   acceptable. **Jamais le cache planning 5 min de `notificationSweep`** —
   données fraîches via `getCalendarEventV3` ([src/lib/wix.ts:261](src/lib/wix.ts#L261)),
   dont la garde capacité-valide existe déjà
   ([src/lib/wix.ts:98-110](src/lib/wix.ts#L98-L110)).
2. Appliquer les **resets** §1 ; sinon poser/garder `first_empty_at`,
   mettre à jour `last_observed_at`.
3. **Pré-mutation** : résoudre le coach et les contacts requis. Contact
   manquant/muet/invalide → **pas d'annulation**, échec enregistré au ledger,
   **une seule alerte dédupliquée par occurrence** (pas une par minute pendant
   3 h) aux destinataires résolubles.
4. **Vérification finale** : re-fetch de l'occurrence — identité, statut
   actif, 0 participant, règle toujours appariée, continuité d'observation
   valide (`last_observed_at` ≤ 2 min), aucun paiement actif.
5. **Verrou** : la vérification finale + la mutation Wix se font sous
   `pg_advisory_xact_lock(hashtext($1))` — forme **transactionnelle**, jamais
   session-level (piège du pool de connexions) ; idiome déjà en place
   ([src/domain/coachPaymentRepo.ts:144](src/domain/coachPaymentRepo.ts#L144)).
   **Clé canonique du verrou = le session ID de disponibilité** : chaque
   chemin de réservation l'a déjà en main, et le ledger fournit le mapping
   event ID → session ID côté annulation. Décision figée — aucun choix
   d'implémenteur.
6. Marquer `CANCELLING` **avant** l'appel Wix ; `CANCELLED` **seulement après
   confirmation** de l'état par re-fetch. Timeout ambigu → re-fetch du statut
   avant tout retry ; **ne jamais rejouer** une annulation déjà confirmée.
7. **Récupération des `CANCELLING` périmés** (crash/deploy entre le marquage
   et la confirmation — chaque push redéploie) : à chaque sweep, toute ligne
   `CANCELLING` de plus de ~2 min → re-fetch Wix → finaliser `CANCELLED` si
   Wix confirme, sinon **revenir à `OBSERVING` avec timer remis à zéro**. Une
   ligne bloquée ne doit **jamais** rendre définitivement irréservable un
   cours encore actif côté Wix. (Même esprit que les reconcile-stuck-PAID du
   sweeper.)

## 5. Protection des chemins de réservation

- **Tous** les chemins locaux de création de réservation de cours prennent le
  **même verrou** (clé = session ID) autour de leur check final de
  disponibilité + création : chemin payé
  (`wix.createBooking`, [src/domain/fulfillment.ts:221](src/domain/fulfillment.ts#L221)),
  chemin abonnement (`createBookingRaw` + `redeemMembershipForBooking`,
  [src/domain/fulfillment.ts:1011](src/domain/fulfillment.ts#L1011)), et les
  redemptions directes Clés / bonus / invitations.
- **Sous verrou** : rejeter toute occurrence dont le ledger est `CANCELLING`
  ou `CANCELLED`.
- **Paiement mobile-money tardif** (chemin honoré `AWAITING_PAYMENT → EXPIRED
  → PAID`, [src/db/schema.ts:378](src/db/schema.ts#L378)) visant une
  occurrence auto-annulée → `REFUND_NEEDED` avec **raison distincte
  `class_auto_cancelled`**, via le workflow de remboursement durable existant
  (notif client + réception, [src/domain/fulfillment.ts:1431](src/domain/fulfillment.ts#L1431)).
  Nota : le chemin payé route déjà un slot indisponible vers `REFUND_NEEDED`
  via `findSlot` ([src/domain/fulfillment.ts:203](src/domain/fulfillment.ts#L203)) —
  le check ledger ajoute la **bonne raison**, couvre les chemins abonnement et
  réduit la course.
- **Plan activé dont le premier cours est auto-annulé** → le plan reste actif,
  flux deferred-slot existant pour proposer un autre créneau.
- **Redemptions directes** (Clé, bonus, invitation) → refus de l'occurrence
  annulée **avant** le redeem, retour au flux d'alternatives
  slot-indisponible existant.
- **`slot_cache`** ([src/db/schema.ts:575](src/db/schema.ts#L575),
  [src/domain/repo.ts:2150](src/domain/repo.ts#L2150)) : les lookups excluent
  les entrées `CANCELLING`/`CANCELLED`, et les lignes de la session sont
  **purgées à la confirmation** — une réponse WhatsApp périmée (« oui pour
  7h15 ») redéclenche une recherche de disponibilité fraîche au lieu de
  pousser la cliente vers une réservation vouée à l'échec.

## 6. Notifications et administration

- Après `CANCELLED` confirmé : **une livraison durable par destinataire
  distinct** (coach, owner, manager) via la machinerie existante de
  `notificationSweep` — template-first (le staff est ~toujours hors fenêtre
  24 h), gestion 131047, retries transitoires **indépendants par
  destinataire**, échecs permanents visibles au journal
  ([src/domain/notificationSweep.ts:173](src/domain/notificationSweep.ts#L173)).
- Contenu : cours, date, heure, coach, règle, raison de l'annulation.
- **États annulation et notification strictement séparés** : un retry de
  notification ne peut jamais rejouer la mutation Wix.
- Admin `/admin/notifications` étendu : CRUD des règles, sélection des
  contacts, checks d'activation (owner/manager manquant, muet, dupliqué ou
  sans numéro → activation bloquée et **affichée comme erreur**, y compris si
  le owner se met lui-même en muet), statut des annulations récentes,
  **pause globale**, et remontée visible des eventId Wix absents, échecs
  d'annulation et échecs de livraison.

## 7. Plan de test

- Cutoffs : borne **09:15 incluse**, calcul 23:00 la veille (passage de
  minuit), règle start−3 h, jours de semaine, plages horaires, tout en
  `Africa/Dakar`.
- Continuité : 15 min ininterrompues requises ; reset sur participant
  restauré, sur paiement actif, sur expiration de paiement (le sweep suivant
  reprend l'éligibilité), et sur **gap d'observation > 2 min**
  (redémarrage/deploy).
- Fail-closed : capacité inconnue, participants ≠ 0, occurrence
  inactive/annulée, eventId Calendar absent, destinataires manquants/muets,
  échecs de lecture Wix, occurrence dépareillée → **aucune annulation**.
- Vérification finale : un participant apparu pendant la grâce → abandon.
- Unicité : une seule occurrence annulée (jamais la série) ; règles
  chevauchantes, redémarrages, workers concurrents → pas de double
  annulation ; timeout Wix ambigu puis vérification de statut ; réponse
  « déjà annulé ».
- **Courses sous verrou** : annulation vs création payée, abonnement, Clé,
  bonus, invitation.
- Paiement tardif → `REFUND_NEEDED` raison `class_auto_cancelled` + alerte
  réception + message client.
- `slot_cache` : invalidation + réponse interactive périmée → recherche
  fraîche.
- **Récupération `CANCELLING` périmé** : crash simulé après marquage →
  finalisation ou retour à `OBSERVING`, jamais de blocage permanent.
- Notifications : livraison indépendante par destinataire, retries
  transitoires, échecs permanents, dedup des retries, alertes de
  configuration **one-shot par occurrence**.
- Intégration : claims DB/redémarrages, CRUD admin + validations ; Wix mocké :
  succès, précondition échouée, timeout ambigu + vérification, déjà-annulé.

## 8. Rollout et ops

- **Désactivé globalement** tant que le probe §2 n'a pas réussi ; ensuite
  activation règle par règle via l'admin, pause globale disponible.
- Ce chantier touche au flux paiement → **`npm run agent:ship -- --full`
  obligatoire**. Rappel : 4 échecs d'intégration préexistants sur
  `origin/main` depuis le 06/08 (planFulfillment/OM/wave `emailCalls`) —
  vérifier `HEAD~1` avant d'accuser le diff.
- Vérifier le déploiement par commit hash (`railway status --json`), pas par
  `/healthz`.
- À l'implémentation : mettre à jour PROGRESS.md (décision, pièges,
  chronologie).

## 9. Hypothèses et décisions

- « Jusqu'à 09:15 » **inclut** un cours démarrant exactement à 09:15.
- **Aucun message client** pour l'occurrence elle-même : l'annulation exige
  0 participant vérifié ; les payeurs tardifs reçoivent le message
  refund-needed existant.
- Les contacts **muets ne sont pas des destinataires requis valides** ; les
  règles doivent utiliser des contacts actifs.
- Réservation concurrente **via le dashboard ou le widget Wix** : le verrou
  local ne peut pas la couvrir ; la protection restante = check final frais +
  comportement de l'endpoint vérifié au probe §2 (fenêtre résiduelle de
  l'ordre de la seconde ; blast radius et runbook documentés par le point 4
  du probe).
- **DÉCIDÉ (Babakar, 17/08/2026)** : préavis minimum
  `AUTO_CANCEL_MIN_NOTICE_MINUTES` = **120** (configurable en variable
  d'environnement, défaut 120).
- Effet assumé : chaque `git push` = deploy = reset des timers en cours → une
  soirée chargée en deploys retarde les annulations vers le floor de préavis.
  Conservateur par construction, acceptable.

## 10. Références vérifiées contre le code (17/08/2026)

| Assertion | Preuve |
| --- | --- |
| Sweeper 60 s existant, sections try/catch indépendantes | [src/index.ts:110](src/index.ts#L110) |
| Cache planning notifications = 5 min (à ne PAS utiliser ici) | [src/domain/notificationSweep.ts:38](src/domain/notificationSweep.ts#L38) |
| Fetch Calendar V3 + garde capacité valide déjà en place | [src/lib/wix.ts:261](src/lib/wix.ts#L261), [src/lib/wix.ts:98-110](src/lib/wix.ts#L98-L110) |
| eventId court déjà normalisé (`rescheduleEventId`), optionnel côté Wix | [src/lib/wix.ts:479-481](src/lib/wix.ts#L479-L481) |
| Garde anti-sessionId long (incident Kadiatou 334 chars) | [src/lib/wix.ts:2423-2431](src/lib/wix.ts#L2423-L2431) |
| Idiome verrou advisory transactionnel | [src/domain/coachPaymentRepo.ts:144](src/domain/coachPaymentRepo.ts#L144) |
| Chemin payé : `findSlot` → `REFUND_NEEDED` déjà existant | [src/domain/fulfillment.ts:203](src/domain/fulfillment.ts#L203), [src/domain/fulfillment.ts:1431](src/domain/fulfillment.ts#L1431) |
| Chemin abonnement : `createBookingRaw` + `redeemMembershipForBooking` | [src/domain/fulfillment.ts:1011-1023](src/domain/fulfillment.ts#L1011-L1023) |
| Paiement tardif honoré `EXPIRED → PAID` | [src/db/schema.ts:378](src/db/schema.ts#L378) |
| Livraison staff template-first + 131047 + journal + dedup | [src/domain/notificationSweep.ts:173-186](src/domain/notificationSweep.ts#L173-L186), [src/db/schema.ts:874](src/db/schema.ts#L874) |
| `slot_cache` (schéma + accès) | [src/db/schema.ts:575](src/db/schema.ts#L575), [src/domain/repo.ts:2150](src/domain/repo.ts#L2150) |
| Admin notifications existant (page + pause) | [src/admin/routes.ts:3464](src/admin/routes.ts#L3464) |
