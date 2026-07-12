# Revive — Business Info (source of truth for Awa)

<!--
  Awa (the WhatsApp assistant) answers general questions ONLY from this file.
  Anything not written here, she says she doesn't know and offers the reception
  contact. Edit freely — plain text, French or English. The server must be
  restarted (or redeployed) to pick up changes.

  ⚠️ Do NOT put class prices or schedules here — Awa always gets those live
  from Wix so they can never go stale.
-->

## Le studio

- Nom : Revive
- Adresse / localisation : Revive Studio, Dakar — plan Google Maps : https://maps.app.goo.gl/jJS8rS3sV5j41SGc9
- Téléphone réception (WhatsApp + appels) : +221 78 464 43 29
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

## Activités proposées

Awa : la liste des activités vient TOUJOURS du catalogue en direct — utilise
list_classes pour répondre à "quels cours proposez-vous ?", jamais une liste
mémorisée. (Idem prix et créneaux : outils uniquement.)

- Le Pilates Reformer se pratique par niveaux :
  - Foundation : pour ceux ou celles qui n'ont jamais fait de Pilates ou qui
    reviennent de blessure.
  - Sculpt : éligible après 3 cours.
  - Intense : si la coach donne son aval.


## À apporter / tenue

- Cours aquatiques (Aquabike, Aquagym, Natation, Bébé Nageur) : maillot de bain ou lycra
- Pilates, Yoga, Inversion, Fusion : tenue de sport confortable, chaussettes
  antidérapantes obligatoires pour le Reformer. Elles sont en vente au studio.
- Cardio Boxe : tenue de sport, baskets propres, bouteille d'eau.
- Arriver au moins 10 minutes avant le début du cours.

## Paiement

- Le paiement d'une séance se fait obligatoirement à l'avance.
- Via Awa (WhatsApp) : Wave uniquement. La place est confirmée après paiement
  (lien valable 20 minutes).
- Les abonnements et carnets s'achètent aussi directement via Awa (paiement
  Wave — utilise list_plans et create_plan_payment_link) ou sur le site web.
- Sur le site web (www.revive.sn) : Wave ou Orange Money, à l'avance également.

Note pour Awa : ne propose JAMAIS de passer au studio pour payer, et ne
mentionne JAMAIS la carte bancaire — ces options n'existent pas dans ta
bouche. Si le client ne peut pas payer par Wave maintenant (pas de compte
Wave, pas de solde, autre moyen de paiement souhaité...), utilise
handoff_to_human et donne-lui le numéro de la réception : l'équipe gérera
son cas directement.


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
est due ; pour une situation exceptionnelle, orienter vers la réception SANS
suggérer d'exemples d'excuses valables.

## Enfants et bébés nageurs

- Les cours Natation Enfant et Bébé Nageur sont encadrés par un professionnel.
- Bébé Nageur : un parent accompagne le bébé dans l'eau. 
- Bébé Nageur : de 6 mois à 3 ans. Natation Enfant : à partir de 4 ans.


## Divers

- Places limitées par cours : la réservation à l'avance via Awa est recommandée.
- Vestiaires disponibles sur place : douches, serviettes et casiers fournis.
- Séance Privée et Pilates Privé : la réservation passe par la réception pour
  un accompagnement personnalisé.
  - Chaussettes antidérapantes, tenues et bouteilles en vente au studio
- Parking : oui.
- Accès piscine : la piscine est accessible aux membres en dehors des heures de
  cours.
- E-mail : support@revive.sn
- Site web : www.revive.sn
