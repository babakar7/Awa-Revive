# LEAD-FOLLOWUP-PLAN — relances pour convertir les leads pub en Clés

> **Statut : PLAN v2 — à implémenter dans un worktree (`npm run agent:new -- lead-nudges`).**
> v1 rédigée le 03/08/2026 après analyse prod (§1) ; v2 le même jour après revue
> (claim atomique, exclusion funnel paiement, holdout, chaîne retry).
> Décision associée : budget pub doublé ($5 → $10/jour) le 03/08.

## 1. Contexte — ce que disent les données prod (24/07 → 03/08)

- 173 leads pub (`campaign_leads`, clé `pack_decouverte_ctwa`), ~22/jour à $5/jour.
- **7 Clés L'Invitée vendues (30 000 F)**, toutes issues des cohortes 30/07–01/08
  (après le fix « Named Key request wins » du 30/07) → **~10 % de conversion
  post-fix**, ROAS ≈ 7–18×. La créa qui convertit : « Découvre le Pilates Reformer ».
- **Fuite n°1 : 70 leads (40 %) n'écrivent JAMAIS un 2e message.** Ils envoient le
  message pré-rempli, reçoivent le pitch d'Awa, silence. Zéro relance aujourd'hui.
- **Fuite n°2 : des liens de paiement plan expirent sans relance** (4 ordres
  `EXPIRED/KEY` + 1 Aquafitness sur la période). Le nudge lien-expiré existant
  ([src/domain/expiryNudge.ts](src/domain/expiryNudge.ts)) ne couvre QUE
  `pending_bookings` — **les `pending_plan_orders` ne sont pas relancés.**
- Les acheteurs décident vite : 4/7 paient en <30 min, max observé 33 h.
  → Les relances doivent être précoces (heures, pas jours).
- Paiement : Wave 9/10 des ordres Clé. L'outage OM n'affecte pas ce funnel.

**Objectif : récupérer une partie des 40 % silencieux + 100 % des liens plan
expirés, et le MESURER proprement (holdout) pour décider la suite.**

## 2. Vue d'ensemble — deux relances V1, une V2

| # | Relance | Cible | Canal | Délai | Version |
|---|---------|-------|-------|-------|---------|
| A | **Lead silencieux** | Lead `pack_decouverte_ctwa` sans AUCUNE réponse après le message pub | `sendText` (fenêtre 24 h) | 3 h de silence | **V1** |
| B | **Lien plan expiré** | `pending_plan_orders` EXPIRED (Clés ET autres plans) | `sendText` (fenêtre quasi toujours ouverte) | ≤30 min après expiration | **V1** |
| C | **Réveil J+2** | Lead non converti, fenêtre 24 h fermée | `sendTemplate` (template Meta à créer) | ~48 h | **V2 — après mesure** |

Principes non négociables :

- **Un seul envoi par cible, à vie.** Le claim est un
  `INSERT … SELECT … WHERE <toutes les gardes volatiles>` **atomique** : il
  re-vérifie au moment T du claim que le client n'a pas répondu, n'a pas payé,
  n'a pas de nouvel ordre, n'est pas en takeover — pas seulement « pas déjà
  claimé ». (Le claim naïf du nudge booking, repo.ts:867, ne re-vérifie que
  `expiry_nudged_at is null` ; on ne le clone PAS tel quel.)
- **Claim ≠ envoi réussi** : pattern `key_nudges` (claim insère
  `outcome='FAILED', detail='claimed'`, puis `complete` passe à
  `SENT/FAILED` — keyRepo.ts:155-178). On y ajoute le **wamid** retourné par
  `sendText` (whatsapp.ts:59) pour tracer les échecs Meta asynchrones.
- **Chaque envoi est journalisé dans `conversations` via `repo.addTurn`** pour
  qu'Awa ait le contexte si le client répond.
- **Aucune décision côté modèle** : candidats et timing 100 % SQL/serveur.
- Kill-switch config par relance, **les deux `false` par défaut** ; activation
  explicite après dry-run (§10).

### Gardes de pause (communes A et B) — les VRAIES sources

Vérifiées sur chaque inbound par l'agent (src/agent/index.ts, hard gates) :

- `clients.human_takeover_until > now()` (relais humain actif) ;
- `clients.awa_disengaged_until > now()` (Awa désengagée) ;
- handoff `OPEN` dans `handoffs` ;
- coupe-circuit réellement déclenché dans `agent_tool_failures` (condition de
  déclenchement effectif, pas simple présence d'une ligne) ;
- `clients.is_test = true`.

## 3. Relance A — lead pub silencieux

### 3.1 Candidats (`repo.silentLeadsToNudge(campaignKey, …)`)

**Périmètre campagne : `PACK_DISCOVERY_CAMPAIGN` uniquement**
(constante existante, [src/domain/packDiscoveryCampaign.ts](src/domain/packDiscoveryCampaign.ts)),
passée en **argument** de la requête — la copy parle de L'Invitée et ne doit
jamais partir vers une future campagne différente.

**Les trois horloges** (le lead sert au rattachement campagne, PAS au calcul de
fenêtre) :

1. `last_user_at > now() - LEAD_NUDGE_MAX_AGE_HOURS (22 h)` — fenêtre Meta sûre,
   calculée depuis le **dernier message entrant** (`conversations.role='user'`) ;
2. `last_assistant_at > last_user_at` — Awa a parlé la dernière ;
3. `last_assistant_at <= now() - LEAD_NUDGE_DELAY_MINUTES (180)` — silence de
   3 h après la réponse d'Awa (pas depuis `campaign_leads.created_at`).

**Périmètre V1 : uniquement la fuite mesurée — AUCUN message utilisateur après
le message déclencheur** (`campaign_leads.trigger_message_id` ; en pratique :
un seul message `role='user'` dans la conversation). Les leads à 2-3 messages
qui ont calé plus loin sont **hors V1** : la copy matin/soir serait incohérente
pour un client qui a déjà répondu « soir » et reçu des créneaux. Extension
multi-message = itération ultérieure, avec copy neutre ou état serveur
déterministe.

**Exclusion funnel paiement (anti-empilement A+B)** : est exclu tout client
ayant **créé le moindre ordre ou lien de paiement depuis son entrée campagne,
quel que soit le statut, `EXPIRED` inclus** — `pending_plan_orders` (tout
statut) et `pending_bookings` avec `payment_link` (tout statut). A = « bloqué
avant tout paiement proposé » ; dès qu'un lien a existé, B ou le flux normal
est propriétaire du suivi. Sans cette règle, un lien Clé expiré recevrait B
puis A trois heures plus tard.

**Autres gardes** : gardes de pause §2 ; pas déjà dans `outbound_nudges`
(dedup `LEAD_SILENT:<client_id>`) ; **heures d'envoi 09 h–21 h Dakar** (si le
créneau tombe la nuit, le sweep du matin rattrape si la fenêtre 24 h tient
encore ; sinon le candidat sort naturellement — pas d'état « reporté »).

**Holdout 15–20 % (mesure causale)** : le doublement de budget et l'activation
des nudges arrivent en même temps — un avant/après ne prouve rien. Un
candidat sur cinq/six, choisi par **hash déterministe de `client_id`** (ex.
`hashtext(client_id::text) % 6 = 0`), est claimé avec
`outcome='SUPPRESSED', detail='holdout'` et **jamais relancé**. Le claim du
holdout est durable → groupe contrôle stable. La mesure compare réponse et
conversion nudgés vs holdout.

### 3.2 Message (copy — FR défaut, EN si `clients.language='en'`)

Court, une question, pas un re-pitch (le pitch complet est déjà dans
l'historique). Signé Awa, de Revive (jamais « Revive Pilates »). **Pas de
promesse de réservation** (« je te garde une place » impliquerait qu'on pose
une option — le système ne fait que consulter les dispos, et paiement d'abord) :

> **FR** : « Coucou{, {name}} 👋🏾 C'est encore Awa, de Revive. Tu m'avais écrit
> pour la Clé L'Invitée (3 séances de Pilates Reformer + piscine + 1 cours
> bonus, 30 000 F) — je peux t'aider à trouver une place cette semaine si tu
> veux 🙂 Tu préfères plutôt matin ou soir ? »

> **EN** : "Hi{, {name}}! Awa from Revive again 😊 You messaged me about the
> L'Invitée Key (3 Reformer sessions + pool access + 1 bonus class, 30 000 F) —
> I can help you find a spot this week if you'd like 🙂 Do mornings or evenings
> work better for you?"

La question fermée (matin/soir) donne une réponse à un mot ; la réponse relance
l'agent normal (dispos réelles via `list_classes`, jamais en dur).

## 4. Relance B — lien de paiement plan expiré

Sœur de `nudgeExpiredLinks` (bookings) pour `pending_plan_orders` :
`nudgeExpiredPlanLinks` dans expiryNudge.ts.

**Périmètre — décision explicite : TOUS les plans, pas seulement les Clés.**
Le message est générique (`plan_name`), la mécanique identique, et la période
d'analyse contient déjà un abandon non-Clé récupérable (Aquafitness). La
mesure (§8) reste segmentée par `is_key` pour suivre l'objectif Clés. (Si on
voulait Clés only, il suffirait d'ajouter `p.is_key = true` — non retenu.)

### 4.1 Candidats (`repo.expiredPlanLinksToNudge`)

Adaptation de `repo.expiredLinksToNudge` (repo.ts:834) :

- `status='EXPIRED'`, `payment_link is not null` ;
- expiré depuis < 30 min (fenêtre de fraîcheur) ;
- pas d'ordre plan plus récent pour ce client (ni `retry_of_order_id` pointant
  vers cet ordre — Awa a déjà refait un lien) ;
- pas de message `role='user'` postérieur à l'expiration ;
- gardes de pause §2 ;
- pas déjà dans `outbound_nudges` (dedup `PLAN_LINK:<order_id>`).

Toutes ces conditions sont **répétées dans le claim atomique** (§2). Pas de
colonne `plan_expiry_nudged_at` : le dedup vit dans `outbound_nudges` (PK),
qui distingue claim/SENT/FAILED et porte le wamid — contrairement au simple
timestamp du pattern booking, qui compterait comme « relancé » un envoi ayant
échoué après claim.

Pas de contrainte `slot_start` (un plan n'a pas de créneau) ni de gate horaire :
le lien expire ~30 min après création, le client était actif il y a moins d'une
heure — fenêtre 24 h et heure décente garanties. Pas de holdout sur B (volume
trop faible, mécanique déjà éprouvée côté bookings).

### 4.2 Message

> **FR** : « ⏳ Ton lien de paiement pour {plan_name} a expiré — nous n'avons
> pas reçu de confirmation. Si tu viens de payer, la confirmation arrive d'ici
> 1 à 2 min ; sinon réponds-moi et je t'en renvoie un tout frais 🙂 »

> **EN** : "⏳ Your payment link for {plan_name} has expired — we haven't
> received a confirmation. If you just paid, it should arrive within 1–2 min;
> otherwise reply here and I'll send you a fresh one 🙂"

## 5. V2 (ne PAS implémenter maintenant) — template « réveil J+2 »

Pour les leads jamais convertis dont la fenêtre 24 h est fermée : template Meta
one-shot à ~48 h (créé par Babakar, langue `en` par convention), vars
`WA_LEAD_REVIVAL_TEMPLATE` + `_LANG`, dedup `LEAD_REVIVAL:<client_id>` dans la
même table. **Condition d'activation : mesure §8 concluante** — au moins
**2 semaines OU ≥50 nudges A envoyés** (le premier atteint), et un delta
nudgés/holdout visible. Si A récupère bien, C est du spam ; si A plafonne, C
prend le relais.

## 6. Schéma & config

```sql
-- schema.ts — journal commun des relances sortantes (A, B, futur C).
-- Nommé outbound_nudges (pas lead_nudges) : B concerne aussi des clients
-- hors campagne. Pattern claim/complete de key_nudges + wamid.
create table if not exists outbound_nudges (
  dedup_key text primary key,     -- 'LEAD_SILENT:<client_id>' | 'PLAN_LINK:<order_id>' | 'LEAD_REVIVAL:<client_id>'
  client_id uuid references clients(id),
  campaign_key text,              -- null pour B hors campagne ; mesure par campagne
  kind text not null,             -- 'LEAD_SILENT' | 'PLAN_LINK' | 'LEAD_REVIVAL'
  outcome text not null check (outcome in ('SENT','SUPPRESSED','FAILED')),
  detail text,                    -- 'claimed' → puis erreur / 'holdout' / vide
  wa_message_id text,             -- wamid retourné par sendText (échecs Meta asynchrones)
  created_at timestamptz not null default now()
);
```

(Le claim insère `outcome='FAILED', detail='claimed'` via
`INSERT … SELECT … WHERE <gardes volatiles>` ; `complete` met à jour outcome,
detail, wamid. Aucune colonne ajoutée à `pending_plan_orders`.)

Config ([src/config.ts](src/config.ts)) :

| Var | Défaut | Rôle |
|-----|--------|------|
| `LEAD_NUDGE_ENABLED` | `false` | kill-switch relance A |
| `LEAD_NUDGE_DELAY_MINUTES` | `180` | silence minimal après le dernier message d'Awa |
| `LEAD_NUDGE_MAX_AGE_HOURS` | `22` | borne fenêtre 24 h (depuis le dernier inbound) |
| `LEAD_NUDGE_QUIET_START` / `_END` | `21` / `9` | heures silencieuses Dakar |
| `LEAD_NUDGE_HOLDOUT_MOD` | `6` | 1 candidat sur N en holdout (0 = désactivé) |
| `PLAN_EXPIRY_NUDGE_ENABLED` | `false` | kill-switch relance B — activation après dry-run §10 |

## 7. Câblage

- Nouveau module `src/domain/leadNudge.ts` : `silentLeadNudgeMessage(lang, name)`
  (pure, testable), `isInHoldout(clientId, mod)` (pure), `sweepSilentLeads(log)`.
- `nudgeExpiredPlanLinks(log)` + `expiredPlanLinkNudgeMessage` dans
  [src/domain/expiryNudge.ts](src/domain/expiryNudge.ts).
- Les deux appelés depuis le **sweeper 60 s** de [src/index.ts](src/index.ts)
  (B juste après `nudgeExpiredLinks` ; A dans son propre `try/catch`).
- Requêtes candidates + claims atomiques dans
  [src/domain/repo.ts](src/domain/repo.ts) (`claimOutboundNudge` prend la liste
  de gardes en SQL, pas seulement le dedup). `campaignKey` passé en argument
  depuis `PACK_DISCOVERY_CAMPAIGN`.

## 8. Mesure (aller-retour avec le doublement de budget)

Fenêtre : **2 semaines OU ≥50 nudges A** (le premier atteint) — 7 jours et
2 Clés seraient un signal trop bruité pour décider V2. Bilan opérationnel
possible à J+7 (santé des sweeps, volume, plaintes), décision à la fenêtre.

- **Relance A — nudgés vs holdout** : % de réponse (message `role='user'`
  postérieur au nudge / au claim holdout) et % d'ordre Clé `ACTIVATED` sous
  72 h, comparés entre `outcome='SENT'` et `detail='holdout'`. Succès = delta
  net en faveur des nudgés (pas de seuil absolu : le holdout EST la baseline).
- **Relance B — suivre la chaîne de retry** : quand Awa recrée un lien
  (`refresh_expired_plan_payment_link`), le nouvel ordre porte
  `retry_of_order_id` et l'ancien reste `EXPIRED` (tools.ts:2963,
  schema.ts:430). Compter comme converti : paiement tardif de l'ordre original
  **OU** activation d'un descendant via CTE récursif sur `retry_of_order_id`.
  Chercher seulement `ACTIVATED` sur l'ordre relancé sous-compterait.
  Segmenter par `is_key`.
- **Qualité du numéro WhatsApp** (blocages/signalements dans WhatsApp
  Manager) : si la note baisse, allonger le délai, pas de V2.
- **Budget doublé** : comparer coût/lead et coût/Clé avant/après. Si les leads
  doublent mais pas les ventes → signal « refine targeting » (audience élargie
  de moindre qualité), pas « spend more ». Le holdout isole l'effet nudge de
  l'effet budget.

## 9. Tests

- **Purs** (`npm test`) : copy FR/EN (snapshot) ; holdout déterministe ; logique
  des trois horloges et bornes (délai, 22 h, heures silencieuses) ; exclusions
  (funnel paiement tout statut, takeover/disengaged/handoff, is_test,
  multi-message) — sélection isolée en fonctions pures sur le modèle de
  `renewalNudgeCandidates`.
- **Intégration** (`npm run test:integration`) :
  - claim one-shot : 2 sweeps → 1 seul envoi ;
  - **réponse entre sélection et claim → 0 envoi** (le test clé du claim
    atomique) ; idem paiement tardif passé `PAID` et handoff ouvert entre-temps ;
  - lead silencieux → SENT + turn ajouté + wamid journalisé ;
  - lead en holdout → SUPPRESSED, jamais renudgé au sweep suivant ;
  - ordre plan EXPIRED → SENT ; ordre avec `retry_of_order_id` descendant → pas
    de nudge ;
  - lien Clé expiré → B envoyé puis A **non** envoyé (anti-empilement).
- Ship avec `npm run agent:ship -- --full` (flux paiement touché).

## 10. Rollout

1. Worktree `npm run agent:new -- lead-nudges`, implémentation V1 (A+B), les
   deux flags `false`.
2. Ship → auto-deploy. **Dry-run** : requêter les candidats A et B en prod
   (script read-only) et vérifier à la main que la sélection est saine (pas de
   client en takeover, pas de payeur, volumes plausibles).
3. Activer `PLAN_EXPIRY_NUDGE_ENABLED=true` puis `LEAD_NUDGE_ENABLED=true` via
   `railway variables --set`, surveiller un cycle de sweep dans les logs.
4. Bilan opérationnel J+7 ; **décision V2 + budget à 2 semaines / 50 nudges**
   (§8). Mettre à jour PROGRESS.md au ship (décision + chiffres §1).

## Hors périmètre (explicite)

- Leads pré-30/07 (fenêtre morte, pitch d'époque buggé) — campagne « réveil »
  séparée, à décider avec la V2.
- Leads multi-messages qui ont calé (2-3 msgs) — extension post-V1 (§3.1).
- Clients non-pub pour A (B, lui, couvre tout client à lien plan expiré —
  décision §4).
- Aucun changement au prompt d'Awa ni au flux de paiement lui-même.
