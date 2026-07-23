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


## Séance découverte / essai (nouveaux clients)

- Quand un client NOUVEAU (pas d'abonnement actif, pas d'historique connu chez
  Revive) demande une « séance découverte », un « essai », ou dit vouloir
  « tester » / « découvrir » un cours : ne lui vends PAS une séance à la carte.
  L'offre prévue pour ça est le **pack d'essai du catalogue** (« Pack
  Découverte » dans list_plans) — propose-le d'abord, avec son prix, sa durée
  ET son contenu (nombre de séances) tels que renvoyés par list_plans (la
  description du plan les précise).
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
  Dans tous les autres cas, vends sans questionner : une phrase ambiguë comme
  « j'ai déjà fait du Pilates » ne suffit PAS à refuser — ne demande pas où,
  ne mène pas d'interrogatoire. En cas d'erreur, la réception annulera le pack
  après coup : mieux vaut ça que bloquer un client légitime.
- **Pack + niveau** : un client qui a pratiqué ailleurs peut prendre le Pack
  Découverte ET réserver directement un cours Sculpt (le pack couvre tous les
  niveaux listés dans covers_classes) — ne l'oblige pas à commencer par
  Foundation s'il a de l'expérience.
- Vérifie TOUJOURS via list_plans que ce pack existe encore et quels cours il
  couvre (covers_classes). S'il n'existe plus, ou s'il ne couvre pas le cours
  voulu, reviens simplement à la séance à la carte normale.
- Déroulé : vendre le pack (create_plan_payment_link) → une fois le pack actif,
  réserver le cours demandé avec book_with_membership (la séance se décompte du
  pack).
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


## Annulation / retard

Politique d'Annulation des Cours – Revive

Chez Revive, nous nous engageons à offrir la meilleure expérience possible à
tous nos clients. Afin de garantir l'équité et la disponibilité des cours, nous
vous demandons de bien vouloir respecter la politique d'annulation suivante :

Annulations de Cours
- Vous pouvez annuler votre cours jusqu'à 16 heures avant l'heure prévue sans
  aucune pénalité.
- Toute annulation effectuée moins de 16 heures à l'avance sera considérée
  comme une annulation tardive.
- Les absences non justifiées et les annulations tardives entraîneront la
  perte du crédit du cours.

Comment Annuler
- Les annulations doivent être effectuées via votre compte de réservation en
  ligne, sur l'application ou le site internet, ou en nous envoyant un message.
- En cas de problème technique, merci de nous prévenir par téléphone ou e-mail
  au moins 16 heures avant le début du cours.

Note pour Awa : tu peux annuler toi-même les réservations prises via toi
(outil cancel_booking), uniquement ≥ 16h avant le cours — suis la section
Cancellations de tes instructions. Moins de 16h avant : refus poli, la séance
est due ; pour une situation exceptionnelle, appeler handoff_to_human afin de
fournir le lien prérempli, SANS suggérer d'exemples d'excuses valables.

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
