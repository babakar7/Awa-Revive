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

- **Avant tout push : `npm run build && npm test`** (tests purs, sans réseau).
  Intégration : `npm run test:integration` (Postgres jetable Docker).
- **Déploiement : auto-deploy** — `git push` sur `main` (`babakar7/Awa-Revive`)
  rebuild et redéploie sur Railway. Fallback manuel : `railway up --detach` (ne
  PAS combiner avec un push pour le même changement = double build). Santé :
  `GET /healthz`. Détails ops : PROGRESS.md §7.
- Prod : `https://resabot-production.up.railway.app`. Numéro Awa : +221 78 953 66 76.
- Après un changement produit non trivial, **mets à jour PROGRESS.md** (décision,
  piège, chronologie) — c'est ce qui permet à la session suivante de reprendre.

## Git & push — PLUSIEURS AGENTS travaillent en parallèle sur le MÊME dossier

Le dossier de travail est partagé : à tout moment il peut contenir des
changements non commités d'un autre agent. `railway up` déploie tout le dossier,
mais git ne suit que ce qui est commité — d'où un risque : **si un agent pousse
un commit qui n'inclut pas les fichiers modifiés d'un autre agent, le prochain
auto-deploy rebuild depuis git et fait DISPARAÎTRE ce travail de la prod.**
Règles pour éviter ça :

- **Ne commite QUE ton propre travail.** Stage les fichiers que TU as modifiés,
  un par un (`git add <fichier>`), **jamais `git add -A` / `git add .`** — ça
  embarquerait le travail en cours d'un autre agent (potentiellement à moitié
  fait) sous ton commit. En cas de doute sur la paternité d'un fichier, laisse-le.
- **Pousse après chaque update majeure** (une feature ou un fix cohérent, buildé
  et testé), pas à la fin d'une longue série. Plus tôt tu commites+pousses ton
  travail, moins il risque d'être écrasé par le push d'un autre agent. Un
  `git push` = un auto-deploy : groupe donc un ensemble cohérent, pas chaque
  micro-edit.
- **Préfère `git push` à `railway up`** pour livrer : le push met git ET la prod
  d'accord. `railway up` déploie sans commiter → git prend du retard sur le live
  (c'est ce retard qui crée le risque ci-dessus). Réserve `railway up` aux tests
  rapides que tu comptes commiter juste après.
- **`main` est la branche de déploiement** : `origin/main` doit toujours refléter
  ce qui tourne en prod. Avant de pousser, `npm run build && npm test` doivent
  passer (idéalement laisser la CI verte, cf. PROGRESS.md §7).
- Si tu vois des fichiers modifiés que tu n'as pas touchés, **ne les commite pas
  et ne les révoque pas** : c'est le travail d'un autre agent. Signale-le plutôt.
