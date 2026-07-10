# CLAUDE.md — à lire EN PREMIER

Bot WhatsApp **Awa** : réserve des cours du studio **Revive** (Dakar) dans **Wix
Bookings**, paiement d'abord via **Wave** (mobile money) ou décompte d'un
**abonnement** Wix. Node 20 / TypeScript / Fastify / Postgres / `@anthropic-ai/sdk`.

## Commence toujours par lire, dans cet ordre

1. **[PROGRESS.md](PROGRESS.md)** — journal d'avancement : état exact, décisions,
   pièges découverts en prod, chronologie, reste à faire, runbook ops. **C'est la
   source de vérité vivante — lis-le en entier avant de toucher au code.**
2. **[README.md](README.md)** — setup, architecture, variables d'env, simulation
   des paiements.
3. **[PHASE2.md](PHASE2.md)** — backlog priorisé (ce qui est hors périmètre actuel).
4. **[business-info.md](business-info.md)** et **[cafe-menu.md](cafe-menu.md)** —
   sources de vérité métier d'Awa, **lues au boot** (redéployer après édition).
5. **[WIX-WEBHOOK-PLAN.md](WIX-WEBHOOK-PLAN.md)** — chantier **EN VEILLE**, ne pas
   implémenter sans demande explicite.

## Invariants non négociables

- **Paiement d'abord** : aucune réservation Wix n'est créée avant qu'un webhook
  Wave signé soit vérifié (ou qu'une séance d'abonnement soit décomptée). Le
  point unique de création est le handler webhook Wave ([src/webhooks/wave.ts](src/webhooks/wave.ts)).
- **Le modèle propose, le serveur décide** : prix TOUJOURS depuis le catalogue Wix
  ou `cafe-menu.md` (jamais du modèle) ; `event_id`s validés contre `slot_cache`
  (anti prompt-injection) ; règle des 16h et fenêtres de dates recalculées côté
  serveur. Ne jamais déplacer une décision de prix/date/éligibilité vers le prompt.
- **Ne jamais nommer un cours en dur** dans `business-info.md` ni le prompt : le
  catalogue vient TOUJOURS de `list_classes` (live Wix). business-info ne contient
  que les règles que Wix n'expose pas (niveaux, tenue, prérequis). Un cours écrit
  en dur qui n'existe pas dans Wix = Awa le propose à tort (bug réel, 10/07).

## Workflow

- **Avant tout push : `npm run build && npm test`** (90 tests purs, sans réseau).
  Intégration : `npm run test:integration` (Postgres jetable Docker).
- **Déploiement : auto-deploy** — `git push` sur `main` (`babakar7/Awa-Revive`)
  rebuild et redéploie sur Railway. Fallback manuel : `railway up --detach` (ne
  PAS combiner avec un push pour le même changement = double build). Santé :
  `GET /healthz`. Détails ops : PROGRESS.md §7.
- Prod : `https://resabot-production.up.railway.app`. Numéro Awa : +221 78 953 66 76.
- Après un changement produit non trivial, **mets à jour PROGRESS.md** (décision,
  piège, chronologie) — c'est ce qui permet à la session suivante de reprendre.
