# Plan — Plus jamais de réservation Wix sans fiche contact

> **STATUT : PROPOSÉ (20/08/2026), en attente du go de Babakar.** Toutes les
> mesures de §1 viennent d'un relevé live de l'API Wix + de la base de prod le
> 20/08. Chantier prévu : `npm run agent:new -- booking-contact-always`.

## 0. Objectif

Qu'**aucune réservation créée par Awa ne parte sans `contactId`**. Aujourd'hui
une cliente qui paie sa séance sans jamais passer par le flux « compte / email »
n'a aucune fiche dans le CRM Wix : sa réservation porte juste un prénom et un
numéro, et le tableau de bord Wix la rapproche visuellement d'un homonyme.

## 1. Le cas, et son ampleur

**Penda, lundi 17/08, Reformer Sculpt 11h15–12h05.** Payé 12 000 F par Wave à
09h39, réservation Wix `60c35f2b`, tout est nominal côté paiement. Mais :

- la réservation porte `contactDetails: { firstName: "Penda", phone: "+221789580984" }`
  — **pas de `contactId`** ;
- **aucun contact Wix du site ne porte ce numéro** (vérifié par filtre `phone`,
  filtre `e164Phone` et recherche plein-texte) ;
- le site compte **9 contacts « Penda »**, dont un nommé exactement « Penda »
  (+221 76 529 58 11, créé en septembre 2025, **2 réservations, toutes en
  septembre 2025**, aucune le 17/08) ;
- c'est **ce numéro-là** que Babakar voit dans la liste de participants.

Donc l'interface affiche l'homonyme. La réception qui appelle « la Penda du
lundi 11h15 » tombe sur quelqu'un d'autre.

**Ce n'est pas isolé.** Relevé du 01/07 au 20/08 (950 réservations non annulées) :

| Mesure | Valeur |
|---|---|
| Réservations créées par Awa (`createdBy: APP`) | 121 |
| …dont **sans `contactId`** | **12 (10 %)** |
| Clientes distinctes concernées | 9 |
| Réservations orphelines d'autres sources (réception, site) | 64 |

Les 12 orphelines d'Awa, toutes **PAID** :

```
14/07 12:00  Pilates Fusion (test)          Babakar       +221774982711
14/07 12:00  Pilates Fusion (test)          Khadija       +447349618069
29/07 16:15  Bébé Nageur                    Leila         +221771498068
05/08 12:30  Pilates Reformer (Sculpt)      Jessica       +221781330312
06/08 11:15  Pilates Reformer (Sculpt)      Julian        +13478314560
07/08 17:15  Pilates Reformer (Foundation)  Yacine        +221783708795
13/08 11:15  Aquabike (Intermédiaire)       Djibril       +221778873873
15/08 11:15  Pilates Reformer (Sculpt)      Julian        +13478314560
15/08 11:15  Aquabike (Intermédiaire)       Djibril       +221778873873
17/08 11:15  Pilates Reformer (Sculpt)      Penda         +221789580984
18/08 12:30  Pilates Reformer (Sculpt)      Fall Marème   +33672648957
19/08 10:15  Pilates Reformer (Sculpt)      Djibril       +221778873873
```

**Djibril y revient trois fois, Julian deux fois** : ce sont des clientes
fidèles qui restent invisibles du CRM séance après séance. Coût réel : pas
d'historique, pas d'éligibilité abonnement possible (l'index d'éligibilité Wix
travaille par contact), pas de ciblage marketing, et un risque d'attribution à
un homonyme.

## 2. Cause racine

Un seul endroit décide, [src/lib/wix.ts:3121](src/lib/wix.ts#L3121) :

```ts
const contact = args.resolvedContact === undefined
  ? await findContactByPhone(args.phone, args.name)
  : args.resolvedContact;
// …
contactDetails: {
  ...(contact?.id ? { contactId: contact.id } : {}),   // ← rien trouvé = rien attaché
  ...contactName,
  phone: args.phone,
},
```

`findContactByPhone` est **délibérément conservateur** (commentaire d'origine :
« lier le MAUVAIS contact est pire que d'en créer un nouveau ») et renvoie
`null` dans **deux cas très différents** :

1. **aucun contact** avec ce numéro → il faudrait en créer un ;
2. **plusieurs contacts** et le prénom ne tranche pas → il ne faut surtout PAS
   en créer un de plus.

Le code aval traite ces deux cas de la même façon : il réserve sans fiche.
Personne ne crée jamais la fiche manquante sur le chemin « paiement d'une
séance à l'unité ».

## 3. Ce qui existe déjà — et pourquoi ça ne suffit pas

- **Le backfill du cas « A »** (PROGRESS §6.6bis,
  [src/domain/bookingContactBackfill.ts](src/domain/bookingContactBackfill.ts))
  sait rattacher a posteriori les réservations orphelines des 60 derniers jours
  **dès qu'une fiche prouvée existe**. Il est déclenché après vérification email
  et après chaque réservation où un contact a été résolu. Il fonctionne — mais
  il lui faut une fiche à laquelle se raccrocher. Pour une cliente qui n'a
  jamais donné d'email, cette fiche n'arrive jamais.
- **La création sans vérification**
  ([src/domain/unverifiedAccounts.ts](src/domain/unverifiedAccounts.ts)) crée
  bien un contact au bout de 5 min de silence — mais **uniquement** pour les
  clientes engagées dans le flux `link_requests` (nom + email déjà donnés). Une
  cliente qui réserve et paie en 2 minutes n'y entre jamais.

Le trou est donc précis : **paiement d'une séance à l'unité, cliente sans fiche,
sans passage par le flux compte**. C'est exactement le cas Penda.

## 4. Décision produit

**Quand la résolution par téléphone ne trouve AUCUN contact, Awa crée la fiche
avant de réserver, puis réserve avec ce `contactId`.**

Corollaires non négociables :

- **Ambiguïté ≠ absence.** On ne crée JAMAIS quand plusieurs contacts portent le
  numéro sans que le prénom tranche : on garde le comportement actuel (résa sans
  `contactId`) et on le signale (§7). Créer là, ce serait fabriquer des doublons
  — le mal que le code d'origine évitait à raison.
- **La création ne peut jamais faire échouer une réservation payée.** Le
  paiement est déjà encaissé : si `createContact` échoue, on réserve quand même
  en inline, comme aujourd'hui. Aucun remboursement, aucun handoff déclenché par
  ce chemin (même posture que §3 pour `unverifiedAccounts`).
- **Pas de fiche fabriquée avec un nom poubelle.** Le prénom de profil WhatsApp
  peut valoir « A » ou « L » (incident 6.6bis). Voir la règle de qualité ci-dessous.

## 5. Règles détaillées

### 5.1 Quand créer

Remplacer `findContactByPhone` par `resolvePhoneContact`
([src/lib/wix.ts:1708](src/lib/wix.ts#L1708)), qui distingue déjà les trois cas :

| Résolution | Action |
|---|---|
| `one` | rattacher (comportement actuel) |
| `none` **et** nom exploitable | **créer la fiche**, puis rattacher |
| `none` **et** nom douteux | réserver en inline + marquer `contact_gap='bad_name'` |
| `ambiguous` | réserver en inline + marquer `contact_gap='ambiguous'` |
| lecture Wix en échec | réserver en inline + marquer `contact_gap='lookup_failed'` |

### 5.2 Nom exploitable

Un nom est exploitable s'il fait **≥ 2 caractères** après trim et contient au
moins deux lettres (hors emoji/ponctuation). « Penda », « Fall Marème » : oui.
« A », « L », « 🌸 » : non. Le nom utilisé est celui déjà retenu par le flux de
réservation (`client.name`, confirmé par la cliente au moment du paiement), pas
le nom de profil WhatsApp brut quand les deux diffèrent.

Un nom non exploitable ne bloque pas la vente : la réservation part comme
aujourd'hui, et la ligne est listée dans le rapport §7 pour que la réception
complète la fiche à la venue.

### 5.3 Idempotence et concurrence

- La création passe par un **verrou consultatif Postgres sur le numéro**
  (`pg_advisory_xact_lock(hashtext('wixcontact:'||phone))`), pour que deux
  paiements simultanés de la même cliente ne créent pas deux fiches.
- Sous le verrou, on **re-résout** avant de créer : si une autre passe vient de
  créer la fiche, on la réutilise.
- L'id créé est mémorisé côté local (colonne `clients.wix_contact_id`, **à
  créer** : elle n'existe pas aujourd'hui) pour éviter une requête Wix à chaque
  réservation suivante — mais la vérité reste Wix : en cas d'écart, Wix gagne.

### 5.4 Contenu de la fiche

`createContact({ name, phone, email? })` existe déjà
([src/lib/wix.ts:1935](src/lib/wix.ts#L1935)) et gère la mise en forme
sénégalaise du numéro. On y ajoute l'email **seulement s'il est connu et prouvé**
(`clients.claimed_email` validé) — jamais un email deviné, qui casserait la
future vérification de compte.

### 5.5 Où brancher

Dans [src/domain/fulfillment.ts](src/domain/fulfillment.ts), juste avant
`guardBooking(...)` : c'est le seul point de création de réservation payée, et
il détient déjà `client`, `phone` et le contact résolu. Le `resolvedContact`
passé à `createBooking` devient alors non nul dans le cas `none`, ce qui a un
effet de bord heureux : le **backfill existant se déclenche derrière** et
rattrape les réservations antérieures de la même cliente (Djibril, Julian).

Hors périmètre : les réservations par abonnement, qui possèdent forcément un
contact (le décompte du plan passe par lui).

## 6. Rattrapage de l'existant

Script one-shot `scripts/backfill-orphan-booking-contacts.ts`, en **deux temps
avec confirmation** :

1. **Dry-run** : liste les réservations Wix sans `contactId` créées par Awa sur
   90 jours, et pour chaque numéro la résolution (`none` / `ambiguous` / `one`).
2. **Exécution** : pour les `one`, rattachement direct via
   `backfillBookingContacts` (déjà écrit, déjà éprouvé) ; pour les `none` avec
   nom exploitable, création de la fiche puis rattachement ; les `ambiguous`
   sont **listés pour arbitrage humain**, jamais traités automatiquement.

Sur les 12 lignes actuelles, on attend 9 fiches créées ou retrouvées — les deux
« Pilates Fusion (test) » du 14/07 sont des tests (Babakar, Khadija) et seront
sautées via `clients.is_test`.

## 7. Détection permanente — pour que ça ne revienne jamais

Corriger le flux ne suffit pas : il faut qu'une régression se **voie**.

- **Marqueur local** : colonne `pending_bookings.contact_gap` (nullable,
  `'ambiguous' | 'bad_name' | 'lookup_failed' | 'create_failed'`) écrite au
  moment de la réservation. Une réservation saine la laisse à `null`.
- **Balayage quotidien** (sweeper 5 min existant, une passe par jour) : compte
  les réservations Wix des 7 derniers jours créées par Awa sans `contactId`.
  Au-delà de **0**, ligne dans le journal admin ; au-delà de **3 sur 7 jours**,
  alerte WhatsApp au owner via le canal des alertes existant. Le seuil évite le
  bruit des cas `ambiguous` légitimes.
- **Vue admin** : encart « Réservations sans fiche client » sur `/admin/crm`,
  avec pour chaque ligne le nom, le numéro, la raison, et un bouton
  **« Créer la fiche »** / **« Rattacher à… »** pour les cas ambigus. C'est le
  filet pour ce que l'automatisme refuse de trancher.

## 8. Tests

- **Purs** (`npm test`) : la décision `contactPlanForBooking(resolution, name)`
  extraite en fonction pure — crée / n'crée pas / raison — avec les cas `one`,
  `none`+bon nom, `none`+« A », `ambiguous`, échec de lecture.
- **Intégration** (`npm run test:integration`, obligatoire : on touche au flux
  paiement) : un paiement Wave d'une cliente inconnue crée la fiche puis la
  réservation avec `contactId` ; un `createContact` qui jette laisse quand même
  la réservation partir (et pas de refund) ; deux paiements concurrents de la
  même cliente ne créent qu'une fiche.
- **Vérification prod** après déploiement : rejouer le relevé du §1 une semaine
  plus tard — la part d'orphelines d'Awa doit être à 0 hors `ambiguous`.

## 9. Risques et ce qu'on ne fait PAS

- **Doublons CRM** — le risque principal. Neutralisé par : ne créer que sur
  `none`, re-résoudre sous verrou, et couvrir les orthographes locales du numéro
  (`phoneMatchVariants` couvre déjà « 77 444 66 66 » brut saisi par la réception).
- **Un appel Wix de plus dans le chemin payé** : +1 requête (~300 ms) seulement
  quand la cliente est inconnue, et jamais bloquante. Le paiement est déjà
  encaissé, la réservation ne peut pas échouer à cause de ça.
- **Les 64 réservations orphelines d'autres sources** (réception, site web) sont
  **hors périmètre** : elles viennent de l'interface Wix elle-même, pas d'Awa,
  et se corrigent côté process réception. À décider séparément — le rapport §7
  les rendra visibles.
- **On ne crée pas de compte membre (site member)**, seulement un contact CRM.
  L'accès au compte en ligne reste conditionné à la vérification email
  existante, inchangée.

## 10. Checklist de livraison

- [ ] `contactPlanForBooking` pur + tests unitaires
- [ ] `resolvePhoneContact` branché dans `fulfillment.ts` + création sous verrou
- [ ] Colonne `pending_bookings.contact_gap` + `clients.wix_contact_id`
- [ ] Tests d'intégration (flux paiement → `npm run agent:ship -- --full`)
- [ ] Script de rattrapage, dry-run montré à Babakar avant exécution
- [ ] Balayage quotidien + seuil d'alerte
- [ ] Encart `/admin/crm` « Réservations sans fiche client »
- [ ] PROGRESS.md : nouvelle sous-section sous 6.6bis (le cas Penda + la mesure)
- [ ] Contrôle prod à J+7 : part d'orphelines d'Awa = 0 hors `ambiguous`
