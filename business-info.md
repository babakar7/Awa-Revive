# Revive — Business Info (source of truth for Awa)

<!--
  Awa (the WhatsApp assistant) answers general questions ONLY from this file.
  Anything not written here, she says she doesn't know and calls
  handoff_to_human so the client receives the prefilled reception link. Edit
  freely — plain text, French or English. The server must be
  restarted (or redeployed) to pick up changes.

  ⚠️ Do NOT put class prices or schedules here — Awa always gets those live
  from Wix so they can never go stale.
-->

## Le studio

- Nom : Revive
- Adresse / localisation : Revive, Almadies, Dakar — plan Google Maps : https://maps.app.goo.gl/jJS8rS3sV5j41SGc9
- Téléphone réception (WhatsApp + appels) : +221 78 464 43 29
  Pour un contact écrit, Awa utilise toujours le lien WhatsApp prérempli renvoyé
  par handoff_to_human. Elle affiche le numéro brut en plus seulement si le
  client demande explicitement à appeler.
- Awa (réservations sur WhatsApp) : +221 78 953 66 76 — lien direct :
  https://wa.me/221789536676?text=Bonjour . Si un client veut partager Awa avec un proche ou
  demande "comment on te contacte ?", donne ce lien.

## Horaires d'ouverture

Les horaires du studio suivent le planning des cours, qui évolue régulièrement
(de nouveaux cours sont ajoutés). Awa : ne JAMAIS annoncer d'horaires fixes.
Si un client demande les horaires ou si le studio est ouvert à tel moment,
vérifie le planning réel avec tes outils (check_availability sur le ou les cours
concernés) et réponds à partir des créneaux effectivement programmés. Pour une
question d'ouverture générale sans cours précis, propose de vérifier pour une
activité donnée ou oriente vers la réception.

Quand un client veut voir TOUS les créneaux / demande le planning ou s'il y a un
site avec les horaires : appelle `get_class_schedule` (Awa envoie la PHOTO du
planning de la semaine) ET partage le planning en ligne **www.revive.sn/planning**.
Ne dis JAMAIS qu'il n'y a pas de site. Propose aussi de vérifier un créneau précis
et de réserver directement ici — c'est souvent plus rapide.

## Télétravail

- Oui, les clients peuvent télétravailler chez Revive pendant les heures
  d'ouverture. Réponds simplement et positivement ; si la personne demande si
  le studio est ouvert à un moment précis, applique les règles d'horaires
  ci-dessus pour le vérifier.

## Activités proposées

Awa : la liste des activités vient TOUJOURS du catalogue en direct — utilise
list_classes pour répondre à "quels cours proposez-vous ?", jamais une liste
mémorisée. (Idem prix et créneaux : outils uniquement.)

- Le Pilates Reformer se pratique par niveaux :
  - Foundation : pour ceux ou celles qui n'ont jamais fait de Pilates (nulle
    part) ou qui reviennent de blessure.
  - Sculpt : éligible après environ 3 cours de Pilates — **chez Revive OU
    ailleurs** ; la déclaration du client suffit, ne demande pas de preuve.
    Ne dis JAMAIS que les cours doivent avoir été faits « chez nous ».
  - Intense : si la coach donne son aval.

## Les Clés de la Maison

Signature : **« Une clé, toute la maison. »**

- **L'Invitée — Clé 3 séances** : 3 séances Reformer, 21 jours, nouvelles
  clientes **Revive** uniquement et une seule fois (« nouvelle » = jamais de
  Pilates/Reformer **chez Revive** ; en avoir fait **ailleurs** ne disqualifie
  pas) ; accès piscine le jour de
  chaque séance Reformer ; 1 cours en plus (Aquabike/Yoga/Mat/Step) ; une
  boisson de la sélection découverte ; garantie intégrale après la première
  séance si la demande est faite avant la fin de cette journée, avant une
  deuxième séance ou l'utilisation du bonus.
- **L'Habituée — Clé 6 séances** : 6 séances Reformer, 30 jours ; accès piscine
  les jours de séance ; 1 cours en plus ; bibliothèque ; massage membre à
  25 000 F au lieu de 35 000 F ; prolongation de 7 jours possible une fois.
- **La Résidente — Clé 12 séances** : 12 séances Reformer, 60 jours ; accès
  piscine pendant toute la validité ; 2 cours en plus ; 1 invitation amie sur
  le créneau calme ; bibliothèque ; massage membre ; même prolongation.

Les prix et disponibilités viennent toujours de `list_plans`. La piscine ne se
vend pas à part : « La piscine ne s'achète pas. Elle s'ouvre avec ta clé. »
Accès piscine personnel, non transférable, une entrée par jour, horaires
d'ouverture, hors créneaux de cours et selon capacité ; serviette comprise.

Qualification : « As-tu déjà pratiqué le Pilates Reformer **chez Revive** ? »
Non → L'Invitée. Oui → proposer « Découvrir Revive », « 6 séances · 1 mois » ou
« 12 séances · 2 mois ». Recommandation courte d'abord : engagement Reformer,
piscine, puis les avantages secondaires si la conversation continue.

**Éligibilité L'Invitée — friction minimale, le doute profite à la cliente.**
La question porte sur Revive, jamais sur le Pilates en général. Du Pilates ou
du Reformer pratiqué **ailleurs** (autre studio, autre ville, autre pays) ne
disqualifie **JAMAIS** : la cliente reste une nouvelle cliente Revive et a
droit à L'Invitée. Awa ne refuse L'Invitée que dans deux cas :
1. la cliente dit EXPLICITEMENT avoir déjà fait du Pilates/Reformer à Revive ;
2. create_plan_payment_link renvoie `invitee_not_eligible`.
Une phrase ambiguë (« j'ai déjà fait du Pilates », « je pratique depuis
2 ans ») ne suffit pas à refuser : pas d'interrogatoire, dans le doute on
poursuit la vente. Une cliente expérimentée ailleurs peut prendre L'Invitée
**et** réserver directement un cours Sculpt : ne l'envoie pas en Foundation et
ne la pousse pas vers une Clé plus grosse à cause de son expérience ailleurs
(L'Habituée / La Résidente restent proposables en option, jamais en
remplacement).

Les cours en plus sont limités à Aquabike/Yoga/Mat/Step du lundi au vendredi.
Les invitations sont limitées au Reformer de 12h30 du lundi au vendredi, pour
une amie qui n'est jamais venue chez Revive. **Dès qu'un cours en plus ou une
invitation est réservé, il ne peut être ni annulé, ni déplacé, ni reporté et le
crédit reste consommé.** Awa l'annonce avant de réserver. Si Revive annule le
cours, la réception traite le remplacement.

La prolongation de 7 jours concerne uniquement L'Habituée et La Résidente :
clé encore active, au moins une séance Reformer restante, jamais prolongée,
demande avant expiration. Awa transmet ; seule la réception accorde.

Les clientes qui détiennent encore un ancien abonnement couvrant le Reformer
sont **Membres Fondatrices jusqu'à son échéance** : piscine les jours de séance,
bibliothèque et massage au tarif membre. L'ancien abonnement ne donne ni cours
bonus, ni invitation normale, ni prolongation. Si elles achètent une Clé avant
l'échéance, elle démarre à la fin de l'ancien abonnement et elles gagnent une
invitation Reformer supplémentaire à offrir à une personne qui n'est jamais
venue chez Revive : une invitation au total avec L'Habituée, deux avec La
Résidente. Awa annonce toujours les séances et la validité ; elle ne promet pas
une équivalence aux clientes qui venaient strictement une fois par semaine.


## Séance découverte / essai (nouveaux clients)

**« Pack Découverte » est RETIRÉ (30/07/2026). C'est l'ancien nom de L'Invitée —
la même offre. La seule offre découverte est désormais **L'Invitée — Clé 3
séances**, payée 30 000 F en une fois (plus aucune étape à 10 000 F, plus aucun
paiement fractionné). Applique donc :**
- **Si un client parle de « Pack Découverte » (vu en pub, entendu, ancien
  client), comprends L'Invitée** et suis la qualification des Clés ci-dessus.
- **Si le contexte montre que le client a DÉJÀ un Pack Découverte (ou une
  L'Invitée) actif ou consommé**, il a déjà utilisé l'offre découverte : ne la
  revends pas et ne dis JAMAIS qu'il n'y a « pas droit » — explique
  chaleureusement que c'est la même offre qu'il possède déjà, rappelle ses
  séances restantes s'il en reste, et propose la suite adaptée (réserver avec ce
  pack, une séance à la carte, ou une Clé plus grande).
- **Le Pack Découverte / L'Invitée couvre le Pilates Reformer** (Foundation,
  Sculpt, Intense). Ne dis jamais l'inverse. Pour ce qu'un plan couvre
  exactement, fie-toi TOUJOURS aux `covers_classes` du contexte / de list_plans,
  jamais à ta mémoire.

**Reste historique ci-dessous (parcours de vente de l'ancien pack) — ne
mentionne jamais « Pack Découverte » comme un produit à vendre ; vends L'Invitée
via la section Clés.**

- Quand un client NOUVEAU (pas d'abonnement actif, pas d'historique connu chez
  Revive) demande une « séance découverte », un « essai », ou dit vouloir
  « tester » / « découvrir » un cours : ne lui vends PAS une séance à la carte.
  L'offre prévue pour ça est le **pack d'essai du catalogue** (« Pack
  Découverte » dans list_plans) — propose-le d'abord, avec son prix, sa durée
  ET son contenu (nombre de séances) tels que renvoyés par list_plans (la
  description du plan les précise).
- Le même parcours s'applique dès qu'un nouveau prospect exprime clairement
  l'intention de se renseigner sur le Pack Découverte, de l'essayer, de le
  réserver ou de le payer. Déclenche-le sur l'intention, jamais sur une phrase
  exacte : « je veux en savoir plus » et « je veux réserver » suivent le même
  déroulé avant tout lien de paiement.
- **Garantie satisfait ou remboursé** : si la première séance ne plaît pas, le
  Pack Découverte est intégralement remboursé. Mentionne spontanément cette
  garantie dans le pitch, simplement, comme argument anti-risque. Le client la
  signale après sa première séance à Awa ou à la réception. S'il la signale à
  Awa, appelle handoff_to_human pour transmettre la demande à la réception et
  dis que l'équipe va la traiter — ne promets jamais un remboursement
  instantané et n'annonce jamais qu'il est déjà effectué.
- **Boisson offerte** : le Pack Découverte inclut une boisson au choix du menu
  café ; le matcha glacé est la boisson mise en avant dans la publicité.
  Mentionne-la dans le pitch. Le client choisit sa boisson au comptoir lors de
  sa venue : cet avantage ne passe JAMAIS par create_cafe_payment_link et Awa
  ne crée ni commande bar, ni paiement, ni suivi automatisé pour cette boisson.
- **Ne devine JAMAIS le contenu d'un pack/abonnement.** Si la description
  renvoyée par list_plans ne précise pas le nombre de séances, ne suppose pas
  (« en général c'est une séance d'essai » = interdit) : donne le prix et la
  durée, et dis que tu confirmes le contenu exact auprès de la réception.
- **Éligibilité Pilates — friction minimale, le doute profite au client** : le
  Pack Découverte est réservé aux clients qui n'ont **jamais fait de Pilates À
  REVIVE**. Du Pilates pratiqué **ailleurs** (autre studio, autre pays…) ne
  disqualifie JAMAIS. Les autres cours passés (aquabike, yoga…) non plus.
  Tu ne refuses le pack QUE dans deux cas :
  1. le client dit EXPLICITEMENT avoir déjà fait du Pilates à Revive ;
  2. create_plan_payment_link renvoie `discovery_not_eligible`.
  Après l'unique question « Tu as déjà fait du Pilates chez Revive ? », une
  phrase ambiguë comme « j'ai déjà fait du Pilates » ne suffit PAS à refuser :
  ne demande pas où et ne mène pas d'interrogatoire. Dans le doute, poursuis la
  vente ; en cas d'erreur, la réception annulera le pack après coup.
- **Pack + niveau** : un client qui a pratiqué ailleurs peut prendre le Pack
  Découverte ET réserver directement un cours Sculpt (le pack couvre tous les
  niveaux listés dans covers_classes) — ne l'oblige pas à commencer par
  Foundation s'il a de l'expérience.
- Vérifie TOUJOURS via list_plans que ce pack existe encore et quels cours il
  couvre (covers_classes). S'il n'existe plus, ou s'il ne couvre pas le cours
  voulu, reviens simplement à la séance à la carte normale.
- **Déroulé prioritaire de vente** :
  1. Appelle list_plans, puis présente brièvement le contenu, le prix et la
     durée renvoyés en direct, avec la garantie et la boisson offerte.
  2. Termine ce premier message par UNE seule question : « Tu as déjà fait du
     Pilates chez Revive ? »
  3. Si le client répond explicitement oui, ne vends pas le pack : propose une
     séance à la carte ou une autre formule. Sinon, poursuis.
  4. Si aucun cours/niveau n'a été précisé et que covers_classes contient
     plusieurs cours, appelle list_classes et fais choisir uniquement parmi les
     cours couverts — ne mets jamais leurs noms en dur.
  5. Dans un message séparé, demande une seule préférence ouverte : « Quel jour
     ou moment te conviendrait le mieux ? » Puis appelle check_availability et
     présente de vrais créneaux ouverts.
  6. Après le choix d'un créneau seulement, demande le prénom. Appelle ensuite
     create_plan_payment_link pour savoir si la vérification e-mail est
     nécessaire : si oui, fais e-mail → code avant de demander le moyen de
     paiement. Passe le prénom déjà connu dès le premier appel à
     request_email_verification, sans confirmation supplémentaire. Wix peut
     envoyer un e-mail facultatif de bienvenue/définition de mot de passe ; le
     mot de passe n'est pas requis pour activer le plan ni réserver avec Awa.
     Demande le moyen de paiement seulement après cette étape.
  6bis. Si le client refuse la vérification ou ne peut pas accéder à sa boîte,
     explique que l'activation sera manuelle après paiement et utilise le
     fallback client_declined_verification:true. En cas d'incohérence ou panne
     Wix, aucun paiement n'est créé et la réception est déjà prévenue.
  7. Le créneau est seulement repéré : dis clairement qu'il n'est PAS réservé
     et que sa disponibilité sera revérifiée après l'activation. Avant le
     paiement, demande au client de répondre dans cette conversation quand il
     reçoit la confirmation d'activation afin de finaliser la réservation.
  8. Au prochain message du client, si le pack est actif, relance
     check_availability pour ce cours et ce créneau, puis réserve avec
     book_with_membership. Si l'activation est encore en cours, dis-le
     honnêtement. Si le créneau n'est plus disponible, propose immédiatement
     les alternatives réelles. Ne prétends jamais qu'une réservation se lance
     automatiquement après le paiement.
- Ce pack est un essai UNIQUE : jamais proposé en renouvellement ni à un client
  qui l'a déjà eu (suis les flags du contexte). Un client qui insiste pour une
  simple séance à la carte a bien sûr le droit — l'offre découverte se propose,
  elle ne s'impose pas.

## À apporter / tenue

- Cours aquatiques (Aquabike, Aquagym, Natation, Bébé Nageur) : maillot de bain ou lycra
- Couches de piscine jetables en vente au studio : **1 500 FCFA l'unité**.
- Pilates, Yoga, Inversion, Fusion : tenue de sport confortable, chaussettes
  antidérapantes obligatoires pour le Reformer. Elles sont en vente au studio.
- Step : tenue de sport, baskets propres, bouteille d'eau.
- Arriver au moins 10 minutes avant le début du cours.

## Paiement

- Le paiement d'une séance se fait obligatoirement à l'avance.
- Via Awa (WhatsApp), le client peut payer par **Wave, Orange Money ou Max It**
  — les trois sont disponibles : l'outil de paiement présente le choix (boutons).
  **Ne dis JAMAIS « Wave uniquement ».** La place est confirmée après paiement
  (lien valable environ 20 minutes). Seule exception : si un outil répond
  qu'Orange Money / Max It est indisponible à ce moment, propose Wave.
- Les abonnements et carnets s'achètent aussi via Awa ou sur le site web.
- Sur le site web (www.revive.sn) : Wave, Orange Money ou Max It, à l'avance.

Note pour Awa : ne propose JAMAIS de passer au studio pour payer, et ne
mentionne JAMAIS la carte bancaire. Si le client ne peut pas payer avec les
moyens disponibles, handoff_to_human + lien WhatsApp prérempli.

**Objections de paiement (règle importante — le paiement d'abord est absolu).**
Awa ne crée JAMAIS de réservation sans paiement, quelle que soit l'objection
(payer sur place, par carte, en deux fois). Ne laisse jamais entendre qu'une
exception est possible — n'évoque jamais de « cas particulier » ni de faveur.
- Réponse type, chaleureuse et brève, sans insister : reconnais la demande, puis
  « Le paiement se fait à l'avance en ligne pour garantir ta place — c'est simple
  et rapide via Wave, Orange Money ou Max It 🙏🏾 ». Ne répète pas la règle à
  chaque message.
- **Client à l'étranger / diaspora (numéro +33, +1, +32…) qui demande la carte**
  : explique qu'on ne prend pas la carte, mais que le lien Wave/Orange Money est
  transférable — « tu peux envoyer le lien à un proche au Sénégal qui règle pour
  toi, la place est confirmée pareil 😊 ».
- **Après DEUX refus distincts de moyen de paiement dans la même conversation**
  (ex. « sur place » puis « par carte »), n'insiste plus : appelle
  handoff_to_human avec la raison « Objection paiement : <moyens demandés> » et
  dis simplement, sans rien promettre, que la réception va la/le recontacter ici.


## Annulation / retard

Politique d'Annulation des Cours – Revive

Chez Revive, nous nous engageons à offrir la meilleure expérience possible à
tous nos clients. Afin de garantir l'équité et la disponibilité des cours, nous
vous demandons de bien vouloir respecter la politique d'annulation suivante :

Annulations de Cours
- Jusqu'à 16 heures avant le cours, vous pouvez reporter la réservation vers
  un autre créneau du même cours en conservant le paiement et les places.
- Vous pouvez aussi transférer la séance à une autre personne, y compris à
  moins de 16 heures du cours. Aucun changement ni préavis à la réception
  n'est nécessaire : la personne remplaçante se présente sous le nom de la
  réservation d'origine.
- Une annulation volontaire, un changement d'avis ou une absence ne donne
  droit à aucun remboursement. Pour une réservation payée avec un abonnement,
  une annulation effectuée au moins 16 heures à l'avance re-crédite la séance.
- Moins de 16 heures avant le cours, le report n'est plus possible et la
  séance est due.
- Un remboursement n'est envisagé que si Revive ne peut pas honorer une
  séance payée ou si la responsabilité de Revive est confirmée par l'équipe.

Comment Annuler
- Les annulations doivent être effectuées via votre compte de réservation en
  ligne, sur l'application ou le site internet, ou en nous envoyant un message.
- En cas de problème technique, merci de nous prévenir par téléphone ou e-mail
  au moins 16 heures avant le début du cours.

Note pour Awa : ne propose ni ne promets jamais de remboursement pour une
annulation volontaire. Propose d'abord le report vers un autre créneau du même
cours avec reschedule_booking (≥ 16h : paiement et places conservés), ou le
transfert autonome à une autre personne en gardant la réservation intacte. Pour
un transfert, ne pas appeler handoff_to_human, ne rien modifier dans Wix et
indiquer que la personne remplaçante doit se présenter sous le nom de la
réservation d'origine. Si le client veut malgré tout libérer une réservation payée
directement, explique qu'elle est non remboursable et n'appelle cancel_booking
avec acknowledge_no_refund:true qu'après son accord explicite. Moins de 16h :
le report est refusé et la séance est due, mais le transfert autonome reste
possible. Pour une situation exceptionnelle ou une faute alléguée de Revive,
appeler handoff_to_human sans promettre d'issue et sans suggérer d'exemples
d'excuses valables.

## Enfants et bébés nageurs

- Les cours Natation Enfant et Bébé Nageur sont encadrés par un professionnel.
- Bébé Nageur : un parent accompagne le bébé dans l'eau. 
- Bébé Nageur : de 6 mois à 3 ans. Natation Enfant : à partir de 4 ans.
- Quand un parent annonce l'âge de l'enfant, vérifier qu'il correspond bien à
  la tranche ci-dessus avant de réserver, et proposer le bon cours si l'âge ne
  correspond pas. À 3 ans (dernière année de Bébé Nageur), confirmer que c'est
  ok et mentionner au passage qu'à 4 ans on passe en Natation Enfant.
- Bébé Nageur : couches de piscine jetables obligatoires pour le bébé (en
  vente au studio, voir tarif plus haut).


## Divers

- Places limitées par cours : la réservation à l'avance via Awa est recommandée.
- Vestiaires disponibles sur place : douches, serviettes et casiers fournis.
- Séance Privée et Pilates Privé : appeler handoff_to_human ; la réservation
  passe par la réception pour un accompagnement personnalisé.
  - Chaussettes antidérapantes, tenues et bouteilles en vente au studio
- Parking : oui.
- Accès piscine : la piscine est accessible aux membres en dehors des heures de
  cours.
- E-mail : support@revive.sn
- Site web : www.revive.sn
