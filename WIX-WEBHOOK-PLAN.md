# Plan d'implémentation — Webhooks Wix (annulations en temps réel)

> ⚠️ **STATUT : MIS EN VEILLE (juillet 2026).** Décision produit : la réception
> coche "notifier le client" dans Wix lors d'une annulation — Wix envoie la
> notification officielle, et Awa ne message plus le client (le sweep 5 min ne
> fait plus qu'une synchro silencieuse de la base). L'intérêt temps-réel de ce
> webhook a donc disparu. Le plan reste valable techniquement si le besoin
> revient (ex : rappels, autres événements Wix). NE PAS implémenter sans
> demande explicite.

> Document destiné à un agent d'implémentation. Le projet est le bot WhatsApp "Awa"
> (Node 20 / TypeScript / Fastify / Postgres) déployé sur Railway
> (`https://resabot-production.up.railway.app`). Lire ce document en entier avant de coder.

## 1. Objectif

Aujourd'hui, les annulations faites par la réception dans le dashboard Wix sont détectées
par **polling** : un balayage toutes les 5 minutes (`src/domain/cancellationSync.ts`)
compare les réservations locales `BOOKED` aux statuts Wix, marque `CANCELLED` et prévient
le client sur WhatsApp.

But : recevoir un **webhook Wix "Booking Canceled" en temps réel** pour que le client soit
prévenu en quelques secondes au lieu de ≤ 5 minutes.

Le balayage existant est **conservé en filet de sécurité** (les webhooks peuvent se perdre),
mais son intervalle passe de 5 min à 30 min.

## 2. Décision d'architecture (déjà tranchée — ne pas re-débattre)

- **Custom app Wix** (https://manage.wix.com/account/custom-apps) : c'est le seul canal
  officiel pour recevoir des webhooks signés. L'API key REST utilisée par le reste du
  projet ne reçoit PAS de webhooks. L'app custom est privée (installée uniquement sur le
  site Revive), pas de review App Market.
  - Alternative rejetée : Wix Automations → "notifier par webhook" (pas de signature
    vérifiable, payload pauvre).
- Événement : `entityFqdn: "wix.bookings.v2.booking"`, `slug: "canceled"`.
  Souscrire aussi `declined` (même traitement).
- Les webhooks Wix arrivent sous forme de **JWT signé RS256** dans le corps de la requête
  (texte brut, pas JSON). Vérification avec la **clé publique de l'app** (page Webhooks du
  dashboard de l'app).
- Le webhook et le sweeper convergent vers la **même logique idempotente** : la transition
  atomique `BOOKED → CANCELLED` (`src/domain/stateMachine.ts`) ne réussit qu'une fois,
  donc un même événement traité deux fois (webhook + sweeper, ou doublon Wix) n'envoie
  qu'un seul message WhatsApp.

## 3. Étapes manuelles (dashboard Wix — à faire faire par l'humain, lui donner ces instructions)

1. Aller sur https://manage.wix.com/account/custom-apps (compte propriétaire du site
   Revive) → **Build Custom App** / créer une app, nom : `Awa Webhooks`.
2. Dans l'app : **Permissions** → ajouter la permission de lecture Wix Bookings
   ("Read Bookings" / Bookings — Manage Bookings si read seul indisponible).
3. **Webhooks** → Add Webhook :
   - Catégorie **Bookings** → événement **Booking Canceled** ;
   - URL de callback : `https://resabot-production.up.railway.app/webhooks/wix` ;
   - Ajouter de la même façon **Booking Declined** sur la même URL.
4. Sur la page Webhooks, cliquer **Get Public Key** et copier la clé PEM
   (`-----BEGIN PUBLIC KEY----- ...`).
5. **Installer l'app sur le site Revive** (bouton Install / Test your app → choisir le
   site). ⚠️ Ajouter un webhook crée une nouvelle version de l'app : si des webhooks sont
   ajoutés après installation, mettre à jour la version installée sur le site.
6. La page Webhooks de l'app a un onglet **Logs** : il liste tous les webhooks envoyés —
   c'est l'outil de debug principal côté Wix.

## 4. Configuration

- Nouvelle variable d'env **`WIX_WEBHOOK_PUBLIC_KEY`** (optionnelle dans `src/config.ts`,
  comme les vars SMTP : si absente → route répond 503 et log un warning au boot, le
  sweeper reste le seul mécanisme).
  - La clé est un PEM multi-lignes. Sur Railway, la stocker **en base64**
    (`base64 < key.pem`) et la décoder au boot, OU avec des `\n` littéraux remplacés au
    chargement (`value.replace(/\\n/g, "\n")`). Implémenter le support des deux : si la
    valeur ne commence pas par `-----BEGIN`, la traiter comme base64.
- Dépendance npm à ajouter : **`jsonwebtoken`** (+ `@types/jsonwebtoken` en dev).
  Vérification : `jwt.verify(token, publicKey, { algorithms: ["RS256"] })`.

## 5. Implémentation (fichiers)

### 5.1 `src/webhooks/wix.ts` (nouveau) — la route

`POST /webhooks/wix`, enregistrée dans `src/server.ts` à côté des routes WhatsApp/Wave.

Contraintes impératives :

- **Le corps est le JWT en texte brut.** Le serveur a déjà un content parser custom pour
  garder le rawBody (voir `src/server.ts`) — vérifier qu'il accepte aussi
  `Content-Type: text/plain` (et l'absence de content-type). Ajouter un
  `app.addContentTypeParser` pour `text/plain` si nécessaire. Utiliser le corps brut
  (string) comme token.
- **Répondre 200 en < 1250 ms** sinon Wix considère l'envoi échoué et fait jusqu'à
  12 retries (1 min, 10 min, 1 h, ...). Donc : vérifier le JWT, répondre 200
  immédiatement, et traiter en asynchrone (`setImmediate`) — même patron que
  `src/webhooks/wave.ts`.
- JWT invalide / clé absente → 401 (ou 503 si pas de clé configurée) + log warn.

Décodage du payload (structure Wix, niveaux de JSON "stringifié" imbriqués) :

```ts
const claims = jwt.verify(rawBody, publicKey, { algorithms: ["RS256"] }) as any;
// claims.data est une STRING JSON → la parser
const outer = JSON.parse(claims.data);
// outer contient instanceId, eventType, et selon les événements les données sont
// encore une string JSON dans outer.data — parser défensivement :
const event = typeof outer.data === "string" ? JSON.parse(outer.data) : outer;
// Champs attendus : event.entityFqdn === "wix.bookings.v2.booking",
// event.slug === "canceled" | "declined", event.entityId (= wix booking id),
// event.id (= event id unique), event.actionEvent?.body?.booking (objet booking complet)
```

⚠️ La structure exacte des imbrications varie selon l'ancienneté de l'événement : coder un
petit normaliseur défensif qui cherche `entityFqdn`/`slug`/`entityId`/`id` aux deux
niveaux, et logger le payload décodé au niveau info pendant la phase de test.

Traitement asynchrone :

1. **Idempotence** : `repo.alreadyProcessed("wixwh:" + event.id, "wix")` (table
   `processed_webhooks` existante) → si déjà vu, stop.
2. Filtrer : `entityFqdn === "wix.bookings.v2.booking"` et
   `slug ∈ {"canceled","declined"}` — tout le reste : log info + stop.
3. `entityId` = l'id de booking Wix → chercher dans `pending_bookings` la ligne avec
   `wix_booking_id = entityId` et statut `BOOKED`. Introuvable → log info + stop (c'est
   une résa faite hors Awa : site web / studio — hors périmètre).
4. Appeler la logique partagée d'annulation (voir 5.2) : transition `CANCELLED` +
   message WhatsApp proactif au client.

### 5.2 Refactor `src/domain/cancellationSync.ts` — partager la logique

Extraire de `syncCancellations` une fonction exportée :

```ts
export async function handleWixCancellation(bookingRow, log): Promise<boolean>
// - repo.markCancelled(...) (transition atomique BOOKED→CANCELLED ; si elle échoue,
//   quelqu'un l'a déjà traitée → return false, NE PAS envoyer de message)
// - cancellationMessage(lang, ...) existant (fr/en/wo) + sendText + repo.addTurn
```

⚠️ Aujourd'hui `repo.markCancelled` est appelé AVANT l'envoi du message sans vérifier
son résultat. Pour l'idempotence webhook+sweeper, la fonction partagée doit **n'envoyer
le message que si la transition a réellement eu lieu** (markCancelled doit retourner la
ligne mise à jour ou null — adapter `src/domain/repo.ts` si besoin, la fonction
`transition()` de `stateMachine.ts` fait déjà ça).

Le sweeper `syncCancellations` appelle ensuite cette fonction partagée, et son intervalle
dans `src/index.ts` passe de 5 min à **30 min** (c'est un filet de sécurité).

### 5.3 `src/server.ts` / `src/index.ts`

- Enregistrer la route, parser `text/plain`.
- Au boot : si `WIX_WEBHOOK_PUBLIC_KEY` absente → `console.warn` explicite.

### 5.4 Simulateur — `scripts/simulate-wix-webhook.ts` (nouveau)

Même esprit que `scripts/simulate-wave-webhook.ts` :

- Génère une paire de clés RSA de test OU utilise une clé privée locale passée en env
  (`WIX_WEBHOOK_TEST_PRIVATE_KEY`), signe un JWT reproduisant la structure Wix
  (avec les niveaux stringifiés), et POST sur `http://localhost:3000/webhooks/wix`.
- Options : `--booking-id <wixBookingId>`, `--slug canceled|declined`,
  `--bad-signature`.
- Pour tester en local il faut mettre la clé publique de test dans
  `WIX_WEBHOOK_PUBLIC_KEY`.

### 5.5 Tests (`test/`)

Le projet utilise vitest (34 tests existants — ils doivent tous continuer à passer).

- `test/wixWebhook.test.ts` :
  - JWT signé avec la bonne clé → accepté et payload correctement normalisé
    (tester les deux variantes d'imbrication) ;
  - mauvaise signature → rejeté ;
  - slug non géré → ignoré sans erreur ;
  - clé au format base64 et au format PEM avec `\n` → toutes deux chargées.
- Ne PAS écrire de test qui nécessite Postgres ou le réseau (les tests existants sont
  purs — suivre ce modèle : tester la vérification/normalisation en isolant la logique
  dans des fonctions exportées).

## 6. Pièges connus (lire attentivement)

1. **Fenêtre WhatsApp de 24 h** : le message proactif d'annulation ne peut être délivré
   que si le client a écrit au bot dans les dernières 24 h. C'est une limite Meta déjà
   présente avec le sweeper actuel — ne pas essayer de la résoudre ici (les templates
   Meta sont un chantier Phase 2 séparé). Logger l'échec d'envoi sans faire échouer le
   traitement.
2. **Doublons et désordre** : Wix prévient explicitement que les événements peuvent
   arriver en double et dans le désordre → l'idempotence par `event.id` + transition
   atomique est obligatoire (déjà prévu ci-dessus).
3. **Ne PAS toucher au flux de création de réservation** : l'invariant central du projet
   est "aucune réservation Wix avant paiement Wave vérifié" (`src/webhooks/wave.ts`).
   Ce chantier est purement entrant (notifications).
4. **Résas hors Awa** : un booking annulé qui n'est pas dans `pending_bookings` est
   normal (résa site web/studio) — log info, pas d'erreur.
5. **Annulation demandée par le client par téléphone** : le message proactif part quand
   même — c'est voulu, la formulation neutre existante ("Si ce n'est pas toi qui l'as
   demandé...") couvre ce cas. Réutiliser `cancellationMessage` tel quel.
6. Le rawBody parser actuel de `server.ts` est pensé pour JSON (signatures WhatsApp/Wave)
   — vérifier que l'ajout du parser `text/plain` ne casse pas les deux webhooks existants
   (les tests de signature existants doivent passer).

## 7. Déploiement & validation E2E

1. `npm run build && npm test` (34 tests existants + nouveaux, tous verts).
2. Test local avec le simulateur (`npm run dev` + `simulate:wix`).
3. Railway : `railway variable set WIX_WEBHOOK_PUBLIC_KEY=<base64 du PEM>` (CLI 5.x :
   `railway variable set KEY=VALUE`, utiliser `--stdin` pour les valeurs multilignes),
   puis `railway up --detach`, attendre le healthcheck (`/healthz`).
4. **Test réel** (avec l'humain) :
   - faire une réservation payée via Awa (il existe un service de test à 10 FCFA) ;
   - annuler cette résa dans le dashboard Wix ;
   - vérifier : message WhatsApp reçu en < 30 s ; ligne `CANCELLED` en base ; onglet
     Logs de l'app Wix → webhook livré avec 200 ; logs Railway propres.
5. Vérifier que le sweeper (désormais 30 min) ne renvoie PAS de second message pour la
   même annulation.
6. Mettre à jour `README.md` (section webhooks), `PHASE2.md` (cocher l'item), et
   `.env.example` (`WIX_WEBHOOK_PUBLIC_KEY`).

## 8. Références

- À propos des webhooks Wix (JWT, clé publique, retries, doublons) :
  https://dev.wix.com/docs/build-apps/develop-your-app/api-integrations/events-and-webhooks/about-webhooks
- Événement Booking Canceled (schéma, `wix.bookings.v2.booking` / `canceled`) :
  https://dev.wix.com/docs/rest/business-solutions/bookings/bookings-and-time-slots/bookings-v2/bookings-v2-and-confirmation/booking-canceled
- Exemple de vérification JWT self-hosted :
  https://dev.wix.com/docs/build-apps/develop-your-app/develop-a-self-managed-app/webhooks/handle-events-with-webhooks-for-self-hosting-using-the-java-script-sdk
- Astuce : ajouter `.md` à n'importe quelle URL `dev.wix.com/docs/...` pour obtenir la
  version markdown de la doc.
