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
4. **[business-info.md](business-info.md)** — source de vérité métier d'Awa,
   **lue au boot** (redéployer après édition). **[cafe-menu.md](cafe-menu.md)** =
   seed initial du menu bar uniquement ; la vérité vit désormais dans la table
   `cafe_menu_items`, **éditable via /admin/menu** (plus de redéploiement).
5. **[WIX-WEBHOOK-PLAN.md](WIX-WEBHOOK-PLAN.md)** — chantier **EN VEILLE**, ne pas
   implémenter sans demande explicite.

## Invariants non négociables

- **Paiement d'abord** : aucune réservation Wix n'est créée avant qu'un webhook
  Wave signé soit vérifié (ou qu'une séance d'abonnement soit décomptée). Le
  point unique de création est le handler webhook Wave ([src/webhooks/wave.ts](src/webhooks/wave.ts)).
- **Le modèle propose, le serveur décide** : prix TOUJOURS depuis le catalogue Wix
  ou la table `cafe_menu_items` (jamais du modèle) ; `event_id`s validés contre `slot_cache`
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
  rebuild et redéploie sur Railway. Santé : `GET /healthz`. Détails ops :
  PROGRESS.md §7. (`railway up` est **banni** hors hotfix — cf. section Git.)
- Prod : `https://resabot-production.up.railway.app`. Numéro Awa : +221 78 953 66 76.
- Après un changement produit non trivial, **mets à jour PROGRESS.md** (décision,
  piège, chronologie) — c'est ce qui permet à la session suivante de reprendre.

## Git — UN AGENT = UN WORKTREE (plusieurs agents en parallèle)

Plusieurs agents (sessions Claude Code, kilo, humains) travaillent sur ce repo
en même temps. Pour qu'ils ne se marchent JAMAIS dessus, chacun travaille dans
son **propre git worktree** — un checkout isolé, sa branche, son `node_modules`,
son `.env`. Fini l'arbre partagé et les commits qui s'écrasent. Outillage :
[scripts/agent-worktree.sh](scripts/agent-worktree.sh) (alias `npm run agent:*`).

- **Le dossier principal `…/resabot` est le HUB : lecture/ops seulement.** Il
  reste épinglé sur `main` et sert à coordonner, lancer la CLI Railway, requêter
  la DB, créer des worktrees. **N'y édite JAMAIS de fichier produit.** Si tu le
  trouves sale (hors doc/plan non suivis), arrête-toi et signale-le.
- **Démarrer un chantier :** `npm run agent:new -- <topic>`. Ça crée
  `../resabot-worktrees/<topic>` (dossier voisin, invisible pour `railway up` et
  `tsc`) sur une branche `agent/<topic>` partie d'`origin/main`, copie le `.env`,
  fait `npm ci`. Tu bosses là. Dans TON worktree tout est à toi : `git add -A` OK.
- **Livrer :** commite, puis `npm run agent:ship` — rebase sur `origin/main`,
  `build` + `test`, puis `git push origin HEAD:main` (retry auto si un autre a
  poussé entre-temps) → auto-deploy Railway. Pas de PR. Ajoute `-- --full` pour
  inclure `test:integration` (obligatoire si tu touches au flux paiement).
  Ensuite `npm run agent:done -- <topic>` retire le worktree et sa branche.
- **Pousse par unité cohérente** (une feature/un fix buildé+testé), tôt et
  souvent — un `git push` = un auto-deploy.
- **`railway up` est banni.** Seule exception : hotfix depuis le hub propre sur
  `main`, et même là commite+pousse d'abord et laisse l'auto-deploy faire, sauf
  prod à terre. `railway up` déploie du non-commité → git prend du retard sur le
  live, ce qui régressait la prod au push suivant (l'incident qu'on élimine).
- **`origin/main` == prod, toujours.** `build` + `test` verts avant tout ship
  (idéalement CI verte, cf. PROGRESS.md §7).
