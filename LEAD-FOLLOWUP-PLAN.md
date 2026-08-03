# LEAD-FOLLOWUP-PLAN — relances pour convertir les leads pub en Clés

> **Statut : PLAN — à implémenter dans un worktree (`npm run agent:new -- lead-nudges`).**
> Rédigé le 03/08/2026 après analyse prod des conversations pub (voir §1).
> Décision associée : budget pub doublé ($5 → $10/jour) le 03/08.

## 1. Contexte — ce que disent les données prod (24/07 → 03/08)

- 173 leads pub (`campaign_leads`, clé `pack_decouverte_ctwa`), ~22/jour à $5/jour.
- **7 Clés L'Invitée vendues (30 000 F)**, toutes issues des cohortes 30/07–01/08
  (après le fix « Named Key request wins » du 30/07) → **~10 % de conversion
  post-fix**, ROAS ≈ 7–18×. La créa qui convertit : « Découvre le Pilates Reformer ».
- **Fuite n°1 : 70 leads (40 %) n'écrivent JAMAIS un 2e message.** Ils envoient le
  message pré-rempli (« Bonjour, je veux réserver la clé invité »), reçoivent le
  pitch d'Awa, silence. Zéro relance aujourd'hui.
- **Fuite n°2 : 5 leads ont reçu un lien de paiement Clé et n'ont jamais payé**
  (4 ordres `EXPIRED/KEY`). Le nudge lien-expiré existant
  ([src/domain/expiryNudge.ts](src/domain/expiryNudge.ts)) ne couvre QUE
  `pending_bookings` — **les `pending_plan_orders` (Clés) ne sont pas relancés.**
- Les acheteurs décident vite : 4/7 paient en <30 min, max observé 33 h.
  → Les relances doivent être précoces (heures, pas jours).
- Paiement : Wave 9/10 des ordres Clé. L'outage OM n'affecte pas ce funnel.

**Objectif : récupérer une partie des 40 % silencieux + 100 % des liens Clé
expirés. Même +5 % de conversion sur les silencieux ≈ +3-4 Clés/semaine au
budget doublé.**

## 2. Vue d'ensemble — deux relances V1, une V2

| # | Relance | Cible | Canal | Délai | Version |
|---|---------|-------|-------|-------|---------|
| A | **Lead silencieux** | Lead pub sans réponse après le pitch | `sendText` (fenêtre 24 h ouverte par le message pub) | 3 h de silence (configurable) | **V1** |
| B | **Lien Clé expiré** | `pending_plan_orders` EXPIRED | `sendText` (fenêtre quasi toujours ouverte : le lien vient d'être créé) | ≤30 min après expiration | **V1** |
| C | **Réveil J+2** | Lead non converti, fenêtre 24 h fermée | `sendTemplate` (template Meta à créer) | ~48 h après le lead | **V2 — après mesure de A/B** |

Principes non négociables (héritées des nudges existants) :
- **Un seul envoi par cible, à vie** (claim durable AVANT envoi — « a lost nudge
  is a minor miss, a double nudge is spam », cf. expiryNudge.ts:62).
- **Chaque envoi est journalisé dans `conversations` via `repo.addTurn`** pour
  qu'Awa ait le contexte si le client répond.
- **Aucune décision côté modèle** : candidats et timing 100 % SQL/serveur.
- Kill-switch config par relance (comme `KEYS_AUTOMATION_ENABLED`).

## 3. Relance A — lead pub silencieux

### 3.1 Candidats (`repo.silentLeadsToNudge`)

Un client est candidat si TOUTES ces conditions tiennent :

1. Ligne `campaign_leads` (peu importe `matched_by`) créée il y a
   `LEAD_NUDGE_DELAY_MINUTES` (défaut **180 min**) à **22 h max** — borne haute
   prudente pour rester dans la fenêtre 24 h Meta (erreur 131047 sinon).
   La fenêtre court depuis le **dernier message entrant** du client, pas depuis
   le lead : prendre `max(conversations.created_at) where role='user'` comme
   référence.
2. Dernier message de la conversation : `role='assistant'` (Awa a parlé la
   dernière, le client n'a pas répondu depuis ≥ le délai).
3. Aucun ordre plan `PAID/ACTIVATED/AWAITING_PAYMENT/DRAFT` ni booking
   `AWAITING_PAYMENT+` pour ce client (s'il est déjà dans un tunnel de paiement,
   la relance B ou le flux normal s'en charge).
4. Pas de handoff ouvert (table `handoffs`) ni pause coupe-circuit
   (`agent_tool_failures`) — ne jamais parler par-dessus un humain.
5. `clients.is_test = false`.
6. Pas déjà claimé dans `lead_nudges` (dedup `LEAD_SILENT:<client_id>`).
7. **Heures d'envoi : 09 h–21 h Dakar.** Si le créneau tombe la nuit, le sweep
   suivant le rattrapera au matin **si** la fenêtre 24 h est encore ouverte ;
   sinon la cible sort naturellement des candidats (pas d'état « reporté »).

Note : on relance aussi les leads à 2-3 messages qui ont calé (pas seulement les
1-message) — la condition est « silence après le dernier message d'Awa », pas
« n'a écrit qu'une fois ».

### 3.2 Message (copy — FR défaut, EN si `clients.language='en'`)

Court, une question, pas un re-pitch (le pitch complet a déjà été envoyé —
cf. règle « full perks upfront », il est dans l'historique). Signé Awa, de
Revive (jamais « Revive Pilates »).

> **FR** : « Coucou{, {name}} 👋🏾 C'est encore Awa, de Revive. Tu m'avais écrit
> pour la Clé L'Invitée (3 séances de Pilates Reformer + piscine + 1 cours
> bonus, 30 000 F) — je peux te garder une place cette semaine si tu veux 🙂
> Tu préfères plutôt matin ou soir ? »

> **EN** : "Hi{, {name}}! Awa from Revive again 😊 You messaged me about the
> L'Invitée Key (3 Reformer sessions + pool access + 1 bonus class, 30 000 F) —
> I can hold you a spot this week if you'd like 🙂 Do mornings or evenings work
> better for you?"

Terminer par une **question fermée simple** (matin/soir) : donne au client une
réponse à un mot, et la réponse relance l'agent normal qui reprend la main
(dispos réelles via `list_classes`, jamais en dur).

### 3.3 Pourquoi 3 h de délai

Les acheteurs paient en minutes quand ils sont chauds — à 3 h de silence, le
lead est refroidi mais la pub est encore fraîche dans sa tête, et il reste de la
marge avant la fermeture de la fenêtre 24 h (y compris pour le report matin).
`LEAD_NUDGE_DELAY_MINUTES` reste configurable pour itérer sans redéployer la
logique.

## 4. Relance B — lien de paiement Clé expiré

Miroir exact de `nudgeExpiredLinks` (bookings) appliqué à
`pending_plan_orders`. Réutiliser le pattern, pas le généraliser à outrance :
une fonction sœur `nudgeExpiredPlanLinks` dans expiryNudge.ts.

### 4.1 Candidats (`repo.expiredPlanLinksToNudge`)

Adaptation directe de `repo.expiredLinksToNudge` (repo.ts:834) :

- `pending_plan_orders.status='EXPIRED'`, `payment_link is not null` ;
- `plan_expiry_nudged_at is null` (**nouvelle colonne**, même rôle que
  `pending_bookings.expiry_nudged_at`) ;
- expiré depuis < 30 min (fenêtre de fraîcheur identique) ;
- pas d'ordre plan plus récent pour ce client (il n'a pas déjà relancé) ;
- pas de message `role='user'` postérieur à l'expiration (il n'a pas déjà
  repris la conversation) ;
- `is_test=false`, pas de handoff ouvert.

Pas de contrainte « slot_start > now() » (un plan n'a pas de créneau) et pas de
gate horaire : le lien expire ~30 min après création, donc le client était
actif il y a moins d'une heure — fenêtre 24 h garantie, heure décente garantie.

### 4.2 Message

Même ton que `expiryNudgeMessage` :

> **FR** : « ⏳ Ton lien de paiement pour {plan_name} a expiré — nous n'avons
> pas reçu de confirmation. Si tu viens de payer, la confirmation arrive d'ici
> 1 à 2 min ; sinon réponds-moi et je t'en renvoie un tout frais 🙂 »

> **EN** : "⏳ Your payment link for {plan_name} has expired — we haven't
> received a confirmation. If you just paid, it should arrive within 1–2 min;
> otherwise reply here and I'll send you a fresh one 🙂"

## 5. V2 (ne PAS implémenter maintenant) — template « réveil J+2 »

Pour les leads jamais convertis dont la fenêtre 24 h est fermée : template Meta
one-shot à ~48 h. Nécessite un template approuvé (créé par Babakar, langue
`en` par convention — cf. mémoire « Meta templates in English »), var config
`WA_LEAD_REVIVAL_TEMPLATE` + `_LANG`. **Condition d'activation : mesurer
d'abord A/B pendant ≥1 semaine.** Si A récupère déjà bien, C est du spam ; si A
plafonne, C prend le relais. Prévoir dedup `LEAD_REVIVAL:<client_id>` dans la
même table.

## 6. Schéma & config

```sql
-- schema.ts, à côté de key_nudges (même forme)
create table if not exists lead_nudges (
  dedup_key text primary key,          -- 'LEAD_SILENT:<client_id>' | 'LEAD_REVIVAL:<client_id>'
  client_id uuid references clients(id),
  campaign_key text,                    -- copie de campaign_leads.campaign_key (mesure par campagne)
  kind text not null,                   -- 'LEAD_SILENT' | 'LEAD_REVIVAL'
  outcome text not null check (outcome in ('SENT','SUPPRESSED','FAILED')),
  detail text,
  created_at timestamptz not null default now()
);

alter table pending_plan_orders add column if not exists plan_expiry_nudged_at timestamptz;
```

Config ([src/config.ts](src/config.ts)) :

| Var | Défaut | Rôle |
|-----|--------|------|
| `LEAD_NUDGE_ENABLED` | `false` | kill-switch relance A (activer via `railway variables --set` après déploiement) |
| `LEAD_NUDGE_DELAY_MINUTES` | `180` | silence minimal avant relance A |
| `LEAD_NUDGE_MAX_AGE_HOURS` | `22` | borne fenêtre 24 h |
| `LEAD_NUDGE_QUIET_START` / `_END` | `21` / `9` | heures silencieuses Dakar |
| `PLAN_EXPIRY_NUDGE_ENABLED` | `true` | kill-switch relance B (pattern éprouvé, on peut démarrer ON) |

## 7. Câblage

- Nouveau module `src/domain/leadNudge.ts` : `silentLeadNudgeMessage(lang, name)`
  (fonction pure, testable) + `sweepSilentLeads(log)`.
- `nudgeExpiredPlanLinks(log)` + `expiredPlanLinkNudgeMessage` dans
  [src/domain/expiryNudge.ts](src/domain/expiryNudge.ts).
- Les deux appelés depuis le **sweeper 60 s** de [src/index.ts](src/index.ts)
  (relance B juste après `nudgeExpiredLinks` ligne ~94 ; relance A dans son
  propre `try/catch`, une erreur ne doit pas bloquer l'expiry sweep).
- Requêtes candidates dans [src/domain/repo.ts](src/domain/repo.ts), claims
  `claimLeadNudge` / `claimPlanExpiryNudge` sur le modèle existant.

## 8. Mesure (aller-retour avec le doublement de budget)

À J+7 après activation, requêter (script d'analyse déjà écrit, à re-runner) :

- **Relance A** : parmi les `lead_nudges SENT` — % ayant répondu (message
  `role='user'` postérieur), % ayant un ordre Clé `ACTIVATED` sous 72 h.
  Seuil de succès : ≥10 % de réponses, ≥2 Clés attribuables/semaine.
- **Relance B** : % d'ordres `EXPIRED/KEY` relancés qui finissent `ACTIVATED`.
- Garder un œil sur les désabonnements/blocages Meta (qualité du numéro dans
  WhatsApp Manager) — si la note baisse, réduire l'agressivité (délai plus
  long, pas de V2).
- Comparer coût/Clé avant-après doublement : si les leads/jour doublent mais
  pas les ventes, c'est le signal « refine targeting » (souvent : élargissement
  d'audience de moins bonne qualité) — pas « spend more ».

## 9. Tests

- **Purs** (`npm test`) : copy FR/EN (snapshot), logique candidats sur les
  bornes (délai, fenêtre 22 h, heures silencieuses, handoff ouvert, is_test,
  ordre en cours) — isoler la sélection dans des fonctions pures sur le modèle
  de `renewalNudgeCandidates` / `thirdSessionDueWithin24h`.
- **Intégration** (`npm run test:integration`) : claim one-shot (2 sweeps → 1
  seul envoi), lead silencieux → SENT + turn ajouté, ordre Clé EXPIRED → SENT,
  suppression si le client a répondu entre-temps.
- Ship avec `npm run agent:ship -- --full` (on touche au flux
  paiement/plan orders → intégration obligatoire).

## 10. Rollout

1. Worktree `npm run agent:new -- lead-nudges`, implémentation V1 (A+B).
2. Ship → auto-deploy. Relance B active d'office ; relance A derrière
   `LEAD_NUDGE_ENABLED=true` posé via `railway variables --set` après
   vérification d'un cycle de sweep sain dans les logs.
3. J+7 : bilan §8, décision V2 (template J+2) + décision budget suivant.
4. Mettre à jour PROGRESS.md au ship (décision + chiffres du §1).

## Hors périmètre (explicite)

- Pas de relance des leads **pré-30/07** (fenêtre 24 h morte depuis longtemps ;
  nécessiterait le template V2 — et leur pitch d'époque était buggé, mais c'est
  une campagne « réveil » séparée à décider avec la V2).
- Pas de généralisation aux clients non-pub (les 2 fuites mesurées sont sur le
  funnel pub ; élargir = décision produit séparée).
- Aucun changement au prompt d'Awa ni au flux de paiement lui-même.
