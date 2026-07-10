# Revive Bookings — Backlog Phase 2

Constitué du spec §11 (non-goals Phase 1) + de tout ce qui a émergé pendant la
construction et les tests de la Phase 1. Classé par thème, avec une suggestion
de priorité (🔥 fort impact client / 🔧 confort ops / 🧪 à valider avant d'investir).

## Paiements

- 🔥 **Orange Money** en plus de Wave (le site web le propose déjà — parité des
  canaux). Non-goal explicite du spec Phase 1.
- 🔥 **Remboursements automatisés** via l'API Wave quand un `REFUND_NEEDED` est
  créé (aujourd'hui : manuel dans le portail Wave, listé par `npm run summary`).
- 🔧 **Raison d'annulation** transmise dans les messages (distinguer "annulé à
  ta demande" de "annulé par le studio") — nécessite de saisir la raison côté
  Wix lors de l'annulation.

## Réservations

- ~~🔥 **Annulation par le bot**~~ → **FAIT (juillet 2026)** : outil
  `cancel_booking`, règle 16h vérifiée côté serveur (double contrôle
  consultation + exécution). Abonnement → séance re-créditée automatiquement
  (Benefit Programs revert) ; Wave → annulation + le client contacte la
  réception pour le remboursement (email automatique en parallèle). < 16h →
  refus poli sans suggérer d'excuses. Le **report en un geste** → **FAIT
  (10/07/2026)** : cancel + rebook orchestrés dans une seule conversation
  (nouveau créneau choisi avant d'annuler ; Wave = OK explicite du client sur
  remboursement + nouveau paiement). Reste Phase 2 : les annulations
  partielles de groupe (handoff).
- 🔥 ~~**Utiliser un abonnement existant pour réserver**~~ → **FAIT en Phase 1**
  (outils `check_membership` + `book_with_membership` : vérification d'identité
  par numéro WhatsApp, éligibilité et décompte du crédit délégués au checkout
  eCommerce Wix). Reste Phase 2 : **vendre** des abonnements/packs via le bot
  (paiement Wave d'un plan), et les réservations de groupe sur abonnement.
- 🔧 **Réservations de groupe multi-noms** : aujourd'hui N places sous un seul
  nom ; permettre de nommer chaque participant (utile pour l'émargement).
- 🔧 **Séance Privée / Pilates Privé automatisés** (aujourd'hui : renvoi vers
  la réception ; ce sont des services type "appointment" avec un flux de
  disponibilité différent des classes).
- 🧪 **Liste d'attente** quand un cours est complet (Wix a une waiting list) —
  à valider : la demande existe-t-elle vraiment ?

## Identité client / CRM

- ~~🔥 **Capture d'email post-réservation**~~ → **FAIT en Phase 1** : question
  posée une seule fois après un paiement réussi, uniquement si le matching par
  numéro WhatsApp a échoué ; email enregistré (outil `record_email`) + entrée
  dans le registre handoffs pour fusion MANUELLE par la réception. Jamais de
  rattachement automatique par email déclaré.
- ~~🔥 **`get_my_bookings` élargi**~~ → **FAIT (10/07/2026)** : liste aussi les
  résas prises au comptoir/site (lookup Wix `listContactUpcomingBookings` par
  contactId), marquées `booked_via: "studio"` en lecture seule (annulation =
  réception). ⚠️ Forme de la réponse extended-bookings à confirmer sur données
  réelles.
- 🔧 **Hygiène CRM préalable au lancement** : retirer les vrais numéros des
  contacts de test (test1/test2), fusionner les doublons créés pendant les
  tests, s'assurer que les fiches clients portent leur numéro WhatsApp.

## Notifications (nécessitent des templates Meta pré-approuvés)

> Hors fenêtre de 24h après un message entrant, WhatsApp impose des templates
> approuvés — c'était un non-goal Phase 1. Les items suivants en dépendent tous.

- 🔥 **Rappels de séance** (J-1 et/ou H-2) avec la politique d'annulation 16h.
- ~~🔥 **Notifications d'annulation**~~ → **ABANDONNÉ (juillet 2026)** : la
  réception coche "notifier le client" dans Wix au moment d'annuler — Wix est
  le canal officiel. Awa ne message plus le client sur annulation ; le sweep
  5 min ne fait plus qu'une synchro silencieuse de la base.
- ~~🔧 **Relance lien de paiement expiré**~~ → **FAIT (10/07/2026)**, sans
  template : la relance part ~1 min après l'expiration TTL, donc toujours dans
  la fenêtre 24h (le client venait d'écrire). One-shot (`expiry_nudged_at`),
  silencieuse si le client est passé à autre chose.

## Intégration Wix temps réel

- 🧊 **Vrais webhooks Wix** (app custom, payloads JWT — plan détaillé dans
  `WIX-WEBHOOK-PLAN.md`) : **mis en veille (juillet 2026)**. Leur intérêt
  principal était de notifier le client en temps réel sur annulation ; comme
  Wix notifie désormais lui-même, le polling 5 min (synchro silencieuse) +
  la re-vérification live de `get_my_bookings` suffisent.

## Café (commande groupée à la réservation — ✅ FAIT juillet 2026)

> v1 livrée : Awa propose une fois, légèrement, d'ajouter une commande café à
> la réservation ; la commande est fondue dans le même lien Wave ; menu éditable
> dans `cafe-menu.md` (prix résolus côté serveur, jamais par l'IA) ; confirmation
> client avec le détail + "prête après la séance" ; notification réception
> (email + WhatsApp). Restes pour plus tard :

- ~~🔧 **Café + abonnement**~~ → **FAIT (10/07/2026)** : après une résa par
  abonnement, Awa propose le menu et crée un petit lien Wave café-seul
  (`create_cafe_payment_link`, table `pending_cafe_orders`) rattaché au booking ;
  paiement → réception notifiée + confirmation client. Aucune création Wix.
- 🧪 **Commande café sans réservation** via Awa (aujourd'hui : comptoir).
- 🧪 **Menu en photos** : envoyer les pages du menu en images (sendImage +
  hébergement des visuels) au lieu du texte progressif seul.

## Expérience conversationnelle

- ~~🔧 **Transcription des notes vocales**~~ → **FAIT (juillet 2026)** :
  OpenAI `gpt-4o-mini-transcribe` (0,003 $/min ; clientèle surtout fr/en, le
  banc d'essai wolof est devenu inutile). Les messages audio sont téléchargés
  via l'API média Meta, transcrits, et injectés comme `[note vocale] …` ; en
  cas d'échec, Awa demande poliment d'écrire. Sans `OPENAI_API_KEY`, retour au
  comportement d'avant (texte uniquement).
- ~~🔧 **Résa en un tap**~~ → **FAIT (10/07/2026)** : détection d'habitude
  (`computeBookingHabit`, motif cours+jour+heure ≥2×) proposée en raccourci
  cliquable quand le client veut réserver sans préciser ; ne court-circuite
  jamais check_availability.
- 🧪 **A/B modèle** : tester `claude-haiku-4-5` sur la checklist d'acceptance
  (surtout wolof + respect des règles) pour réduire les coûts si concluant.
- 🧪 **Qualité du wolof** des messages templates (confirmation, remboursement,
  annulation) — faire relire par un locuteur natif.

## Ops / studio

- ~~🔥 **Dashboard admin Awa**~~ → **FAIT (10/07/2026)** : `/admin` sur le
  Fastify existant, Basic Auth 2 comptes (`ADMIN_USERS`, babakar + reception),
  4 pages (vue d'ensemble avec "à traiter" + stats, conversations avec
  recherche et appels d'outils repliés, réservations + abonnements avec
  filtres, handoffs) et 2 actions de pointage : « remboursement effectué »
  (remplace `refund:done`, conservé en secours CLI) et « abonnement activé ».
  Décision ferme : AUCUNE action monétaire automatique — Awa/le dashboard ne
  remboursent jamais, l'argent reste un geste humain dans le portail Wave.
  Restes éventuels : répondre aux clients depuis le dashboard (fenêtre 24h à
  gérer), stats par langue, export.
- 🔧 **Résumé quotidien automatique** (cron Railway → email ou WhatsApp
  réception) au lieu du script manuel `npm run summary` — pourrait être
  remplacé/complété par le dashboard ci-dessus.
- 🔧 **Tarifs manquants dans Wix** : plusieurs services sans prix fixe
  (Impédancemétrie, Bilan diététique…) sont invendables par le bot — soit leur
  donner un prix dans Wix, soit les marquer explicitement "sur devis via
  réception" dans business-info.
- 🔧 **Rotation des secrets** : le token WhatsApp a été exposé dans le fichier
  specs au début du projet (à roter si ce n'est pas déjà fait), scrubber le
  bloc env du fichier specs, et mettre en place une routine de rotation.

## Infra

- 🧪 **Migration du numéro de réception** vers le système (non-goal Phase 1 —
  le spec le mentionne comme éventualité lointaine).
- 🔧 **Domaine propre** (ex: `bookings.revive.sn`) à la place de
  `resabot-production.up.railway.app` — cosmétique mais plus pro dans les
  liens de paiement (success/error pages).
