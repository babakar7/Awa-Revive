# Clés de la Maison — plan final et gestion des abonnements legacy

Référence d’exécution arrêtée le 27 juillet 2026. Wix reste la source de vérité
des crédits. Resabot ne conserve que les relations entre commandes, les droits
que Wix ne sait pas représenter et les états de synchronisation.

## Offre

| Clé | Prix | Validité | Reformer | Cours bonus |
|---|---:|---:|---:|---:|
| L’Invitée — Clé 3 séances | 30 000 F | 21 jours | 3 | 1 |
| L’Habituée — Clé 6 séances | 72 000 F | 30 jours | 6 | 1 |
| La Résidente — Clé 12 séances | 144 000 F | 60 jours | 12 | 2 |

L’Invitée est un nouveau plan distinct. Le Pack Découverte complet reste
indépendant et ferme aux nouvelles ventes lors de la bascule. Les Étapes 1 et 2
restent disponibles uniquement pour achever les parcours déjà engagés.

Un cours bonus est limité à Aquabike, Yoga, Mat ou Step du lundi au vendredi.
Une invitation est limitée au Reformer de 12h30 du lundi au vendredi. Bonus et
invitations sont définitifs dès réservation : aucun changement, annulation,
report ou restitution de crédit par Awa.

## Anciens abonnements

### Fermés aux nouvelles ventes à la bascule

- Reformer 1×, 2× et 3× par semaine ;
- Carnet de 10 Reformer ;
- 1× Reformer + 1× Aquabike ;
- 1× Reformer + 1× Yoga ;
- 1× Reformer + 1× Aquabike + 1× Step ;
- 2× Reformer + 1× Yoga ;
- Pilates 360 2× et 3× par semaine.

Les détentrices les conservent jusqu’à leur échéance et deviennent Membres
Fondatrices pendant leur ordre actif : piscine les jours de séance,
bibliothèque et massage au tarif membre. Elles n’obtiennent ni cours bonus, ni
invitation normale, ni prolongation sur l’ancien abonnement.

### Conservés

Aquafitness, Pilates Mat, Carnet de 10 Aquabike et carnets
Bébé nageur/Natation restent inchangés. Revue commerciale à J+30.

### Argumentaire honnête

Les anciens abonnements ne comportent pas de remise : leurs prix correspondent
aux séances unitaires sur quatre semaines. Les Clés gardent le prix de référence
de 12 000 F par séance Reformer ; les avantages de maison font la différence.

Pour une cliente à deux Reformer par semaine ou davantage, la conversion est
neutre ou favorable. Exemple : 2× Reformer + 1× Yoga coûte 136 000 F sur quatre
semaines. Une Résidente consommée en six semaines représente 96 000 F de
Reformer par quatre semaines, avec environ 1,3 Yoga couvert par ses bonus, soit
environ 123 000 F avant les autres avantages.

Une cliente strictement à un Reformer par semaine doit en revanche accélérer
son rythme à environ 1,4 séance par semaine ou payer plus cher par séance
effectivement consommée. Awa annonce toujours le nombre de séances et la
validité, sans promettre une équivalence. Les cas sensibles passent à la
réception.

## Continuité et invitations

Les invitations gagnées lors d’une nouvelle Clé sont :

- avantage normal : Habituée 0, Résidente 1 ;
- bonus de continuité : +1 lorsque la cliente achète avant l’échéance d’une Clé
  précédente ou d’un abonnement legacy Reformer actif.

Résultats : Fondatrice vers Habituée avant échéance = 1 ; vers Résidente = 2.
Après échéance : 0 et 1. Les mêmes règles s’appliquent Clé vers Clé.

La source est déterminée par le serveur à la date du paiement vérifié :

1. Clé active en priorité ;
2. sinon abonnement legacy Reformer couvrant cette date ;
3. si plusieurs legacy se chevauchent, échéance la plus tardive ;
4. les abonnements hors Reformer sont ignorés.

Le lien de paiement mémorise une source provisoire, mais aucun droit de
continuité. Au passage atomique à `PAID`, le serveur relit la source et son
échéance effective, enregistre `paid_at`, recalcule les invitations et fixe la
date de démarrage. Une prolongation accordée entre le lien et le paiement est
donc respectée. Si la source est déjà expirée au paiement, la Clé démarre
immédiatement et aucun bonus de continuité n’est accordé.

Si la source legacy choisie a un solde nul ou illisible, la date sûre reste son
échéance, mais la réception reçoit une alerte pour avancer éventuellement le
démarrage.

Le webhook Wix `Order Purchased` du comptoir applique exactement le même calcul
avec `order.createdDate`. Un webhook retardé recherche la source qui couvrait
cette date. Si la Clé a déjà été démarrée dans Wix avant l’échéance legacy,
Resabot ne modifie ni n’annule la commande : il alerte la réception.

## Unicité de L’Invitée

L’offre est refusée si le compte possède :

- une réservation passée Revive, toutes disciplines ; ou
- une commande Wix, quel que soit son statut, sur le Pack Découverte complet
  ou sur L’Invitée.

Les commandes Wix de test comptent. Un lien local abandonné sans commande Wix
ne compte pas. En cas d’erreur Wix, la vente reste autorisée et l’incident est
journalisé. En cas de contestation après détection d’une ancienne commande,
Awa transmet à la réception, qui peut vendre au comptoir après vérification
qu’aucune séance ni aucun bonus n’a été utilisé.

Message :

> Une ancienne commande Pack Découverte ou L’Invitée apparaît sur ton compte.
> Comme cette offre est limitée à une fois par personne, je ne peux pas
> l’activer automatiquement. Si cette commande avait été annulée avant ton
> essai, je peux transmettre ta demande à la réception pour vérification.

## Relance L’Invitée : une seule conversion

Les rappels J-5 et 24 h avant la troisième séance sont deux branches
alternatives, jamais deux messages pour la même Clé :

- si la troisième séance est déjà réservée, envoyer uniquement la relance 24 h
  avant cette séance ;
- si aucune troisième séance n’est réservée à J-5, envoyer uniquement la
  relance J-5 ;
- dès que l’une des deux branches a envoyé ou tenté son message, l’autre est
  définitivement supprimée pour cette Clé, même si la troisième séance est
  réservée ensuite.

Les deux templates Meta restent nécessaires parce que leurs contextes et leurs
variables diffèrent, mais ils partagent un claim durable unique
`INVITEE_CONVERSION:<key_id>`.

## Relance Fondatrices à J-5

Une seule relance est claimée par commande Wix legacy, avec issue durable
`sent`, `suppressed` ou `failed`. Un échec n’est pas retenté. Lorsque les Clés
sont actives, les plans legacy sortent du rappel générique de renouvellement.

Template Meta, deux variables (`prénom`, `date`) :

> Bonjour {{prénom}} ✦ Ton abonnement arrive à sa fin le {{date}}. Pour
> continuer, tu peux choisir L’Habituée — 6 séances sur 30 jours — ou La
> Résidente — 12 séances sur 60 jours.
>
> Si tu reprends ta Clé avant cette date, tu reçois des invitations Reformer à
> offrir à des personnes de ton choix qui n'ont jamais fait de Reformer chez Revive :
> une avec L’Habituée, deux avec La Résidente. Elles sont valables sur notre
> créneau calme de 12h30, du lundi au vendredi, sur réservation.
>
> Réponds à ce message et Awa t’aide à choisir ta Clé.

## Garde-fous de lancement

- `AWA_SELLABLE_PLAN_IDS` est deny-by-default ;
- `KEYS_AUTOMATION_ENABLED=false` jusqu’à la bascule ;
- les droits Fondatrice et les relances de conversion sont eux aussi derrière
  ce switch ;
- `LEGACY_REFORMER_PLAN_IDS` contient seulement les dix plans couvrant le
  Reformer ;
- `INVITEE_HISTORY_PLAN_IDS` contient le Pack complet et L’Invitée ;
- les vrais prix Wix restent en place pour la répétition générale.

Avant fermeture du catalogue, tester sur un seul plan legacy déjà masqué la
mutation Wix V3 `visibility=PRIVATE` et `buyable=false`, puis restaurer
automatiquement son état. Si l’API refuse, la réception désactive l’achat dans
le dashboard. L’allowlist protège Awa, mais la visibilité seule ne suffit pas.
Ne jamais archiver un plan.

Validation du 27 juillet : probe réussi sur Pilates 360 privé, `buyable`
temporairement passé de `true` à `false`, relu, puis restauré et revérifié à
`true`. L’authentification API key et la révision V3 sont donc compatibles.

## Bascule

Dans une seule opération contrôlée :

1. mettre les 3 Clés dans `AWA_SELLABLE_PLAN_IDS` ;
2. retirer les legacy Reformer et le Pack complet ;
3. renseigner les IDs legacy/historique et le template J-5 ;
4. fermer les legacy et le Pack sur le site Wix (`PRIVATE`, `buyable=false`) ;
5. passer `KEYS_AUTOMATION_ENABLED=true` ;
6. déployer une seule fois et exécuter la répétition générale masquée avant la
   communication publique.

Les commandes existantes restent intactes. Les offres hors Reformer restent
vendables. Après lancement : surveillance 48 h, puis bilan J+30.
