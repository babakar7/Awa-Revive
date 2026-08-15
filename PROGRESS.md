# PROGRESS — Revive Bookings ("Awa")

## « J'ai payé » ne contredit plus la confirmation ✅ déjà envoyée (15 août 2026)

- **Incident (Khadija, 14/08)** : la confirmation automatique « ✅ Paiement
  reçu — ta place est confirmée » part à 21:33 ; la cliente écrit « C'est
  fait » à 21:34 ; Awa répond « je n'ai pas encore reçu la confirmation » —
  en contradiction directe avec le message précédent. La cliente s'inquiète,
  handoff, vérification manuelle par l'équipe alors que tout était payé.
- **Cause** : pas le replay (les confirmations serveur sont bien des tours
  `assistant` via `repo.addTurn` et incluses dans `lastTurnsForReplay`). C'est
  la règle 4 du flux paiement du prompt : « If they say they paid but you have
  no confirmation… » — le modèle pattern-matchait « client dit avoir payé »
  directement sur le script d'attente sans vérifier que le ✅ figurait déjà
  une ligne plus haut dans l'historique.
- **Fix (prompt seul)** : la règle 4 impose désormais de RELIRE l'historique
  d'abord — si le ✅ de ce paiement y figure, le paiement EST reçu, on
  rassure, interdiction de dire qu'on attend encore ; le script « la
  confirmation arrive dans une minute ou deux » ne s'applique que si AUCUN ✅
  n'apparaît. La règle capture d'écran ≠ preuve est inchangée. Test :
  `test/paidClaimConfirmationPrompt.test.ts`.
- **Piège** : le ✅ arrive souvent quelques secondes AVANT le message du
  client (webhook plus rapide que la saisie) — c'est précisément ce croisement
  qui déclenchait la contradiction.

## Paiements : vue clients par date de réservation (14 août 2026)

- `/admin/paiements` propose désormais deux vues : **Par date de paiement**
  (ledger comptable inchangé) et **Par date de réservation**. La seconde filtre
  sur `pending_bookings.slot_start`, pas sur `paid_at`, puis regroupe les
  réservations confirmées par client avec horaire, cours, places, mode de
  règlement et date d'encaissement à titre informatif.
- Raccourcis adaptés au planning : Aujourd'hui, Demain et 7 prochains jours ;
  les dates futures sont autorisées. Les annulations et clients de test sont
  exclus. Le périmètre est explicitement celui des réservations enregistrées
  par Awa (`pending_bookings`), car les réservations Wix externes ne sont pas
  reliées localement à un client et un créneau dans le ledger.
- La requête dédiée ne charge pas les agrégats comptables et s'appuie sur un
  index partiel des réservations `BOOKED` par `slot_start`.

## Liste d’attente Awa visible dans Wix Bookings (13 août 2026)

- **Incident observé** : Adjiaratou Aby Sissoko (`+221776372807`) avait bien
  été inscrite par Awa dans la liste d’attente locale puis notifiée quand une
  place s’est libérée, mais elle n’apparaissait pas dans l’onglet **Waitlist**
  de la séance Wix. Cause : le moteur Awa et la liste native Wix étaient deux
  systèmes indépendants ; `join_waitlist` n’écrivait que dans Postgres.
- **Décision** : double écriture. Postgres reste la source opérationnelle
  durable (l’API Waitlist Wix est encore en Developer Preview), et chaque
  inscription Awa est aussi enregistrée dans la waitlist native de la séance
  (`/bookings/v1/waitlist/register`) avec la fiche contact Wix, donc visible par
  la réception. Une panne ou une configuration Wix absente ne fait jamais
  perdre la demande locale.
- **Cycle de vie** : désinscription cliente, expiration et notification Awa
  retirent aussi l’inscription native ; les échecs de nettoyage sont conservés
  et retentés. Quand Wix met une inscription en `SUGGESTING`, la place est
  temporairement retenue et l’availability peut rester à zéro : le sweep lit
  donc ce statut, libère la retenue Wix, puis envoie le WhatsApp Awa habituel.
- **Historique actif** : au démarrage/sweep, les anciennes lignes locales encore
  `WAITING` et non synchronisées sont rétro-propagées vers Wix. Les échecs sont
  retentés au maximum toutes les 30 minutes pour ne pas marteler l’API Preview.
- **Validation** : `tsc --noEmit`, 1 235 tests unitaires (143 fichiers) et 399
  tests d’intégration (41 fichiers), tous verts. Cinq tests d’intégration dédiés
  couvrent miroir Wix, repli local, rattrapage, retrait et `SUGGESTING`.

## OM : limite 30 caractères sur le nom du QR + résa enfant au nom du parent (11 août 2026)

Vente perdue en direct (Mariata, 21:48) : carnet Natation 70 000 F, email
vérifié, compte créé, « Oui » pour Orange Money → `create_plan_payment_link`
en `tool_failed` + handoff technique. Cause trouvée par bissection contre
l'API réelle : **le champ `name` de la création QR Sonatel est limité à
30 CARACTÈRES** (non documenté ; 31+ → 500 enveloppant un 400 interne de
`api-qrcode-write-partner-service` ; la limite est bien en caractères, pas en
octets — 30 chars/32 octets passe). Notre code tronquait à 80. « Carnet de 10
Bébé nageur et Natation » = 37 chars → échec systématique ; tous les plans
vendus jusque-là faisaient ≤30, d'où l'invisibilité du bug.

Correctif (`lib/orangeMoney.ts`, commit `9295b4a`) : `omQrName()` tronque à
30 caractères (trim, jamais vide) — le nom n'est qu'un libellé d'affichage
dans l'app OM/Max It. Validé contre l'API réelle (70 000 F, nom tronqué →
qrId OK). Tests purs dans `test/orangeMoney.test.ts`.

Dans la même conversation, 2e bug : le compte Revive a été créé au nom de
l'enfant de 4 ans (« Boubacar Kane ») au lieu de la maman. Décision Babakar :
**pour un enfant, compte/vérification/paiement/résa portent TOUJOURS le nom
du parent payeur** — règle 0c ajoutée au prompt (si le parent répond avec le
prénom de l'enfant, Awa redemande le nom du parent). Fiche Wix + clients.name
corrigés à la main (« Mariata Kane »).

- `om_outage_mode` **désactivé le 11/08 à 22:35 (OK Babakar)** : les callbacks
  OM sont reçus/traités automatiquement chaque jour depuis le 04/08
  (`processed_webhooks`, clés `om:MP…`). Preuve de bout en bout (Awa Ba,
  Max It 12 000 F, 11/08) : lien 12:54:22 → callback 12:55:41 → résa Wix
  12:55:43 → confirmation cliente 12:55:46, entièrement automatique — la
  réconciliation manuelle cliquée à 12:55:53 arrivait après coup. La
  réconciliation manuelle /admin/paiements-om reste dispo pour les retardataires.
- Reste à faire : recontacter Mariata (handoff technique OPEN) — lui renvoyer
  un lien OM maintenant que le fix est déployé ; le créneau « mer 12/08
  17:15 » n'avait plus qu'1 place à 21:46.

## Voix cuisine : note générale lue + survie à l'idle iOS (11 août 2026)

- **Incidents prod (11/08)** : (1) l'annonce vocale ne lisait jamais la **note
  générale** du ticket (champ texte libre) — seulement le titre et les articles ;
  (2) après **quelques minutes sans commande**, l'iPad redevenait muet sur la
  commande suivante, alors qu'une annonce venait de marcher (« iced matcha »
  muet, re-test immédiat OK).
- **Fix 1** ([src/ops/opsCuisinePage.ts](src/ops/opsCuisinePage.ts),
  `newSpeech`) : la voix termine par « … Note, [texte] » quand `t.note` existe.
- **Fix 2 — piège iOS** : le heartbeat `resume()` (4 s) ne suffit PAS. Après
  quelques minutes de silence, iOS (a) **suspend l'AudioContext** → bip muet, et
  (b) **wedge le moteur TTS** → l'utterance est mise en file mais ne démarre
  jamais ; seul un `cancel()` le débloque. Trois défenses : `beep()` fait
  `actx.resume()` si suspendu ; `speak()` a un **watchdog** (si `onstart` n'a pas
  tiré après 1,5 s et qu'aucune de NOS utterances ne joue — flag `talking`, pas
  les getters speechSynthesis qui mentent — → `cancel()` + retry ×2) ; un **tick
  inaudible** (gain 0.0001, 30 ms) toutes les 20 s garde la session audio
  vivante toute la journée.
- **Piège d'édition** : le script de la page vit dans un template literal — un
  backtick dans un commentaire JS casse la compilation (TS1005 à des lignes
  éloignées).

## Navigation admin regroupée + sections repliables (11 août 2026)

- **Besoin** : la barre latérale gauche avait grossi (~29 items, 6 sections
  toujours dépliées), difficile à scanner. Objectif : retrouver vite une page.
- **Fait** ([src/admin/layout.ts](src/admin/layout.ts)) : les 2 pages du
  quotidien (**À faire**, **Conversations**) sont **épinglées** en haut, sans
  en-tête, toujours visibles. Les autres sont regroupées : **Clients** (Suivi,
  Relances, CRM, Classement), **Finance** (Rapport, Paiements, Paiements OM,
  Conversion, Paiements coachs — les pages « argent » enfin colocalisées),
  **Studio**, **Documents**, **Bar**, **Configuration**.
- **Repliables** : chaque en-tête de section est un bouton chevron. Studio /
  Documents / Bar / Configuration sont **repliées par défaut** ; Clients et
  Finance dépliées. État mémorisé par navigateur dans
  `localStorage['awa-admin-nav-sections']` (map `{sectionId: replié}`).
- **Sans piège** : la section qui contient la page active est **toujours
  dépliée** (`data-has-active`) sans écraser la préférence stockée. Un badge
  **agrégé** sur l'en-tête d'une section repliée évite que les compteurs
  disparaissent (ex. Livraisons). Rendu serveur toujours déplié + script
  pré-peinture (`NAV_STATE_JS`) qui applique l'état avant le premier paint →
  pas de flash ; **sans JS, tout reste visible**. Le mode icônes
  (`body.nav-collapsed`) ignore le repli et montre toutes les icônes.
- Fichiers : `layout.ts` (données NAV + `navHtml`), `adminClient.ts`
  (`NAV_STATE_JS` + délégation du toggle + fix piège-focus mobile),
  `adminStyles.ts` (styles groupe/chevron/badge), `test/adminUi.test.ts`.

## Planning des cours (bac à sable) : page admin `/admin/coaching` (11 août 2026)

- **Besoin** : composer visuellement des scénarios de planning coaching (nouveaux
  créneaux tôt/soir, nouvelles coachs Serena/Maty) sans toucher Wix. Board hebdo,
  une carte par cours (heure + coach + type), compteurs de charge par coach en
  live (garde-fou des minimums contractuels), drag & drop entre jours.
- **C'est un bac à sable : rien n'est jamais poussé vers Wix.** La saisie réelle
  reste manuelle dans Wix Bookings. Périmètre volontairement limité aux cours
  **Reformer et Mat** (filtre `isReformerOrMat`). Accessible à toute l'équipe
  admin (pas de garde owner), comme le planning staff.
- **Modèle** : cloné sur le planning staff (scénarios brouillon/publié, un seul
  publié via UPDATE CASE atomique ; grille sérialisée client-side, `savebar`,
  `beforeunload`). Fichiers : [src/domain/classPlanningRules.ts](src/domain/classPlanningRules.ts)
  (pur), [src/domain/classPlanningRepo.ts](src/domain/classPlanningRepo.ts),
  [src/admin/coachingPage.ts](src/admin/coachingPage.ts) (board vanilla),
  [src/admin/coachingRoutes.ts](src/admin/coachingRoutes.ts). Tables
  `class_plan_schedules` / `class_plan_slots` (coach/cours en **texte libre** —
  les coachs ne sont pas tous dans Wix ; ids Wix optionnels, renseignés à l'import).
- **Décisions clés** (revue) : (1) `replaceSlots` en **transaction** (page ouverte
  à toute l'équipe → un save échoué/concurrent ne doit pas laisser la grille vide) ;
  (2) l'**import Wix passe par la MÊME validation** (`validateClassGridPayload`)
  que la saisie manuelle — jamais de contournement ; import = Reformer/Mat
  **CONFIRMED** uniquement, éligible si `serviceId` ∈ services Reformer OU le nom
  matche ; coach = ressource dont l'`id` est un staff Wix connu (le `type` des
  ressources Calendar V3 est un UUID, pas « staff »), repli `resources[0]` ;
  (3) semaine importée = **lundi suivant → lundi d'après exclu** ; (4) état injecté
  en **littéral JS** (échappement `<`, U+2028/U+2029) au lieu du double-encodage
  fragile du staff, car coach/cours sont du texte libre ; (5) suggestions Wix
  **dégradées par source** (profils DB alimentent toujours les coachs même si Wix
  est down). Tests : `test/classPlanningRules.test.ts` + `test/integration/classPlanning.test.ts`.

## Garde horaire de créneau : plus jamais un lien de paiement sur le mauvais horaire (11 août 2026)

- **Incident (11/08, +221778299595)** : la cliente accepte « Sculpt samedi 11h15 » ;
  le modèle appelle `create_payment_link` avec le `choice_id` du créneau **10h15**
  (premier de la liste d'availability) tout en écrivant « 11h15 » à côté du lien.
  `slot_cache` ne peut PAS attraper ça : 10h15 avait bien été proposé, ce n'était
  juste pas le créneau accepté. La cliente a payé 12 000 F pour le mauvais horaire,
  puis Awa a soutenu qu'elle se trompait (« c'était le seul créneau disponible » —
  faux). Babakar a dû replacer la résa à la main.
- **Garde serveur (lint sécurité, bloquant)** : nouveau `SlotTimeGuard` dans
  [src/agent/outboundLint.ts](src/agent/outboundLint.ts). Dès qu'un outil qui
  verrouille un créneau réussit dans le tour (`create_payment_link`,
  `book_with_membership`, `add_spots_to_booking`, `book_key_*`,
  `reschedule_booking`), toute heure (`11h15`, `11:15`, `1:15 pm`…) ou date
  (`15 août`, `August 15`) écrite dans la réponse sortante doit correspondre aux
  champs `*_dakar` calculés par le serveur — sinon blocage `slot_time_mismatch`
  + retry correctif qui énonce le VRAI créneau (le client voit donc l'horaire
  réel AVANT de payer). `get_my_bookings`/`cancel_booking`/`join_waitlist`
  cautionnent leurs horaires sans activer la garde ; `check_availability` ne
  cautionne RIEN (c'est précisément « aussi disponible » qui a créé le bug).
  Exclusions anti-faux-positifs : durées/montants (« 20 minutes », « 12 000 F »),
  fenêtre d'annulation (« 16h avant »).
- **Écho déterministe** : si la réponse d'un tour verrouillant UN seul créneau ne
  mentionne aucune heure, le serveur ajoute `📅 <slot_start_dakar>` — l'horaire
  réellement réservé est toujours visible avant que l'argent parte.
- **Prompt** : description d'`event_id` (vérifier que le choice_id correspond à
  l'horaire ACCEPTÉ, jamais deviner), note du résultat `create_payment_link`
  (relayer `slot_start_dakar` verbatim ; si ce n'est pas le créneau accepté, ne
  PAS envoyer le lien), et règle système : un client qui conteste l'horaire d'une
  résa confirmée → `get_my_bookings` + excuse + `reschedule_booking`/handoff,
  jamais « tu te trompes », jamais de justification inventée.
- Tests : `test/outboundLint.test.ts` (35 tests, dont le replay exact de
  l'incident). Piège connu : la garde ne couvre pas une heure affirmée de mémoire
  dans un tour SANS outil verrouillant (c'est la règle prompt qui couvre ça).

## Ledger des paiements par méthode (10 août 2026)

- Nouvelle page équipe `/admin/paiements` : mouvements signés, totaux SQL brut/remboursements/net, détail filtrable, qualification des paiements Wix hors ligne et export CSV sécurisé.
- Les remboursements booking passent par une transition atomique partagée entre la route admin et le script. Les mouvements manuels sont owner-only, append-only et idempotents.
- Le sync Wix importe les transactions par identifiant, déduplique les ordres Awa et n’avance son watermark qu’après un scan complet réussi.
- Décision comptable : les anciennes commandes Wix en `XAF` sont incluses à parité nominale 1:1 comme XOF, tout en conservant leur devise brute pour audit. Toute autre devise reste exclue.

> Journal d'avancement destiné à un agent (ou humain) qui reprend le projet.
> Dernière mise à jour : **4 août 2026** — le garde de couverture ne peut PLUS
> jeter une réponse livrable (réparation + ajout déterministe, seul le lint
> sécurité bloque). Avant : retard client = simple accusé de
> réception ; langue ancrée sur les messages du CLIENT (pas le prefill web).
> Avant : alerte owner à chaque tentative de
> paiement OM/Max It. Avant : garde serveur premier contact et
> questions multiples. Avant : abonnements généralisés :
> L'Abonnement Aquabike + plan sur mesure automatisés (familles de clés,
> coexistence, admin « Abonnements »). Avant : relance A des leads pub silencieux
> (holdout ITT, OFF par défaut) + budget pub doublé. Avant : coupe-circuit
> déterministe des conversations sans intention, relais technique fiable,
> renouvellement des paiements de plan expirés et première séance des Clés.
> Avant : politique d’annulation non remboursable, report et transfert de séance ; fiabilisation Awa
> après l'incident Riche Aubambi : service canonique, coupe-circuit,
> attribution humain/Awa et alertes cuisine iPad-only ; contact de remise des
> livraisons et alertes dédiées (§6.29), livraisons programmées
> avec activation durable (§6.27), fiabilisation des alertes
> livraison + mode commande de test (§6.26), refonte premium et UX de
> tout l’admin (§4.41), notifications staff, livraisons bar, handoffs `wa.me`.
> Compléments : `README.md`, `PHASE2.md`, `ORANGE-MONEY-PLAN.md` (plan OM),
> `OM-LINKS-HOW-TO.md` (créer un lien de test), `WIX-WEBHOOK-PLAN.md` (EN VEILLE),
> `business-info.md`, `cafe-menu.md` (menu du bar),
> `PLAN-PACK-DECOUVERTE-ACTIVATION.md`.

## Silence répété après une liste interactive : repli déterministe (10 août 2026)

- Incident Camou, 22:13 : après une liste de créneaux Reformer correctement
  livrée, « Ok mercie » a produit `<NO_REPLY>` lors de la génération normale
  puis encore lors de la relance sans outils. L'ancien garde a donc créé à tort
  un relais technique, envoyé le message de panne et suspendu Awa 12 h. Aucun
  paiement ni réservation n'était engagé.
- Une deuxième réponse vide/sentinelle réussie côté API n'est désormais plus
  assimilée à une panne : `resolveSilenceRecovery` envoie une courte réponse
  déterministe localisée FR/EN/WO. Aucune tâche, alerte ou pause technique n'est
  créée. Une exception réelle de la relance conserve le relais technique.
- La régression teste le chemin de résolution réellement appelé par la boucle,
  le retrait de la sentinelle et la conservation d'une vraie réponse de relance.

## <16h : l'exception ne se propose JAMAIS, et c'est le client qui appelle (10 août 2026)

Incident Arame Seye (malade, cours à 12h30) : Awa a refusé le report (règle
16h, correct) mais a spontanément proposé « un report exceptionnel » et offert
de « transmettre la demande au gérant qui traite par téléphone ». Double faute
signalée par Babakar : (1) l'exception ne doit JAMAIS être évoquée par Awa —
uniquement si le client la demande explicitement ; (2) il n'existe pas de
« transmission au gérant » — le client appelle lui-même le gérant. Cause : le
flux `exceptional_cancellation` (→ appel du gérant) ne couvrait que
l'ANNULATION <16h ; le refus de REPORT <16h renvoyait encore l'ancien message
« call handoff_to_human » sans cadre, et rien n'interdisait l'offre spontanée.
Correctif (business-info.md, systemPrompt.ts, tools.ts) :
- Interdiction explicite partout de mentionner report/annulation exceptionnel
  ou l'escalade gérant sans demande explicite du client — même en cas de
  maladie : règle + option transfert, rien de plus.
- `exceptional_cancellation:true` couvre désormais aussi le REPORT <16h ; les
  messages de refus 16h (reschedule + cancel) pointent vers ce flux.
- Formulation « je transmets la demande » bannie : Awa donne le numéro du
  gérant et dit au client de l'appeler (le gérant est prévenu par l'alerte).
- Tests cancellationPolicy mis à jour : le report <16h exceptionnel route vers
  le gérant (ancienne assertion inverse supprimée), offre spontanée verrouillée.

## Voix cuisine muette après rechargement : amorçage au premier tap (10 août 2026)

Suite du durcissement voix du 05/08 — il restait UN trou : iOS n'autorise le
`speechSynthesis.speak()` programmatique qu'après UN `speak()` déclenché dans
un vrai geste utilisateur, **une fois par chargement de page** (`resume()` ne
compte pas). Un board fraîchement rechargé restait donc muet jusqu'à ce que
quelqu'un bascule 🔇→🔊 (dont le « Son activé » amorçait le moteur) — exactement
ce qui a frappé l'iPad cuisine après le rechargement forcé du matin (watchdog
SSE). Correctif (cuisine **v18**, service **v22**) : le premier tap n'importe où
prononce une phrase vide — inaudible, mais elle active le moteur pour les
annonces SSE. Diagnostic terrain : « la voix ne dit plus les commandes » juste
après un rechargement = ce trou ; désormais un seul tap sur l'écran suffit.

## Supervision (owner) : contrôle TOTAL des tickets (10 août 2026)

Demande Babakar : le board /ops/owner doit pouvoir faire tout ce que /cuisine
et /ops/service font. Fini le watch-only : chaque carte porte désormais les
verbes cuisine (Commencer / Prête — avec la même grâce d'annulation locale 3 s
et le même push accueil quand une commande salle passe prête / Terminée pour le
BAR) et les verbes salle (Servie qui libère la table vidée, bascule ⚡ urgent,
Annuler derrière une confirmation à verbes). Endpoints propres au rôle owner
(`/ops/owner/tickets/:id/…`) qui appellent les MÊMES fonctions repo aux gardes
atomiques — un tap périmé depuis n'importe quel board se résout à un seul
gagnant. `autoCloseIfEmpty` hissé au niveau module (partagé accueil/owner). Le
test « watch-only » d'opsOwnerAssets affirme maintenant le contrôle total.

## Boards ops gelés en silence : watchdog SSE + auto-clôture 2 h (10 août 2026)

Incident prod 10/08 : l'iPad cuisine affichait un instantané VIEUX DE DEUX
JOURS — les commandes du matin (cappuccino, poke, iced latte de la Terrasse)
invisibles, et un matcha déjà servi le 08/08 impossible à faire partir. Cause :
un socket à moitié mort (blip réseau / onglet suspendu) tue le flux SSE **sans
déclencher `onerror`** → EventSource ne se reconnecte jamais, aucun bandeau
« hors ligne », le board a l'air sain. La DB, elle, était juste.

- **Ping serveur visible** : le keepalive SSE devient un vrai évènement `ping`
  (un commentaire `: ping` est invisible pour l'API EventSource). Sans `id`,
  donc le curseur de replay n'avance pas ([src/ops/opsRoutes.ts](src/ops/opsRoutes.ts)).
- **Watchdog dans les 3 PWA** (cuisine / service / owner) : 60 s sans ping ni
  évènement → on détruit et reconstruit le flux (`?since=cursor` rejoue tout le
  manqué) ; au réveil de l'onglet, vérification immédiate. Piège d'implémentation :
  les commentaires du JS client vivent dans des template literals — un backtick
  dans un commentaire (« \`ping\` ») TERMINE la chaîne (tsc l'attrape, mais loin).
- **Auto-clôture** : sweep 60 s — un ticket TABLE/BAR encore ouvert après
  `OPS_TICKET_AUTOCLOSE_MINUTES` (défaut 120) est marqué prêt + terminé
  (`serve_by='auto'`) et sa session vidée est libérée. En réalité il a été servi
  ou oublié (une session Canapé du 08/08 est restée 2 jours au board parce que
  personne n'a tapé « Servie »). Les tickets DELIVERY sont exclus : leur cycle de
  vie appartient à la commande de livraison, un retard est un incident à montrer.
- Aussi : fenêtre d'annulation « Prête » raccourcie 5 s → 3 s (demande cuisine).

Diagnostic pour la prochaine fois : si « le board ne montre pas X », comparer
avec `kitchen_tickets` en DB (voir mémoire prod-db-access) — si la DB est bonne,
c'est un client gelé ; recharger la PWA suffit, et depuis ce patch elle se
répare seule en ≤ 60 s.

## Coupe-circuit no-intent : plus jamais en pleine vente (8 août 2026)

Incident prod 08/08 17:06 (Maryeme, +221770491668) : en pleine vente
sur-mesure, « Merci » (la veille 20:50) + « Oui ça me va » + « D'accord
merci » = 3 tours « sans intention » en 24 h → le coupe-circuit déterministe
a envoyé la ligne de clôture canned (à 800 ms, sans modèle) et mis Awa en
pause 24 h — alors que la cliente venait d'ACCEPTER l'offre. (Le
`awa_disengaged_*` était déjà nul au diagnostic : le « Rendre à Awa » du
owner à 17:10 l'avait levé avant de reprendre la main — le premier
diagnostic « simple takeover » était incomplet.) Même famille que Codette
(06/08), via le coupe-circuit au lieu du tool disengage.

Deux correctifs :
- **Garde serveur dans `recordNoIntentTurn`** (couvre texte ET note vocale
  échouée) : `hasRecentBookingActivity(60 min)` ⇒ le tour n'alimente JAMAIS
  le compteur — un fragment poli au milieu d'une vente n'est pas du bruit.
  Même principe que le refus de `disengage_conversation` (Codette).
- **Classifier** (`noIntentGuard.ts`) : les affirmations nues ancrées en début
  de message (« oui », « ok », « d'accord », « ça me va », « parfait »,
  « waaw », « yes »…) = `revive_intent` (elles répondent forcément à une
  proposition d'Awa) ; « ok/okay/d accord » retirés des pleasantries. « Merci »
  seul, salutations et au-revoir restent no_intent.

Tests : `noIntentGuard.test.ts` (affirmations vs pleasantries),
`adminOperations.test.ts` (le compteur reste à 0 malgré 4 tours no-intent
quand une vente est active). Maryeme : rien à réparer en base (takeover
volontaire du owner en cours jusqu'au 09/08 05:10).

## Offre bar post-réservation retirée (8 août 2026)

La liste interactive « Envie d'accompagner ta séance ? 🥤 » envoyée d'office
après chaque confirmation (webhook Wave + book_with_membership) n'apportait
rien (décision Babakar 08/08). Retirée entièrement : `lib/cafeOffer.ts`
supprimé, appels retirés de `fulfillment.ts` et `agent/index.ts` (avec le
tracking `cafeMenuShown`), `repo.claimCafeOffer` supprimé (la colonne
`clients.cafe_offer_at` reste en base, inoffensive). Le menu du bar reste
accessible à la demande : bouton « Voir le menu » (cap_menu), texte libre,
et /commander. `wave-webhook.test.ts` ajusté (plus AUCUNE liste interactive
serveur après la confirmation).

## Compte créé SANS vérification après abandon du code (8 août 2026)

Cas Marouche (+221778838837, 08/08) : L'Invitée choisie, créneau choisi
(mer 12/08 17:15), email donné, code envoyé… plus rien. L'ancien circuit
(30 min → NEEDS_RECEPTION + handoff) suspendait la vente à une intervention
humaine. Demande de Babakar : au bout d'un moment, créer le compte SANS
vérification et prévenir la cliente qu'elle peut réserver sa séance.

Correctif (`domain/unverifiedAccounts.ts`, sweep 60 s AVANT
`escalateStaleLinkRequests`) : toute demande de CRÉATION (`wix_contact_id`
null + email + nom) silencieuse depuis `UNVERIFIED_CREATE_AFTER_MINUTES`
(5 min — 30 min au ship initial, réduit le jour même sur demande de
Babakar ; l'escalade réception des LIAISONS reste à 30 min) →
`wix.createContact` direct, demande `LINKED` par `auto-sans-verification`
(preuve durable : le prochain `create_plan_payment_link` passe sans
re-vérification ; handoff éventuel auto-fermé), message WhatsApp proactif
FR/EN registre-aware (« compte créé, rien à finir, réponds ici pour finaliser
ta réservation »). Même modèle de confiance que `client_declined_verification`
(la fiche est neuve, elle ne possède rien).

- **La liaison d'un compte EXISTANT n'est JAMAIS auto-liée** (anti-usurpation :
  sans preuve de la boîte mail, on offrirait l'abonnement d'autrui) — elle
  reste escaladée à la réception comme avant.
- Échec Wix → **la demande est écartée en silence** (`DISMISSED`), AUCUNE
  intervention réception (cf. addendum 11/08 ci-dessous).
- Tests : `test/integration/unverifiedAccounts.test.ts` (6 cas : nominal,
  fermeture handoff, anti-usurpation, fraîcheur, échec Wix silencieux, idempotence).

### Addendum 11/08 — échec de création : plus d'intervention humaine

Cas Pape Alassane (+221763941300, 11/08) : nouveau prospect, email donné, code
jamais recopié, a choisi de payer par Wave (`client_declined_verification`) puis
n'a pas payé. Le sweep a tenté `createContact` → **échec Wix** → l'ancien
fail-safe créait un handoff « Compte non relié » que la réception devait traiter
pour un prospect qui n'a jamais payé (pur bruit). Décision Babakar : **ne plus
créer d'intervention humaine pour ce type de cas**. Désormais l'échec fait
`links.dismiss` (→ `DISMISSED`, hors périmètre du sweep création ET de
l'escalade 30 min ; tout handoff « Compte non relié » ouvert est auto-fermé),
sans notif ni entrée /admin/crm. S'il revient et paie, le flux d'activation payé
recrée/rattrape la fiche. La voie LIAISON d'un compte existant reste escaladée
(anti-usurpation inchangé). Commit `0c53002`.

## Handoffs « Compte non relié » : auto-fermeture à la résolution (7 août 2026)

Deux pastilles « intervention humaine » fantômes le 07/08 : **Aida Fall**
(+221766395117) — sweep 30 min → handoff 15:52, la cliente revient à 16:46,
compte créé + Clé payée + séance réservée, pastille intacte ; **Charles Gomis**
(+221773565079) — demande écartée d'un clic « Ignorer » dans /admin/crm
(owner, 15:41), pastille intacte aussi. Cause : un handoff n'avait QU'UN seul
chemin de fermeture, le bouton « traité » de la page Handoffs — rien ne le
reliait au sort de la demande de liaison qui l'avait ouvert (contraste :
les `conversation_reviews`, elles, s'auto-fermaient déjà).

Correctif (`domain/linkRequests.ts`) : `autoCloseAccountLinkHandoffs(requestId,
doneBy)` ferme les handoffs OPEN préfixés « Compte non relié » du client, appelé
aux trois sorties de la demande : `markVerified` (code accepté, done_by `auto`),
`markLinked` (liaison admin, done_by = l'admin) et `dismiss` (« Ignorer » CRM,
done_by = l'admin). Jamais de retouche d'un handoff déjà traité à la main ; ne
lève jamais (le ménage ne casse pas l'opération). Tests :
`test/integration/linkHandoffAutoclose.test.ts` (4 cas, dont le garde-fou).
Pas de backfill nécessaire : les deux pastilles ont été fermées à la main
(« traité », owner) juste avant le déploiement, et la requête de contrôle ne
trouve plus aucun handoff de liaison orphelin en prod.

## Lead pub Clé Invitée : « ce sujet » enfin expliqué à Awa (9 août 2026)

L'opener pré-rempli de la pub Meta Clé Invitée (« Bonjour ! Puis-je en savoir
plus à ce sujet ? ») arrivait SANS contexte : les notes campagne historiques
(PACK DÉCOUVERTE META CAMPAIGN / META NEW LEAD) sont mortes depuis le retrait
du Pack (flags en dur à false, 01/08), et rien ne les a remplacées pour l'ère
des Clés — Awa ne voit pas la créa de la pub et l'opener ne nomme rien, donc
elle répondait « à propos de quoi exactement ? » à un lead chaud.

Correctif : flag `cleInviteeAdLead` (`KEYS_AUTOMATION_ENABLED` + matcher
campagne existant — opener canonique OU source_id allow-listé) → note dynamique
« CLÉ INVITÉE META AD » : « ce sujet » = L'Invitée, ne pas demander de
précision, dérouler comme si la cliente avait NOMMÉ L'Invitée (règles EXPLICIT
KEY REQUEST : salutation obligatoire, pitch complet depuis list_plans,
éligibilité normale). Tests dans `discoveryAdFlowPrompt.test.ts`.
Au passage : le matcher forçait déjà `revive_intent` sur l'opener (jamais
compté no-intent) et `recordCampaignLead` continue d'attribuer le lead.

## Massage réservable par Awa : c'était un trou de PROMPT, pas de code (9 août 2026)

Awa a répondu à Memona (La Résidente) qu'elle ne pouvait pas réserver le
massage au tarif membre et qu'il fallait « l'arranger au studio ». FAUX : le
tarif membre massage EST déjà implémenté et vif en prod — `domain/massageMemberRate.ts`
(`resolveMassageUnitPrice`, pur + testé) branché dans `create_payment_link`
(tools.ts ~2120) ; le massage est un Class Wix (capacité 1, 35 000 F,
`pricingPlanIds` vide donc jamais « couvert gratuitement »), et
`create_payment_link` applique 25 000 F pour les détentrices d'une Clé listée
dans `MASSAGE_MEMBER_PLAN_IDS` (L'Habituée `e94da7f8`, La Résidente `1594e182`,
sur-mesure `c5e1955f`/`d0fe7f79`). Memona détient La Résidente → 25 000 F auto.

Le seul manque était la GUIDANCE : rien ne disait à Awa que le massage est un
cours réservable de bout en bout ; elle a donc supposé « perk à arranger au
studio ». Correctif texte uniquement (aucun changement de code de paiement) :
- `business-info.md` : note « Réserver un massage » — réservable ici comme un
  cours, tarif serveur (25 000 membre / 35 000 plein), ne jamais renvoyer au
  studio, ne pas annoncer un prix de mémoire (le lien porte le bon montant).
- `systemPrompt.ts` : règle MASSAGE (réserver directement via
  check_availability → create_payment_link ; jamais « seulement au studio » ;
  montant décidé par le serveur).

Piège pour la prochaine session : le HUB `…/resabot` a un `config.ts` sale
(modifs locales non commitées) SANS les vars MASSAGE — grep sur le hub a
faussement conclu « code absent ». origin/main (donc les worktrees) a bien tout.
Toujours vérifier dans un worktree frais, pas le hub. cf. [[prod-db-access]].

## Rebonds email des codes de vérification : webhook Brevo + repli sans-vérif (7 août 2026)

Vente perdue 05–07/08 (+221786603672, kaeva18@gmail.com) : sa boîte Gmail est
**pleine** (« 452 4.2.2 out of storage space »). Brevo accepte l'envoi (201) et
n'apprend le rebond que quelques secondes après → Awa renvoyait code sur code
vers une boîte morte, la cliente répétait « je n'ai pas reçu », personne ne
voyait pourquoi. Premier code (05/08) pourtant livré mais **ouvert à +43 min**,
TTL 10 min déjà expiré ; deuxième (07/08) rebondi. (Le tout après un premier
contact 04/08 tué par l'abort technique corrigé dans `cf53848`.)

Correctif — le serveur apprend la non-livraison et guide vers une issue :
- **`POST /webhooks/brevo?token=BREVO_WEBHOOK_TOKEN`** (`webhooks/brevo.ts`) :
  événements de non-livraison uniquement (soft/hard bounce, blocked,
  invalid_email, error), token en comparaison à temps constant (vide =
  endpoint 404), idempotence `processed_webhooks`, table `email_bounces`.
- **Message proactif** (`domain/emailBounce.ts`) : rebond sur l'email d'une
  demande `AWAITING_CODE` → UN WhatsApp au client (claim atomique
  `link_requests.bounce_notified_at`), adapté au motif (boîte pleine / adresse
  invalide / autre), FR/EN + registre vous. Toujours les trois issues dans
  l'ordre : autre email → réessayer une fois réparé → **continuer sans
  vérification** (le repli `client_declined_verification` /
  `client_has_no_email` existait déjà côté outils).
- **`request_email_verification` consulte `latestBounce()`** (7 jours) avant
  tout envoi : adresse en rebond connu → statut `email_bounced` (aucun code
  envoyé) qui briefe le modèle sur les trois issues ; `retry_bounced_email:true`
  force le renvoi une fois le problème réglé. Jamais de renvoi muet en boucle.
- Config : `BREVO_WEBHOOK_TOKEN` (Railway) ; webhook créé côté Brevo (API
  `/v3/webhooks`, type transactional) pointant sur awa.revive.sn.
- Tests : `emailBounce.test.ts` (parsing des deux graphies Brevo, classement
  des motifs — dont le payload Gmail réel —, message client).
- Piège à retenir : un « opened » Brevo peut être le proxy images de Gmail,
  pas une lecture humaine ; et un soft bounce peut finir livré après retry —
  le message client dit « pas pu être livré *pour le moment* ».

## Liste interactive expirée → `<NO_REPLY>` : garde étendue au-delà du TTL (7 août 2026)

Incident prod 07/08 06:35 (Kadidiatou Diallo, +221778417056) : elle répond
« Dimanche » **22 h après** la liste de créneaux Foundation du 06/08. Les lignes
`presented_choices` avaient expiré (TTL 2 h) → la garde « PENDING INTERACTIVE
LIST » de `218f14e` (Mareme) ne s'est pas armée, le modèle a reconduit la
discipline `<NO_REPLY>` et s'est tu deux fois → fallback technique + takeover
12 h. **Même piège que Mareme, via le trou du TTL.**

Correctif :
- Nouveau flag `expiredInteractiveList` : quand aucune liste n'est ouverte mais
  que le DERNIER tour assistant est un envoi interactif (marqueur
  `[message interactif`, détecté par `isInteractiveListTurn` /
  `repo.lastAssistantTurnContent`), `dynamicContext()` injecte un bloc
  « EXPIRED INTERACTIVE LIST » : sentinelle interdit + ids périmés → re-passer
  par les outils (`check_availability`…) pour re-présenter des options fraîches.
- Au passage, deux bugs du registre vous (`applyFrenchRegister`) : « Tu n'as
  rien à faire » devenait « Vous n'as rien à faire » (règle `tu n'as` absente —
  visible dans les fallbacks reçus par Kadidiatou et Mareme), et les règles
  `ton/ta/tes` en `\b` ASCII mutilaient les mots à lettre accentuée adjacente
  (« êtes » → « êvos ») → lookarounds Unicode.
- Tests : `pendingInteractiveListPrompt.test.ts` (bloc expired),
  `choiceMatcher.test.ts` (`isInteractiveListTurn`), `frenchRegister.test.ts`
  (négations conjuguées).

## Review : trace `outbound_filter` périmée re-flaguait des conversations saines (6 août 2026)

Faux positif « À reprendre » 06/08 16:30 (Bitty, +221776375930) : sa réservation
Reformer du 11/08 était **confirmée et le message envoyé**, pourtant la review a
produit « bloquée par le filtre de sortie ». Cause : `reviewTurns` relit les
**30 derniers tours**, et `normalizeVerdictForTranscript` forçait
`technical_failure` dès qu'une trace `outbound_filter` apparaissait **n'importe
où** dans la fenêtre — ici celle du 04/08, incident déjà reviewé (2 items) et
depuis corrigé (coverage guard ne bloque plus). Tout client ayant un jour subi
un blocage aurait été re-signalé à chaque conversation tant que la trace restait
dans la fenêtre.

Correctif : l'override ne se déclenche que si la trace filtre est **postérieure
au dernier message client** (le blocage appartient au dernier échange). Tests :
`test/conversationReview.test.ts` (trace périmée ignorée / blocage frais toujours
forcé).

## `<NO_REPLY>` périmé après une liste interactive — garde tour courant (6 août 2026)

Incident prod 06/08 14:25 (Mareme Diatta, +221787979416) : prospecte L'Invitée
chaude (éligible, date choisie, liste de créneaux Foundation reçue) répond en
texte libre « Oui niveau debutant je n'ai jamais fait de Pilate » **sans choisir
de créneau**. Le modèle a reconduit la discipline `<NO_REPLY>` de
`present_options` sur CE tour et s'est tu **deux fois** — y compris à travers la
relance de récupération sans outils — → fallback technique + handoff
`agent_empty_reply`, lead gelé (takeover 12 h, personne n'a répondu pendant
1 h 30).

Correctif (`218f14e`) :
- **Garde serveur** : quand la dernière liste `presented_choices` est encore
  ouverte et que le texte entrant ne résout AUCUNE de ses options
  (`resolveFreeTextChoice` → null), `dynamicContext()` injecte un bloc
  « PENDING INTERACTIVE LIST » qui interdit explicitement le sentinelle sur le
  tour courant et impose une réponse normale (+ ré-invitation à choisir).
- **Prompt statique** : la règle `present_options` précise désormais que
  `<NO_REPLY>` ne vaut QUE pour le tour où le tool a rendu `sent:true`.
- Test : `test/pendingInteractiveListPrompt.test.ts`.

Leçon : la relance de récupération (« Do not output <NO_REPLY> ») ne suffit pas
face à un historique qui répète la discipline du sentinelle — il faut pré-armer
le contexte AVANT le premier appel, pas rattraper après. Réponse manuelle à
Mareme envoyée depuis /admin + « Rendre à Awa » (le takeover technique de 12 h
aurait sinon muselé Awa jusqu'à 02 h 25).

## Massage (Ruffine) — tarif abonné 25 000 / plein tarif 35 000 (6 août 2026)

Nouveau service **Massage** (Relaxant ou Tonique), 45 min, animé par **Ruffine**,
le **samedi 11 h → 13 h** (2 créneaux de 45 min : 11 h 00 et 11 h 45). Prix plein
**35 000 FCFA** ; les abonnés d'un plan qualifiant paient **25 000 FCFA**.

**Wix ne sait pas faire un « tarif membre » par service** (un plan couvre un
service ou pas — pas de prix réduit). Le rabais est donc géré par canal :

- **Awa (WhatsApp)** — règle SERVEUR (jamais le modèle) dans `create_payment_link`
  ([src/domain/massageMemberRate.ts](src/domain/massageMemberRate.ts)). Si le
  client détient un plan qualifiant (identité VÉRIFIÉE via son numéro), le lien
  Wave/OM est émis à 25 000, sinon 35 000. Le massage n'est **connecté à aucun
  plan dans Wix** → c'est toujours un lien payant, jamais un décompte de séance.
  Piloté par config, **inerte tant que non configuré** :
  - `MASSAGE_SERVICE_IDS` = id du service Massage (Class capacité 1).
  - `MASSAGE_MEMBER_PLAN_IDS` = L'Habituée, La Résidente, + plans sur-mesure ≥ 3×/sem
    (aujourd'hui « 1x Reformer 1x Mat 1x Step » et « 2x Reformer 1x Yoga 1x Step »).
    **Exclus** : L'Invitée (3 séances) et les carnets Aquabike / Bébé nageur.
  - `MASSAGE_MEMBER_RATE_XOF` = 25000 (garde-fou : si ≥ prix catalogue, on retombe
    sur le catalogue — jamais de surfacturation).
  - **À ajouter à la checklist sur-mesure** : tout nouveau plan sur-mesure ≥ 3×/sem
    doit être ajouté à `MASSAGE_MEMBER_PLAN_IDS`.

- **Réception (appel téléphonique)** — RÈGLE MANUELLE. Quand la réception réserve
  un massage pour un client qui appelle, elle **applique 25 000 à la main** si le
  client détient L'Habituée, La Résidente ou un plan sur-mesure ≥ 3×/sem (visible
  sur sa fiche Wix). Sinon 35 000. Aucun code ne le fait à sa place.

- **Site web** — Wix facturerait 35 000 à tout le monde (pas de rabais membre
  possible). Décision : **ne pas mettre le massage sur les pages de réservation du
  site** — tout passe par Awa (25 000 auto) et la réception (25 000 manuel).
  ⚠️ Ne PAS utiliser le toggle « masqué » de Wix : `listServices` filtre les
  services `hidden`, donc Awa ne le verrait plus non plus. Le laisser visible pour
  l'API, juste absent du menu de réservation du site.

Setup Wix restant (côté studio) : convertir le service en **Class capacité 1**,
ne garder que **Ruffine** (retirer les 9 autres staff), la restreindre au
**samedi 11 h–13 h** (retirer ses heures du jeudi), **max 1 place / réservation**.
Une fois la Class créée, renseigner `MASSAGE_SERVICE_IDS` avec son nouvel id.

## /ops/service — « Je prends » en une étape + fin du blocage « Chargement… » (6 août 2026)

Deux retours Babakar sur le board salle (v20) :

- **Prise en une étape** : le double « Je prends » (claim) puis « Servie »
  (complete) sur une commande PRÊTE devenait UN seul bouton **« 🙋 Je prends »**
  qui complète directement (l'endpoint `/served` termine n'importe quel ticket
  READY, sans claim préalable). Fini l'état intermédiaire « Pris par X » (le
  bouton `/take` backend reste mais n'est plus utilisé par l'UI). Plus simple.
- **Plus de « Chargement… » figé** (bug « ça remarche si je ferme/rouvre l'app ») :
  le boot inline est bloqué par notre CSP stricte (`script-src 'self'`), donc le
  vrai premier rendu vient de `GET /state`. Désormais `render()`+`refreshState()`
  s'exécutent **en tout premier**, avant l'init audio/push/composeur — un throw
  dans ces parties optionnelles ne peut plus laisser le board vide. Ajout d'un
  garde `loaded` + `retryLoad()` : un échec réseau du premier `/state` réessaie
  ~5×/2s puis bascule sur « Aucun espace — ↻ Recharger » au lieu de rester coincé
  sur « Chargement… ». La création de l'`EventSource` est aussi sous try/catch.

Tests : 1106 unit + 40 integration (flux servir inchangé), + assertions asset
(bouton unique, garde de chargement, render joué avant l'audio).

## CI rouge bloquait tous les déploiements — e-mail réception retiré sans `--full` (6 août 2026)

Prod est restée figée sur `21cb2f9` (05/08 18:42) alors que plusieurs commits
étaient sur `main` : Railway a **"Wait for CI"** activé et **ne promeut que les
commits dont la CI est verte**. Or la CI (`.github/workflows/ci.yml` : tsc + `npm
test` + **`npm run test:integration`**) était rouge depuis `c7709fa` (retrait de
l'e-mail réception, réception WhatsApp-only). `agent:ship` ne lance PAS
l'intégration sans `--full` ; le changement ne touchait pas le flux paiement donc
`--full` a été zappé — mais 4 tests d'intégration paiement (`planFulfillment`,
`wave-webhook`, `orange-money-webhook`) asseraient encore que la réception reçoit
un **e-mail** (`mock.emailCalls()`). CI rouge → aucun auto-deploy → e-mails de
handoff toujours envoyés en prod. Corrigé : ces tests vérifient désormais le
WhatsApp réception (`waTextsTo("221780000000")`, texte libre car
`WA_RECEPTION_TEMPLATE=""` en test). **Leçon : tout changement à `notify` /
routage réception se livre avec `agent:ship -- --full`.** Auto-deploy s'était
aussi "manqué" plusieurs pushes → c'était la garde CI, pas un webhook cassé.

## Findability des composeurs de commande — 🔥 Populaires + tri (6 août 2026)

Babakar : « trouver un article doit être ultra simple » (best-sellers : matchas,
toasts, brunch) + « la recherche doit filtrer en temps réel, sans Enter ». Les
composeurs noyaient les vraies entrées (suppléments au milieu, ~49 articles triés
par `sort_order` non éditable).

Livré sur les **trois** pickers (salle **v19**, supervision **v3**, /commander
**v2**) :

- **Section « 🔥 Populaires » en tête** de la vue par défaut, calculée sur les
  ventes réelles (30 j) : nouvelle `topOrderedItemIds()`
  ([kitchenTicketRepo.ts](src/domain/kitchenTicketRepo.ts)) — un seul scan jsonb
  sur `kitchen_tickets.items_json`, exclut annulés / test / « Supplément… »,
  mémoïsé 5 min. Exposée comme `top: string[]` dans `serviceBootData`,
  `ownerBootData` et le `menu.json` de /commander. Chaque populaire n'apparaît
  qu'une fois (retiré de sa catégorie en vue défaut → pas de double compteur).
- **Tri intra-catégorie** : ⭐ favoris d'abord, « Supplément… » en dernier, sinon
  ordre serveur. Logique volatile partagée en UN endroit :
  [src/ops/opsPicker.ts](src/ops/opsPicker.ts) (`window.__pick.top/sortItems`),
  inlinée dans les trois bundles (fini la triplication / le drift).
- **Recherche temps réel** : déjà `oninput` sur salle/commander (aucun Enter) —
  confirmé + `enterkeyhint=search`. La **supervision** n'en avait AUCUNE : elle
  gagne la barre recherche + chips catégories + Favoris + Populaires (même UX
  que la salle ; « my UX sucks » résolu).
- Le serveur reste seul décideur (prix/choix inchangés, `pickerMenu()` intact).

**À nettoyer côté données** (via /admin/menu, pas touché — je le signale) :
doublons menu prod — « Salade Light » / « Salade light », « Salade soleil » ×2
(dont 1 désactivée). À dédoublonner par Babakar.

## Disengage sur une prospecte en plein funnel — garde serveur (6 août 2026)

Incident prod 05/08 19:13 (Codette, +221775048261) : prospecte L'Invitée
qualifiée (« Non jamais » → éligible → Foundation), créneaux matinée présentés,
elle répond « En semaine plutôt » — et le modèle appelle
`disengage_conversation` (« Conversation répétitive sans intention Revive ») :
ligne de clôture envoyée, Awa muette 24h, lead perdu en silence (le disengage ne
pingue personne, par design). Cause : ses trois réponses courtes rapides ont
pattern-matché « rapid loop of unclear fragments » ; le garde n'existait que
dans le prompt. Fix : garde SERVEUR (« le modèle propose, le serveur décide ») —
`repo.hasRecentBookingActivity(clientId, 60)` détecte un tool de
réservation/vente (check_availability, present_options, create_payment_link…)
dans l'heure, et `disengage_conversation` refuse alors avec
`client_engaged_in_booking` + instruction de continuer la vente. Description du
tool durcie (une préférence de créneau n'est pas un « fragment »). Récupération :
flags levés à la main + message de reprise avec les créneaux Foundation
semaine/matin réels envoyé et journalisé. Tests : refus si activité récente,
disengage normal sinon.

## La supervision (owner) peut aussi PRENDRE une commande (5 août 2026)

Demande Babakar : sur la vue superviseur (/ops/owner), pouvoir aussi prendre une
commande. Le board owner était volontairement lecture seule. Ajouté un bouton
header **« ＋ Commande »** qui ouvre un composeur allégé (choix de l'espace dans
une liste déroulante — l'owner n'a pas de tuiles —, articles avec quantités,
choix obligatoires et notes par ligne, sur place / à emporter, prénom optionnel).

Principe **« le serveur décide »** respecté sans duplication de logique :
- Le corps de création de commande est extrait en `createSpotOrder(deviceLabel,
  spotId, body)` dans [opsRoutes.ts](src/ops/opsRoutes.ts), **partagé** par
  l'endpoint accueil `POST /ops/service/spots/:id/orders` ET le nouveau
  `POST /ops/owner/spots/:id/orders`. Prix/choix validés côté serveur, session
  ouverte/réutilisée côté serveur, heading/subheading dérivés de la session.
- `ownerBootData()` + `/ops/owner/state` exposent désormais `spots` + `menu`
  (même `pickerMenu()` que la salle et /commander — source unique).
- La commande créée par l'owner atterrit sur les boards cuisine + accueil via le
  canal d'événements partagé (bip/voix/push habituels).
- Le board owner reste **watch-only pour tout le reste** : aucune mutation de
  ticket existant (verrouillé par test : plus de /preparing,/ready,/urgent,
  /served,/cancel). Bump `ASSET_VERSION` owner v1→v2.
- Le composeur salle (réception) n'a PAS été touché — zéro risque de régression
  sur le flux critique ; l'owner a sa propre variante plus légère (pas de
  recherche/favoris, inutile pour une prise occasionnelle).

## Panneau 🔔 conscient de la plateforme — Android débloqué (5 août 2026)

L'un des téléphones accueil est un **Android** (pas tous iPhones) : le panneau
🔔 v16/v17 testait « installée sur l'écran d'accueil » EN PREMIER et montrait
les étapes Safari/iPhone sans jamais offrir « Activer les alertes » — alors
qu'Android Chrome pousse très bien depuis un simple onglet. Corrigé (SW
**v18**) : le gate d'installation ne s'applique qu'à iOS (`IOS &&
!isStandalone()`), textes par plateforme (déblocage Android en place — 🔒 →
Autorisations → Notifications — sans réinstallation ; astuce d'installation
Chrome ; « Ne pas déranger » au lieu du bouton silencieux). Runbook : sur
l'Android accueil, ouvrir 🔔 → « Activer les alertes » → « Tester la
sonnerie ».

## Voix cuisine muette + faux chemin Réglages iOS — durcissement (5 août 2026)

Deux retours de Babakar après le lot précédent :

- **« La tablette cuisine ne parle plus »** — la DB prod montre le board vivant
  (tickets ackés en <1 s), donc panne audio côté client. Causes possibles :
  toggle 🔇 (persisté en localStorage, survit aux relances !), volume iPad, ou
  le bug WebKit connu : après des heures d'inactivité le moteur TTS se met en
  pause silencieuse et toutes les phrases suivantes s'empilent sans jamais
  jouer. Correctifs (cuisine **v15**, service **v17**) :
  - **Heartbeat `speechSynthesis.resume()` toutes les 4 s** (inoffensif à vide)
    + relance au retour premier plan, sur les DEUX boards.
  - Le mute cuisine est maintenant **criant** : bouton « 🔇 Son coupé » en
    style warn (un board muet est un incident, pas une préférence).
  - Diagnostic terrain : si « Son activé » ne se prononce pas quand on réactive
    le 🔊, fermer/rouvrir l'app (moteur TTS bloqué) et vérifier le volume.
- **« Réglages → Salle Revive → Notifications n'existe pas »** — vrai : iOS ne
  liste une web app dans Réglages → Notifications qu'APRÈS un premier prompt de
  permission. Un état « refusé » sans entrée visible ne se réinitialise qu'en
  **réinstallant l'icône** (ce qui efface aussi le cookie d'appairage). Le
  panneau 🔔 donne désormais le vrai pas-à-pas : supprimer l'icône → Safari →
  « Sur l'écran d'accueil » → **réappairer** (/admin/appareils) → réactiver.

## /ops/service — sonnerie + vibration fiables « commande prête » (5 août 2026)

Retour Babakar : les téléphones accueil ne sonnaient pas au passage READY, alors
que les réglages iOS semblaient OK. Diagnostic (vérifié en prod) :

- Le serveur **envoyait déjà** un push web au TABLE→READY vers le rôle `accueil`
  ([opsRoutes.ts](src/ops/opsRoutes.ts) `/tickets/:id/ready`), clés VAPID bien
  présentes sur Railway. Le tuyau marchait.
- **Cause réelle** : sur 3 iPhones accueil, **1 seul était abonné** (Syndel, DB
  prod). Sur iPhone le push PWA exige l'app **installée sur l'écran d'accueil**
  (iOS 16.4+) ; ouverte dans Safari, l'ancienne cloche 🔔 était *cachée*
  (`pushSupported()`→false) et l'app n'apparaissait jamais dans Réglages iOS →
  d'où « les réglages ne montrent rien ». Meryl et LInsey jamais abonnées.

Corrections livrées (SW **v16**) :

- **Panneau 🔔 Alertes toujours visible** (fini l'auto-masquage), atténué tant
  que CE téléphone n'est pas abonné → couverture visible d'un coup d'œil. Il
  guide selon l'état : pas installée → pas-à-pas « Partager → Sur l'écran
  d'accueil » ; permission à demander → « Activer les alertes » ; refusée →
  chemin Réglages iOS ; abonnée → « ✓ activées » + **« Tester la sonnerie »**.
- **Endpoint `POST /ops/service/push/test`** (`pushToDevice`) qui sonne
  UNIQUEMENT ce téléphone → preuve immédiate sans attendre une vraie commande.
- **Vibration** ajoutée à la notif push (`vibrate:[…]`) et **alerte premier plan
  renforcée** au READY : triple bip + vibration + voix « Commande prête,
  {espace} » (respecte le toggle 🔊).
- `.env.example` documente enfin `VAPID_PUBLIC_KEY/PRIVATE_KEY/SUBJECT`
  (`npx web-push generate-vapid-keys`).

**Runbook ops (à faire sur CHAQUE iPhone accueil)** : installer la PWA sur
l'écran d'accueil → ouvrir 🔔 → « Activer les alertes » → « Tester la sonnerie »
(écran verrouillé). Au 5/08 seule Syndel était abonnée ; **Meryl et LInsey
restent à faire**. Rappel : **mode silencieux (bouton latéral) = pas de son**,
seulement la vibration — le son de notif est le son système, non
personnalisable.

## Confirmations /ops/service : le verbe sur les boutons (4 août 2026)

Retour Babakar : le `confirm()` natif d'annulation affichait « Annuler / OK » —
illisible quand la question est justement « Annuler cette commande ? » (le
bouton « Annuler » du dialogue veut dire… garder la commande). Remplacé par un
dialogue maison (`askConfirm`) où chaque bouton porte son verbe :

- ✕ ticket → « Annuler cette commande ? » avec **Oui, annuler la commande**
  (rouge) / **Non, garder la commande** ; fermeture du composeur avec panier →
  « Abandonner cette commande ? » avec **Oui, abandonner** / **Non, continuer
  la saisie**.
- Échappatoires sûres : tap sur le fond = garder ; focus initial sur « Non ».
  `role=alertdialog`. Plus aucun `confirm()` natif dans l'app salle (verrouillé
  par test : `opsServiceAssets.test.ts`).
- `ASSET_VERSION` v14 → v15 (purge du cache SW des iPads).

## La salle parle : voix sur /ops/service pour les nouvelles commandes (4 août 2026)

Demande Babakar : que la voix « dise la commande » quand une nouvelle commande
arrive, sur /ops/cuisine ET /ops/service. Constat : la cuisine le faisait déjà
(commit `5605c38`, la voix lit espace + lignes) ; **la salle n'avait aucune
voix** — juste un bip, et seulement au passage READY.

- /ops/service embarque désormais la même stack Web Speech que la cuisine :
  à chaque `ticket_new` TABLE inédit, bip + annonce « Nouvelle commande
  [à emporter], {espace}. {qté} {article}, {options}, {note}… ». La voix dit
  le **nom de l'espace** (Canapé/Terrasse/Pergola) résolu via la session, pas
  le code ticket (C-24) affiché en cuisine ; repli sur subheading/heading si
  la session n'est pas encore dans le modèle.
- Toggle 🔊/🔇 persisté (`localStorage service.sound`) dans le header, comme en
  cuisine ; il coupe bip + voix, et l'activation prononce « Son activé » (le
  geste utilisateur qui déverrouille TTS sur iOS).
- `ASSET_VERSION` v13 → v14 pour purger le cache du service worker des iPads
  (sinon l'app.js embarqué reste l'ancien et « rien ne change » en salle).
- Le READY reste bip seul (pas de voix) — non demandé ; à élargir si l'accueil
  le réclame.

## Le garde de couverture ne sacrifie PLUS JAMAIS une réponse livrable (4 août 2026)

Trois leads perdus le même matin par le même mécanisme, dont un CHECKOUT PAYANT :

- **Awa Ka 09:31** : premier contact « Clé Invité » → salutation/identité
  manquantes → 2 échecs → « problème technique » (garde v1, avant la réparation).
- **Aicha Sy Gaye 10:05** : même rejet `present_options`, puis le déploiement du
  correctif v2 (3ea7380) a remplacé le conteneur PENDANT sa réécriture — le
  drain SIGTERM est plafonné à 25 s, le process est mort en vol : aucune
  réponse, aucun fallback, aucun alerte (webhook déjà ACKé → jamais relivré).
- **Bitty 11:56** : « Ok pour le paiement et m'envoyer la localisation » → lien
  Wave L'Invitée CRÉÉ (30 000 F), réponse du modèle avec le lien… bloquée DEUX
  fois par `no_unsolicited_question` (un « ? » de trop, et « ok pour le
  paiement » n'était pas reconnu comme signal d'achat) → le lien payé est jeté,
  la cliente reçoit « problème technique », Awa en pause 12 h.

Décision (« une fois pour toutes ») : **une réponse livrable n'est JAMAIS
convertie en panne pour une raison de couverture.** Le pipeline final devient :

1. Réparation présentation (salutation/identité) — inchangé (v2).
2. UNE réécriture modèle seulement s'il manque du non-ajoutable ET que la
   réponse ne porte PAS de lien de paiement approuvé serveur (une réécriture ne
   doit jamais risquer de perdre un vrai lien de checkout). Échec de réécriture
   → on garde l'original réparé, on ne jette plus rien.
3. Lint sécurité (lien fabriqué / syntaxe outil) — SEUL bloqueur restant, avec
   sa retry ; l'acceptation de la retry ne dépend plus de la couverture.
4. Ajout déterministe FINAL des faits statiques manquants : adresse (lien Maps
   extrait de business-info.md via `businessMapsUrl()`), méthode de réservation
   (fr/en/wo, tu/vous), lien planning. Le reste (ex. question superflue) est
   loggé `[outbound_coverage_degraded]`, jamais fatal.

Aussi : `hasBuyingSignal` reconnaît désormais « ok pour le paiement », « je
paie », etc. — une confirmation d'achat n'impose plus le zéro-question.
Fichiers : [src/agent/replyCoverage.ts](src/agent/replyCoverage.ts)
(`appendMissingCoverageInfo`), [src/agent/index.ts](src/agent/index.ts)
(pipeline final), [src/agent/systemPrompt.ts](src/agent/systemPrompt.ts)
(`businessMapsUrl`). Reste ouvert (PHASE2) : file d'attente durable des
messages entrants pour survivre au remplacement de conteneur (cas Aicha).

## Retard client + ancrage de langue (conversation Sourcils Senegal, 4 août 2026)

Deux corrections prompt issues de la même conversation prod (cliente anglophone
arrivée via le bouton wa.me du site) :

- **« Je serai en retard » → simple accusé de réception.** Awa répondait
  « préviens juste l'équipe en arrivant » + rappel de l'heure du cours. Feedback
  Babakar : la cliente n'a rien à faire, on accuse réception gentiment et c'est
  tout. Nouvelle règle prompt (section annulation/no-show) : UNE phrase
  chaleureuse, pas de consigne « préviens l'équipe », pas de rappel d'horaire.
- **Langue : les messages du CLIENT font foi, pas le prefill du site.** Premier
  message = texte prérempli français du bouton web (« Bonjour, je souhaite
  réserver un cours », arrivé même URL-encodé — l'encodage du lien wa.me côté
  site Wix est à corriger sur le site). La cliente écrivait ensuite en anglais ;
  `detectLanguage` avait bien flippé `clients.language` à `en`, mais le modèle
  imitait ses propres 20 réponses françaises. Règles ajoutées : les réponses
  d'Awa ne comptent JAMAIS comme signal de langue, un prefill français ne dit
  rien de la langue du client, bascule dès que ses messages sont clairement dans
  une autre langue ; la note de contexte dynamique le répète explicitement.

À noter (même conversation) : la question compte/email post-paiement a bien été
posée (une fois, optionnelle par design) — la cliente a répondu « Merci » sans
donner d'email → contact Wix auto-créé au nom du profil WhatsApp, sans email.

## Alerte owner à chaque tentative de paiement OM/Max It (4 août 2026)

Tant que les callbacks Sonatel restent silencieusement perdus (panne du 31/07),
un paiement OM/Max It réel peut ne laisser AUCUNE trace locale. Jusqu'ici
l'équipe n'était prévenue qu'à l'EXPIRATION du lien (nudge) ou si le client se
plaignait. Désormais le gérant est alerté sur WhatsApp dès la CRÉATION d'un
lien/QR OM ou Max It — c'est-à-dire à chaque tentative de paiement — pour
surveiller le portail marchand et réconcilier via `/admin/paiements-om`.

- Point d'accroche unique : `createClientPaymentSession`
  ([src/domain/paymentSession.ts](src/domain/paymentSession.ts)) après succès du
  QR Sonatel → couvre les 7 outils agent (cours, abonnements, bar, livraisons)
  ET le flux web `/commander`. Wave non concerné.
- [src/domain/omAttemptAlert.ts](src/domain/omAttemptAlert.ts) : retrouve la
  commande (union des 4 tables d'ordres, la ligne existe toujours avant la
  session) + la cliente, puis `notifyReception` avec sujet `⚠️ Paiement …
  à réconcilier manuellement` → copie owner automatique (marqueur ⚠,
  cf. `ownerAlertRules`). Numéro Équipe/test → préfixe `🧪 TEST` : journalisé
  mais ne réveille personne. Fire-and-forget : n'impacte jamais le flux de
  paiement. Actif panne ou pas (le callback peut se reperdre en silence —
  c'est exactement l'incident du 31/07).
- Tests : [test/omAttemptAlert.test.ts](test/omAttemptAlert.test.ts) (format,
  Max It vs OM, fallback si ligne introuvable, suppression owner sur test).

## Premier contact + questions multiples : réponse complète avant tout envoi (3 août 2026)

- Incident prod `+221781038893` : « Bonjour… Comment réserver ? quelles sont
  vos horaires ? Vous êtes où ? ». `get_class_schedule` a envoyé la photo avant
  toute salutation, puis sa consigne de suivi a poussé « quel cours ? » ; Awa
  n'a répondu ni au fonctionnement de la réservation ni à l'adresse, pourtant
  présentes dans `business-info.md`.
- Cause : la salutation et « ANSWER FIRST, FULLY » n'étaient que des consignes
  modèle, tandis que `get_class_schedule` avait un effet WhatsApp immédiat et
  imposait ensuite une question commerciale contradictoire. Le garde de sortie
  ne voyait donc le message qu'après le premier envoi irréversible.
- Correctif : `replyCoverage` dérive côté serveur les obligations du tour
  (premier bonjour + identité automatisée, réservation, planning, localisation,
  absence de CTA sans signal d'achat). Elles sont injectées au contexte et
  validées avant tout `present_options`, toute légende de planning et tout texte
  final ; un brouillon incomplet est corrigé une fois, jamais livré tel quel.
- `get_class_schedule` exige désormais la réponse complète dans `message`,
  l'envoie comme légende de l'image avec `www.revive.sn/planning`, puis clôt le
  tour par `<NO_REPLY>`. Le serveur supprime tout second texte même si le modèle
  ignore ce marqueur. En milieu de conversation, aucune nouvelle salutation ni
  présentation n'est exigée.
- Les horaires restent dynamiques : aucune promesse fixe « 10 h–19 h ». La
  source officielle demeure le planning live + son lien ; la localisation
  reste Almadies avec le lien Google Maps de `business-info.md`.

## Abonnements généralisés : L'Abonnement Aquabike + plan sur mesure (3 août 2026)

**Contexte :** la machinerie des Clés (registre, cours bonus, invitations,
prolongation, gate avis Google) ne gérait que 3 types Reformer. On l'a
généralisée pour deux nouveaux abonnements, en gérant l'axe que les 3 Clés
n'exerçaient jamais : **la coexistence de deux _familles_ de clés** (REFORMER =
les Clés + le sur-mesure ; AQUABIKE) actives/programmées chez une même cliente.

**Ce qui est en prod :**
- **`keyRules`** : 5 types (`KeyType` += `AQUABIKE`, `SUR_MESURE`) ; mapping
  imbriqué par type (`family`, `invitation{planId,serviceIds,slotRule,friendRule}`,
  `bonus|null`, `baseInvitations`, `continuityInvitation`, `reviewGateEligible`).
- **Schéma** : `key_type` CHECK étendu ; `bonus_plan_id` nullable (le sur-mesure
  n'a pas de cours en plus) ; colonne `family` ; unicité SCHEDULED désormais
  **par (cliente, famille)** sur `key_registry` ET `pending_plan_orders` (une
  prochaine Clé ET un prochain Aquabike peuvent coexister). ALTER idempotents.
- **Continuité résolue PAR FAMILLE dans la requête** (`keyCoveringAt`,
  `resolveContinuitySource`) : un Aquabike ne masque jamais une Clé, ni
  l'inverse. **Bug corrigé** : la garantie L'Invitée cherchait la clé active la
  plus récente (`activeKeyForClient`) — un Aquabike plus récent l'aurait masquée ;
  passée à `activeKeyOfType(…, 'INVITEE')`.
- **Gate avis Google** : fondée sur `decision.earlyRenewal` (post-famille) +
  `mapping.reviewGateEligible` → jamais déclenchée pour AQUABIKE/SUR_MESURE, ni
  par erreur sur une Résidente achetée pendant un Aquabike actif. **Aucune
  extension de la gate** (décision Babakar).
- **Réclamation** (`book_key_invitation`/`book_key_bonus`) : périmètre par
  candidate (mapping de chaque clé) ; règle d'amie selon le service.
  **Invitation Aquabike : amie qui n'a jamais fait d'AQUABIKE à Revive**
  (`NEVER_AQUABIKE` + `wix.hasPastAquabikeBooking`) — pas « jamais venue ».
  Aquabike : invitation = cours Aquabike lun–ven toute heure ; bonus = 1 séance
  Reformer au créneau calme 12h30. Plan Wix d'invitation séparé (Invitation
  Aquabike, connecté au seul service Aquabike).
- **Relances lifecycle** (`keyNudge`) : les rappels J+10 invitation / J-5 membre
  / fin de séances sont **réservés à la famille REFORMER** — leurs templates
  Meta sont formulés « Reformer/Clé ». L'Aquabike n'a pas de relance lifecycle
  tant que ses propres templates n'existent pas (un message mal formulé est pire
  qu'aucun). `renewalNudge` exclut désormais tout plan-clé configuré.
- **Admin** : « Clés de la Maison » → **« Abonnements »** (`/admin/abonnements`,
  anciennes URL en 301) ; page de référence statique enrichie d'un **catalogue
  de tous les abonnements + avantages** (`subscriptionsReferencePage.ts`).
- **Prompt + business-info** : règles bonus/invitation par plan ; le plan sur
  mesure « 1x Reformer 1x Mat 1x Step » (100 000 F) est **jamais proposé
  spontanément** (uniquement sur demande nominale).

**Config Wix + Railway (fait) :** plans créés dans Wix ; vars Railway posées —
`AQUABIKE_ABO_PLAN_ID`, `AQUABIKE_BONUS_PLAN_ID`, `AQUABIKE_INVITATION_PLAN_ID`,
`AQUABIKE_SERVICE_IDS`, `SUR_MESURE_PLAN_ID`, + sur-mesure dans
`AWA_SELLABLE_PLAN_IDS`. Le plan bonus Aquabike (« Cours Bonus Reformer - Abo
Aquabike ») est connecté aux 3 services Reformer (sinon la séance offerte serait
irréservable). Les bonus des Clés ont été renommés « Cours Bonus — … » (le code
les référence par ID, aucun impact). Rollout : plomberie d'abord (types dark
tant que les vars sont vides), puis copie client une fois Wix/Railway prêts.

**Piège découvert :** une cliente ayant déjà l'ancien Aquabike (avant
l'automatisation) ne reçoit pas rétroactivement le bonus/invitation — activation
manuelle par la réception (cas Diarra Niang, bonus activé à la main).

**Reste (action Babakar) :** vérifier/dupliquer les templates Meta lifecycle en
variantes Aquabike si on veut les relances Aquabike ; sinon rien.

## /admin/relances recentré sur les leads TIÈDES, pas les cliqueurs réflexes (3 août 2026)

**Décision produit (Babakar) :** ne PAS relancer les leads qui n'ont jamais
répondu à Awa. Le message « Bonjour, je veux réserver la clé invité » est
**pré-rempli par la pub** (le lead ne le tape pas) — donc un lead dont c'est le
seul message n'a montré aucune intention, il a juste cliqué. Cible retenue :
**« vrais échanges » — ≥2 réponses tapées après le message auto**, puis silence.

**Changement (`silentLeadCandidates` / claim, [src/domain/leadNudgeRepo.ts](src/domain/leadNudgeRepo.ts)) :**
la garde ne cherche plus « zéro réponse après le trigger » mais :
- `replies_after_trigger >= 2` (≥2 messages user après le trigger ancré sur
  `campaign_leads.trigger_message_id`) ;
- **Awa a répondu en dernier** (`last_assistant_at > last_user_at`) → vrai stall,
  pas un message qu'Awa doit encore traiter ;
- fenêtre 24 h calculée sur `last_user_at` (dernier message du lead) ;
- stall : `last_assistant_at <= now() - delay`.
Le reste (exclusion funnel paiement, pauses, is_test, one-shot, claim atomique)
inchangé. La page affiche « N réponses, puis silence » + « a écrit il y a X » +
compte à rebours de la fenêtre. Un nouveau message du lead le retire de la liste
(Awa lui doit alors une réponse — flux normal). Tests : cliqueur 0 réponse et
lead 1 réponse **exclus**, lead 2+ réponses **listé**, « fresh reply un-stalls ».

## Relance A passée en ENVOI MANUEL — /admin/relances (3 août 2026)

**Décision produit (Babakar) :** pas d'envoi automatique. La réception relit les
leads pub silencieux dans le dashboard et décide, un par un, d'envoyer la
relance ou d'ignorer le lead. Le sweep auto de la relance A (livré plus tôt le
même jour, cf. section suivante) est **retiré**.

**Ce qui change :**
- Nouvelle page [/admin/relances](src/admin/relancesPage.ts) : liste des leads
  candidats (nom, tel, ancienneté du clic, **compte à rebours de la fenêtre
  24 h**, aperçu du message), 2 boutons par lead — « Envoyer la relance » /
  « Ignorer ». Panneau historique des relances envoyées/ignorées. Badge nav
  `leadNudges`. Routes GET + POST send/skip dans
  [src/admin/routes.ts](src/admin/routes.ts).
- L'envoi manuel passe par le **même claim atomique** (re-vérifie
  réponse/paiement/takeover/handoff + fenêtre 24 h au clic) : si le lead a
  répondu entre l'affichage et le clic, l'envoi est refusé (`status='gone'`,
  bandeau « Lead déjà traité »). Le skip est one-shot et honoré
  inconditionnellement (le lead disparaît de la liste).
- **Holdout / mesure ITT supprimés** : la sélection manuelle n'est pas
  randomisée, donc plus de bras HOLDOUT ni de FNV-1a/heures calmes. `arm='MANUAL'`
  pour tous. `outbound_nudges.arm` accepte désormais `MANUAL` (migration
  `alter … add constraint`). Mesure = simple décompte relances envoyées →
  conversion Clé ≤72 h (non causal, assumé).
- Sweep auto + config `LEAD_NUDGE_ENABLED/QUIET/HOLDOUT` retirés ; il ne reste
  que `LEAD_NUDGE_DELAY_MINUTES` (silence min avant d'apparaître, 180) et
  `LEAD_NUDGE_MAX_AGE_HOURS` (borne fenêtre 24 h, 22) qui cadrent la liste.
- L'échec Meta asynchrone repasse toujours `SENT→FAILED`
  (`markOutboundNudgeFailedByWamid`, webhook statuts).

Tests : `test/relancesPage.test.ts` (rendu), `test/leadNudge.test.ts` (copie),
`test/integration/leadNudge.test.ts` (envoi/skip/course/exclusions),
`test/integration/relancesRoute.test.ts` (route bout-en-bout avec auth).

## Relance A (auto) — lead pub silencieux jamais revenu après le pitch (3 août 2026)

**Analyse prod (24/07→03/08).** 173 leads pub CTWA (`campaign_leads`, clé
`pack_decouverte_ctwa`), 7 Clés L'Invitée vendues — toutes issues des cohortes
30/07–01/08, après le fix « Clé nommée » : ~10 % de conversion post-fix,
ROAS ≈ 7–18×. Seule créa qui convertit : « Découvre le Pilates Reformer ».
**Fuite : 70 leads (40 %) n'écrivent jamais un 2e message** — clic, pitch
d'Awa, silence, zéro relance. Décision produit associée : **budget pub doublé
$5→$10/jour le 03/08**. Spec complète : [LEAD-FOLLOWUP-PLAN.md](LEAD-FOLLOWUP-PLAN.md)
(3 tours de revue).

**Découverte pendant l'analyse.** La relance des liens de paiement PLAN expirés
(ex-« relance B ») était déjà en prod depuis le 01–02/08 (`nudgeExpiredPlanOrders`,
exclusion des retries `retry_of_order_id`, alerte réception OM/Max It). Piège de
process : les premières revues avaient été faites depuis le hub 32 commits en
retard → on a failli re-spécifier du code existant. **Toujours `git fetch` +
inspecter `origin/main` (ou un worktree frais) avant d'analyser.**

**Ce qui a été livré (relance A uniquement).** Un seul message libre à un lead
`pack_decouverte_ctwa` qui n'a **jamais répondu** après le pitch, 3 h de silence,
dans la fenêtre 24 h (borne 22 h). [src/domain/leadNudge.ts](src/domain/leadNudge.ts)
(copie FR/EN, holdout FNV-1a, heures calmes, sweep),
[src/domain/leadNudgeRepo.ts](src/domain/leadNudgeRepo.ts) (candidats + claim),
table `outbound_nudges`, appelée depuis le sweeper 60 s. **OFF par défaut**
(`LEAD_NUDGE_ENABLED=false`) — à activer via Railway après un dry-run prod.

Décisions de conception (les pièges à connaître) :
- **« Jamais répondu » ancré sur `campaign_leads.trigger_message_id`**, PAS sur
  un décompte de messages : `conversations` est un flux par client, donc un
  ancien client qui reclique la pub doit rester éligible (testé).
- **Exclusion de TOUT funnel paiement** (plan orders + booking links, tout
  statut, `EXPIRED` inclus) → la relance A ne s'empile jamais sur la relance
  lien-expiré ni sur le flux normal.
- **Claim atomique** (`INSERT … SELECT … WHERE <toutes les gardes>`) qui
  re-vérifie au moment du claim réponse/paiement/takeover/handoff — une réponse
  arrivée entre sélection et claim annule l'envoi (test « ITT race »). Les
  gardes SQL sont partagées verbatim entre sélection et claim.
- **Mesure causale (intention-to-treat)** : `arm` (TREATMENT/HOLDOUT, fixé au
  claim, immuable) séparé de `outcome` (CLAIMED→SENT/FAILED, ou SUPPRESSED).
  Holdout 1/6 par FNV-1a côté TS (`Math.imul(…)>>>0`, stable entre versions PG,
  contrairement à `hashtext()`). Un rejet Meta async repasse `outcome=FAILED`
  via `markOutboundNudgeFailedByWamid` (branché au webhook statuts) **sans
  toucher l'`arm`** — sinon les échecs Meta, corrélés à l'âge du lead,
  biaiseraient le bras traitement.
- **Pas de promesse de réservation** dans la copie (« je peux t'aider à trouver
  une place », pas « je te garde une place ») : paiement d'abord.

**Mesure (à 2 semaines OU ≥50 claims TREATMENT).** Principale : conversion Clé
≤72 h, tous `arm=TREATMENT` (FAILED inclus) vs `arm=HOLDOUT`. Si les leads
doublent mais pas les ventes → « refine targeting », pas « spend more » ; le
holdout isole l'effet nudge de l'effet budget. V2 (template réveil J+2) gated
sur cette mesure. Tests : `test/leadNudge.test.ts` (pur, 11) +
`test/integration/leadNudge.test.ts` (10).

## Place d'accompagnant impossible pour une cliente à Clé + double fabulation (Khadidjatou, 2 août 2026)

**Incident** : cliente avec Clé L'Invitée demande « ma place sur ma clé + je paie
pour mon amie, lien Wave svp ». Sa place : OK (book_with_membership, 1 séance
déduite). La place de l'amie : le modèle tente `create_payment_link` → refusé par
le garde `covered_by_membership` (conçu contre la double facturation d'un abonné,
il ignore le cas « la place en plus est pour quelqu'un d'autre »). L'outil correct
existait : **`add_spots_to_booking`** (lien argent pour les places AJOUTÉES, sans
toucher au plan) — mais le message d'erreur ne le mentionnait pas. Le modèle a
alors **fabulé** (« le système a rattaché sa place à votre abonnement » — faux :
rien n'a été rattaché, le lien a juste été refusé) et handoff. Récup ops : lien
envoyé via le vrai flux add_spots (12 000 FCFA, payé, 2 places BOOKED dim 9/08
11:15). **Deuxième fabulation** ensuite : la confirmation auto de la place ajoutée
disait « ta place est confirmée » (copie générique) ; quand la cliente a demandé
« donc c'est pour 2 ? », le modèle a NIÉ le paiement pourtant confirmé dans
l'historique et ressorti sa fausse histoire, sans appeler get_my_bookings.

**Correctifs** (worktree `companion-spots`) :
- Message `covered_by_membership` : ajoute le CAS ACCOMPAGNANT explicite
  (book_with_membership pour le client PUIS add_spots_to_booking avec le
  booking_id retourné ; jamais create_payment_link pour l'accompagnant).
- Note de succès `book_with_membership` : même pointeur au moment exact où le
  modèle en a besoin.
- Prompt : cas MIXTE « clé + je paie pour un ami » (§membership) + interdiction de
  fabuler une explication pour un appel outil refusé + règle « une question sur ce
  qu'une confirmation couvre → get_my_bookings et répondre UNIQUEMENT de son
  résultat ; ne jamais "corriger" une confirmation système depuis ses propres
  messages passés » (§get_my_bookings).
- `confirmationMessage` (fulfillment) : les réservations d'extension (order_note
  « Ajout de N place(s)… » posé par add_spots) disent désormais « la/les place(s)
  supplémentaire(s) confirmée(s) — ta propre réservation reste inchangée » au lieu
  du générique « ta place est confirmée » qui a semé la confusion (client ET
  modèle). Garde anti-collision avec les notes bar (extension = sans extras).
- Tests : add-spots sur réservation MEMBERSHIP (scénario exact), garde
  covered_by_membership → message accompagnant (fixture plans au beforeEach du
  fichier : le catalogue services est module-caché 10 min, pricingPlanIds figés au
  premier appel), copies d'extension FR/EN + anti-collision note bar.

## Boucle « vérifié mais pas de member » → achat de plan impossible (Lisa Coulaud, 2 août 2026)

**Incident** : Lisa vérifie son email par code le 28/07 (`account_created` : fiche
Wix créée + liée, MAIS sans member — le member n'est provisionné qu'à l'achat).
Elle achète le 02/08 : `create_plan_payment_link` → `plan_member_verification_required` ;
Awa redemande l'email → `request_email_verification` → `already_linked` (« no
verification needed ») ; retry → **encore** `verification_required` → boucle. Le
modèle s'échappe en **mentant** (`client_declined_verification:true`, aucun refus
réel) → activation manuelle, 30 000 FCFA Wave bloqués, séance jamais réservée,
intervention manuelle de Babakar.

**Root cause** : dans `decideMemberProvisioning`, la fenêtre de fraîcheur 60 min
servait À LA FOIS à arbitrer fiche-prouvée-vs-index-téléphone ET à autoriser la
création du member. Comme TTL d'autorisation, elle enferme tout client vérifié il
y a > 1 h sans member. Décision : **une preuve par code est DURABLE pour le
provisioning** (elle n'expire pas).

**Correctifs** (worktree `verified-member-loop`) :
- **F1** — [src/domain/memberProvisioning.ts](src/domain/memberProvisioning.ts) : trois
  notions séparées. `recentProof` (60 min → arbitrage index seul) ; `durableProof`
  (preuve VERIFIED/LINKED de tout âge → `links.latestProvenLinkRequest`, autorise
  `create_member` UNIQUEMENT si `phoneContactId === durableProof.linkedContactId`,
  anti-hijack) ; `pendingVerification` (→ `codeAlreadySent` seul, un code actif reste
  prioritaire). `verifiedEmail` nullable (LINKED admin sans email) → `provisionWixMember`
  retombe sur l'email primaire de la fiche, sinon `verification_required`.
- **F2** — branche `already_linked` de `request_email_verification` SANS mutation
  d'`updated_at` : preuve durable correspondante → « retry create_plan_payment_link
  NOW » ; sinon (fiche téléphone+email jamais prouvée, ex. vieux paiement Wave) →
  **envoi d'un vrai code** au lieu de la fausse promesse.
- **F4** — le mensonge est neutralisé STRUCTURELLEMENT par F1 (preuve durable →
  décision `create_member`, donc `client_declined_verification` est inerte) ;
  renfort de consigne dans les 3 descriptions du paramètre + prompt.
- **F3 (chantier séparé, PHASE2)** : créer le member dès `submit_verification_code`.
  Écarté ici car `createMember(email)` peut atterrir sur une autre fiche (index email
  en retard) — même risque que `autoProvisionDeclinedNewAccount` déjà en prod.
- **Ordre Lisa `0e05a8e1` : INTOUCHÉ** (réglé manuellement ; poser `member_id` seul le
  rendrait éligible à `stuckPaidPlanOrders` → `findPlanOrderForMember` ±5 min →
  SECONDE Clé créée dans Wix).

Tests : `test/memberProvisioning.test.ts` (Path A/B, anti-hijack, ambiguïté,
code-actif-prioritaire, email nullable) + `test/integration/planMemberSale.test.ts`
(Lisa durable J-2 → auto-activation ; already_linked retry sans mutation ; faux
`client_declined_verification` ignoré).

## Auto-fermeture des interventions à la prise de relais (2 août 2026)

Un handoff / une review « à reprendre » restait OPEN dans /admin/suivi tant que
personne ne cliquait « Traité », même après résolution réelle (Tout, Maryeme,
Marie tous restés OPEN, fermés à la main en DB). **Décision : prendre le relais
ou répondre soi-même au client EST le traitement de l'intervention.**

Nouvelle `autoResolveClientFollowUps` ([src/domain/adminOperations.ts](src/domain/adminOperations.ts))
qui passe à DONE tous les items OPEN (`handoffs` + `conversation_reviews`) du
client, avec audit `follow_up.auto_resolved`. Trois déclencheurs :
- **`startHumanTakeover`** (bouton « Prendre le relais ») → outcome `resolved`,
  note « Auto : prise de relais par <user> » (dans la transaction du takeover).
- **POST `/conversations/:id/reply`** (réponse admin envoyée) → outcome
  `contacted` — filet pour les takeovers TECHNIQUES où personne n'a cliqué
  « Prendre le relais » (`awa-technical-failure`, cas Tout).
- **`startAwaDisengage`** (« Mettre en pause », contact non sérieux) → outcome
  `not_applicable`.

Garde `status='OPEN'` → jamais de réécriture d'un item déjà clos ; `link_requests`
(liaison CRM) intacts (tâche distincte, propre flux 1-clic). Aucun changement UI :
les items disparaissent d'eux-mêmes de /admin/suivi, du bloc « Suivi ouvert » de
la page conversation et des badges. Tests : bloc dédié dans
[test/integration/adminOperations.test.ts](test/integration/adminOperations.test.ts)
(takeover ferme handoff+review, isolation par client, reply en takeover technique,
disengage, non-réécriture d'un item déjà clos).

## PANNE callbacks Orange Money/Max It + outil admin de réconciliation (2 août 2026)

**Constat systémique** (découvert via l'incident Marie, +221776382380) : depuis le
**31/07 12:36 GMT** (dernier callback réel `MP260731.1236.A50831`), **plus aucun
callback Sonatel n'arrive** alors que les paiements aboutissent : Maryeme 01/08
(payé, prouvé SUCCESS via `GET /api/eWallet/v1/transactions`, zéro callback),
Marie 02/08 (2 liens, payé ~09:00, zéro callback, séance réservée à la main par
Babakar), + 1 booking 08:30. Wave confirme normalement sur la même période →
problème spécifique OM, très probablement côté Sonatel (notre endpoint répond
200 et un POST manuel du 02/08 00:54 a été traité de bout en bout). Config
vérifiée saine (`X-Callback-Url` → `https://awa.revive.sn/webhooks/orange-money`).
**Email de signalement envoyé à Sonatel** (marchand 553651) : logs de délivrance,
support du header `X-Callback-Url`, changement plateforme au 31/07, re-déclenchement.

**Nouvel outil : `/admin/paiements-om`** (nav Studio → « Paiements OM ») — la
réception colle l'ID de transaction du portail OM, choisit la commande (liste
des ordres OM/Max It non payés < 7 jours : cours, abonnements, bar, livraisons)
et valide. Le serveur rejoue le pipeline webhook EXACT (`enqueueOmVerification`
→ vérification authentifiée Sonatel montant/marchand/SUCCESS →
`processPayment`/fulfillment → confirmation WhatsApp client). Payment-first
intact : rien n'est validé sans confirmation Sonatel ; une transaction ne peut
jamais être rattachée à deux commandes. Tableau « Dernières vérifications »
pour suivre les résultats. Fichiers : [src/admin/omReconcilePage.ts](src/admin/omReconcilePage.ts),
routes GET/POST dans routes.ts, lien nav layout.ts.

Runbook tant que la panne dure : tout paiement OM/Max It réclamé → portail OM →
copier l'ID `MP…` → `/admin/paiements-om`. (Le nudge d'expiration + l'alerte
réception OM shippés plus tôt aujourd'hui préviennent automatiquement.)

**Mode panne OM/Max It (toggle owner, même jour)** — bouton sur
`/admin/paiements-om` (clé `app_state om_outage_mode`). Quand ACTIF :
- Prompt : bloc « OM OUTAGE MODE » injecté dans le contexte dynamique — Awa ne
  dit JAMAIS qu'un paiement OM/Max It « n'a pas été reçu » ; elle rassure
  (« vérification manuelle temporaire », sans jamais dire Sonatel/panne),
  fait UN `handoff_to_human` avec montant/article/heure, promet la confirmation
  automatique ici ; Wave annoncé comme instantané mais OM/Max It jamais refusés.
- Notes outils `create_payment_link`/`create_plan_payment_link` (OM/maxit) :
  pré-avertir le client d'une confirmation plus lente.
- Nudges d'expiration : copie qui ne sous-entend plus le non-paiement + alerte
  réception/owner « MODE PANNE OM ACTIF » pointant `/admin/paiements-om`.
- **Alerte OM/Max It étendue aux réservations de cours** (le trou du cas Marie :
  seul le flux abonnement alertait) — expiration OM/maxit d'un booking = même
  alerte réception/owner, mode panne ou pas.

## Incidents Tout & Maryeme → 4 correctifs paiement/fiabilité (2 août 2026)

Deux conversations ratées le 1er août, diagnostiquées sur la DB prod + code.

- **Tout** (`c2c58ab4`) : premier message « je veux réserver la Clé Invité » →
  réponse immédiate « un problème technique ». Cause : une `APIConnectionError`
  transitoire vers l'API Anthropic n'était PAS retentée (`withOverloadRetry` ne
  couvrait que les 529). Le loop a basculé en relais technique + takeover 12h dès
  le 1er message. **Récupéré** : takeover levé, message de relance envoyé.
- **Maryeme** (`b4a634b1`, order `3e44be77`) : funnel L'Invitée parfait jusqu'au
  lien Max It (30 000 FCFA, séance mer 5 août 17:15). Elle a payé (confirmé par
  Babakar, transaction `MP260801.2046.A59064`) mais **le callback Sonatel n'est
  jamais arrivé** → l'ordre est passé EXPIRED sans notif à personne. En plus, la
  vérif email iCloud n'est jamais arrivée et Awa a improvisé « répondez quand
  vous recevez la confirmation d'activation », laissant la cliente en attente
  infinie. **Récupéré** : callback rejoué (re-vérifié Sonatel → PAID), compte Wix
  créé avec l'email fourni (fiche unique, pas de doublon), Clé + bonus activés,
  séance CONFIRMED dans Wix, message de confirmation envoyé.

Correctifs (worktree `convo-failure-fixes`) :
- **A — retry des erreurs réseau Anthropic** : `withOverloadRetry` retente
  désormais aussi les `APIConnectionError` (via `isConnectionError`, instanceof +
  fallback nom/message ; les 4xx/5xx HTTP restent fail-fast). Décision Babakar :
  on GARDE le takeover 12h + silence après échec définitif (Awa promet que la
  réception recontacte — un auto-resume serait incohérent) ; le retry réduit
  juste l'entrée dans cet état.
- **B — nudge sur ordre de plan expiré + alerte réception OM/Max It** : nouveau
  `expiry_nudged_at` sur `pending_plan_orders`, `expiredPlanOrdersToNudge`/
  `claimPlanOrderExpiryNudge`, `nudgeExpiredPlanOrders` dans le sweep 60s. Le
  client reçoit « lien expiré, si tu as payé dis-le-moi » ; pour OM/Max It la
  réception est aussi alertée (un callback perdu est invisible autrement — c'est
  le trou exact du cas Maryeme).
- **C — anti-dérive « j'ai payé » / activation manuelle** : la note ACTIVATION et
  le prompt séparent explicitement CONFIRMATION de paiement (auto ~2 min → sinon
  `handoff_to_human`) et ACTIVATION (manuelle) ; interdiction de demander au
  client d'attendre/rapporter une « confirmation d'activation ».
- **D — création de compte directe quand le code n'arrive pas** (demande Babakar,
  override ciblé du NO-GO du 13/07) : si un client d'un compte NEUF a donné son
  email pour la vérif mais décline (code non reçu), on crée la fiche + le membre
  Wix directement (`autoProvisionDeclinedNewAccount`) → activation automatique au
  lieu du limbo manuel. **Effet de bord assumé** : Wix envoie un mail de
  bienvenue/mot-de-passe (Awa l'annonce). Fail-safe : tout doublon/ambiguïté →
  fallback manuel. Compte existant → toujours vérif par code obligatoire.

Runbook « callback OM perdu » : demander la transaction `MP…`, la rejouer via
`POST /webhooks/orange-money` (voir OM-LINKS-HOW-TO.md) ; si compte neuf, créer
la fiche+membre avant de rejouer pour une activation auto complète.

## Coupe-circuit des conversations sans intention (2 août 2026)

- Incident Atueydjk : Awa a répondu vingt fois à vingt notes vocales très
  courtes ou inexploitables en quatre minutes, sans intention Revive. Quatre
  transcriptions ont même repris mot pour mot le prompt de contexte Whisper.
- Correctif serveur déterministe : salutations/adieux répétés, fragments courts
  hors sujet, échecs de note vocale et échos du prompt de transcription
  alimentent un compteur atomique. Au troisième tour sans intention, Awa envoie
  une unique phrase de clôture dans la langue du client puis reste silencieuse
  pendant 24 heures, avant tout appel au modèle.
- Reprise sûre : seule une demande Revive explicite (cours, réservation, plan,
  prix, horaire, paiement, livraison, etc.) réactive Awa avant les 24 heures.
  Les pauses manuelles ou déclenchées pour comportement non sérieux gardent leur
  sémantique et ne sont jamais levées par ce mécanisme.
- Transcription : une réponse identique au prompt Whisper est désormais rejetée
  comme échec de transcription au lieu d'être traitée comme un message client.
- Visibilité admin : le motif `no_intent` est stocké et affiché comme « Boucle
  sans intention ». Couverture : reproduction des trois premiers tours
  Atueydjk, langues FR/EN/WO, prompt echo, compteur PostgreSQL concurrent-safe,
  clôture au troisième tour et silence après clôture.

## Audit des 20 dernières conversations — correctifs (1er août 2026)

Revue des 20 dernières conversations prod. Corrigés dans `agent/awa-convo-fixes` :

- **B1 — fuite de `<NO_REPLY>`** (Gogo Ibrahim) : le modèle mélangeait le
  sentinel interne avec une vraie réponse (« `<NO_REPLY>`\n\nPour répondre… »),
  `classifyReplyOutcome` testait l'égalité stricte → le token partait au client.
  Fix : on strippe tout sentinel autonome avant classification/envoi (réponse
  mixte livrée en texte propre, sentinel pur → recover/silence), + garde-fou
  outbound-lint `leaked_sentinel`.
- **B2 — IDs inventés** (Aissatou/Agnes/Maimouna/Khadidjatou) : slugs
  (`sculpt`) et placeholders (`invitee_key_id_placeholder`) → `unknown_*_id` +
  aller-retour d'erreur sur le chemin paiement. Fix : `unknown_service_id` /
  `unknown_plan_id` renvoient les IDs valides live (auto-correction en 1 tour,
  jamais montrés au client) + règle prompt « copier l'ID verbatim ».
- **B5 — client déjà payé, `get_my_bookings` vide** (Mickaelle, 2 numéros) :
  Awa proposait de re-réserver (risque double paiement). Fix prompt : proposer
  la vérification e-mail pour relier les fiches, sinon handoff — jamais
  re-réserver. Invariant serveur vérifié : la fusion de fiches n'a lieu
  qu'après un code e-mail correct (`submit_verification_code` → `planVerifiedMerge`).
- **B3 — prix de cours inventés** (Myrma/Amicolle) : `list_classes` renvoyait 6
  cours, Awa en listait 10 avec prix. Investigation : Power Yoga/Yoga
  Inversions/Step/Natation Enfant étaient en cours de config Wix ce matin-là
  (list_classes les renvoie tous aujourd'hui, prix exacts) → fenêtre transitoire,
  pas un bug de filtre. Fix prompt : ne citer nom/prix/durée QUE depuis le dernier
  `list_classes`.
- **B4 — texte entrant percent-encodé** (Amicolle : `Bonjour%2C%20je…`) : lien
  wa.me double-encodé. Fix : décodage défensif au parse, heuristique stricte
  (≥2 espaces encodés, ou 1 espace + octet accentué, `decodeURIComponent` OK),
  URLs/`%` isolé/malformé laissés intacts, chaque décodage loggé (source à
  corriger côté lien wa.me).
- **D1 — Pack Découverte RETIRÉ** : `index.ts` force
  `packDiscoveryCampaign`/`packDiscoveryMetaNewLead` à `false` — plus aucun lead
  n'entre dans le pitch 10 000 F ; la découverte passe par L'Invitée. Les leads
  référral restent enregistrés (attribution). Le flux de continuité/fulfillment
  (`PACK_DISCOVERY_CONTINUATION_PLAN_IDS`, activé en réception) reste VIVANT tant
  qu'un pack étape-1 est en vol (Zeina, 28/07). Blocs prompt dynamiques laissés
  inertes, à supprimer en bloc quand : (1) aucun pack actif, (2) aucun
  paiement/réservation en attente lié, (3) 14 jours sans lead campagne. À FAIRE
  côté Babakar : couper la pub Insta « Pack découverte ».
- **C — copy/persona** : perks de Clé présentés d'emblée (choix Babakar) ;
  langue conservée sur message court/neutre (Arame EN→FR) ; pas de surclassement
  de niveau non demandé (Khadidjatou→Sculpt) ; nom de plan inventé « Découvrir
  Revive » retiré (prompt + business-info) ; coach nommé depuis l'outil au lieu
  de « sa/son coach ».

## Renvoi d'un lien de Clé expiré bloqué par le filtre de sortie (1er août 2026)

- Incident Kadidiatou Diallo : `refresh_expired_plan_payment_link` avait bien
  créé une nouvelle tentative Wave liée à l'ordre expiré, mais Awa envoyait le
  relais technique au lieu du lien. Aucun paiement ni réservation n'avait eu
  lieu.
- Cause : l'allowlist anti-faux-liens ne faisait confiance qu'aux noms
  `create_*_payment_link`. Le vrai outil de renouvellement commence par
  `refresh_`, donc son URL serveur était classée à tort
  `unapproved_payment_url`. Le même angle mort existait pour
  `add_spots_to_booking`, qui crée lui aussi un vrai lien.
- Fix : allowlist explicite et testée des six outils serveur autorisés à
  produire un lien. Les outils non listés et les noms ressemblants restent
  refusés ; le garde anti-liens inventés n'est pas élargi à tous les résultats.

## Machine à avis Google — invitation du 1er renouvellement anticipé (31 juillet 2026)

- **Objectif** : la **première fois** (à vie) qu'une cliente renouvelle une Clé
  **avant expiration**, l'invitation gagnée naît **verrouillée** (`PENDING_REVIEW`)
  et s'active quand elle laisse un **avis Google** puis envoie une **capture
  d'écran**. Awa active sur capture — la capture suffit, pas de validation
  réception (celle-ci reçoit une notif FYI). Un seul avis débloque **toutes** les
  invitations de la clé (cas Résidente : les 2). Une fois par cliente : ses
  renouvellements anticipés suivants donnent l'invitation sans condition.
- **Périmètre** : la condition est **annoncée dès l'argumentaire de vente** d'un
  renouvellement anticipé (contexte dynamique `reviewGate: "announce"`). Les
  **achats au comptoir** (webhook Wix) ne sont **jamais** gated — le provisioning
  comptoir ne passe pas `reviewGatePlanOrderId`, seule la voie Awa/fulfillment le
  fait. **Risque assumé par Babakar** : conditionner un avis est contraire à la
  policy Google (avis incitatifs) ; décision produit prise en connaissance de cause.
- **Modèle** : nouveau statut `PENDING_REVIEW` sur `key_invitations` (invisible à
  `availableInvitationForKey`) + table `google_review_gates` (PK `client_id` =
  règle à-vie), créée au paiement vérifié dans `finalizeVerifiedKeyContinuity`
  (re-entrante : insert idempotent). Une clé chaînée naît plus tard, à
  l'activation ; le gate porté par la cliente survit à ce décalage (capture avant
  provisioning → invitations nées `GRANTED`).
- **Décision pure** : `reviewGateApplies()` dans `keyRules.ts` (feature on +
  early renewal + cliente connue + pas déjà gated + invitationCount > 0). Le gate
  change le **statut de naissance** des invitations, jamais leur nombre
  (`invitationEarnings` inchangé).
- **Flux** : message de demande envoyé après paiement dans `processPlanPayment`
  (`maybeSendGoogleReviewAsk`, claim atomique `ask_sent_at` → retries webhook
  no-op, couvre Wave + OM). Outil `record_google_review` (activation atomique +
  idempotente + notif FYI). `book_key_invitation` renvoie `invitation_pending_review`
  + lien quand la seule invitation est verrouillée → rappel doux piloté par l'outil.
- **Config** : `GOOGLE_REVIEW_URL` (vide = feature éteinte ; effective seulement
  avec `KEYS_AUTOMATION_ENABLED`). Lien prod : `https://g.page/r/CQm4IE7CTYQYEBM/review`.
  Le lien n'est pas une URL de paiement → `outboundLint` ne le bloque pas.
- **Tests** : `test/googleReviewGate.test.ts` (table `reviewGateApplies` + copie
  fr/en/wo), `test/integration/googleReviewGate.test.ts` (à-vie PK, invisibilité
  redemption, activation atomique + idempotente, claim one-shot, capture avant
  provisioning, Résidente 2 invitations).

## Relais technique fiable + Clé avec première séance (31 juillet 2026)

- Les pannes terminales convergent vers `handleTechnicalFailure()` : pause Awa
  de 12 h (`awa-technical-failure`), tâche ouverte dédupliquée, message cliente
  fixe FR/EN/WO sans lien/numéro/action, et alertes WhatsApp réception + gérant
  dédupliquées par incident et destinataire dans `notification_log`.
- Les retries sûrs restent en amont du relais. Les erreurs métier structurées
  (créneau plein/commencé, lien expiré, vérification) et les médias simplement
  illisibles restent conversationnels ; seul un crash réel du handler média
  déclenche le relais. Chaque nouveau message pendant les 12 h conserve
  l’alerte de relais humain existante. Badge admin : « Relais technique Awa ».
- Le contexte charge le dernier paiement de plan expiré depuis moins de 7 jours
  sans exposer son ancienne URL. `refresh_expired_plan_payment_link` revérifie
  propriétaire, état, âge, concurrence, plan/prix/membre/moyen de paiement et
  éventuelle première séance, puis crée une nouvelle tentative liée par
  `retry_of_order_id`. Un créneau plein ou commencé renvoie une erreur métier et
  ne crée aucun paiement.
- `create_plan_payment_link` accepte le groupe indivisible
  `service_id + event_id(choice_id) + slot_start`. Le serveur résout et fige le
  vrai événement Wix. Après paiement, il active le plan, sélectionne le bénéfice
  exact par `planId + wixOrderId`, réserve, décompte et confirme une seule fois.
  Si la place s’est remplie, la Clé reste active et l’équipe propose ici un autre
  créneau sans nouveau paiement ; les échecs techniques persistants passent au
  relais terminal.
- Les alias de service retirent désormais les mots génériques `pilates` et
  `reformer` des deux côtés, refusent un reste vide/collision, et n’acceptent
  qu’une correspondance unique (`sculpt`, `reformer_sculpt`,
  `pilates_foundation` restent valides selon le catalogue Wix).
- Vérification : `npm run build`, **909 tests unitaires** et **282 tests
  d’intégration** passent (28 fichiers, Postgres Docker).

## Clé nommée = on répond sur CETTE Clé (30 juillet 2026)

Incident prod (cliente Fary-Seune, 30/07) : « Je suis intéressée par votre offre
« l'Habituee » ». Awa a posé la qualification (« avez-vous déjà pratiqué le
Pilates Reformer chez Revive ? »), a reçu « Non », puis a déroulé **tout le
pitch de L'Invitée** — sans jamais parler de L'Habituée, la Clé explicitement
demandée. Faute de confiance : la cliente demande A, on lui vend B.

- **Cause** : pas un bug de données (`list_plans` renvoie bien les trois Clés
  distinctes de Wix). Le funnel de vente codé en dur dans
  [src/agent/systemPrompt.ts](src/agent/systemPrompt.ts) (règle CLÉS DE LA MAISON)
  et son miroir [business-info.md](business-info.md) imposait : toute marque
  d'intérêt Clés → question de qualification → « Non → recommander L'Invitée ».
  Aucun garde-fou pour une cliente ayant nommé une Clé précise. Le funnel, écrit
  pour les demandes génériques (« je veux découvrir »), écrasait la demande
  explicite. (Introduit par `e34035f` — one-tap Clé qualification.)
- **Correctif** : nouvelle règle **EXPLICIT KEY REQUEST WINS** en tête de la
  section, prioritaire sur le funnel. Si la cliente nomme une Clé (y compris mal
  orthographiée / sans accent / nom poétique seul / « Clé 6/12 séances ») → on
  présente et vend **cette** Clé depuis `list_plans`, jamais une autre. Pour
  L'Habituée / La Résidente : **pas** de question de qualification et **aucune
  mention de L'Invitée** (décision Babakar 30/07 : « never mention unless
  asked ») — L'Invitée ne revient que si la cliente demande elle-même l'offre
  découverte. Le funnel « Non → L'Invitée / Oui → trois horizons » ne s'applique
  plus qu'à une demande générique sans Clé nommée. La protection symétrique
  existait déjà en sens inverse (ligne « L'Habituée/La Résidente never as a
  replacement » pour L'Invitée) ; on a ajouté le sens manquant.
- **Pas de changement serveur** : le garde `plan_id` + `plan_name_confirm`
  empêchait déjà de *payer* la mauvaise Clé ; le bug était purement dans ce
  qu'Awa *dit*.

## Paiements coachs — récupération des occurrences Wix annulées (30 juillet 2026)

`Query Events` de Calendar V3 est une projection : une occurrence récurrente
annulée peut en disparaître entièrement. Cas réel Yass du 16/07 : 10h15 restait
`CONFIRMED` avec deux participantes, tandis que 12h30, annulée au niveau séance,
n'apparaissait plus et produisait à tort « 0 annulée ».

- La synchronisation pagine désormais les bookings `CANCELED` comme simples
  pistes de découverte, filtre leurs dates localement (les filtres temporels
  Bookings Reader ont déjà renvoyé de faux résultats vides), puis relit les
  `eventId` absents de Query Events avec List Events et Get Event en repli.
- Seul le statut Calendar réel `CANCELLED` ajoute une séance annulée : annuler
  des réservations clientes ne suffit jamais à annuler le cours.
- Les IDs déjà présents dans le brouillon sont revérifiés, les décisions
  manuelles restent conservées, et une panne de découverte fait échouer la
  synchronisation au lieu d'afficher un faux zéro.
- Spike production sur l'ID réel de 12h30 : List Events et Get Event répondent
  tous deux 200 avec `CANCELLED` et `recurrenceType=EXCEPTION`.
- Les volumes du scan (pages, bookings, candidats, durée) sont journalisés pour
  rendre visible sa croissance. Le registre webhook des annulations sans aucun
  booking est le second lot du même chantier.
- **Vérification prod après déploiement (`9b6bb76`)** : resynchronisation du
  brouillon courant Yass juillet réussie. Résultat observé dans l'état :
  **4 annulées, 1 vide, 83 comptées**. Annulées : 06/07 12h30,
  13/07 12h30, 16/07 12h30 et 22/07 18h15. Le 16/07 10h15 reste confirmé et
  compté avec 2 participantes ; le 16/07 12h30 est annulé et exclu. Les anciens
  objectifs « 1 annulée » / « 81 » étaient des estimations opérationnelles,
  pas une vérité du dépôt.
- **Correction tarifaire Yass (31 juillet 2026)** : l'ancienne formule
  `800 000 / 84`, qui produisait à tort **790 476 FCFA** pour 83 cours, a été
  remplacée par le tarif métier confirmé de **9 500 FCFA par cours**. La fiche
  permanente et le brouillon de juillet ont été corrigés et vérifiés en
  production : **83 × 9 500 = 788 500 FCFA**.
- **Lot 2, distinct de `WIX-WEBHOOK-PLAN.md`** : il ne notifie aucun client et
  ne remplace pas le sweep des réservations ; il doit seulement mémoriser les
  occurrences Calendar annulées sans booking pour les états coachs. Avant tout
  code de registre, souscrire la Custom App à
  `wix.calendar.v3.events_view / projection_updated`, annuler réellement une
  séance de test sans booking et prouver la réception du payload signé. Si ce
  test échoue, utiliser une comparaison périodique des projections plutôt que
  supposer le webhook fiable.
- **Sortie du scan historique** : conserver les métriques pendant trois mois
  civils clôturés après mise en service du lot 2. Si le registre/diff ne manque
  aucune annulation sur ces trois clôtures, borner le scan des bookings annulés
  à une fenêtre documentée ou le retirer ; sinon le garder comme filet et
  investiguer les écarts.

## Revue de 20 conversations prod → 4 lots de correctifs UX (30 juillet 2026)

Analyse des 20 dernières vraies conversations clientes (dump prod, `is_test=false`).
Le tunnel marche (4 réservations payées propres) mais des frictions récurrentes
coûtaient des conversions (12/20 classées `dropoff`). Quatre lots livrés :

- **Lot 1 — garde-fous confiance (`cf0fe66`, `6e20951`).**
  - **Lien de paiement fabriqué (incident réel 25/07)** : le modèle avait émis en
    clair une fausse imitation `[outil] create_payment_link(...) -> {...}` avec un
    lien Wave inventé ; cliente plantée. Nouveau `lintOutboundReply()`
    ([src/agent/outboundLint.ts](src/agent/outboundLint.ts)) : garde de sortie sur
    CHAQUE message du modèle — bloque tout URL de paiement pas exactement issu d'un
    vrai `create_*_payment_link` ce tour-ci (ou d'un enregistrement de paiement
    actif en base) et toute syntaxe d'appel d'outil. Sur blocage : une relance
    corrective SANS outils, contrainte aux liens approuvés ; si ça re-bloque →
    fallback technique + alerte réception (jamais de faux lien). Marqueur de
    rejeu d'outil renommé `[outil]` → `⟦trace⟧`, que le modèle ne doit jamais émettre.
  - **`present_options`** rejette tout id d'option `slot_` non canonique / absent
    du `slot_cache` (incident `slot_placeholder2/3/4`).
  - **Garde couverture abonnement** dans `create_payment_link` : refuse un lien à
    la carte quand le plan actif du client couvre la classe avec assez de séances
    (→ `book_with_membership`) ; ne boucle pas (ne se déclenche que si
    `remaining >= participants`).
- **Lot 2 — conversion + persona (`e34035f`).**
  - **Persona conseil, pas vendeur pressant** (demande explicite de Babakar) :
    répondre d'abord et complètement aux questions d'info sans CTA collé,
    recommander UNE option adaptée, ne closer que sur signal d'achat, un seul
    « next step » par sujet et jamais après un refus. Paires bon/mauvais exemples
    dans le prompt.
  - **Question de qualification L'Invitée** posée en boutons `present_options`
    (`key_revive_yes/no`) au lieu d'une question ouverte (là où ~6/20 mouraient),
    formulation canonique unique.
  - **Pack Découverte RETIRÉ** (décision Babakar) : c'est l'ancien nom de
    L'Invitée. business-info reformulé (jamais dire à un détenteur qu'il n'y a
    « pas droit », couverture toujours via `covers_classes`). Campagne étape-1 à
    10 000 F morte.
  - **Objections paiement** : script ferme-mais-chaleureux, réponse diaspora
    (« transfère le lien à un proche au Sénégal »), handoff après 2 refus — sans
    jamais laisser entendre qu'une exception existe (réception seule, règles
    internes non divulguées).
  - **Vérif e-mail** annoncée d'avance + fallback pay-first proposé si hésitation.
  - **STT** biaisé FR/Wolof/EN + vocabulaire studio.
- **Lot 3 — qualité de conversation (`1e66a2b`).**
  - **Réactions 👍** : un 👍/OK sur la DERNIÈRE question d'Awa est routé comme un
    « oui » (wamid stockés sur les tours assistant/interactif ;
    [src/agent/reactionIntent.ts](src/agent/reactionIntent.ts)). Non contraignant :
    le prompt interdit qu'une réaction autorise seule un paiement/annulation/résa.
  - **Upsell bar** : cooldown 24h → **7 jours** (client récurrent upsellé 3× en
    2 semaines).
  - **Note de silence** : quand ≥24h séparent deux échanges, le contexte indique
    l'écart et interdit de reprendre une offre expirée / une date passée.
- **Lot 4 — connaissances & ops (`324f3b2`).**
  - **Fermetures studio** éditables sans redéploiement (`/admin/fermetures`,
    table `studio_closures`, intervalle `[début, fin)`), appliquées côté serveur
    partout : `check_availability` filtre les créneaux fermés + renvoie
    `closed_dates`, `create_payment_link` et `book_with_membership` refusent un
    créneau fermé, et les fermetures des ~30 prochains jours sont injectées au
    contexte (Awa les annonce). Incident déclencheur : Awa a dit « on n'est pas
    fermé » alors que fermé le lundi pour le Maggal de Touba.
  - **Base FAQ Awa** (`/admin/faq`, table `faq_entries`) : « Enregistrer la
    réponse en FAQ » dans le formulaire de résolution d'un handoff (même
    transaction) ; seules les entrées `published`+`enabled` sont injectées au
    prompt comme DONNÉES (jamais des instructions), plafonnées. Évite les 3
    handoffs pour la même question (cas télétravail).
  - **Reste à faire** : la garde fermeture au niveau de la réconciliation
    webhook Wave (fermeture créée alors qu'un lien est déjà vivant → chemin de
    remboursement) n'est pas encore posée — bloquée à la création du lien seulement.

Plan complet et revue archivés hors repo (`~/.claude/plans/`). Le marqueur
`⟦trace⟧` remplace `[outil]` — si tu vois encore `[outil]` dans un prompt/test,
c'est un oubli à corriger.

## Awa dit toujours bonjour au 1er message, même pour L'Invitée (30 juillet 2026)

Sur la conversation d'Anissa, Awa entrait direct dans le pitch L'Invitée sans dire
bonjour. Cause : pour un 1er message à intention claire, le prompt rendait la
salutation *optionnelle* ([systemPrompt.ts](src/agent/systemPrompt.ts) : « weaving
in one brief introduction line such as… »), et la consigne Pack Découverte ne la
rappelait pas → Awa la sautait. Correctif (prompt only) : la salutation +
présentation brève (« Salut ! Moi c'est Awa, je suis une assistante automatisée de
Revive 😊 ») est désormais **obligatoire sur tout 1er message**, y compris L'Invitée /
Pack Découverte — on ne coupe que le « Comment je peux t'aider ? » et le long pitch
générique. Renforcé aux 3 endroits : règle persona, consigne Pack Découverte, et le
contexte dynamique FIRST CONTACT. Garde-fou : `discoveryAdFlowPrompt.test`.

## Alerte propriétaire sur WhatsApp dès qu'une intervention est à faire (29 juillet 2026)

Demande gérant : « quand il y a une intervention à faire, je dois être alerté
directement sur WhatsApp, **par template**, pour toujours avoir l'alerte ».

- **Pourquoi un template** : le numéro du gérant n'écrit jamais à Awa → sa
  fenêtre 24 h est fermée en permanence, et Meta **accepte (200) puis jette**
  un free-text hors fenêtre (131047 asynchrone). Le template est le seul envoi
  garanti. On envoie donc **template d'abord**, free-text seulement en secours
  si le template échoue — l'inverse du chemin client.
- **Qui décide** : [src/domain/ownerAlertRules.ts](src/domain/ownerAlertRules.ts),
  module pur. Classement **sur le sujet seul** (le corps contient des « en
  attente » qui n'engagent personne) : commande de test → jamais ; liste
  informative (nouvelle livraison, départ autorisé, espèces choisies, récap du
  jour, message pendant un relais humain) → jamais ; marqueur d'intervention
  (⚠ 💸 🔴 🚨 🙋 🛡 🔀 🔗) ou verbe d'action (« à faire », « à vérifier »,
  « manuelle », « remboursement », « planté »…) → **le gérant est réveillé**.
  Un sujet inconnu ne réveille pas : une alerte inutile répétée finit ignorée,
  et c'est comme ça qu'on rate la vraie.
- **Filet anti-oubli** : le test balaie les 44 sujets réellement passés à
  `notifyReception()` dans `src/` et **échoue** tant qu'un sujet n'est rangé ni
  côté intervention ni côté information. Un futur appel doit choisir son camp
  (marqueur, liste informative, ou `ownerAlert: true/false` explicite).
- **Envoi** : `notifyReception()` fanne vers `OWNER_PHONE` **en parallèle** de
  la réception — une réception injoignable n'emporte plus l'alerte du gérant
  avec elle. Jamais de doublon si `OWNER_PHONE == RECEPTION_PHONE`. Journalisé
  `notification_log` source `owner_alert` (visible dans /admin/notifications,
  libellé « alerte gérant »), donc un échec de template se voit.
- **Config** : `OWNER_ALERT_ENABLED` (défaut true), `WA_OWNER_ALERT_TEMPLATE`
  (**vide ⇒ réutilise `WA_RECEPTION_TEMPLATE`**, déjà approuvé — rien à faire
  chez Meta pour démarrer), `WA_OWNER_ALERT_TEMPLATE_LANG`.
- **Vérification** : bouton **« Tester l'alerte gérant »** sur
  /admin/notifications — même chemin que les vraies alertes, journalisé
  pareil. À cliquer une fois après le déploiement : c'est la seule preuve que
  la chaîne template → WhatsApp du gérant fonctionne.

## Fix vente L'Invitée : « chez Revive », pas « le Pilates en général » (29 juillet 2026)

**Bug prod (conversation Céline Abeln).** Awa a refusé de vendre **L'Invitée —
Clé 3 séances** à une prospecte qui avait pratiqué le Pilates **ailleurs**. La
règle métier est pourtant « nouvelles clientes **Revive** uniquement » : seul un
passé Pilates/Reformer **chez Revive** disqualifie.

- **Cause** : la question de qualification était écrite sans portée — « As-tu
  déjà pratiqué le Pilates Reformer ? » (`business-info.md` + prompt système
  `CLÉS DE LA MAISON`), avec « si oui → propose L'Habituée / La Résidente ».
  Une cliente expérimentée ailleurs répondait « oui » → Awa la sortait de
  L'Invitée. Le serveur, lui, était déjà correct : `create_plan_payment_link`
  ne bloque que sur `hasAnyPastReviveBooking` ou un ancien order Pack/Invitée
  (`invitee_not_eligible`, [src/agent/tools.ts](src/agent/tools.ts)). C'était
  donc un refus **inventé par le prompt**, jamais par le serveur — le même
  piège que le Pack Découverte avait déjà documenté (« À REVIVE »).
- **Fix** : question re-scopée « … **chez Revive** ? » des deux côtés, plus une
  règle d'éligibilité explicite calquée sur celle du Pack Découverte : pratiquer
  ailleurs ne disqualifie JAMAIS ; refus uniquement si (1) la cliente dit
  explicitement avoir pratiqué à Revive, ou (2) le serveur renvoie
  `invitee_not_eligible` ; une phrase ambiguë (« j'ai déjà fait du Pilates »)
  ne suffit pas, pas d'interrogatoire, le doute profite à la cliente.
- **Anti-régression secondaire** : une cliente expérimentée ailleurs garde
  L'Invitée **et** peut réserver directement un cours Sculpt (pas de renvoi en
  Foundation) ; L'Habituée / La Résidente restent proposables en option, jamais
  en remplacement. Précisé aussi que le « never compare with *ailleurs* » du
  prompt est une règle marketing, pas un critère d'éligibilité.
- **Garde-fou** : [test/inviteeEligibilityPrompt.test.ts](test/inviteeEligibilityPrompt.test.ts)
  verrouille le contrat (portée Revive, non-disqualification de l'extérieur,
  deux seuls motifs de refus, pas de downgrade Foundation).

## Livraisons — numéro international + intervention notif client (29 juillet 2026)

Incident Rebecca Sharp : une cliente **+1** (USA) s'affichait **+3018253162** dans
l'admin (indicatif pays perdu) → la confirmation WhatsApp échouait → bandeau
« Confirmation client échouée : appeler le +… » sans moyen de le résoudre. Quatre
correctifs :

1. **Racine** ([wix.ts](src/lib/wix.ts) `wixDeliveryClientFromContact`) : préférer
   `e164Phone` (canonique international) à `primaryInfo.phone` (affichage, qui pour un
   contact étranger omet l'indicatif). Le `+1` (ou tout indicatif) n'est plus perdu.
2. **Message plus clair** ([deliveryPresentation.ts](src/domain/deliveryPresentation.ts)) :
   explique la cause (numéro injoignable / fenêtre 24 h) et l'action (vérifier le numéro,
   appeler, marquer « Cliente prévenue »).
3. **Bouton « ✅ Cliente prévenue »** (carte livraison) → `POST /livraisons/:id/notify-handled`
   → passe les statuts de notif client `failed` à **`manual`** (nouveau `NotifyStatus`),
   ce qui efface l'intervention sans prétendre que WhatsApp est parti.
4. **Éditeur « Corriger la cliente »** (nom + numéro) → `POST /livraisons/:id/client`
   (`updateDeliveryClientContact`) : corrige `client_name`/`client_phone` sur une livraison
   ouverte, ré-arme la confirmation (`created_notify_status='pending'`) vers le bon numéro,
   et rafraîchit le ticket cuisine. Avant, l'éditeur ne changeait que le contact de remise.

Tests : `wixDeliveryClientPhone` (pur) + `deliveryOrders` intégration (notify-handled →
manual, correction numéro → +1 conservé + re-arm, validations). 825 purs verts.

## Commande client par QR — page /commander (28 juillet 2026)

Nouvelle **app client web** (QR dans les vestiaires → `menu.revive.sn/commander`)
qui réutilise 100 % du pipeline café d'Awa. Le client compose son panier (menu
partagé `pickerMenu()`, prix serveur, favoris ⭐, choix multi-groupes → `selections`),
choisit un **mode de service** et **paie en ligne les ARTICLES** (Wave/OM) ; le
webhook vérifié pilote `fulfillCafeOrder` — invariant paiement-d'abord identique.

- **4 modes** : Sur place / À emporter / À venir chercher → **ticket BAR** cuisine
  (heading = prénom saisi, badge 📦 + voix « à emporter » si à emporter) ;
  **Livraison** → **livraison auto-créée** dans /admin/livraisons.
- **Paiement livraison hybride** : articles payés en ligne (`payment_status='PAID'`),
  **frais réglés en espèces au livreur** (`delivery_fee_status='CASH_DUE'`,
  `delivery_fee_xof` = `config.DELIVERY_FEE_XOF` ou NULL si non fixé). Tous les
  textes livraison (staff, départ, page magique livreur, notif client, templates)
  sont **fee-aware** : jamais « ne rien encaisser » sur une livraison web à frais.
- **Idempotence** : `delivery_orders.source_cafe_order_id UNIQUE` + primitive
  `createWebDeliveryFromPaidCafeOrder` (`on conflict do nothing`) → un rejeu de
  fulfillment (bail 2 min / sweep stuck) ne crée JAMAIS 2 livraisons ; échec de
  création → la commande café reste PAID non-fulfilled (le sweep retente).
  POST public idempotent sur `client_request_id`.
- **Prénom figé** : `pending_cafe_orders.customer_name` (le ticket/la livraison
  utilisent le prénom SAISI, pas le nom CRM ; la fiche n'est complétée que si vide).
- **Horaires** : `barOpenNow()` (nouveau `src/domain/openingHours.ts`) lit le
  planning publié du rôle **bar** → **fail-closed** sur endpoint public (pas de
  planning = fermé) ; **Livraison** coupée après `DELIVERY_ORDER_CUTOFF_MIN` (18h).
- **Sécurité** : CSP stricte (boot par `fetch /commander/menu.json`, pas d'inline) ;
  prix jamais dans le POST (recalcul `computeExtras`) ; numéro SN strict
  `^221(7[05678])\d{7}$` ; rate-limit `allowPublicOrder` (IP + numéro) ; URLs de
  retour construites serveur (`COMMANDER_PUBLIC_BASE_URL`), jamais depuis le body.
- **Nouveaux réglages** : `DELIVERY_FEE_XOF` (0 = pas de montant fixe affiché),
  `DELIVERY_ORDER_CUTOFF_MIN` (1080), `COMMANDER_PUBLIC_BASE_URL` (menu.revive.sn).
- **Vitrine + QR** : `menu.revive.sn` gagne un bouton « 🛒 Commander » ; QR
  imprimable A6 dans **/admin/qr-commander** (dépendance `qrcode`).
- **Hors périmètre** : frais en ligne (espèces au livreur), création de livraison
  par Awa WhatsApp (inchangée — le staff saisit toujours ses livraisons), page de
  suivi/notif « prête », EN/wolof.
- Tests : `commandePage`/`deliveryFeeMessages` (purs) + `integration/commandePublic`
  (e2e à emporter/sur place/livraison, idempotence webhook, prénom, horaires
  fail-closed, cutoff, validation, rate-limit). 820 purs + 255 intégration verts.

## Politique annulation / report / transfert (28 juillet 2026)

- Une annulation volontaire, un changement d’avis ou une absence ne déclenche
  plus jamais de remboursement. Le remboursement `PAID → REFUND_NEEDED` reste
  réservé aux paiements que Revive n’a pas pu honorer (créneau perdu, échec
  technique ou faute Revive confirmée).
- À ≥16 h, Awa propose d’abord le report natif vers un autre créneau du même
  cours (`reschedule_booking`) : paiement et places conservés. Le transfert à
  une autre personne est autonome, même à moins de 16 h : aucune intervention
  de la réception, aucune modification Wix ; le remplaçant se présente sous le
  nom de la réservation d’origine. Seul le changement de cours passe par
  `handoff_to_human`, avec la réservation existante laissée intacte.
- Pour une réservation Awa payée directement, `cancel_booking` exige
  `acknowledge_no_refund:true`, uniquement après acceptation explicite du
  client. La place est libérée, le statut devient `CANCELLED` avec
  `forfeited_at`, et aucun dossier de remboursement n’est créé. Une séance
  d’abonnement annulée dans les temps continue d’être re-créditée.
- Une réservation comptoir/site a un mode de paiement inconnu d’Awa : sa
  dernière annulation passe désormais par la réception, sans mutation Wix par
  Awa et sans promesse de remboursement ou de re-crédit.
- Garde supplémentaire : `BOOKED → REFUND_NEEDED` a été retiré de la machine
  d’état. Les paiements conservés restent visibles dans les factures et le
  chiffre d’affaires via `forfeited_at`.
- Régressions : contrat du prompt/outils, machine d’état et intégration
  `cancel_booking` (refus sans consentement, annulation finale sans
  remboursement, ancienne réservation intacte jusqu’au consentement).

## Ops PWA — efficacité cuisine/service (28 juillet 2026)

Audit UX des PWAs cuisine (KDS tablette) et service (accueil iPhone), livré en un
lot front + petit ajout serveur, **sans migration** (colonnes existantes). Bumps
d'assets : cuisine `v11→v12`, service `v12→v13`.

- **[P0] Notes par article visibles en cuisine.** `ExtraLine.note` (« sans sucre »)
  arrivait au ticket mais la carte cuisine et la voix l'ignoraient. Un helper client
  unique (`lineLabel`/`linePicked`) formate choix + note pour la carte, la carte
  compacte, le bandeau et `itemsSpeech()` — corrige au passage la voix qui oubliait
  les options multiples (`selections`).
- **Sous-total indicatif par table** sur la tuile occupée. `OpenSession.total_xof`
  = somme des tickets TABLE non annulés (**servis inclus**, cast `::integer`),
  ré-émis en live via `publishOpenSessionUpdate()` après commande / Servie / annulation
  (seulement si la session survit à l'auto-close). Libellé « Sous-total — indicatif » :
  **le POS reste la caisse**, ce n'est pas une addition finale.
- **Bandeau « À préparer ensemble »** (cuisine) : agrège les préparations réellement
  identiques (signature `id + selections + note normalisée`) présentes dans **≥ 2
  tickets** ouverts distincts → batching.
- **Chip ⭐ Favoris** au composeur service : `cafe_menu_items.favourite` (déjà en DB)
  désormais recopié dans le snapshot (`CafeMenuItem.favourite`) et exposé `fav` par
  `buildServiceMenu` ; catégorie sentinelle `__FAV__`.
- **Cartes READY compactées** (cuisine) : items en une ligne pour dégager l'écran en
  rush — **jamais** un ticket portant une note par article (l'instruction reste lisible).
- **Historique « Récent » (lecture seule, borné au jour)** : bouton 🕐 sur les deux
  apps. Service → tables fermées du jour + leur sous-total (« l'addition » après
  l'auto-close). Cuisine → tickets servis/annulés (recall d'une instruction / annonce
  ratée / litige). Endpoints `GET /ops/{cuisine,service}/recent` (auth par rôle,
  jamais mis en cache par le SW). Aucune action : le board reste forward-only.
- **Annulation locale du « Prête » (cuisine v12→v13).** Un tap « Prête » ne poste
  plus tout de suite : pendant 5 s la carte affiche « ↩ Annuler (N) » (contour ambre).
  Sans annulation → le POST `/tickets/:id/ready` part normalement ; annulé → **rien**
  n'atteint le serveur (pas de changement de statut, pas de fausse alerte accueil).
  100 % client (`startPendingReady`/`commitReady`), l'endpoint et le forward-only sont
  intacts ; un reload ou une annulation SSE (`clearPendingReady`) purge le commit en
  attente. Choisi contre un vrai retour-arrière serveur (qui casserait le forward-only).
- Backlog assumé : « ↻ La même », 86 depuis le téléphone,
  cycle « servie → réglée » (persistance du sous-total jusqu'au paiement). Livraisons
  côté service = hors périmètre (un autre agent y travaille).
- Régression : `test/opsCuisineAssets` + `opsServiceAssets` (marqueurs + version cache)
  et `test/integration/serviceSessions` (total_xof servi/annulé, `session_update`,
  `/state` `fav:true`, `/recent` des deux apps + rejet de rôle). 794 purs + 241 intégration verts.

## Correctif en cours — report direct du même cours (24 juillet 2026)

Le cas Memona a exposé une règle produit erronée : pour déplacer un Aquabike
à plus de 16 h, Awa annulait la résa Wave, mettait le remboursement en file,
puis réclamait un second paiement. Wix propose pourtant le report natif d'une
réservation de cours, qui conserve la réservation, le paiement et les places.

- Nouvel outil `reschedule_booking` : réservation propriétaire + ancien créneau
  ≥16 h + nouveau créneau présenté au client, encore libre, du **même cours**.
  Il appelle `POST /_api/bookings-service/v2/bookings/{id}/reschedule` avec la
  révision Wix et le nouvel `eventId`; aucun `cancel_booking`, aucun lien et
  aucun remboursement.
- Applicable aux résas Awa (Wave/OM/Max It/abonnement) et aux résas
  comptoir/site : celles-ci sont revalidées sur la fiche Wix du numéro avant
  mutation. Les résas Awa mettent ensuite à jour la même ligne locale en
  conservant statut `BOOKED`, paiement, montant, participants et extras.
- Changement de cours = hors du report direct : handoff réception, ancienne
  réservation laissée intacte pour préserver sa valeur. Échec d'un report Wix
  = ancienne résa inchangée.
- Régression : `test/integration/rescheduleBooking.test.ts` vérifie le report
  Wave direct, la garde 16 h et le refus inter-cours. Le remboursement déjà
  créé pour Memona reste à traiter : elle a effectivement payé une seconde
  réservation avant ce correctif.

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
phone_number_id 1175926012276896). Tests : **586 unitaires** (`npm test`, rapides,
sans réseau) + **131 d'intégration** sur Postgres réel jetable, dont les chemins de paiement Wave + OM, les livraisons, la santé DB et les escalades de liaison
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
| Annulation par Awa (règle 16h) | ✅ 28/07 | report même cours ou transfert proposés d’abord ; abonnement → re-crédit ; paiement direct → non remboursable avec accord explicite |
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
                      BOOKED→CANCELLED ; REFUND_NEEDED n’est accessible que depuis PAID ; REFUND_NEEDED→REFUNDED.
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
8. **Annulation par Awa (mis à jour 28/07)** : outil `cancel_booking`, ≥ 16h
   avant le cours (recalculé côté serveur). Awa propose d’abord un report du
   même cours ou un transfert. Abonnement → revert automatique du crédit ;
   paiement Awa (Wave/OM/Max It) → annulation non remboursable uniquement après
   accord explicite (`acknowledge_no_refund:true`), statut `CANCELLED` +
   `forfeited_at`. Les résas comptoir/site restent intactes et passent en
   handoff car Awa ne connaît pas leur mode de paiement. < 16h → refus poli, sans
   JAMAIS suggérer d'exemples d'excuses valables (consigne explicite de
   Babakar). Transfert = autonome, sans modification Wix, sous le nom de la
   réservation d'origine ; changement de cours et annulations partielles =
   handoff sans annuler la réservation. Aucun `BOOKED → REFUND_NEEDED` : ce dernier
   statut est réservé à un paiement que Revive n’a pas pu honorer.
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
      **Résolu (13/07)** : login fallback en dur `revive`/`revive@5000` quand
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
    `test/notificationRules.test.ts` (30 cas).

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

- **4.40 — Refonte UI de l'admin (17/07).** Design system aux couleurs Revive
  dans le CSS partagé (`admin/layout.ts`, seule feuille de style) : tokens
  `:root` (fond crème `#faf7f2`, violet marque `#6b4a6f` = celui des
  reçus/devis/cartes cadeaux, 4 niveaux de texte, sémantiques vert/rouge/ambre
  réservés aux statuts), sidebar **aubergine** avec état actif violet, topbar
  affinée, favicon 🤖. Composants : cartes, stats (chiffres tabulaires), tables
  (th uppercase, hover), badges par classes (`badge--gray/violet/red/amber/
  blue/green` — `helpers.badge()` mappe les statuts), boutons `.act` violet +
  variantes `--sm/--danger/--ghost`, styles de base des inputs natifs (focus
  ring violet, `accent-color`), bulles de chat d'Awa en violet doux, bannière
  `.card.success`, utilitaires `.row/.between/.col/.actionbar/.nowrap/.right`.
  - **Sweep inline → classes** dans les 10 pages (~277 `style="…"` → il en
    reste ~180, uniquement du layout ponctuel : widths/margins) : suppression
    des 4 `const INPUT`, boutons/badges/bannières unifiés, `.actionbar` sticky
    (factures/devis), page login au violet. Pages print (factures/staff) :
    CSS locaux autonomes non touchés.
  - **Vérification par screenshots réels** (rendu statique des `renderX()` +
    `layout({badges})` sans DB → Chrome headless) : dashboard, conversation,
    livraisons, menu (vue + édition inline), devis, desktop + mobile 390px.
    Fix mobile : `.card{overflow-x:auto}` (tables défilent dans la carte).
  - Aucun changement de routes, de champs de formulaire ni de logique ;
    JS client existant conservé (confirm, totaux live, drag&drop staff).
  - **v2 (feedback gérant, même jour)** : (a) fix hover illisible — la règle
    `main a:hover` gagnait sur la couleur des liens-boutons `<a class="act">`
    (le hover ne redéclarait que le fond) → chaque état hover de chaque
    variante redéclare désormais SA couleur, et `main a` exclut `.act` ;
    (b) **langage de couleurs par rôle** : violet = action principale
    (créer/enregistrer/envoyer), **vert `.act--ok`** = confirmation d'un fait
    (✅ Traité, Remboursement effectué, Abonnement activé, Prête, Livrée,
    Activer, Remettre au menu), ghost = secondaire/écarter (Ignorer, Modifier,
    Test, Pause, Imprimer, Renvoyer…), rouge = destructif (✕, ✖ Annuler
    livraison). `livraisonsPage.inlineForm` prend un param `variant` ; boutons
    de tables densifiés en `.act--sm` ; disabled via `:disabled` (plus
    d'opacity inline) ; transitions 150 ms. Vérifié par galerie de composants
    (états normal + hover simulés en dur) + screenshots.

- **4.41 — Admin premium, task-first et mobile (20/07).** Deuxième passe de
  fond sur **tout** `/admin`, sans toucher aux routes, requêtes ni actions
  métier. Le langage Revive reste crème/aubergine mais gagne une hiérarchie
  éditoriale, des surfaces plus calmes et une UX opérationnelle cohérente.
  - **Fondation isolée** : `adminStyles.ts` contient désormais tokens, shell et
    composants, alignés sur les mauves officiels Revive (`#7c547d` principal,
    `#a98baa` accent) ; `adminClient.ts` contient l’amélioration progressive.
    `layout.ts` reste le contrat SSR zéro build front/zéro dépendance runtime et
    accepte largeur, sous-titre, actions et fil d’Ariane sans casser ses appels.
  - **Navigation orientée tâches** : 6 groupes stables (Aperçu, Clients, Studio,
    Documents, Bar, Configuration), icônes SVG homogènes, état actif explicite,
    sidebar repliable mémorisée, recherche client globale (`Cmd/Ctrl+K`). À
    ≤900 px, vrai drawer avec scrim, `aria-expanded`, Escape, focus piégé puis
    restauré ; `prefers-reduced-motion` est respecté.
  - **Accueil opérationnel** : `/admin` n’est plus une collection de tables mais
    une file priorisée. Remboursements/activations, interventions humaines,
    CRM et incidents livraison sont des tâches avec action visible ; états vides
    calmes ; statistiques reléguées après le travail à faire.
  - **Composants et sécurité UX** : cartes, stats, tables, badges, champs,
    boutons, en-têtes, filtres, empty states et pages login/unlock harmonisés.
    Focus visible global ; modale de confirmation progressive via `data-confirm` ;
    formulaires désactivés après soumission pour éviter le double clic. Aucun
    changement d’autorité serveur : calculs et validations restent côté backend.
  - **Lisibilité renforcée (20/07)** : corps global à 16 px / interligne 1,6,
    texte secondaire à 14 px et `#665c68`, tableaux à ~15 px, labels/boutons à
    14 px, descriptions à 15 px et titres de page à 26 px. La réduction du corps
    à 14 px sur mobile est supprimée. Surfaces « papier chaud » (`#f5efe9` fond,
    `#fbf7f2` cartes, `#fefbf7` champs) à la place du blanc pur pour réduire
    l’éblouissement ; les documents print autonomes sont exclus.
  - **Passe complète des écrans** : conversations, réservations/commandes,
    handoffs/reviews/CRM, factures/devis/cartes cadeaux, livraisons/menu,
    planning staff, paiements coachs, notifications, profil WhatsApp et checklist.
    Les tables critiques ont un comportement mobile explicite ; la grille staff
    conserve le drag-and-drop mais gagne clavier (Entrée/Espace), Escape et retour
    de focus. Les documents print autonomes conservent leur CSS et leur géométrie.
  - **Régression** : `test/adminUi.test.ts` couvre structure/a11y/échappement du
    shell et les états urgent/vide de l’accueil. Vérification de livraison :
    `npm run build`, suite `npm test`, `git diff --check`.

- **4.42 — Fiches recettes internes du menu bar (20/07).** `/admin/menu` devient
  un catalogue recherchable avec filtres statut/catégorie/recette et compteurs de
  complétude. L’ajout et l’édition quittent le tableau compact pour des fiches
  dédiées (`/admin/menu/new`, `/admin/menu/items/:id`) contenant nom, prix,
  catégorie, description commerciale, incontournable, ingrédients/quantités et
  étapes de préparation. L’ancien `?edit=ID` redirige vers la fiche.
  - Deux colonnes nullables et idempotentes (`recipe_ingredients`, `recipe_steps`),
    5 000 caractères chacune. Recette facultative : badge « complète » seulement
    si les deux champs sont présents ; un manque ne bloque jamais la vente.
  - **Séparation stricte** : les recettes vivent dans `MenuItemView`/DB mais sont
    volontairement omises de `CafeMenuRow`, `CafeMenuItem`, `rowToSnapshot`, du
    prompt d’Awa, des listes WhatsApp et des formulaires client/livraison.
  - Retirer/restaurer conserve la recette. L’ancien seed `cafe-menu.md` ne remplit
    que les champs commerciaux ; les recettes se complètent progressivement dans
    l’admin. Couverture pure (validation, filtres, rendu/échappement, non-fuite)
  et intégration CRUD/routes/migration.

- **4.43 — Authentification admin par rôles, sans double mot de passe (20/07).**
  `/admin/login` accepte désormais deux catégories de comptes dans une seule
  session signée de 30 jours : `ADMIN_USERS` pour l’équipe restreinte, et
  `OWNER_ADMIN_USER` + `OWNER_ADMIN_PASSWORD` pour le propriétaire avec accès
  total. Le rôle est signé dans le cookie et vérifié côté serveur à chaque
  requête. Toutes les pages, mutations et PDF de `/admin/paiements-coachs`
  exigent le rôle propriétaire ; un compte équipe reçoit un refus 403 avec une
  action claire « Changer de compte ». Suppression du cookie financier 8 h,
  de l’écran `/unlock` et des boutons « Verrouiller » : une seule connexion
  propriétaire suffit. `OWNER_PAYMENTS_PASSWORD` reste provisoirement accepté
  comme fallback de migration pour ne pas casser l’accès au déploiement.

- **4.44 — Copie d’une semaine entre employées (20/07).** Dans la grille
  `/admin/staff`, chaque ligne propose « Copier depuis… ». La source est choisie
  parmi les autres employées du planning ouvert ; après confirmation, les sept
  jours de la destinataire sont remplacés exactement, repos compris. La copie
  travaille dans l’état navigateur courant (donc inclut les modifications non
  enregistrées), clone chaque créneau, recalcule grille/totaux/effectifs et
  réutilise le bouton « Enregistrer » existant. Aucun nouveau endpoint ni schéma.

- **4.45 — Awa se désengage d’un contact non sérieux / suggestif (24/07).**
  Un contact (+221752208766) envoyait des messages suggestifs sans intention
  studio ; Awa n’avait aucune règle et continuait à répondre. Nouveau mécanisme
  **auto-déclenché par Awa**, calqué sur le relais humain (`human_takeover_until`
  gaté dans [index.ts](src/agent/index.ts)) mais distinct : le relais = *un
  humain répond* ; le désengagement = *personne ne répond, Awa s’arrête*.
  - Colonnes `awa_disengaged_until/_at/_reason` sur `clients` ([schema.ts](src/db/schema.ts)).
    `isAwaDisengaged` ([adminOperations.ts](src/domain/adminOperations.ts)) miroir
    de `isHumanTakeoverActive`. Auto-release ~24 h.
  - **Gate silencieux** dans [index.ts](src/agent/index.ts) juste après le gate
    relais humain, et dans les 3 handlers média (image/vocal/média non lu) :
    `if (isAwaDisengaged(client)) return;` — le tour entrant reste persisté
    (visible en admin), **aucune notification équipe** (décision produit :
    « silencieux pour l’équipe »).
  - **Outil `disengage_conversation`** ([tools.ts](src/agent/tools.ts)) : Awa
    l’appelle quand un contact est clairement là pour draguer/jouer avec le bot
    sans intention de réservation, puis envoie UNE ligne polie et ferme de
    recentrage, et rien après. Barre HAUTE (prompt) : pas pour une phrase isolée
    ambiguë, un compliment, ni un client qui drague MAIS a un vrai besoin (on
    sert le besoin, on ignore la drague). Aucun scolding/moralisation.
  - **Admin** : badge « Awa en pause » (liste + espace client), bouton **Mettre
    en pause** (route `/disengage`, `startAwaDisengage`, 24 h) pour couper un
    contact tout de suite sans attendre la re-détection, et **Rendre à Awa**
    (`resumeAwa` étendu pour effacer les deux états). Remédiation immédiate pour
    +221752208766.
  - Tests : `isAwaDisengaged` (bornes), enregistrement de l’outil.
  - Livré seul sur `main` (branche `fix/awa-disengage`), **séparément** de la
    feature ops-cuisine-pwa (pas encore prête à merger).

- **4.46 — Post-mortem conversation « Salma » (24/07) → 4 correctifs.**
  Cliente Salma (+221771692109, entrée organique « Salam ») : elle veut payer le
  Pack Découverte, finit **plantée sans lien**, réception jamais prévenue sur
  WhatsApp. Analyse en DB prod (`conversations`, `notification_log`, `handoffs`)
  + logs Railway. Quatre défauts, quatre fixes (worktree `reception-notify-hardening`) :
  - **Fix 1 — notifs réception jetées en silence (le vrai drame).** Le handoff
    « client planté » partait en **texte libre** ; la fenêtre 24 h de la réception
    avec le numéro du bot est ~toujours fermée (elle *reçoit* d’Awa, n’écrit pas au
    bot), donc Meta acceptait (200) puis **droppait en asynchrone** (131047,
    `deliveryPing=0`) — seul l’e-mail passait. `notifyReception` passe désormais
    **`preferTemplate: true` par défaut** ([notify.ts](src/lib/notify.ts)), ce qui
    couvre handoff, échec technique, relais humain et tous les autres appels d’un
    coup (le mécanisme template-first existait déjà, cf. 131047).
  - **Fix 2 — Awa a créé un lien pour le MAUVAIS plan.** Conversation qui saute du
    Pack Découverte à l’Aquabike → `create_plan_payment_link` appelé avec le
    plan_id **Aquafitness 80 000 F** (le serveur validait : plan réel, prix
    catalogue). Nouveau param **requis `plan_name_confirm`** + garde serveur
    `planNamesConflict` ([planNameGuard.ts](src/domain/planNameGuard.ts)) : si l’id
    et le nom confirmé divergent → `plan_mismatch`, pas de lien. Prompt : toujours
    passer id+nom de la MÊME ligne list_plans, et ne jamais dire « j’ai envoyé un
    lien » sans en avoir réellement envoyé un.
  - **Fix 3 — incident actif indépendant : sweep cuisine planté chaque minute.**
    `kitchen_tickets` (chantier livraisons) créée en prod avant l’ajout de
    `heading/subheading` → `create table if not exists` ne les posait pas → 42703
    en boucle. `alter table ... add column if not exists` de rattrapage
    ([schema.ts](src/db/schema.ts)). **Livré en premier, seul.**
  - **Fix 4 (petit) — 1 retry sur hoquet transitoire du prestataire de paiement.**
    `withTransientRetry` ([retry.ts](src/lib/retry.ts)) autour de la création de
    session Wave/OM ([paymentSession.ts](src/domain/paymentSession.ts)) : une
    session est sûre à recréer (un premier essai échoué ne rend aucun lien). Évite
    « service temporarily unavailable » → handoff immédiat. NB : si le transitoire
    est une *lecture Wix*, le bon durcissement uniforme serait au niveau `wixGet`
    (lectures idempotentes) — laissé en suivi, pas de retry sur `wixPost`/écritures.
  - Tests purs : `planNameGuard`, `retry`. Le suite n’utilise **aucun `vi.mock`**
    (tests sans réseau) → Fix 1 vérifié en prod (un handoff test doit journaliser
    `sent_template` pour +221784644329, plus jamais `failed/131047`).
  - **Suivi ouvert** : Salma attend depuis 14:20 (créneau repéré ven 31/07 18:15
    Foundation) ; 2 handoffs `OPEN` — la réception doit la recontacter.

## 5. Chronologie condensée

- **23/07 — Pack Découverte : friction minimale (annuler après coup > bloquer).**
  Déclencheur : cas Barbara (23/07). Elle demande le pack puis un cours Sculpt ;
  Awa lui répond que Sculpt exige « 3 cours **chez nous** » (invention — la règle
  ne dit que « après 3 cours »), Barbara réplique « Si j'ai déjà fait », Awa en
  déduit *Pilates à Revive* et lui refuse le pack → à-la-carte 12 000 F. Or du
  Pilates fait **ailleurs** ne disqualifie NI du pack NI de Sculpt. Décision de
  Babakar : côté conversation, Awa ne refuse le pack QUE si (1) le client dit
  **explicitement** avoir fait du Pilates **à Revive**, ou (2) le serveur renvoie
  `discovery_not_eligible` ; toute phrase ambiguë (« j'ai déjà fait du Pilates »)
  = on vend sans questionner, la réception annulera après coup si besoin. Sculpt
  accepte l'expérience faite ailleurs (sur simple déclaration) — un client
  expérimenté peut prendre le Pack Découverte ET réserver Sculpt directement.
  **Changement prompt uniquement** ([business-info.md](business-info.md) §
  niveaux + § découverte) : le garde-fou serveur `discovery_not_eligible`
  ([tools.ts:1637](src/agent/tools.ts#L1637)) reste **inchangé** — il ne lit que
  les bookings Pilates Revive, donc le Pilates ailleurs y est déjà invisible.
- **19/07 — Factures : Awa émet de vraies factures, et tout part en PDF
  (`764fbb1` + ce commit).** (a) `send_receipt` → **`send_invoice`** : demande
  client reçu/justificatif/facture = facture RÉELLE du registre
  `/admin/factures` (numérotation FAC-YYYY-NNNN partagée avec la réception).
  Une facture par paiement (`findInvoiceBySource` — redemander renvoie le MÊME
  numéro) ; `company` pour facture entreprise (nouveau numéro si la société
  change) ; `missing_client_name` → le modèle demande le nom (`client_name`,
  sauvegardé). Handoff facture réservé aux mentions légales spéciales /
  paiements hors liste (>90 j, comptoir). (b) Sur demande gérant, layout calqué
  sur les factures Wix (page blanche, bande tableau bleue, Sous-total / Taxes /
  Total / Montant payé / Reste à payer) et **envoi en PDF joint**
  (`invoicePdf.ts` pdfkit + `sendDocument` type document, nom de fichier
  `Facture-FAC-….pdf`) — pour Awa ET le bouton Envoyer de `/admin/factures`.
  La page print HTML suit le même layout. `invoiceImage.ts` (PNG) n'est plus
  branché sur les factures.
- **19/07 — Interrupteur global alertes staff (`c316966`).** Bouton ⏸️/▶️ en
  tête de `/admin/notifications` : pause TOUTES les règles d'un clic (flag
  `staff_alerts_paused` en `app_state`, gate en tête de sweep — rien n'est
  claimé pendant la pause). Demande gérant après le fix ci-dessous : ne pas
  déclencher les premières alertes sans prévenir le staff. **État laissé :
  pause ACTIVE, les 2 règles enabled** — pour démarrer les envois, un seul
  clic sur « ▶️ Activer les alertes ».
- **19/07 — Fix CRITIQUE rappels staff : aucune alerte n'était jamais partie
  (`d30fcc0`).** Les 2 règles de `/admin/notifications` (« Aquabikes à l'eau »
  30 min avant au gardien +224 [numéro guinéen VOULU], « Effectif coach » 3h
  avant hors Reformer) échouaient à CHAQUE sweep depuis le 14/07 : l'index
  unique sur `notification_log.dedup_key` est PARTIEL (`where dedup_key is not
  null`) et le `ON CONFLICT (dedup_key)` du claim ne répétait pas le prédicat →
  Postgres 42P10 avant tout envoi, erreur avalée par le try/catch de la boucle,
  journal admin VIDE (piège : l'échec était invisible partout sauf `railway
  logs`). Fix une ligne (`notificationRepo.ts:claimOrReclaim`) + test
  d'intégration de régression (`notificationClaim.test.ts`). Vérifié aussi :
  Wix a les téléphones de tous les coachs sauf **Lamine** (Fusion) — à créer
  dans Wix sinon ses alertes feront `failed` (visible au journal désormais).
- **19/07 — Handoff inversé : la réception écrit AU client (`ffad537`).**
  Feedback gérant (cas hernie discale) : le client ne doit plus rien envoyer.
  `handoff_to_human` ne retourne plus de lien wa.me au client — Awa le rassure
  (« la réception va te recontacter ici ») et la notif réception contient un
  lien 1-clic vers le client avec message prérempli à la voix de la réception
  (`clientOutreachLink`, `receptionContact.ts`). ~12 consignes du prompt
  alignées. INCHANGÉS volontairement (lien immédiat conservé) : annulation résa
  studio (remboursement), échec post-paiement, fallback technique.
- **19/07 — Journal notif : source `new_chat` (plus `reception`) pour le ping
  owner.** Le ping « Nouvelle conversation » part bien uniquement vers
  `NEW_CHAT_NOTIFY_PHONE` (Babakar), mais était journalisé via
  `recordReceptionLog` → colonne Source = `reception` alors que la réception
  n'était pas contactée. Correctif : `recordNewChatLog` (`source='new_chat'`) +
  libellés FR dans `/admin/notifications` (réception / nouvelle conv / …).
  Anciennes lignes historiques restent `reception` en DB ; seuls les nouveaux
  pings sont corrects. Livraison inchangée.

- **18/07 — Numéros équipe/test + campagne `new_slots` (`9b7c911`).**
  (a) `clients.is_test` : badge « 🧪 Équipe » + bascule sur la fiche
  conversation, plus de ping « nouvelle conversation » au gérant pour l'équipe,
  à EXCLURE de toute audience de campagne. 5 seedés : Baba, Meryl, Réception,
  Linsey, Syndel. (b) Template Meta **`new_slots`** (Marketing, langue `en`,
  corps FR, 2 variables : cours + créneaux) créé et approuvé — réutilisable
  pour annoncer de nouveaux créneaux. Envoyé à 6 clientes à la demande
  Foundation non servie (nouveaux créneaux Ven 16h15/17h15/18h15, coachs
  Leslie/Yass/Leslie) ; chaque envoi journalisé comme tour assistant pour le
  contexte d'Awa. Piège découvert : `WA_WABA_ID` en env Railway pointe un WABA
  de TEST (templates sample uniquement) — le vrai est « Revive »
  `1738439110507790` (via business 778192040138434) ; l'envoi n'en dépend pas
  (phone_number_id suffit).

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
- **Activation abonnement pour NOUVEAU client (13/07, décision historique
  supersédée le 28/07).** Contrainte (§11) : l'API offline `createOfflineOrder`
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
  manuel réception. **Cette conclusion n'est plus la règle produit** : l'e-mail
  Wix est désormais accepté et annoncé, et le provisioning self-service du
  28/07 ci-dessous remplace ce no-go. Détails actuels :
  `PLAN-PACK-DECOUVERTE-ACTIVATION.md`.
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
  jamais la réponse). 5 tests `conversationStart`. Journal : `source='new_chat'`
  (corrigé 19/07 — avant réutilisait `recordReceptionLog` → faux label
  « reception »). Fichiers : [notify.ts](src/lib/notify.ts),
  [index.ts](src/agent/index.ts), config, repo, `.env.example`.
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
  `revive`/`revive@5000` quand `ADMIN_USERS` est vide — plus jamais ouvert sans
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

### 6.5 Admin — espace client et relais humain (20/07/2026)

- [x] File partagée **Suivi clients** : handoffs + conversations à reprendre,
  filtres/pagination, résultat de clôture obligatoire et note facultative.
- [x] URL conversation conservée mais enrichie en espace client : fil WhatsApp,
  suivis ouverts, réservations, abonnements, bar/livraisons et documents liés.
- [x] Relais humain sûr : pause Awa explicite, reprise manuelle ou automatique
  après 12 h, fenêtre WhatsApp 24 h, envoi idempotent et échecs visibles.
- [x] Rapport 1/7/30 jours, drill-down des stats et journal propriétaire des
  mutations.
- [x] Réponses humaines WhatsApp activées en production le 20/07 :
  `ADMIN_HUMAN_REPLY_ENABLED=true` sur Railway. L'équipe doit d'abord prendre
  le relais (Awa est alors suspendue 12 h) ; le texte libre est limité à la
  fenêtre Meta de 24 h et les envois sont idempotents. Hors fenêtre, un template
  approuvé reste nécessaire via `WA_ADMIN_FOLLOWUP_TEMPLATE`.
- [x] Mode local sur données réelles ajouté : `npm run dev:prod-db:check` teste
  la connexion et `npm run dev:prod-db` lance le hot reload avec l'URL publique
  PostgreSQL Railway. Seule la base prod est injectée ; les workers périodiques
  locaux sont désactivés pour éviter les doubles expirations/notifications.
- [x] Déployé via le commit `3072ca8` ; Railway `SUCCESS`, `/healthz` et
  `/admin/login` en HTTP 200. Validation avant push : build TypeScript, 461
  tests unitaires et 85 tests d'intégration réussis.

### 6.6 Réservations Awa — nom CRM + commande Wix (20/07/2026 — déployé, suivi Wix en cours)

- [x] Le nom canonique de la fiche contact Wix est maintenant prioritaire lors
  de la réservation : un nom WhatsApp/modèle réduit à `L` ne remplace plus
  `Habott Lina`. Le nom complet est aussi resynchronisé dans l'admin local.
- [x] Le checkout externe Wave/Orange Money/Max It suit désormais la dernière
  étape Wix documentée : après confirmation de la réservation, création de
  l'ordre eCommerce lié au booking puis ajout du paiement déjà encaissé comme
  transaction offline `APPROVED`. Les réservations abonnement restent sur le
  ledger Benefit Programs et ne créent pas un ordre par séance.
- [x] Synchronisation post-`BOOKED` isolée du remboursement, avec lease,
  recherche par `externalOrderId`, contrôle des paiements existants et reprise
  automatique des réservations des dernières 48 h. Une panne Orders ne peut
  donc ni annuler la place ni produire un double paiement au retry.
- [x] Vérification locale du correctif initial : build, 458 tests unitaires et
  17 tests d'intégration Wix/Wave ciblés ; scénarios dédiés nom `L` →
  `Habott Lina`, ordre/paiement Wix et panne Create Order réparée sans nouvelle
  réservation. Les hotfixes suivants ont aussi repassé le build, 3 tests
  unitaires ciblés et les 17 tests d'intégration.
- [x] Déployé sur `main` : `df3a63b` (nom + ordre/paiement), `b6f78bd`
  (`taxDetails` à 0 requis par Create Order), `45fdff4` (une seule reprise de
  commande par cycle) et `b3ef6a2` (appels eCommerce espacés de 1,25 s).
  Railway `SUCCESS` sur `b3ef6a2` et `GET /healthz` → `{"ok":true}`.
- [x] Permission Orders effectivement atteinte : les appels Search/Create
  Order sont acceptés par l'authentification Wix (aucun `403`) ; la première
  sonde live a renvoyé une validation `400` sur la taxe, désormais corrigée.
- [ ] **État live restant au 20/07, 20:53 UTC :** Wix répond encore
  `429 RATE_LIMITED` sur `POST /ecom/v1/orders`, y compris avec une seule reprise et
  les appels espacés. Tant que Wix ne libère pas ce quota d'écriture, une résa
  payée future peut encore afficher « Aucune commande créée ». La place reste
  `BOOKED` et confirmée ; seule la fiche eCommerce/paiement manque et le worker
  la réessaie automatiquement, une commande à la fois.
- [ ] Contrôle manuel restant : vérifier Habott Lina dans l'admin et dans Wix
  lorsque le quota Orders est libéré. Sa réservation déjà créée avec `L`
  affiche encore ce libellé historique mais EST réparable (cf. 6.6bis) ; les
  nouvelles réservations prennent le nom canonique de la fiche contact Wix.

### 6.6bis Cas d'étude « A » (Amy Ndiaye) — réparation d'un booking sans fiche contact (21/07/2026)

- **Le cas** : première cliente (tél. +221777406410), profil WhatsApp « A »,
  paie sa 1ʳᵉ séance AVANT d'avoir donné son nom (20/07 22:28 UTC). Aucune
  fiche contact Wix n'existait à ce moment → le garde-fou « nom CRM d'abord »
  (6.6) n'avait rien à quoi se raccrocher → booking Wix créé
  `{firstName:"A"}` sans `contactId`. Deux minutes plus tard elle donne
  « Amy Ndiaye » + email, la fiche Wix est créée : ses réservations 2 et 3
  sont correctes, la 1ʳᵉ restait orpheline sous « A ».
- **Découverte API** : `PATCH https://www.wixapis.com/bookings/v2/bookings/{id}`
  fonctionne (NON documenté — absent du Writer V2 public) avec
  `{booking:{revision:"<rev courante>", contactDetails:{contactId, firstName,
  lastName, phone}}}` → 200, revision incrémentée, statut/paiement/participants
  intacts, booking rattaché à la fiche. Vérifié live le 21/07 ~23:02 UTC :
  les 3 réservations d'Amy sont désormais « Amy Ndiaye » avec `contactId`.
  La `revision` se lit via `POST /_api/bookings-reader/v2/extended-bookings/query`
  (le GET `/bookings/v2/bookings/{id}` n'existe pas → 404).
- **Habott Lina réparée aussi** (21/07) : ses 2 bookings « L » (Reformer
  Sculpt 20/07) avaient déjà un `contactId` mais le libellé tronqué — même
  PATCH, désormais « Habott Lina » dans Wix.
- **Backfill auto livré** (21/07) : `src/domain/bookingContactBackfill.ts` —
  décision pure `planBookingContactRepairs` (testée) + orchestrateur
  `backfillBookingContacts` qui ne lève JAMAIS (PATCH non documenté = échec
  non fatal, juste loggé). Périmètre : bookings BOOKED des 60 derniers jours
  avec `wix_booking_id`, max 25, rattachés dès que la fiche diverge (contactId
  manquant OU libellé ≠ nom canonique de la fiche). Deux déclencheurs,
  fire-and-forget : `submit_verification_code` (fiche prouvée/créée — cas Amy)
  et post-BOOKED dans `fulfillment.ts` quand un contact est résolu (hors du
  try/catch refund, une panne de backfill ne peut pas rembourser). Helpers
  Wix : `getBookingContactSnapshots` + `updateBookingContactDetails`.

### 6.7 Sprint conversion réservations — instrumentation et quick wins (20/07/2026)

- [x] Flux interne append-only `booking_funnel_events` + parcours corrélés
  `booking_funnel_journeys` : disponibilité demandée, créneaux montrés / aucun
  créneau, sélection, lien créé, paiement vérifié, réservation Wix, expiration,
  relance, handoff et échec technique. Fermeture sur réservation/handoff/échec
  ou après 24 h d'inactivité. Métadonnées opérationnelles uniquement : aucun
  transcript ni lien de paiement. Les numéros `clients.is_test` sont marqués à
  l'écriture et exclus à nouveau à la lecture des métriques.
- [x] Événements de paiement/réservation émis par les transitions serveur après
  webhook Wave signé ou lookup Orange Money/Max It vérifié. Un échec Wix après
  paiement reste `REFUND_NEEDED`, notifie client + réception et apparaît dans
  `/admin/conversion`; un `PAID` non finalisé y apparaît aussi immédiatement.
- [x] Backfill idempotent des étapes historiques observables depuis
  `pending_bookings` : lien créé, expiré, réservé, plus les remboursements à
  reprendre. Les étapes pré-lien ne sont pas inventées rétroactivement.
- [x] Quick wins : une fenêtre vide déclenche automatiquement UNE recherche sur
  les 7 jours suivants et renvoie les alternatives dans la même réponse ; un
  créneau rempli/périmé avant le lien renvoie des alternatives fraîches ; le
  dernier moyen de paiement de cours réussi passe en premier sans jamais être
  auto-sélectionné ; après création du lien, le message est limité au cours,
  montant, expiration et lien. La relance d'expiration one-shot est maintenant
  reliée jusqu'à la réservation récupérée.
- [x] Dashboard `/admin/conversion` : conversion 7/30 j, tunnel par étape,
  lien→réservation par moyen de paiement, récupération des expirations, top
  codes d'échec, paiements à reprendre et liens directs vers les conversations.
- [x] Validation automatisée : build TypeScript, 469 tests unitaires et 91
  tests d'intégration réussis (Wave, Orange Money/Max It, abonnement, capacité,
  fenêtre vide, créneau périmé, expiration, doublons et panne Wix après paiement).
- **Baseline au déploiement** : aucune valeur pré-lien fiable avant cette
  instrumentation. Le backfill permet seulement le taux historique
  lien→réservation et les expirations. Ne pas publier de faux taux global ; la
  première baseline complète sera figée après **30 parcours réels ou 30 jours**.
- **Plus grande fuite observée** : non encore statistiquement déterminable au
  moment de la livraison (0 parcours pré-lien instrumenté). Les incidents
  payés mais non réservés restent P0 sans attendre le seuil ; les deux fuites
  conversationnelles déjà connues (fenêtre vide et créneau rempli avant lien)
  ont motivé les alternatives serveur immédiates.
- **Décision produit résultante** : ne pas élargir les fonctionnalités avant la
  revue du premier échantillon. Prioriser la plus forte chute mesurée dans le
  tunnel et viser au moins **+10 % relatif** sur lien→réservation ; conserver la
  séparation entre qualité de service (un `dropoff` volontaire n'est pas un
  échec) et conversion commerciale (il n'est pas une vente).
- [ ] Recette appareils réels encore à exécuter : trois rails de paiement,
  groupe/capacité, expiration→relance→réservation, solde abonnement et réservation
  studio. Les scénarios détaillés sont ajoutés à `/admin/tests`; le cas
  paiement confirmé→panne Wix doit être joué seulement sur l'environnement de
  recette avec un petit montant.

### 6.8 Admin — fil de conversation en direct, sans recharger (20/07/2026)

- [x] La page `/admin/conversations/:clientId` rafraîchit désormais le fil de
  messages toute seule : un script embarqué interroge toutes les ~3,5 s le
  nouvel endpoint `GET /admin/conversations/:clientId/thread` (JSON
  `{ sig, html }`, protégé par le même hook d'auth admin). Le serveur rend le
  fragment HTML avec le `timeline()` existant — aucune duplication du markup
  côté client.
- [x] Signature de changement (`threadSignature`, `clientWorkspacePage.ts`) :
  hash des `created_at` + `delivery_status` + `error` de chaque tour. Elle
  capte les nouveaux messages ET le passage « Envoi… » → envoyé/échec des
  réponses humaines. Sig identique → `html: null` (réponse quasi gratuite).
- [x] Choix délibérés : polling léger plutôt que SSE/WebSocket (aucun bus
  d'événements dans l'app, inserts SQL directs) ; seul le `<section id="thread">`
  est remplacé → le texte du composer et la position de scroll survivent ;
  pause quand l'onglet est masqué ; backoff ×2 jusqu'à 30 s sur erreur ;
  auto-scroll bas uniquement si l'utilisateur y était déjà.
- [x] Piège vérifié en intégration : la signature se calcule sur les DONNÉES,
  pas sur le HTML rendu — les formulaires « Réessayer » embarquent un
  `request_key` UUID aléatoire qui changerait le HTML à chaque rendu.
- [x] Tests : `test/clientWorkspaceThread.test.ts` (signature pure + rendu) et
  `test/integration/adminThreadPoll.test.ts` (401 poller JSON, 404, no-op sur
  sig inchangée, nouveau message, flip pending→sent, script présent sur la page).

### 6.9 Revue conversation Amy Ndiaye → 8 correctifs UX (20-21/07/2026)

Revue de la conversation réelle d'Amy Ndiaye (20/07 22:22-22:38 : 3 séances
Bébé Nageur payées Wave pour sa fille de 3 ans, mais 5 demandées — plan resté
incomplet en silence). Correctifs livrés :

- **Cap 24h sur l'offre bar post-paiement** : colonne `clients.cafe_offer_at`
  + claim atomique `repo.claimCafeOffer` dans `sendCafeMenuOffer` (les DEUX
  flux, Wave + abonnement). Amy avait reçu 3 fois la même liste en 12 min.
- **Prompt — requêtes multi-séances** (nouvelle section systemPrompt) :
  « N séances » = N dates différentes à 1 participant (jamais N places/N
  personnes) ; `list_plans` d'abord (un carnet ≈ N séances = 1 paiement) ;
  liste de dates convenue et récapitulée, liens numérotés « séance 2/5 » ;
  après chaque ✅ paiement, la réponse suivante enchaîne sur le lien de la
  date suivante sans re-demander ; interdiction de promettre un envoi
  automatique post-paiement ; jamais clore un plan incomplet en silence
  (Awa avait promis « je cherche plus loin pour les 3 autres » puis plus rien).
- **Prompt — registre tu/vous** : miroir du client réévalué à chaque message
  (Amy vouvoyait, Awa tutoyait tout du long).
- **Prompt — âge (règle 0b)** + business-info : vérifier l'âge annoncé contre
  les tranches (Bébé Nageur 6 mois-3 ans, Natation Enfant 4+) avant de
  proposer des créneaux ; à la borne haute, confirmer et mentionner le cours
  suivant. Awa n'avait pas réagi à « ma fille de 3 ans ».
- **classTips — tip Bébé Nageur dédié** (fr/en/wo) : couche de piscine
  jetable obligatoire (en vente au studio) + maillot pour le parent — le tip
  générique « maillot ou lycra » avait déclenché la question couches 2 min
  après la confirmation. Match bébé+aquatique (jamais un cours bébé hors eau).
- **Outils — descriptions durcies** : `event_id` → préférer le `choice_id`
  court (Amy : 2 erreurs `unknown_slot` sur event_id tronqué par le modèle,
  rattrapées mais +10 s de latence) ; `client_name` → jamais d'initiale ou
  placeholder (un lien était parti avec « A »).
- **Marque** : « Revive Pilates » → « Revive » dans STUDIO_ADDRESS (var
  Railway + défaut config.ts + business-info) — chaque confirmation violait
  la règle de marque.
- **Divers** : repli média illisible neutre (« je continue à t'aider » au
  lieu de « ce que tu veux réserver »).
- La question couches (handoff 22:36) avait déjà son fix : prix 1 500 F
  ajouté à business-info (`a34e84e`, autre agent, 22:43 le soir même).
- Build + 491 tests unitaires + 96 intégration verts.

### 6.9bis Engagements multi-séances DURABLES (persistance serveur) (23/07/2026)

Le fix §6.9 était **prompt-only** : le plan multi-séances ne vivait que dans
l'historique 30 tours, donc un plan pouvait encore retomber au silence (mode
d'échec Amy : 3/5 payées puis rien). Cette itération le rend **durable et piloté
serveur** (« le serveur avance la progression, jamais la formulation d'Awa »).

- **Schéma** ([schema.ts](src/db/schema.ts)) : `multi_session_commitments`
  (1 engagement ACTIF/client, index unique partiel) + `multi_session_commitment_items`
  (1 ligne/séance, `intent_status PLANNED|NEEDS_RESELECTION|CANCELLED`, position
  unique). **FK inversée** `pending_bookings.commitment_item_id` : plusieurs
  tentatives historiques/séance (1er lien expiré → 2e payé) sans perdre l'audit.
  Index unique partiel = **au plus une tentative bloquante/item**
  (DRAFT/AWAITING/PAID/BOOKED/REFUND_NEEDED).
- **[commitments.ts](src/domain/commitments.ts)** : `deriveItemState` PURE
  (précédence BOOKED→PAID/REFUND_NEEDED→AWAITING/DRAFT→intent ; EXPIRED-only =
  re-tentable). **Progression = COUNT(items BOOKED)** → idempotent face aux
  webhooks dupliqués (jamais un compteur incrémenté). Verrou consultatif
  par client (`pg_advisory_xact_lock`, comme bookingFunnel). `startCommitment`
  idempotent (même plan → existant ; plan différent → `conflict`). Sweep
  d'expiration (inactivité 7 j, rafraîchie à chaque BOOKED ; ou toutes dates
  passées sauf items NEEDS_RESELECTION). `closeCommitment` ORDONNÉ : expire les
  liens DRAFT/AWAITING **avant** de CANCELLER les items ; **différé** tant qu'une
  tentative PAID attend son fulfillment ; jamais BOOKED/REFUND_NEEDED touchés.
- **Outils** ([tools.ts](src/agent/tools.ts)) : `start_multi_session_commitment`
  (résout les choice_id via slot_cache, exige exactement N slots),
  `abandon_multi_session_commitment`. `create_payment_link` gate : tant qu'un
  engagement ACTIF existe pour LE MÊME service, `commitment_item_id` est EXIGÉ
  (sinon lien orphelin) ; re-sélection d'un item NEEDS_RESELECTION via un
  nouveau choice_id (même outil, pas d'outil en plus). **Pas de règle des 16h à
  l'achat** (elle ne vaut qu'à l'annulation).
- **[fulfillment.ts](src/domain/fulfillment.ts)** : après BOOKED (rail Wave/OM/
  Max It — transition partagée), `advanceOnBooking` ; si plan incomplet →
  message « Séance X/N confirmée — on continue ? » avec boutons
  `ms_continue`/`ms_later`/`ms_link` (le 3e = invitation de liaison intégrée pour
  un client non lié, sinon perdue s'il s'arrête tôt), qui **remplace** l'offre
  café ; à la complétion → liaison-si-due **avant** l'offre café (intégrité du
  compte > upsell). Paiement tardif après clôture : honoré (invariant
  `EXPIRED→PAID` intact), engagement NON rouvert, pas de « on continue ».
- **Taps `ms_*`** ([index.ts](src/agent/index.ts)) : `ms_later`/`ms_link` routés
  serveur (déterministes, sans modèle) ; `ms_continue` → le modèle re-lance
  `check_availability` (le slot_cache a un TTL 2 h, périmé pour un plan
  multi-jours) puis `create_payment_link` avec l'item — guidé par la ligne
  dynamicContext « ACTIVE multi-session plan ». `ms_link` = invitation
  *présentée* (le compte n'est LIÉ qu'après `submit_verification_code`).
- **Périmètre v1** : séances Wave/OM/Max It payées à l'unité uniquement —
  `book_with_membership` EXCLU (pas d'interruption de paiement, pas de mode Amy).
- **Hors périmètre** (projets séparés) : file de suivi 4-états + assignation ;
  persistance delivered/read WhatsApp ; carte « Situation actuelle » réception
  (Phase 3) + `buildClientJourneySnapshot` (Phase 2).
- Build + 634 tests unitaires + 187 intégration verts (dont 13 domaine
  commitments + 2 E2E : gating create_payment_link, webhook→« Séance 1/3 »+boutons).

### 6.10 Messages non-texte lisibles dans l'admin + réactions silencieuses (21/07/2026)

Un client (+1 301…, takeover actif) envoie un message que le webhook ne gère
pas → stocké comme un opaque « [non-text message] », type réel perdu à jamais
(ni en DB ni dans les logs — irrécupérable rétroactivement). Correctifs :

- **`parseInboundMessages`** capture désormais `reactionEmoji` (type
  `reaction`) et `filename` (type `document`).
- **Réactions emoji** (❤️/👍 sur un message) : nouveau `handleReaction` —
  loggé « [réaction ❤️] » (ou « [réaction retirée] ») dans le fil admin,
  ping réception si takeover, mais **jamais de réponse** : répondre « je ne
  peux pas lire ce type de message » à un ❤️ était perçu comme un bug. NB :
  un emoji TAPÉ comme message arrive en type `text` normal — seul le
  long-press réaction passait par le fallback.
- **Stickers** (WebP) : décrits par le modèle en quelques mots
  (`describeWhatsAppSticker`, prompt dédié, réutilise le chemin image
  `image/webp` déjà supporté) et injectés comme tour user « [sticker reçu :
  pouce levé] » → lisibles dans l'admin ET Awa y réagit naturellement (au lieu
  du « je ne peux pas lire » canné, même bug qu'un ❤️). Échec de description →
  repli « [sticker] » loggé, toujours lisible.
- **Autres types non gérés** : libellé descriptif via `unsupportedMediaLabel`
  — « [vidéo] », « [document : nom.pdf] », « [localisation partagée] »,
  « [contact partagé] », sinon « [message non pris en charge : <type>] ». Même
  libellé pour le fil admin ET les pings réception (avant : « [message non
  lisible] » partout).
- Build + 504 tests verts (parsing réaction/document/sticker, libellés,
  `stickerTurnText`).

### 6.11 Nommer les leads « chat-only » depuis leur fiche Wix (21/07/2026)

Rebecca Sharp (+1 301…) parcourt le planning et pose des questions mais ne
réserve/ne paie jamais → affichée « (sans nom) » dans l'admin alors qu'une
fiche Wix à son numéro existe. Cause : `clients.name` n'était écrit qu'à la
réservation/paiement/liaison email, jamais sur un simple message. Correctifs
(`4d4a024`, `e3f701d`) :

- **Enrichissement passif à l'inbound** (`maybeEnrichClientNameFromWix`,
  `src/agent/index.ts`) : un message d'un client sans nom déclenche un
  `findContactByPhone` ; sur match **UNIQUE** (null si 0 ou ambigu → jamais de
  nom deviné), le nom canonique est copié via `updateClientName`.
  Fire-and-forget (aucune latence sur la réponse), gardé sur nom vide donc ne
  refire plus une fois posé.
- **Route `/admin/crm/link`** : la liaison manuelle synchronise aussi le nom
  de la fiche vers la ligne locale (avant : numéro ajouté mais nom laissé vide).
- **Backfill one-shot** : `npm run crm:backfill-names` (`--dry` pour prévisu) —
  `scripts/backfill-client-names.ts`, idempotent, récupère l'URL Postgres
  publique via la CLI Railway (comme dev-prod-db). Passé une fois en prod :
  **6 clients nommés sur 19 sans nom** (Rama Seydi, Tabara DIOUF, Leïla FAHSI,
  Aghaby Yanni, Rebecca Sharp, Lala Binta), 13 sans fiche unique, 0 erreur.
- Build + 496 tests unitaires verts.

### 6.12 Livraisons v2 — notifs client de bout en bout + statut « en route » (21/07/2026)

Avant : le client d'une commande livraison (passée par téléphone, payée cash)
ne recevait qu'UN message (« prête »). Rien à la création, rien au départ.
Désormais **3 pings client** + un nouveau statut **OUT_FOR_DELIVERY** et une
2ᵉ alerte réception. Cycle : `IN_KITCHEN → READY → OUT_FOR_DELIVERY → DELIVERED`
(READY→DELIVERED reste permis si la réception saute l'étape départ ; CANCELLED
depuis les 3 états ouverts).

- **3 notifications client** (`deliveryRules.ts`) : ① `createdClientMessage`
  (confirmation à la création : récap + montant à régler + adresse),
  ② `readyClientMessage` **reformulée** (retrait de « va partir en livraison »,
  le départ a son propre ping), ③ `routeClientMessage` (« en route » au départ).
  Pas de message d'annulation ni de « livrée » (refusés par le proprio).
- **Déclenchement du départ par 2 chemins** : lien magique cuisine (2ᵉ bouton
  « 🛵 Partie en livraison » sur `/livraison/:token`, nouveau POST
  `/depart`, GET toujours read-only) ET board admin
  (`POST /admin/livraisons/:id/depart`). « Livrée » reste admin-only.
- **Outbox réutilisée** (`deliveryRepo.ts`) : triplets `created_notify_*` et
  `route_notify_*` (+ `client_notify_*` = ping prête inchangé), généralisés via
  une map `CLIENT_PING_COLS` whitelistée (noms de colonnes JAMAIS construits
  depuis une entrée). Gating des claims : created = ouvert
  (IN_KITCHEN/READY/OUT), ready = READY, route = OUT_FOR_DELIVERY. Retries par
  le sweep 60 s comme les autres.
- **1 seul nouveau template Meta** : `livraison_update` générique
  ({{1}} prénom, {{2}} texte) en fallback 131047 pour created + route ; « prête »
  garde `livraison_prete`. Le code shippe AVANT l'approbation (sans var →
  dégradation propre).
- **Alerte enlèvement one-shot** : `claimDeliveryPickupAlerts` — commande READY
  depuis > `DELIVERY_PICKUP_SLA_MINUTES` (env global, défaut 15) sans départ →
  ping réception, même mécanique que l'alerte retard cuisine.
- **Board** (`livraisonsPage.ts`) : badge « en route (N min) », badge « prête »
  qui vire au rouge après le SLA enlèvement, `clientFlag` par statut (confirmation
  / prête / en route), boutons `🛵 Partie` + `✓ Livrée` selon l'état, bannière
  `departed`.
- **Schéma auto-migré** : colonnes ajoutées via `alter table … add column if not
  exists` ; le CHECK statut est `drop`/`add` à chaque boot (idempotent).
  `created_notify_status` ajouté default 'sent' PUIS repassé 'pending' → pas de
  confirmation rétroactive pour les commandes déjà ouvertes au déploiement.
- **Edge cases assumés** : messages création/prête possibles dans le désordre si
  cuisine instantanée ; livrée direct depuis READY → pas de ping route (parcours
  s'arrête à « prête ») ; ping prête encore pending au départ → le sweep arrête
  de le retenter, le ping route supersède.
- **Ops** : le proprio crée le template Meta `livraison_update` (code langue
  `en`, corps FR `Bonjour {{1}} ! Mise à jour de votre commande Revive : {{2}}`),
  puis l'agent pose `WA_DELIVERY_UPDATE_TEMPLATE=livraison_update` (+
  `_LANG=en`) sur Railway. `DELIVERY_PICKUP_SLA_MINUTES` optionnel (défaut 15).
- Build + 507 tests unitaires + 15 tests intégration livraison (créa confirm,
  départ lien magique + double-POST idempotent, départ admin, livrée-direct sans
  ping route, annulation depuis OUT sans message, sweep enlèvement one-shot).

### 6.13 Choix intégré à un article de menu (jus d'orange / boisson chaude…) (21/07/2026)

Certains articles ont un choix (Brunch Mykonos : jus d'orange **ou** boisson
chaude ; Iced Matcha : lait d'avoine **ou** lait de vache). Avant : le choix
vivait dans le texte de la description + une consigne au prompt (`order_note`),
et le **formulaire livraison admin n'avait aucun champ** — la réception devait
le taper dans la note globale. Désormais c'est un **choix structuré par
article**, obligatoire à la saisie.

- **Modèle** (`lib/cafeMenu.ts`) : `CafeMenuItem` gagne `optionLabel?` +
  `optionChoices?[]` ; `ExtraLine` gagne `choice?` (option figée sur la ligne).
  `computeExtras(items, input, { requireChoices })` valide un choix fourni
  contre la liste de l'article et le fige ; avec `requireChoices` (formulaire
  admin) un article à choix sans choix est **rejeté**, sans (chemin **bot**,
  inchangé) il est simplement laissé vide. `formatExtras*` affichent
  « Brunch Mykonos (Jus d'orange) » ; `extrasFromJson` conserve `choice`.
- **Stockage** (`cafe_menu_items`) : colonnes `option_label` +
  `option_choices` (options séparées par « | »). Éditables dans
  **/admin/menu** (2 champs : libellé + options). Backfill one-shot dans
  SCHEMA_SQL pour BRUNCH_MYKONOS (Boisson) et les 5 Iced Matcha (Lait), guardé
  `option_label is null`.
- **Formulaire livraison** (`livraisonsPage.ts`) : un `<select choice_<ID>>`
  apparaît sous l'article quand il a des options ; `parseDeliveryQtyFields`
  apparie `qty_<ID>` ↔ `choice_<ID>` ; la route create passe
  `requireChoices:true` → erreur claire si oubli.
- **Le choix se propage partout** : ticket cuisine, confirmation/prête/en-route
  client, board admin, snapshot `items_json` (via les formatters partagés).
- **⚠️ Backfill = prod only** : le seed `cafe-menu.md` (sans syntaxe d'options)
  tourne APRÈS `migrate()`, donc sur une **base neuve** l'UPDATE ne trouve rien →
  Brunch/Matcha sans options tant qu'on ne les pose pas via /admin/menu. En prod
  la table est déjà peuplée → le backfill s'applique au prochain boot. (Tests
  intégration : options posées explicitement puis `refreshCafeMenu`.)
- **Limite v2** : un seul choix par article, et qty>1 = même choix pour toute la
  ligne (2 brunchs = 2 fois la même boisson) ; exception → note globale.
- Build + 518 tests unitaires + 17 tests intégration livraison (+ choix requis
  rejeté, choix figé sur la ligne + visible sur le ticket cuisine).

### 6.14 Story Instagram quotidienne — raffinements de mise en page (21/07/2026)

La story « PLANNING DU {JOUR} » (rendu déterministe 1080×1920 dans
`lib/storyImage.ts`, données Wix live, charte prune validée le 20/07) a reçu
deux ajustements de layout suite au retour de Babakar :

- **Marges latérales 120px** (constante `SIDE_MARGIN`, avant 60px) : titres,
  noms de cours et rangées de pastilles ne s'approchent plus des bords.
- **Noms longs sur deux lignes au lieu de rétrécir** : un nom qui ne tient pas
  à 58px est coupé au dernier espace qui tient (`nameLines`), la 2e ligne à la
  même taille. Coupe décidée à l'échelle naturelle → identique quel que soit le
  facteur d'échelle du jour ; hauteur de la 2e ligne comptée dans `naturalH`.
  Aucun nom de cours en dur — règle purement géométrique.
- **Variantes d'un cours fusionnées en une section**
  (`mergeClassVariants`, `domain/dailyStory.ts`) : deux cours dont les noms
  partagent leurs deux premiers mots (« Pilates Reformer Sculpt » /
  « Pilates Reformer Foundation ») sont regroupés sous leur tronc commun
  (« PILATES REFORMER »), tous horaires confondus triés par heure. Règle
  purement lexicale, aucun nom en dur. Coachs : 1 → affiché, 2 → « X & Y »,
  plus → ligne omise. (1er jet « 2 lignes » ci-dessus conservé pour les autres
  noms longs, mais les variantes passent désormais par la fusion.)
- **Cours aquatiques toujours en bleu** (`classColorMap`) : un nom contenant
  nageur/natation/aqua/swim reçoit le bleu `#5157a8`, retiré de la rotation des
  autres cours (pas de collision le même jour). Mot-clé sémantique, pas un nom
  de cours en dur.

### 6.15 /admin/menu — UX : recherche instantanée + barre catégories sticky (21/07/2026)

Plainte : retrouver un article = scroller (39 articles / 10 catégories) ou
remplir le formulaire GET et recharger. Refonte du catalogue
(`src/admin/menuPage.ts`) :

- **Recherche instantanée** : le champ `q` filtre EN DIRECT pendant la frappe
  (script inline, premier filtre texte live de l'admin). Chaque `<tr>` porte
  `data-search` **normalisé côté serveur** avec le même `normalized()` que
  `filterMenuItems` (minuscule + accents strippés) — le JS ne fait que
  normaliser la saisie. Sections/pastilles vides masquées, compteur
  « N articles » live, empty-state pré-rendu. Le formulaire GET reste le
  fallback sans JS / deep-link ; le bouton « Filtrer » disparaît (selects
  Statut/Recette en `onchange=submit`, select Catégorie supprimé — le query
  param `category` reste supporté).
- **Barre catégories sticky** (`.menu-jumpnav`, CSS dans `adminStyles.ts`) :
  pastilles `.jump-nav` avec compteur par catégorie, collée sous la topbar
  pendant le scroll (scroll horizontal sur mobile), saut d'ancre
  `#cat-<slug>` — les `h2` ont déjà `scroll-margin-top` global.
- **Lignes compactes cliquables** : 3 colonnes (Article+badges / Recette /
  Prix) au lieu de 5 ; colonnes Statut/Actions → badges (« Retiré » visible
  seulement en vue retirés/tous) ; ligne entière cliquable via `data-href` +
  délégation (les liens/inputs internes gardent la main).
- **Commit de réconciliation** : ce commit embarque aussi la feature
  `no_recipe_needed` d'une session parallèle (article « sans recette », badge
  neutre, exclu du compteur À compléter) — les deux chantiers touchaient
  `menuPage.ts`/`adminMenuPage.test.ts`, un push partiel aurait cassé le build
  prod (cf. règle multi-agents de CLAUDE.md).
- Build + 531 tests unitaires (dont 4 nouveaux UX) ; intégration cafeMenu +
  deliveryOrders verts. ⚠️ Piège découvert : les runs `test:integration` de
  deux agents SE TUENT mutuellement (nom de conteneur Docker fixe
  `resabot-integration-pg`, `docker rm -f` au setup ET teardown) — un
  `ECONNREFUSED 127.0.0.1:<port>` en plein run = l'autre agent a
  démarré/terminé le sien, pas une vraie casse. Relancer une fois seul.

### 6.16 Articles « sans recette » sur /admin/menu (21/07/2026)

Plainte : « Supplément protéine whey » (une dosette dans un smoothie, rien à
préparer) était badgé « Recette à compléter ». Livré dans le commit de
réconciliation 753c724 (détails de la feature, session parallèle de §6.15) :

- **Colonne `no_recipe_needed`** (`cafe_menu_items`, boolean not null default
  false) + alter-guard. **Pas de backfill dans SCHEMA_SQL** : un booléen non
  null-guardable serait re-flagué à chaque boot si l'admin décoche → backfill
  one-off manuel (fait, voir plus bas).
- `isRecipeComplete` court-circuite à true quand le flag est posé → badge
  neutre gris « Sans recette » (prime sur tout), stat « À compléter » et filtre
  corrigés sans branche dédiée. Le flag reste interne (absent du snapshot Awa,
  testé).
- **Checkbox** dans la fiche article (carte recette) : « Article sans recette
  (ex. supplément) » — parsée comme `favourite` dans `parseMenuItemForm`.
- **Backfill prod exécuté le 21/07** : `update … set no_recipe_needed = true
  where id like 'SUPP\_%' and recipe_ingredients is null and recipe_steps is
  null` → 10 lignes (5 supp. smoothie, 4 toast, 1 tapioca), vérifié, aucun
  autre article touché. Les futurs suppléments se cochent à la création.

### 6.17 /admin/menu — catégories en ONGLETS (une à la fois) (21/07/2026)

Suite de §6.15 : afficher tout le menu d'entrée n'avait pas de sens (retour
Babakar). Les pastilles catégories (déjà sticky) deviennent des **onglets** :
une seule catégorie visible à la fois, la **première ouverte** au chargement.

- **Défaut rendu côté serveur** (`menuPage.ts`, `renderMenuPage`) : 1re section
  visible, les autres avec l'attribut `hidden` ; 1re pastille `.active` ;
  compteur initialisé sur la 1re catégorie (pas le menu entier) → zéro flash,
  testable.
- **Fallback no-JS** : `<noscript><style>[data-cat-section][hidden]{display:block
  !important}</style></noscript>` → sans JS, toutes les catégories réapparaissent
  (liste complète, comme avant). L'admin dépend déjà de JS ailleurs.
- **Script onglets** : `showCategory(slug)` masque tout sauf la catégorie
  choisie ; clic pastille → vide la recherche + bascule. **La recherche reste
  GLOBALE** : `runSearch(q)` matche sur toutes les catégories (onglet actif
  ignoré), effacer revient à l'onglet actif. Compteur live selon ce qui est
  montré. Clic-ligne inchangé.
- Aucun changement CSS (réutilise `.jump-nav a.active` et `.menu-jumpnav`
  existants) ni de route.
- Build + 534 tests unitaires (dont 3 nouveaux : onglet défaut serveur,
  noscript, logique de bascule) ; script vérifié `node --check` ; cafeMenu
  intégration verte. Pas de mémorisation de l'onglet (v1 ouvre toujours la 1re).

### 6.18 Catégories du menu GÉRÉES (liste + page dédiée) (21/07/2026)

Avant : la catégorie d'un article était du **texte libre** (champ `<input list>`
+ datalist) → risque de typos (« SMOOTHIES »/« Smoothies ») qui fragmentent le
menu, et le datalist ne s'ouvrait pas au clic (bug Safari signalé). Babakar :
pas de saisie libre sur la fiche, une **page dédiée** pour gérer les catégories.

- **Table canonique `menu_categories`** (`name` unique insensible à la casse via
  `unique index (lower(name))`, `sort_order`). Les articles gardent la catégorie
  en **texte** (pas de FK) ; renommer met à jour les deux. Seed idempotent au
  boot depuis les catégories déjà utilisées (`insert … select category, min(sort_order)
  … group by category on conflict do nothing`) → une catégorie supprimée (donc
  sans article) n'est jamais ré-ajoutée.
- **Repo** (`cafeMenuRepo.ts`) : `listCategories` (avec compte d'articles),
  `categoryNames`, `createCategory`, `renameCategory` (transaction : rename +
  cascade `update cafe_menu_items set category=new where category=old`, refuse un
  merge si le nom cible existe), `deleteCategory` (bloqué si des articles
  l'utilisent), `validateCategoryName`/`normalizeCategoryName` (purs).
- **Fiche article** : la catégorie devient un vrai `<select name="category">`
  (menu déroulant des catégories gérées, catégorie courante présélectionnée,
  plus de saisie libre) + lien vers la page de gestion. La catégorie courante
  reste sélectionnable même si (défensivement) absente de la liste.
- **Page `/admin/menu/categories`** (`renderCategoriesPage`, routes GET + POST
  add/rename/delete) : liste avec compteur d'articles, renommage inline,
  suppression (désactivée = « Utilisée » tant qu'il reste des articles), form
  d'ajout. Lien « Catégories » dans l'en-tête de /admin/menu. Rename appelle
  `refreshCafeMenu` (les catégories des articles ont changé).
- Build + 541 tests unitaires (validation pure, select fiche, page manager) +
  112 intégration (ajout/unicité casse, rename cascade, refus merge, delete
  bloqué puis autorisé, compteur). Aucun nom de catégorie en dur.

### 6.19 Motif d'erreur dans l'alerte « échec technique » (22/07/2026)

Incident Zoé Dourthe (22/07 08:06) : Awa a renvoyé le repli « souci technique »
sur un simple « Mince merci » (erreur transitoire isolée, 1 seule en 3 jours,
aucune résa perdue, réception prévenue). Impossible de nommer l'exception : les
logs Railway ont une fenêtre courte et la ligne avait défilé. Fix : la boucle
agent (`src/agent/index.ts`) capture l'erreur (`loopError`) et joint son
**motif** à l'alerte réception via `describeLoopFailure` (nouveau, pur, testé) —
« <status> — <message> » (ex. « 529 — Overloaded »), tronqué 200 car., ou
« aucune réponse produite (pas d'exception) » si la boucle n'a rien renvoyé
sans throw. Le motif atterrit dans `notification_log.body` → diagnostic possible
après coup, sans dépendre des logs éphémères. Build + 545 tests (4 nouveaux).

### 6.20 Page menu publique — menu.revive.sn (22/07/2026)

Demande : une page web publique (hors admin) où les clients consultent le menu
du bar, toujours à jour avec `/admin/menu`. Implémentation
([src/menuPublic.ts](src/menuPublic.ts), pattern deliveryPublic — autonome,
sans auth, ZÉRO JavaScript client) :

- **Toujours frais** : rendu à chaque requête depuis `cafe_menu_items` +
  `menu_categories` via `listPublicMenuItems()` (nouvelle requête dédiée qui ne
  sélectionne QUE les colonnes publiques — les colonnes recette n'entrent
  jamais dans le module, garde anti-fuite testée). Pas le snapshot mémoire :
  par-processus (stale multi-instances) et il perd `favourite`/`sort_order`.
  `Cache-Control: public, max-age=60` → édits admin visibles sous ~1 min.
- **Routage host** : `/` devient host-aware dans `server.ts` — Host
  `menu.revive.sn` → page menu, sinon redirect `/admin` inchangé (garde-fou
  testé). Chemin stable `GET /menu` servi sur tout host (marche avant le
  cutover DNS). Canonical SEO par markup (`https://menu.revive.sn/`) ; page
  **indexable** (pas de noindex — divergence délibérée des autres pages
  publiques).
- **Design** : charte Revive (crème/prune/mauve, chevron SVG inline), polices
  système (pas d'embed TTF ~400 Ko — clients sur data mobile, décision
  Babakar), nav sticky d'ancres par catégorie (scroll CSS, CSP stricte
  `default-src 'none'` conservée), badge « ★ Incontournable », bouton
  « Commander sur WhatsApp ». Catégories dans l'ordre curé de
  `menu_categories` ; catégories vides masquées ; catégorie supprimée de la
  liste mais encore portée par un article → groupe en dernier.
- Tests : 12 nouveaux (groupement, rendu/échappement, routes host, anti-fuite
  recette). ⚠️ Vérifié build+tests sur **l'arbre commité + mes seuls fichiers**
  (checkout scratch) : l'arbre de travail portait un refactor livraisons
  inachevé d'un autre agent (deliveryRepo/deliveryRules) qui casse `tsc` — pas
  touché, pas commité.
- **Ops restant** : ajouter le domaine custom `menu.revive.sn` au service
  Railway + CNAME chez le registrar de revive.sn (action Babakar). `/menu`
  fonctionne en attendant.

**Passe UX (22/07, revue demandée par Babakar)** : fondu au bord droit de la
nav catégories (débordement invisible sinon — 10 pastilles, ~4 visibles sur
375px), `section:target h2` marque la catégorie atteinte (toujours zéro JS),
contrastes corrigés (`#a98baa` → `#7d5f80`, 2,8:1 → 5,1:1 WCAG AA), pastilles
agrandies (~38px), **CTA WhatsApp flottant** (safe-area iOS, le footer garde le
bouton pleine largeur), `prefers-reduced-motion`, `color-scheme: only light`
(anti-inversion Android), favicon SVG chevron en `data:` (CSP élargie à
`img-src data:` — seule relaxation), et **og:image** pour les aperçus de lien
WhatsApp : [src/lib/menuOgImage.ts](src/lib/menuOgImage.ts) (1200×630,
@napi-rs/canvas, polices bundlées, pattern scheduleImage) servie sur
`GET /menu/og.png` (buffer caché par process, max-age=86400), URL absolue via
`BASE_URL`. 15 tests sur la page (3 nouveaux : CSP, PNG og, hygiène markup).

**Itération 2 (retour Babakar, 22/07)** : (a) double CTA supprimé — seul le
bouton flottant reste, le footer garde juste « Revive — Dakar » ; (b) nav
**centrée** (`justify-content: safe center` — centre quand ça tient, scroll
sûr sinon) ; (c) **une catégorie à la fois** (même choix que l'admin §6.17) :
onglets 100 % CSS — sections masquées sauf `.default` (la première) ou celle
en `:target`, pastille active remplie via `body:has(#id:target)` (spécificité
ID > reset, ordre indifférent). Tout le menu reste dans le DOM (SEO,
deep-links `/menu#cat-…`) ; sans `:has()` (vieux navigateurs) dégradation
douce : défaut + ciblée visibles. Toujours zéro JS, CSP inchangée. 17 tests.

### 6.21 Livraisons v3 — étape unique « partie en livraison », cuisine = rôle `bar`, ping réception à la création (22/07/2026)

Trois demandes de Babakar, facilitées par un fait clé : **`delivery_orders`
était VIDE en prod** (feature jamais utilisée) → zéro migration de données.

- **READY fusionné dans OUT_FOR_DELIVERY** (décision Babakar : « prête » et
  « partie » = le même geste en pratique). Cycle : `IN_KITCHEN →
  OUT_FOR_DELIVERY → DELIVERED` (+`CANCELLED` depuis les 2 états ouverts ;
  IN_KITCHEN→DELIVERED permis pour clore une commande dont le départ n'a jamais
  été tapé — pas de ping route alors). Conséquences en cascade :
  - **2 pings client** au lieu de 3 : confirmation (création) + « en route »
    (départ). `readyClientMessage`/`deliveryTemplateParams` supprimés ; le
    template Meta **`livraison_prete` devient inutilisé** (approuvé, laissé en
    l'état ; `WA_DELIVERY_READY_TEMPLATE` retiré de config.ts, la var Railway
    reste posée sans effet). `livraison_update` couvre les deux pings.
  - **Lien magique = UN bouton** « 🛵 Partie en livraison » (POST racine ; la
    sous-route `/depart` supprimée — aucun ticket dans la nature). Board admin :
    boutons 🛵 Partie / ✓ Livrée / ✖ Annuler dès IN_KITCHEN.
  - **1 seule alerte SLA** : « pas partie après X min » (l'ancienne alerte prépa
    reformulée) ; l'**alerte enlèvement supprimée** (`claimDeliveryPickupAlerts`,
    `DELIVERY_PICKUP_SLA_MINUTES` retirés — elle mesurait l'écart READY→départ
    qui n'existe plus). Stat board « Départ moyen » = création→départ.
  - **Colonnes DB conservées** (`ready_at/ready_by`, `client_notify_*`,
    `pickup_alerted_at`) : inutilisées, retirées de l'interface TS seulement.
    CHECK statut re-posé sans READY (table vide → sûr).
- **Cuisine = rôle exact `bar`** (plus `cuisine`) : le répertoire réel a Fatma
  et Jacqueline en `bar` et le rôle `bar` est AUSSI utilisé par le planning
  staff (`PLANNING_ROLES`) — renommer les contacts les aurait fait disparaître
  du planning ; on adapte donc le code au vocabulaire. Ama supprimée du
  répertoire (départ prochain). **Contacts sans téléphone ignorés** (< 8
  chiffres) au lieu de générer un envoi `failed`/`partial`.
- **Ping réception à CHAQUE création de commande** (`notifyReception`
  whatsappFirst, → +221 78 464 43 29) : Babakar saisit aussi des commandes, la
  réception doit les voir pour les gérer. Écho assumé quand c'est elle qui
  saisit. (Avant, elle n'était prévenue que par accident, via le repli « aucun
  contact cuisine ».)
- Tests mis à jour : 555 unitaires + 109 intégration verts (dont nouveaux cas :
  contact `bar` sans téléphone → repli réception ; ping réception à la
  création ; livrée-direct depuis IN_KITCHEN sans ping route).

### 6.22 Ticket cuisine filtré par le planning staff PUBLIÉ (22/07/2026)

Demande Babakar : ne pas pinguer un membre du bar hors de ses heures
(Jacqueline pas le week-end, Fatma pas le lundi). Plutôt que des règles en dur,
**le ticket cuisine ne part qu'aux contacts `bar` EN SERVICE à l'instant T selon
le planning publié** (`/admin/staff`) — le planning existant devient la source de
vérité des horaires (le publié « Planning V1 » encode déjà ces contraintes).

- `planningNowSlot(now)` (`staffPlanningRules.ts`, pur) : instant → {weekday
  0=Lundi (remap `(getUTCDay()+6)%7`, convention grille ≠ getUTCDay), minute}.
  Dakar == UTC, pattern maison (cf. scheduleImage).
- `onShiftStaffIds(weekday, minute)` (`staffPlanningRepo.ts`) : staff_ids en
  poste selon le planning **publié**. Retourne `null` si AUCUN planning publié →
  pas de filtrage (dégradation = comportement précédent, tout le monde).
  Set vide = vraie réponse « personne en poste » → repli. La pause déjeuner
  13h30–14h30 n'est PAS exclue (le staff est sur place).
- `notifyKitchenForOrder` : filtre les contacts `bar` joignables par le Set ;
  ré-évalué à CHAQUE tentative (création, retry sweep, « 🔁 Renvoyer » — choix
  Babakar : le bouton manuel respecte aussi le planning). Personne à pinguer →
  repli **réception + Babakar** (`OWNER_PHONE`, défaut +221774982711,
  template-first car sa fenêtre 24 h est ~toujours fermée ; dédupliqué si =
  réception), message d'avertissement qui distingue « aucun contact en service
  (planning) » de « aucun contact joignable (répertoire) ». Statut inchangé
  `fallback_reception`.
- Tests : +1 unitaire (`planningNowSlot`), +3 intégration (filtre en poste /
  personne en poste → réception+owner / pas de planning publié → pas de
  filtrage). Les shifts de test sont semés relativement à l'instant réel (poste
  toute la journée aujourd'hui vs demain) — pas de mock d'horloge.
- ⚠️ Ops : c'est le planning **publié** qui gouverne (« Planning actuel » est un
  brouillon ignoré). Le publié donne à Jacqueline un samedi matin 9h15–13h35 —
  si c'est obsolète (« pas de week-end »), éditer /admin/staff et publier.
  Commande créée hors service (soir/dimanche après-midi) → repli
  réception+owner, attendu.

### 6.23 Passe UX du formulaire « Nouvelle livraison » (22/07/2026)

Retour Babakar : saisie pénible (ex. taper un chiffre pour la quantité).
Refonte de `renderLivraisonForm` ([src/admin/livraisonsPage.ts](src/admin/livraisonsPage.ts)),
saisie de commandes téléphoniques par réception/owner souvent au téléphone
(cible 390px) :

- **Steppers tactiles** `[−] n [+]` par article (boutons `.act--ghost .act--sm`,
  ≥44px mobile, `aria-label`) à la place de l'`<input type="number">`. Le champ
  `qty_<ID>` devient un `<input type="hidden">` : `parseDeliveryQtyFields` et
  `computeExtras` (qty 1-10, prix serveur, choix requis) restent **inchangés**.
  Ligne surlignée quand qty>0, select d'option masqué tant que qty=0.
- **Recherche instantanée** d'article (haystack normalisé serveur en
  `data-search`, filtre JS, ouvre les catégories qui matchent) — 44 articles
  dans 10 accordéons sinon.
- **Récap panier** dans l'actionbar : « N article(s) — Total estimé : X F ».
- **Conservation en cas d'erreur** : le POST `/livraisons` re-rend le
  formulaire (200) pré-rempli (client + quantités + choix) avec le message, au
  lieu de rediriger vers un formulaire vierge (`?err=`). `renderLivraisonForm`
  gagne un param `prefill`.
- **Clients récents** : select en tête, dernières ~30 livraisons dédupliquées
  par téléphone (`recentDeliveryClients()` dans
  [src/domain/deliveryRepo.ts](src/domain/deliveryRepo.ts)), remplit
  nom+tél+adresse d'un tap. Téléphone en `type="tel" inputmode="tel"`.
- Détail : `var(--border-subtle)` (jamais défini, no-op silencieux depuis
  l'origine) remplacé par `var(--border-soft)`. Zéro changement au bundle JS
  partagé (script inline de la page uniquement). Build + 567 tests (6 nouveaux,
  [test/livraisonForm.test.ts](test/livraisonForm.test.ts)).

### 6.24 Faux « souci technique » après une liste interactive (22/07/2026)

Incident Modou Lo, 10:38 : après la liste des prochains Aquabike, le client
répond « Ok merci » et reçoit le repli technique + lien réception. Le journal
ajouté en §6.19 prouve l'absence d'exception (« aucune réponse produite »). Cause :
`<NO_REPLY>` sert à éviter le doublon juste après `present_options`, mais un
silence / sentinel renvoyé sur le tour client suivant était systématiquement
transformé en panne, même si aucun interactif n'avait été envoyé dans CE tour.

- `classifyReplyOutcome` distingue maintenant texte livrable, silence légitime
  après interactif du tour courant et silence inattendu.
- Un silence inattendu déclenche UNE seconde génération sans outils, avec une
  consigne explicite de répondre au dernier message (un simple merci reçoit une
  clôture courte) et de ne pas répéter la liste. La réception n'est alertée que
  si cette récupération échoue aussi ou si une vraie exception existe.
- Une sentinel ne peut jamais fuiter telle quelle au client. Le second échec
  stocke `stop_reason` dans le motif technique pour rester diagnostiquable.
- Régression : `test/noReplyRecovery.test.ts` reproduit « liste interactive →
  Ok merci » et verrouille que `<NO_REPLY>` n'est silencieux que dans le même
  tour qu'un `present_options` réussi.
- **CI débloquée au passage, sans changement produit** : le test d'intégration
  Livraison attendait encore l'ancienne redirection 303 sur erreur, alors que
  §6.23 ré-affiche désormais volontairement le formulaire prérempli en 200. Le
  test vérifie maintenant le 200, le message et la quantité conservée. C'était
  l'unique échec sur 112 scénarios et la raison du premier déploiement `SKIPPED`.

### 6.25 Alerte d'effectif ciblée sur un cours Wix (22/07/2026)

Dans `/admin/notifications`, une règle « Avant un cours » peut maintenant viser
un cours précis depuis un sélecteur alimenté par le catalogue Wix. Le mode
historique reste disponible : tous les cours ou filtrage par texte.

- La règle conserve le `service_id` Wix dans `notification_rules.service_id`.
  Le sweep compare cet identifiant exact aux créneaux : deux cours aux noms
  proches ne se mélangent pas et un renommage du cours ne casse pas l'alerte.
- La sélection exacte est prioritaire et exclusive des filtres de nom. Les
  filtres sont désactivés dans l'interface et aussi vidés côté serveur.
- Le serveur revalide le cours dans le catalogue Wix à la création/modification
  et refuse les rendez-vous individuels (`APPOINTMENT`). Si Wix est
  momentanément indisponible, la page reste utilisable pour les règles
  générales et affiche un avertissement au lieu d'échouer entièrement.
- Une ancienne règle visant tous les cours continue donc à fonctionner sans
  migration manuelle. Une règle ciblée garde son identifiant même si le cours
  disparaît temporairement du catalogue affiché.
- Régressions : ciblage exact et calcul d'échéance dans
  `test/notificationRules.test.ts`, rendu du sélecteur dans
  `test/adminNotificationsPage.test.ts`, persistance création/modification dans
  `test/integration/notificationClaim.test.ts`.

### 6.26 Alertes livraison hors fenêtre + commandes de test (22/07/2026)

Incident réel sur la première commande livraison (Linsey, `6cb12809`, créée à
11:46) : ni le client ni la réception n'ont reçu leurs alertes. La base a montré
les deux pings client rejetés **asynchroniquement** par Meta avec `131047`, alors
que `delivery_orders` les avait déjà marqués `sent`. Le ping réception avait le
même faux positif mais son `wamid` n'était pas conservé. En parallèle, le
template `ticket_cuisine` est approuvé avec un bouton URL **fixe** alors que le
code lui passe un token dynamique → `132018`, puis le repli texte était exposé
au même rejet hors fenêtre.

- **Template-first partout sur une livraison** : client via
  `livraison_update`, réception/SLA/repli cuisine via `awa_notification`. Le
  ticket cuisine dédié reste tenté, mais son échec retombe désormais sur le
  template générique (qui contient le lien magique dans son corps), jamais sur
  un texte libre en premier.
- **Vérité async** : les pings client stockent leur `wamid` courant
  (`created_notify_wamid` / `route_notify_wamid`). Un callback Meta `failed`
  repasse l'outbox correspondante à `failed`; le sweep 60 s la retente dans la
  limite habituelle de 3 essais. Les pings réception stockent aussi leur wamid,
  donc le journal n'affiche plus un faux `sent` silencieux.
- **Mode commande de test** : case « 🧪 Commande de test » dans le formulaire.
  Le parcours complet reste exercé (client, réception, bar, départ, SLA), avec
  mentions TEST et badges explicites, mais `is_test=true` exclut la commande
  des stats livraison, de la file d'accueil, des clients récents et des
  candidats facture.
- Validation : build + **576 tests unitaires** + suite d'intégration complète
  verte, dont template-first client/réception, repli `ticket_cuisine` →
  `awa_notification`, retry après échec async et exclusion statistique du mode
  test.

### 6.27 Livraisons programmées et activation durable (23/07/2026)

La réception peut désormais choisir « Maintenant » ou « Programmer » à la
création d'une livraison. Pour une commande programmée, la date saisie est
l'arrivée promise au client en heure de Dakar et l'alerte cuisine est réglable
à 30, 60 ou 90 minutes avant (60 par défaut).

- `delivery_orders` stocke `scheduled_for`, `kitchen_notify_at` et
  `activated_at` en `timestamptz`, plus les outboxes durables du rappel
  réception à l'activation et de l'avertissement client après reprogrammation.
  Les anciennes commandes et les commandes immédiates gardent
  `scheduled_for=null`.
- Le client reçoit dès la création le panier, le total, l'adresse, l'arrivée
  promise et les choix Wave / OM / Max It / espèces. La commande programmée
  reste payable dans le contexte live d'Awa, mais aucun ticket cuisine ni SLA
  ne part avant `kitchen_notify_at`.
- Le sweep 60 s active atomiquement les commandes dues, envoie une seule fois
  le ticket cuisine avec lien magique et rappelle la réception. Le claim et la
  rotation du token cuisine sont maintenant une seule opération SQL : deux
  sweeps concurrents ne peuvent plus envoyer deux tickets. Un redémarrage
  rattrape les activations manquées depuis la base.
- Les départs, clôtures et renvois cuisine exigent `activated_at` dans les
  `UPDATE` SQL. Le lien public d'une commande future reste inaccessible et ses
  48 h de validité commencent à l'activation, pas à la création.
- `/admin/livraisons` sépare les commandes futures dans « Programmées » avec
  arrivée, compte à rebours, paiement, alerte cuisine et actions
  « Reprogrammer » / « Annuler ». La reprogrammation est atomique et autorisée
  uniquement avant l'ancienne activation ; elle conserve le paiement. Seul un
  changement d'arrivée avertit le client, sans reparler du paiement.
- Le SLA, le délai affiché et les statistiques de préparation partent de
  `kitchen_notify_at` pour une commande programmée et de `created_at` pour une
  immédiate. Une arrivée future dont le délai cuisine est déjà atteint est
  activée dès la création.
- Validation : TypeScript, **586 tests unitaires** et **131 tests
  d'intégration** verts. Les 34 scénarios livraison couvrent notamment le
  paiement Awa avant activation, le redémarrage, les sweeps concurrents, la
  reprogrammation, les gardes SQL, l'annulation payée/remboursement et la
  régression complète des livraisons immédiates.

### 6.28 Système temps réel salle + livraisons — Phase 1 : iPad cuisine (23/07/2026)

Début du chantier « écrans temps réel » (cf. plan validé) : une PWA cuisine
(`cuisine.revive.sn`) affiche les tickets en direct et laisse la cuisine
avancer **Nouveau → En préparation → Prête**, avec WhatsApp interne conservé en
**filet de sécurité**. Branche `feat/ops-cuisine-pwa` — **PAS encore en prod**
(voir « Pour mettre en service » plus bas). Trois commits cohérents :

- **Couche projection (`kitchen_tickets`)** : nouvelle table cuisine-facing
  alimentée par `delivery_orders`. Un ticket **naît à l'activation** de la
  livraison (immédiate ou programmée) — l'iPad ne voit jamais une commande
  future. Machine pure `NEW → PREPARING → READY → COMPLETED/CANCELLED` :
  la cuisine ne peut jamais atteindre COMPLETED/CANCELLED (pilotés par la
  commande source). `COMPLETED` quand la livraison quitte la cuisine (départ /
  livrée), `CANCELLED` si annulée. Transitions atomiques `UPDATE … WHERE status`
  (double-tap idempotent). Réconciliation idempotente dans le sweep 60 s
  (backstop qui répare un crash entre activation et insert). Journal durable
  `ops_events` = source de vérité du fan-out SSE **et** du rattrapage.
  ([kitchenTicketRules.ts](src/domain/kitchenTicketRules.ts),
  [kitchenTicketRepo.ts](src/domain/kitchenTicketRepo.ts),
  [opsEvents.ts](src/domain/opsEvents.ts))
- **Interface PWA** : dispatch host `cuisine.revive.sn` (même service Railway,
  comme `menu.revive.sn`), assets servis en dur (manifest, service worker qui ne
  cache QUE le shell — jamais une mutation ni le flux SSE, icônes canvas),
  **sessions d'appareils serveur RÉVOCABLES** (seuls les hachés sont stockés,
  pairing par code court à usage unique, isolation de rôle cuisine/accueil/owner
  — contrairement au cookie admin HMAC stateless). Kiosque construit côté client
  depuis un modèle SSE (DOM via `textContent`, données jamais en `innerHTML`),
  badges source 🛵 Livraison / 🪑 Salle, tri par ancienneté, son WebAudio, ACK
  d'affichage, CSP dédiée. SSE avec rattrapage `Last-Event-ID`/`?since` et drain
  propre au SIGTERM. ([src/ops/](src/ops/),
  [opsDeviceRepo.ts](src/domain/opsDeviceRepo.ts))
- **Filet WhatsApp `INTERNAL_NOTIFY_MODE`** :
  - `parallel` (**défaut, pilote**) : le ticket WhatsApp part systématiquement,
    en plus de l'iPad — comportement existant inchangé, pour comparer.
  - `fallback` (post-pilote) : l'iPad est primaire ; un timer one-shot 15 s
    (`OPS_KITCHEN_FALLBACK_SECONDS`) envoie le WhatsApp **seulement** si l'iPad
    n'a pas accusé réception. Claim atomique (`fallback_claimed_at`) → un seul
    envoi même si le timer et le sweep 60 s se croisent ; le sweep est le
    backstop durable si le process redémarre. Un ACK iPad marque la commande
    « cuisine notifiée » (jamais de WhatsApp, tableau de bord honnête).
- **Supervision admin `/admin/appareils`** : génération de code d'appairage
  (affiché une seule fois, stocké haché), état de connexion (appairé / en ligne
  / révoqué), révocation durable, et un bouton **« test »** qui pousse un
  événement SSE jusqu'à l'iPad de bout en bout.
- **Décisions de conception** (à connaître avant de continuer) :
  - Le ticket est une **projection** de `delivery_orders`, pas une seconde
    vérité : `delivery_orders.status` reste la machine client/paiement,
    `kitchen_tickets.status` l'état ops ; la réconciliation les aligne.
  - Livraisons en **2 acteurs** (décision Babakar) : la cuisine s'arrête à
    « Prête », l'accueil gère le départ. La PWA accueil (tables, « Je prends »,
    départ, push) est la **Phase 2** ; en Phase 1 le départ passe encore par le
    lien magique / le board admin existants (gate paiement inchangé).
  - **Mono-instance** : fan-out SSE en mémoire → valide à 1 replica Railway
    seulement (comme le reste). Scaler exigera un pub/sub Postgres.
  - Note par ligne d'article et modèle « salle » (espaces Canapé/Terrasse/
    Pergola, sessions, schémas) : **Phase 2**, non implémentés ici.
- **Pour mettre en service** (checklist, rien de tout ça n'est fait) : pointer
  le DNS `cuisine.revive.sn` sur le service Railway ; installer la PWA sur
  l'écran d'accueil de l'iPad (iPadOS ≥ 16.4, notifications par geste) ;
  générer un code dans `/admin/appareils` et appairer l'iPad ; garder
  `INTERNAL_NOTIFY_MODE=parallel` pendant le pilote de 7 jours puis basculer en
  `fallback`. Web Push (arrière-plan) et la PWA accueil arriveront en Phase 2.
- Validation : `npm run build` + **610 tests unitaires** verts ; **145 tests
  d'intégration** verts, dont 18 nouveaux (cycle de vie ticket, ACK/claim
  fallback, réconciliation create/complete/cancel, pairing/révocation, et le
  flux HTTP complet pairing → kiosque → autorisation des actions). Aucune
  régression des 34 scénarios livraison.

### 6.29 Contact de remise d’une livraison + alertes dédiées (23/07/2026)

Une livraison peut maintenant préciser un contact différent de la cliente
(assistante, gardien, proche…) qui récupère la commande auprès du livreur et la
remet à la destinataire finale.

- `recipient_name` et `recipient_phone` sont facultatifs mais indissociables,
  normalisés et validés côté serveur. À la création, une case facultative masque
  les deux champs dans le parcours courant et ne les révèle que si une autre
  personne récupère la commande. Le contact reste modifiable tant que la
  livraison est ouverte.
- Le contact de remise apparaît dans le board admin, le ticket cuisine et la
  page publique du livreur. Avant le départ, une modification rafraîchit aussi
  la projection iPad et renotifie la cuisine ; après le départ, elle déclenche
  directement la nouvelle alerte au contact.
- À l’étape **Partie en livraison**, le contact reçoit sa propre alerte
  WhatsApp avec l’adresse, le montant à encaisser si le paiement est en espèces,
  ou la mention « déjà réglée ». La cliente conserve séparément toutes les
  alertes habituelles et reste l’unique interlocutrice d’Awa pour le paiement.
- L’outbox du contact est durable (`recipient_notify_*`, `wamid`, tentatives,
  motif d’échec) : un rejet asynchrone Meta redevient retentable par le sweep.
  Les échecs remontent dans le board livraison, la file admin et les badges de
  navigation au lieu de rester silencieux.
- Validation avant déploiement : build TypeScript, **612 tests unitaires** et
  **40 scénarios d’intégration livraison** verts, dont cash/déjà payé,
  modification avant/après départ, retry asynchrone et garde de statut.
- Déployé sur `main` via `38f6c86`, sans embarquer la PWA cuisine encore en
  attente. La variante de cette branche conserve en plus la synchronisation de
  la projection iPad pour son futur déploiement séparé.

### 6.30 Refonte UX du parcours Livraison (23/07/2026)

Le parcours Livraison est désormais organisé autour de la prochaine action,
sans changer les statuts, transitions SQL, paiements ni notifications :

- Le board actif abandonne la table dense au profit de cartes adaptatives,
  réparties dans l’ordre **Intervention requise**, **En préparation**,
  **Prêtes à partir**, **En route**, puis **Programmées**. Une fonction pure
  dérive le groupe, l’urgence, le motif de blocage et l’unique action principale
  de chaque commande ; les retards et échéances proches remontent en premier.
  Le départ n’est proposé dans le board que lorsque la cuisine est `READY`, le
  paiement autorisé et la commande activée. L’historique reste replié.
- La lecture des commandes ouvertes joint la projection `kitchen_tickets`
  (`kitchen_ticket_status`, `kitchen_ready_at`) sans migration. Les incidents
  de paiement, remboursement, notification et ticket cuisine sont explicités
  directement sur la carte ; contact, adresse, échéance et total restent
  visibles, tandis que le détail du panier et les actions rares sont repliés.
- Le rechargement complet à 60 s est remplacé par un fragment HTML authentifié
  (`GET /admin/livraisons/fragment`) actualisé toutes les 30 s. L’actualisation
  se suspend dès qu’un détail ou formulaire est ouvert, affiche sa dernière
  heure de succès et peut être relancée manuellement. Le SSR et tous les POST
  restent pleinement utilisables sans JavaScript.
- La création est une page guidée en trois panneaux : **Client et destination**,
  **Articles**, **Livraison et confirmation**. Clients récents et recherche Wix
  partagent le même sélecteur, avec fiche choisie et saisie manuelle de secours.
  Un récapitulatif sticky expose quantité, options manquantes, total, moment et
  destinataire. Les erreurs serveur sont rendues au champ concerné, le premier
  champ invalide reçoit le focus et toutes les valeurs soumises sont restaurées.
  SLA et mode test sont rangés dans les réglages avancés.
- La page publique cuisine/livreur présente successivement contact, paiement et
  commande, donne le motif exact d’un départ bloqué et offre un rafraîchissement
  explicite. Le départ passe par la confirmation « Confirmer le départ » avec
  rappel de la notification client. Le GET reste sans effet, le POST idempotent,
  les liens expirent toujours à 48 h et les états terminaux n’exposent aucune
  donnée personnelle.
- Validation : rendu Chrome à **390 px** et ordinateur (aucun débordement
  horizontal à 390 px, contrôles Livraison ≥ 44 px, focus visible), build
  TypeScript, **618 tests unitaires** verts et **41 scénarios d’intégration
  livraison** verts.

### 6.31 Funnel publicitaire Pack Découverte (23/07/2026)

- La garantie satisfait ou remboursé après la première séance et la boisson
  offerte choisie au comptoir sont désormais officialisées dans
  `business-info.md`, sans prix ni nombre de séances en dur.
- Les nouveaux prospects suivent l'ordre qualification Pilates → choix du
  cours → créneaux réels → prénom et paiement. Les créneaux pré-paiement sont
  présentés comme indicatifs et revérifiés après activation du pack.
- Awa limite chaque message à une demande d'information et adapte sa courte
  disclosure IA au besoin déjà exprimé, au lieu de répéter le menu d'accueil
  générique.
- La réservation post-paiement reste sûre et explicite : le client répond après
  la confirmation d'activation, puis Awa revérifie le créneau avant
  `book_with_membership`.
- Validation : build TypeScript et **627 tests unitaires** verts.

## 7. Runbook ops

- **Multi-agent : un agent = un worktree** (mis en place 24/07). Plusieurs
  agents travaillaient sur le MÊME arbre → travail non commité écrasé, `tsc`
  cassé par des fichiers à moitié faits, `test:integration` parallèles qui se
  tuaient (conteneur Docker à nom fixe). Nouveau système :
  - Dossier principal `…/resabot` = **hub** épinglé sur `main`, lecture/ops
    seulement, jamais édité (cf. CLAUDE.md § « Git — un agent = un worktree »).
  - Chantier = worktree isolé via `npm run agent:new -- <topic>` →
    `../resabot-worktrees/<topic>` (voisin du repo, invisible à `railway up`/`tsc`),
    branche `agent/<topic>` sur `origin/main`, `.env` copié, `npm ci`.
  - Livraison = `npm run agent:ship` (rebase origin/main + build + test + push
    `HEAD:main`, retry auto sur non-FF) puis `npm run agent:done -- <topic>`.
    Script : [scripts/agent-worktree.sh](scripts/agent-worktree.sh).
  - `test/integration/globalSetup.ts` : conteneur nommé `resabot-integration-pg-<pid>`
    + label `resabot-integration=1`, purge des seuls conteneurs `exited` → runs
    parallèles coexistent. `railway up` **banni** (hors hotfix hub propre).
  - Réconciliation 24/07 : `origin/main` avait déjà les features disengage +
    pack-découverte (versions « propres » livrées séparément) ; `feat/ops-cuisine-pwa`
    en avait des ré-implémentations parallèles. Merge d'`origin/main` dans la
    branche, résolu par fichier (shape de `main` pour disengage, superset local
    pour campaign/PWA, dédup des symboles dupliqués) ; branche poussée sur
    `origin` (PWA **pas** encore en prod, prod reste sur le disengage de `main`).
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
  pas. `railway up --detach` existe encore mais est **banni hors hotfix** (il
  déploie du non-commité → git prend du retard sur le live = régression au push
  suivant ; cf. § multi-agent). Santé : `GET /healthz` ; logs :
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
## 2026-07-26 — Clés de la Maison (socle V1)

- Catalogue Wix privé créé sans exposition à Awa :
  - L'Invitée 3 séances / 21 j / 30 000 F ;
  - L'Habituée 6 séances / 30 j / 72 000 F ;
  - La Résidente 12 séances / 60 j / 144 000 F ;
  - trois plans gratuits privés « Cours en plus » (1/1/2 crédits).
- Les plans payants couvrent les cinq services Reformer ; les bonus couvrent
  Aquabike, Mat, les deux Yoga et Step. L'Invitation gratuite existante est
  conservée.
- Garde catalogue `AWA_SELLABLE_PLAN_IDS` déployé avant la création des plans :
  `public:false` n'est pas une barrière de vente pour Awa.
- Registre local `key_registry`/`key_invitations` sans aucun solde de séances :
  Wix reste la source de vérité. Provisionnement bonus idempotent avec retries
  1/5/15 min, réparation au chargement, au boot et dans le sweep 60 s.
- `eligible-pools.count` est le nombre de crédits à consommer. La sélection
  Clés est déterministe par
  `programDefinitionInfo.externalId=planId` +
  `programInfo.externalId=orderId`, jamais par ordre de réponse/nom.
- Deux outils dédiés : `book_key_bonus` (Aquabike/Yoga/Mat/Step lun–ven) et
  `book_key_invitation` (Reformer 12h30 lun–ven). L'ordre Invitation gratuit
  est créé paresseusement, une fois le prénom, téléphone et créneau confirmés.
- Toute réservation bonus/invitation confirmée est immuable : Awa bloque
  annulation et déplacement, y compris quand la réservation remonte comme
  `studio:`. Le crédit reste consommé ; seule la réception remplace un cours
  annulé par Revive.
- Webhook Wix `Order Purchased` (JWT RS256) ajouté pour les ventes comptoir,
  filtré strictement sur les trois plans payants et gated par
  `KEYS_AUTOMATION_ENABLED`.
- Postpone End Date implémenté pour aligner Clé + bonus lors d'une prolongation
  de 7 jours. Comme Wix ne permet pas de déplacer le départ d'un ordre payé,
  les prochaines Clés vivent en `SCHEDULED` dans Resabot et l'ordre Wix n'est
  créé qu'à l'activation. La date locale suit une prolongation ; après
  L'Invitée, la troisième séance effectivement commencée libère la prochaine
  Clé immédiatement, sinon elle démarre à l'expiration.
- Les droits d'invitation sont figés au moment de l'achat (avantage normal +
  continuité), puis la commande Wix gratuite est créée paresseusement à
  l'utilisation. L'Invitée est également limitée à un achat par membre dans
  Wix (`maxPurchasesPerBuyer=1`) en plus du contrôle d'historique serveur.
- Cycle V1 ajouté : J-5 L'Invitée, 24 h avant la troisième séance, J-5 membre
  et fin des crédits Reformer. Chaque envoi est un claim durable terminal ;
  les quatre branches restent sombres jusqu'à configuration de leurs templates
  Meta approuvés. Garantie L'Invitée : critères mécaniques serveur, dossier et
  handoff ; présence et remboursement restent strictement humains.
- Les anciennes formules Reformer sont classées « Membre Fondatrice » par IDs
  serveur (`LEGACY_REFORMER_PLAN_IDS`), jamais par interprétation du nom.
- Le funnel Meta 10 000 F est automatiquement neutralisé quand
  `KEYS_AUTOMATION_ENABLED=true`; les paiements Étape 1 déjà enregistrés
  continuent néanmoins leur fulfillment historique.
- Railway contient les mappings IDs/services avec
  `KEYS_AUTOMATION_ENABLED=false`. Les trois plans payants restent hors
  allowlist de vente jusqu'à la répétition générale et la configuration de la
  clé publique du webhook.
- Vérification : build, 681 tests unitaires et 183 tests d'intégration passent.

## 2026-07-27 — Continuité legacy des Clés

- Le catalogue live a été partitionné par couverture Wix, pas par nom :
  dix plans legacy couvrant le Reformer (purs, Carnet 10, quatre mixtes et
  Pilates 360 2×/3×). Aquafitness, Mat et Natation restent hors du périmètre.
- La source de continuité est résolue à la date du paiement vérifié : Clé active
  d'abord, sinon legacy Reformer couvrant la date, échéance la plus tardive en
  cas de chevauchement. Un abonnement hors Reformer ne peut plus repousser le
  démarrage d'une Clé.
- `paid_at` et les champs `continuity_source_*` sont persistés dans
  `pending_plan_orders` et `key_registry`. Les droits ne sont plus figés à la
  création du lien : paiement Awa et webhook comptoir appellent la même décision
  pure et produisent les mêmes invitations/dates.
- Bonus de continuité Fondatrice : +1 invitation si le paiement précède
  l'échéance legacy. Résidente conserve son invitation normale, donc deux au
  total ; Habituée en reçoit une.
- Un solde legacy nul ou illisible garde l'échéance sûre mais alerte la
  réception afin d'avancer éventuellement la date. Une Clé comptoir déjà
  démarrée trop tôt est conservée et signalée, jamais annulée automatiquement.
- Relance dédiée à J-5 (`WA_LEGACY_KEY_CONVERSION_TEMPLATE`) avec claim
  `sent/suppressed/failed` terminal. Quand l'automatisation Clés est active,
  les legacy sortent du rappel générique de renouvellement.
- Unicité L'Invitée renforcée : toute réservation Revive ou toute commande Wix,
  quel que soit son statut, sur le Pack complet ou L'Invitée bloque
  l'activation automatique. Une panne Wix autorise la vente mais produit un
  audit ; une contestation ouvre un handoff réception.
- Les droits Fondatrice restent eux-mêmes gated par
  `KEYS_AUTOMATION_ENABLED`; aucun changement client avant la bascule.
- Probe réversible Wix V3 validé en live sur Pilates 360 privé :
  `buyable=true → false`, relecture, puis restauration vérifiée à `true` ;
  `visibility=PRIVATE` est restée inchangée et le plan n'a jamais été archivé.
- Configuration constatée avant livraison : Clés absentes de
  `AWA_SELLABLE_PLAN_IDS`, `KEYS_AUTOMATION_ENABLED=false`.
- Vérification locale : build TypeScript, 693 tests unitaires et suite
  d'intégration PostgreSQL complète verts.

## 2026-07-27 — Une seule relance de conversion L’Invitée

- Les relances J-5 et 24 h avant la troisième séance deviennent deux branches
  alternatives : pré-3e si la séance est déjà réservée, J-5 sinon.
- Les deux chemins partagent le claim durable
  `INVITEE_CONVERSION:<key_id>` : une cliente ne reçoit jamais les deux, y
  compris si elle réserve sa troisième séance après avoir reçu la relance J-5.
- Les deux templates Meta restent distincts (variables différentes), mais un
  seul peut être consommé par Clé. L’automatisation reste sombre tant que
  `KEYS_AUTOMATION_ENABLED=false`.
- Vérification : build TypeScript, 694 tests unitaires et les 7 scénarios
  d’intégration du registre Clés verts.

## 2026-07-27 — Authentification du relais Wix des achats comptoir

- L'app Wix utilise un handler backend `wixPricingPlans_onOrderPurchased` puis
  relaie l'événement à Railway ; ce flux n'est pas le webhook natif JWT de Wix.
- `/webhooks/wix` accepte désormais ce JSON uniquement avec
  `X-Wix-Webhook-Secret`, comparé en temps constant à
  `WIX_WEBHOOK_SHARED_SECRET` (minimum opérationnel : 32 caractères).
- L'App Instance ID reste un identifiant public et n'est jamais utilisé comme
  preuve d'authenticité. Le support JWT RS256/PEM reste disponible en fallback.
- Le payload structuré conserve l'ID d'événement Wix pour la déduplication et
  le même traitement métier que les ventes comptoir natives.
- L'automatisation Clés reste désactivée jusqu'à la répétition générale.
- Vérification locale : build TypeScript et 710 tests unitaires verts.

## 2026-07-27 — Garde de répétition masquée des Clés

- Le préflight `KEYS_AUTOMATION_ENABLED` ne couple plus le provisionnement
  comptoir/webhook à l'ouverture commerciale dans `AWA_SELLABLE_PLAN_IDS`.
  Les trois Clés peuvent donc rester invisibles et invendables par Awa pendant
  la répétition générale, tandis qu'une commande Wix de test déclenche bien son
  bonus.
- Les cinq templates Meta ne sont plus des prérequis de boot de
  l'automatisation. Chaque branche de relance reste sombre individuellement
  tant que son nom de template est vide, conformément au comportement déjà
  implémenté dans `keyNudge` et `renewalNudge`.
- Les mappings Clé/bonus, les services, le périmètre legacy, l'historique
  Invitée et une méthode d'authentification webhook restent obligatoires.
- Régression dédiée : production simulée avec automation active, catalogue Awa
  fermé et templates vides ; les mappings de provisionnement manquants restent
  refusés.

## 2026-07-27 — Répétition générale masquée des trois Clés

- Architecture webhook finale (remplace le relais Wix CLI décrit plus haut) :
  webhook natif Pricing Plans `Order Purchased` directement vers
  `/webhooks/wix`, JWT RS256 vérifié avec `WIX_WEBHOOK_PUBLIC_KEY`. Les anciennes
  apps Wix de relais ont été désinstallées.
- Répétition exécutée avec le seul membre `Baba Test`, automation ouverte
  temporairement, trois IDs de Clés toujours absents de
  `AWA_SELLABLE_PLAN_IDS` et cinq templates Meta toujours vides.
- Résultats :
  - L'Invitée : Clé active, bonus exact actif, 21 jours, 0 invitation ;
  - L'Habituée : Clé active, bonus exact actif, 30 jours, 0 invitation ;
  - La Résidente : Clé active, bonus exact actif, 60 jours, 1 droit
    d'invitation.
- Pour chaque achat, le registre a conservé le bon couple
  `plan_id`/`bonus_plan_id` et une seule commande bonus. Les premières
  livraisons payantes ont été traitées mais la connexion Wix a expiré vers
  1,5 s (`499`) ; les retries Wix ont reçu `200` et la déduplication a empêché
  tout doublon. Aucun log applicatif d'erreur Clé/webhook pendant la fenêtre.
- Nettoyage vérifié : six commandes Wix (trois payantes + trois bonus)
  `CANCELED`, trois lignes de registre `CANCELLED`, droit Résidente inutilisé
  `VOID`. `KEYS_AUTOMATION_ENABLED=false`, catalogue Awa toujours fermé,
  `/healthz` OK.

## 2026-07-28 — Fiabilité Awa, relais humains et alertes cuisine iPad-only

- Incident Riche Aubambi corrigé à la source : dès qu'un `choice_id` ou
  `event_id` a été validé dans `slot_cache`, son `cached.service_id` canonique
  décide du cours. L'alias répété par le modèle est seulement journalisé et ne
  peut plus produire `unknown_slot` ni changer classe/prix. Même invariant pour
  les liens, engagements multi-séances, abonnements et listes d'attente.
- Les dernières options réellement envoyées sont conservées deux heures. Un
  titre exact, un moyen de paiement explicitement offert ou une heure unique
  écrit en texte libre est résolu avec le même ID qu'un clic ; les formulations
  ambiguës restent au modèle.
- Coupe-circuit persistant : deux erreurs techniques identiques
  outil+code+ressource en deux heures créent un seul handoff, mettent Awa en
  relais humain pendant 12 h et répondent avec un texte déterministe. Un succès
  du même outil/ressource efface le compteur.
- Les réponses admin restent visibles dans le replay mais portent maintenant un
  marqueur humain explicite. La revue qualité les inclut comme
  `human_team` et évalue seulement les tours/outils d'Awa.
- Awa se présente en français avec les mots exacts « je suis une assistante
  automatisée ». Le vouvoiement explicite est un cliquet durable et s'applique
  aussi aux confirmations automatiques, erreurs média, paiements, livraisons et
  remboursements. Un prénom déjà en base n'est plus redemandé.
- Les créations/activations de livraison et les paiements bar ne WhatsAppent
  plus automatiquement la cuisine. Les livraisons continuent sur le ticket
  iPad durable ; les commandes bar payées ont désormais leur propre source
  `BAR`, idempotente, avec bouton de clôture cuisine. Le renvoi WhatsApp manuel
  d'une livraison reste disponible ; une panne de projection bar déclenche une
  alerte critique à la réception.
- Régressions ajoutées : alias→créneau→lien de paiement, ticket BAR,
  iPad-only livraison, état durable du coupe-circuit, attribution humaine,
  choix texte libre, présentation et registre français.

## 2026-07-28 — Auto-activation self-service de toutes les ventes de plans

- Le provisioning membre auparavant spécifique au funnel Meta est partagé dans
  `domain/memberProvisioning.ts` : décision pure
  `use_member|require_verification|create_member`, fiche e-mail prouvée
  prioritaire sur l'index téléphone pendant 60 minutes, détection du
  rattachement divergent et orchestrateur Wix injecté/testable.
- `create_plan_payment_link` exige désormais la vérification e-mail pour un
  client sans membre, annonce l'e-mail Wix facultatif de définition de mot de
  passe, puis crée le membre seulement après toutes les gardes de plan,
  éligibilité, renouvellement/Clés et moyen de paiement, juste avant le draft.
  La même fiche effective alimente l'éligibilité, la continuité et
  `latestPlanEndDate`.
- Un `AWAITING_CODE` ne compte comme code déjà envoyé que jusqu'à son
  expiration. Le code actif est demandé sans nouvel e-mail ; le code expiré
  autorise un renvoi. `decideNoneCandidateAction` reste inchangé : nom connu =
  code envoyé sans double confirmation.
- Refus ou boîte inaccessible : fallback explicite
  `client_declined_verification:true` et activation manuelle après paiement.
  Mismatch/conflit/panne Wix : réception notifiée une fois et aucun paiement.
- La campagne Meta réutilise le même helper tout en conservant ses erreurs
  `discovery_member_*`. Le fulfillment existant garde l'activation offline
  idempotente (`member_id` → ACTIF) et la notification manuelle unique sans
  membre.
- Documentation mise à jour : l'ancien no-go `createMember` est supersédé.

## 2026-07-28 — Réponses rapides des templates WhatsApp

- Les boutons envoyés par `present_options` arrivent en `type:"interactive"`,
  mais les réponses rapides des templates Meta arrivent sous une forme
  distincte : `type:"button"` avec `button.text` et `button.payload`.
- Le parseur entrant accepte désormais les deux formes et injecte un clic de
  template dans la conversation comme `[choix cliqué] <texte> (id: <payload>)`.
  Les boutons des relances Clés ne tombent donc plus dans le repli « type de
  message non pris en charge ».
- Régression unitaire ajoutée avec la forme exacte du webhook Cloud API.

## 2026-07-28 — Mémo réception des Clés dans l’admin

- Nouvelle page statique `/admin/cles/memo`, accessible aux comptes équipe,
  qui reprend les six consignes opérationnelles : vente comptoir, cours bonus,
  invitations, prolongation, garantie L’Invitée et continuité des Membres
  Fondatrices.
- Le principe d’autorité est affiché en tête et en pied : Awa transmet, la
  réception valide et tient le registre ; aucun doublon ne doit être créé dans
  Wix. La page ne dépend ni de Wix ni de Postgres et ne contient aucune
  mutation.
- Le registre `/admin/cles` pointe vers le mémo, la navigation affiche le nom
  complet « Clés de la Maison » et une mise en page A4 imprimable est fournie.
- Régression unitaire : contenu métier complet, absence de formulaire et état
  actif de la navigation.

## 2026-07-28 — Story : créneaux séparés par coach

- Quand plusieurs coachs animent le même cours le lendemain, la story génère
  désormais un bloc distinct par coach au lieu de fusionner leurs noms sur une
  seule ligne.
- Chaque bloc contient uniquement les horaires de la coach affichée. Les
  variantes Wix d’un même cours conservent leur tronc commun et leur couleur,
  mais ne mélangent plus les créneaux de coachs différentes.
- Cette règle remplace le rendu antérieur « Coach A & Coach B ». Une régression
  couvre le cas Reformer avec deux coachs et vérifie l’attribution exacte de
  chaque horaire.

## 2026-07-28 — Lancement public des Clés de la Maison

- Babakar a masqué dans Wix le Pack Découverte et les formules legacy Reformer,
  puis arrêté l'ancien funnel Meta à 10 000 F avant la bascule.
- `AWA_SELLABLE_PLAN_IDS` ne contient désormais que les six offres
  hors-Reformer conservées (Mat, Aquafitness, carnets Aquabike/Natation) et les
  trois nouvelles Clés. Aucun Pack ni plan legacy Reformer ne reste vendable
  par Awa.
- `KEYS_AUTOMATION_ENABLED=true` en production : provisionnement automatique
  des cours en plus, registre/invitations, continuité legacy et cycle de relance
  sont actifs. Les cinq templates Meta Clés sont approuvés et configurés sous
  leur code de langue exact `en`.
- Déploiement Railway de bascule
  `ed5c9b3e-4aa3-405b-b823-77a3950f5024` en `SUCCESS`; démarrage propre et
  `/healthz` retourne `{"ok":true}`. Préflight : build TypeScript et 796 tests
  unitaires verts.
- Smoke test production sur `Baba Test` : `list_plans` a renvoyé exactement les
  six offres hors-Reformer et les trois Clés, puis Awa a présenté L'Invitée
  (30 000 F / 21 j), L'Habituée (72 000 F / 30 j) et La Résidente
  (144 000 F / 60 j), sans proposer le Pack ni un ancien abonnement.
- Le post Instagram de lancement a été publié. Relicat ops non bloquant pour le
  flux WhatsApp : la page statique Wix `/memberships` affiche encore l'ancienne
  gamme et doit être mise à jour manuellement dans l'éditeur Wix ; aucun accès
  d'édition de cette page n'existe dans le dépôt Resabot.

## 2026-07-31 — Commandes Wix « séance déduite » pour les résas abonnement

- Symptôme signalé (résa de Dialy, +221774762370) : une résa payée par
  abonnement apparaissait dans Wix Bookings avec « Aucune commande créée -
  Indisponible ». La séance était pourtant bien décomptée (ledger Benefit
  Programs) — seul l'ordre eCommerce manquait : le chemin membership n'en
  créait volontairement aucun, contrairement au chemin Wave
  (`recordWixOrderForBooking`). La réception ne voyait donc pas d'un coup
  d'œil que la séance venait d'un plan.
- Constat clé (API, ordre natif `6e499090…` du 31/07) : les résas abonnement
  faites par la réception dans le dashboard créent bien un ordre — ligne à
  0 F avec `paymentOption: "MEMBERSHIP"`, `paymentStatus: "PAID"`,
  `buyerInfo.contactId = memberId`, **aucun** enregistrement de paiement.
- Fix : `wix.createMembershipBookingOrder()` reproduit cette forme (ligne 0 F
  MEMBERSHIP, PAID, descriptionLines avec date Dakar + « Séance déduite de
  l'abonnement », `externalOrderId` = id pending_booking).
  `recordWixOrderForBooking` branche sur `payment_method='membership'`
  (contact Wix obligatoire, pas d'add-payment) ; les requêtes
  `claimBookingForWixOrderSync` / `bookingsMissingWixPaymentRecord` acceptent
  désormais `amount_xof = 0` quand `payment_method='membership'`.
- Appel inline après les trois créations membership (`book_with_membership`,
  bénéfice Clé BONUS/INVITATION, première séance d'un plan) + le sweep 60 s
  existant comme rattrapage (1 ordre/sweep, fenêtre 48 h) — il backfille
  automatiquement les résas abonnement récentes sans ordre, dont celle de
  Dialy, dès le déploiement.
- Piège si régression : ne PAS ajouter d'add-payment sur ces ordres (un ordre
  MEMBERSHIP natif n'a aucun paiement, balance 0) ; et le checkout eCommerce
  serveur reste impossible pour les plans (acheteur anonyme par clé API) —
  c'est bien un ordre créé directement, pas un checkout.
- Piège découvert au premier passage prod : sans `status` explicite, Create
  Order laisse l'ordre en `INITIALIZED` (number 0) — invisible dans le
  dashboard ET dans Search Orders (la doc Wix prétend qu'un total 0 est
  auto-APPROVED : faux en pratique). Le payload passe donc
  `status: "APPROVED"` — vérifié en prod (ordre 14913 de Dialy). Deux faits
  confirmés live 31/07 : un paiement offline 0 F APPROVED n'approuve PAS un
  ordre INITIALIZED (le filet dans recordWixOrderForBooking logge juste un
  warn) ; et comme Search Orders exclut INITIALIZED, le dédoublonnage par
  externalOrderId ne ressuscite jamais un ordre fantôme — en recréer un
  APPROVED est la bonne réparation (l'orphelin 39f407e2… de Dialy reste
  invisible et inoffensif).

## 2026-08-02 — Cockpit mensuel des paiements coachs

- `/admin/paiements-coachs` devient un cockpit compact : indicateurs avec
  couverture explicite, statuts et blockers partagés, ventilation
  Reformer/Mat/manuel, anomalies, montants honnêtes (`—` sans snapshot),
  actions par coach et navigation mois précédent/suivant.
- `POST /admin/paiements-coachs/preparer` prépare le mois sans jamais valider,
  envoyer ni marquer payé : les brouillons manquants sont créés, les brouillons
  existants resynchronisés et les états validés/payés ignorés. Services,
  calendrier, annulations et résolution des ids connus sont mutualisés pour
  toutes les coachs ; les erreurs DB restent isolées par coach.
- Une panne Wix partagée crée les nouveaux états liés en `failed`, journalise
  l'échec sur les brouillons existants et conserve `unlinked` pour les coachs
  non associées. Les décisions d'inclusion/exclusion restent préservées par
  `replaceWixSnapshot` et l'idempotence coach/mois existante couvre les doubles
  clics.
- La fiche coach reçoit un bandeau sticky, la checklist de validation commune,
  quatre buckets dont la somme égale `course_count`, les anomalies ouvertes et
  les sections secondaires repliées. Les réglages utilisent une liste compacte
  de formulaires repliables.
- Régressions unitaires et intégration ajoutées pour les neuf statuts, les
  blockers, les couvertures partielles, l'absence de faux zéro, les buckets,
  les panneaux, la cohérence cockpit/fiche, la préparation globale, la panne
  Wix, les erreurs DB isolées, le double clic, l'union/résolution Wix unique et
  la conservation des décisions manuelles.

## 2026-08-05 — Deuxième plan sur mesure « 2x Reformer 1x Yoga 1x Step »

- Nouveau plan Wix taillé pour une cliente précise : **148 000 F · 16 séances ·
  30 jours** (2x Reformer + 1x Yoga + 1x Step par semaine), créé à la main dans
  Wix (`d0fe7f79-…`), connecté aux services Reformer (3 niveaux), Power Yoga et
  Step. Description Wix remplie via l'API v3. Tarification retenue : Reformer
  12 000 F, Yoga **baissé à 7 000 F** (décision Babakar, aligné sur le Mat),
  Step 6 000 F — total exact 148 000 F, pas d'arrondi.
- **`SUR_MESURE_PLAN_IDS` remplace `SUR_MESURE_PLAN_ID`** (liste séparée par
  virgules, le singulier historique reste accepté et fusionné) : un mapping
  `SUR_MESURE` par plan dans `configuredKeyMappings()`. Tous les mappings
  SUR_MESURE partagent exactement les mêmes règles (seul le planId change), ce
  qui garde `keyMappingForType()` sûr alors que le type n'est plus unique.
- Avantages branchés comme l'autre sur mesure : 1 invitation Reformer
  (12h30 lun–ven), prolongation 7 jours, bibliothèque, massage membre, pas de
  cours en plus. **Différence voulue : piscine pendant TOUTE la durée de la
  formule** (l'autre plan = jours de séance uniquement) — mémo et
  business-info le précisent.
- Railway : `SUR_MESURE_PLAN_IDS` posé avec les deux ids ; le nouveau plan
  ajouté à `AWA_SELLABLE_PLAN_IDS` (Awa peut vendre par lien de paiement si la
  cliente le demande par son nom — jamais proposé spontanément, prompt et
  business-info généralisés aux deux plans).
- Piège évité : créer le plan dans Wix ne suffit pas — sans l'id dans
  `SUR_MESURE_PLAN_IDS` le plan reste « dark » (vendu comme plan normal, zéro
  automation Clé), et sans `AWA_SELLABLE_PLAN_IDS` Awa refuse le lien de
  paiement.

## 2026-08-10 — Story Instagram : partage du PNG original en HD

- Le PNG source reste net en 1080×1920 ; la forte perte de qualité observée
  venait de l'aperçu compressé du header image du template WhatsApp, qui ne
  doit pas servir de fichier final pour Instagram.
- `/admin/story` expose maintenant « Partager en HD » sur les téléphones qui
  acceptent le partage natif de fichiers, avec repli « Télécharger en HD ».
  Les deux chemins utilisent le PNG original, jamais une capture WhatsApp.
- La route PNG porte `Cache-Control: no-store` afin qu'un mobile ne réutilise
  pas l'image d'une journée précédente. WhatsApp reste le canal fiable de
  notification hors fenêtre 24 h, pas le transport HD de l'asset final.

## 2026-08-14 — Admin « Soldes séances » : séances restantes par abonnement

- Nouveau `/admin/abonnements/soldes` (lien depuis le registre réception) :
  toutes les commandes de plan ACTIVES avec cliente, plan, date de fin et
  **séances restantes / total**, triées par échéance. Données 100 % serveur :
  `listAllActiveOrders` + nouveau `listAllPoolBalances` (registre de crédits
  Benefit Programs) + `getContactNamesByIds` (noms CRM par lot de 50, `$in`).
- Raison d'être : le dashboard Wix n'affiche JAMAIS le solde d'un abonnement —
  le compteur vit dans le ledger Benefit Programs, pas sur la commande. La
  réception était aveugle (demande Babakar 14/08, après le cas Mariama Thiam).
- Pièges vérifiés en live : la pagination de `balances/query` passe par
  `metadata.cursors.next` (PAS `pagingMetadata` — 749 pools / 8 pages) ; une
  commande sans pool lisible s'affiche « Solde introuvable » (jamais un faux
  0) ; échec Wix → bandeau d'erreur, jamais de page vide silencieuse.
- Vérifié contre la prod : 128 commandes actives, 128 soldes appariés, spot
  checks conformes aux opérations du jour (Clés Invitée 2/3, carnet 9/10).

## 2026-08-14 — Nudge d'expiration : garde « jumeau payé » (cas Khadija)

- Incident (21h30–21h51) : une cliente a tapé « Payer Wave » PUIS « Payer
  Orange Money » quasi simultanément → deux pending_plan_orders jumeaux. Elle a
  payé le lien Wave (le plus ANCIEN, activé 3 min plus tard, Clé + résa OK) ;
  le jumeau OM a expiré à 21h50 et la relance « nous n'avons pas reçu de
  confirmation de paiement » est partie 17 min après sa confirmation ✅. Elle a
  répondu « j'ai déjà payé » → handoff réception inutile.
- Cause : `expiredPlanOrdersToNudge`/`expiredLinksToNudge` excluaient une
  tentative PLUS RÉCENTE, jamais un jumeau plus ancien payé après la création
  du lien expiré.
- Fix ([src/domain/repo.ts](src/domain/repo.ts)) : les deux sweeps se taisent
  si un ordre/résa du même client a été payé (paid_at, ou statut PAID/BOOKED
  via updated_at) APRÈS la création du lien expiré — cross-type (plan payé ⇒
  silence côté résa et vice-versa). Un achat ancien ne masque pas un nouveau
  lien réellement abandonné (borne = created_at du lien). Couvert par
  [test/integration/expiryNudgePaidTwin.test.ts](test/integration/expiryNudgePaidTwin.test.ts).
- Reste PHASE2 : à la création d'un lien de remplacement, le lien précédent
  n'est PAS annulé côté Wave/OM (Awa dit « n'est plus valable » à tort — c'est
  précisément ce qui a permis le paiement du jumeau) ; si une cliente payait
  LES DEUX liens, double débit possible. Envisager void/cancel du lien
  remplacé ou détection du double paiement au webhook.
