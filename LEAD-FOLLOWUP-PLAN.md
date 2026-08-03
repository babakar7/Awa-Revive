# LEAD-FOLLOWUP-PLAN — relance des leads pub silencieux (v4, LIVRÉ)

> **Statut : LIVRÉ en ENVOI MANUEL.** v1→v3 spécifiaient un envoi automatique
> avec holdout randomisé (arm/outcome, intention-to-treat). **v4 (03/08) : pivot
> décidé par Babakar — envoi MANUEL depuis /admin/relances**, pas d'automatisme.
> Conséquence : plus de holdout ni de mesure causale (la sélection humaine n'est
> pas randomisée) ; `arm='MANUAL'`. Le reste du design (claim atomique, ancrage
> trigger, exclusion funnel paiement, fenêtre 24 h, copie) est conservé tel quel.
> La relance « lien plan expiré » était DÉJÀ en prod (§2). Détail d'implémentation
> et fichiers : PROGRESS.md (03/08). Budget pub doublé ($5 → $10/jour) le 03/08.
>
> **Les sections ci-dessous décrivent le design v3 (auto+holdout) pour mémoire.**
> Ce qui a réellement été livré : le même moteur de sélection/claim, déclenché à
> la main via des boutons « Envoyer » / « Ignorer » par lead.

## 1. Contexte — données prod (24/07 → 03/08)

- 173 leads pub (`campaign_leads`, clé `pack_decouverte_ctwa`), ~22/jour à $5/jour.
- **7 Clés L'Invitée vendues (30 000 F)**, toutes issues des cohortes 30/07–01/08
  (post-fix « Named Key request wins ») → **~10 % de conversion post-fix**,
  ROAS ≈ 7–18×. Seule créa qui convertit : « Découvre le Pilates Reformer ».
- **Fuite ciblée : 70 leads (40 %) n'écrivent JAMAIS un 2e message.** Message
  pré-rempli → pitch d'Awa → silence. Zéro relance aujourd'hui.
- Les acheteurs décident vite : 4/7 paient en <30 min, max observé 33 h (payé à
  00h54 — un client peut être actif à minuit). → Relance précoce (heures).
- Paiement : Wave 9/10. L'outage OM n'affecte pas ce funnel.

## 2. Ce qui existe DÉJÀ en prod (ne PAS reconstruire)

- **Relance lien plan expiré (ex-« relance B ») : livrée les 01–02/08**
  (`d32d7b7`, `32da028`) — `expiredPlanOrdersToNudge` +
  `claimPlanOrderExpiryNudge` ([src/domain/repo.ts](src/domain/repo.ts)),
  `nudgeExpiredPlanOrders` ([src/domain/expiryNudge.ts](src/domain/expiryNudge.ts)),
  appelée par le sweeper 60 s ([src/index.ts](src/index.ts)). Couvre déjà :
  exclusion des ordres re-liés (`retry_of_order_id`), garde « le client a
  répondu → Awa gère », alerte réception OM/Max It (callback Sonatel perdu),
  messages FR/EN/WO avec variante outage OM.
- Son claim est le pattern timestamp naïf (`expiry_nudged_at`). **Dette
  assumée, hors chantier** : étroite (fenêtre 30 min), indépendante de A, en
  prod — la refactorer ici ajouterait du risque sans bénéfice pour l'objectif.
- Relance bookings (`nudgeExpiredLinks`) : idem, en prod depuis longtemps.
- **Leçon de processus (vécue sur ce chantier)** : les revues v1/v2 ont été
  faites sur un hub 32 commits en retard → on a spécifié une feature qui
  existait déjà. Avant toute analyse : `git fetch`, puis inspection
  d'`origin/main` ou worktree frais.

## 3. Périmètre du build — relance A uniquement

**A. Lead pub silencieux** : lead `pack_decouverte_ctwa` n'ayant JAMAIS répondu
après le message pré-rempli → un (1) message libre dans la fenêtre 24 h, après
3 h de silence. Plus : journal `outbound_nudges` (A et futur C — PAS
rétroactivement celui de la relance plan), hook d'échec asynchrone Meta,
holdout pour la mesure causale.

### 3.1 Candidats (`silentLeadCandidates(campaignKey, …)`)

**Périmètre campagne** : `PACK_DISCOVERY_CAMPAIGN` uniquement
([src/domain/packDiscoveryCampaign.ts](src/domain/packDiscoveryCampaign.ts)),
passé en **argument** — la copy parle de L'Invitée et ne doit jamais partir
vers une autre campagne.

**Les trois horloges** (le lead rattache à la campagne, la fenêtre WhatsApp se
calcule sur les turns) :

1. `last_user_at > now() − LEAD_NUDGE_MAX_AGE_HOURS (22 h)` — fenêtre Meta sûre,
   depuis le **dernier message entrant** ;
2. `last_assistant_at > last_user_at` — Awa a parlé la dernière ;
3. `last_assistant_at ≤ now() − LEAD_NUDGE_DELAY_MINUTES (180)` — 3 h de
   silence après la réponse d'Awa.

**« Jamais répondu », définition exacte** : aucun turn `role='user'` postérieur
au **turn ancré sur `campaign_leads.trigger_message_id`**
(`conversations.wa_message_id`), fallback `campaign_leads.created_at` si le
trigger est introuvable (cas legacy, de toute façon hors fenêtre 22 h).
JAMAIS « un seul message user dans la conversation » : `conversations` est un
flux par client — un ancien client qui clique la pub serait exclu à tort.

**Exclusion funnel paiement (anti-empilement avec la relance plan en prod)** :
exclu tout client ayant le moindre `pending_plan_orders` (tout statut,
**`EXPIRED` inclus**) ou `pending_bookings` avec `payment_link` (tout statut).
A = « bloqué avant tout paiement proposé » ; dès qu'un lien a existé, la
relance plan ou le flux normal est propriétaire.

**Gardes de pause (les vraies sources, celles de l'agent)** :
`clients.human_takeover_until > now()`, `clients.awa_disengaged_until > now()`,
handoff `status='OPEN'`, coupe-circuit réellement déclenché
(`agent_tool_failures.tripped_at is not null and expires_at > now()`),
`clients.is_test`.

**Divers** : pas déjà dans `outbound_nudges` (dedup `LEAD_SILENT:<client_id>`) ;
**heures d'envoi 09 h–21 h Dakar** (Dakar == UTC), vérifiées côté TS en tête de
sweep — un candidat nocturne est rattrapé au matin si la fenêtre tient encore,
sinon il sort naturellement (pas d'état « reporté »).

### 3.2 Holdout & mesure causale — arm ≠ outcome (intention-to-treat)

Le doublement de budget et l'activation du nudge arrivent ensemble : un
avant/après ne prouve rien. **1 candidat sur `LEAD_NUDGE_HOLDOUT_MOD` (6)** est
assigné au contrôle par **hash FNV-1a de `client_id`, en TypeScript uniquement**
(`Math.imul(…) >>> 0` pour un vrai 32 bits stable — pas de `hashtext()` SQL,
non garanti entre versions PG, et pas de double implémentation).

**Deux dimensions séparées dans le journal** :

- **`arm` = `TREATMENT` | `HOLDOUT`** — assignation expérimentale, **fixée
  définitivement au claim**, jamais modifiée ensuite ;
- **`outcome` = `CLAIMED` → `SENT` | `FAILED`, ou `SUPPRESSED`** (holdout) —
  état opérationnel de livraison.

Un message assigné `TREATMENT` puis rejeté par Meta **reste dans le bras
traitement** pour la comparaison causale (les échecs Meta sont corrélés à l'âge
du lead — les exclure biaiserait le bras traitement vers les leads les plus
frais/joignables ; l'ITT dilue vers zéro, direction conservatrice).

**Invariant** : les deux bras passent **exactement le même claim atomique**
(mêmes gardes SQL, seuls `arm`/`outcome` diffèrent). Un contrôle échantillonné
plus laxement ne serait plus comparable. Testé explicitement (§8).

### 3.3 Claim atomique (`claimSilentLeadNudge`)

`INSERT … SELECT … WHERE <gardes> ON CONFLICT (dedup_key) DO NOTHING` — SQL
**statique, écrit à la main** (pas de générateur de gardes : inauditables). Le
`WHERE` **re-vérifie au moment du claim** toutes les conditions volatiles de la
sélection : gardes de pause, `is_test`, aucun funnel paiement, **et la même
condition ancrée sur `trigger_message_id`** (pas « depuis le dernier message
d'Awa » : le client peut répondre et recevoir la réponse d'Awa en quelques
secondes — la condition non ancrée re-passerait et enverrait un nudge hors
contexte). Couvre la course « réponse entre sélection et claim ».
`completeOutboundNudge(dedupKey, outcome, detail, wamid)` partagé.

### 3.4 Message (FR défaut, EN si `clients.language='en'`)

Court, une question fermée, pas de re-pitch (le pitch complet est dans
l'historique). Signé Awa, de Revive. **Pas de promesse de réservation**
(paiement d'abord ; le système consulte les dispos, il ne pose pas d'option) :

> **FR** : « Coucou{, {name}} 👋🏾 C'est encore Awa, de Revive. Tu m'avais écrit
> pour la Clé L'Invitée (3 séances de Pilates Reformer + piscine + 1 cours
> bonus, 30 000 F) — je peux t'aider à trouver une place cette semaine si tu
> veux 🙂 Tu préfères plutôt matin ou soir ? »

> **EN** : "Hi{, {name}}! Awa from Revive again 😊 You messaged me about the
> L'Invitée Key (3 Reformer sessions + pool access + 1 bonus class, 30 000 F) —
> I can help you find a spot this week if you'd like 🙂 Do mornings or evenings
> work better for you?"

La réponse (« matin ») relance l'agent normal (dispos réelles via
`list_classes`, jamais en dur). Envoi journalisé dans `conversations` via
`repo.addTurn(clientId, 'assistant', msg, wamid)` pour le contexte d'Awa.

## 4. Schéma

```sql
-- Journal des relances proactives de A (et du futur réveil J+2). La relance
-- plan en prod garde son expiry_nudged_at — ce journal n'est PAS rétroactif.
create table if not exists outbound_nudges (
  dedup_key text primary key,        -- 'LEAD_SILENT:<client_id>' | 'LEAD_REVIVAL:<client_id>'
  client_id uuid not null references clients(id),
  campaign_key text,                 -- mesure par campagne
  kind text not null,                -- 'LEAD_SILENT' | 'LEAD_REVIVAL'
  arm text not null check (arm in ('TREATMENT','HOLDOUT')),        -- fixé au claim, immuable
  outcome text not null check (outcome in ('CLAIMED','SENT','FAILED','SUPPRESSED')),
  detail text,
  wa_message_id text,
  assigned_at timestamptz not null default now(),
  sent_at timestamptz                -- mesure « sous 72 h » depuis l'envoi effectif
);
create index if not exists idx_outbound_nudges_wamid
  on outbound_nudges (wa_message_id) where wa_message_id is not null;
```

Cycle : claim `TREATMENT/CLAIMED` → `SENT` (+ `sent_at`, wamid) ou `FAILED` ;
claim `HOLDOUT/SUPPRESSED` (terminal). Plus de hack « `FAILED`/`detail='claimed'` »
du pattern key_nudges : `CLAIMED` est un état de première classe.

**Échecs Meta asynchrones** : Meta accepte (200) puis rejette en asynchrone
(fenêtre fermée, type 131047). `markOutboundNudgeFailedByWamid(wamid, reason)`
branché dans le handler de statuts `failed`
([src/webhooks/whatsapp.ts](src/webhooks/whatsapp.ts), à côté de
`markLogFailedByWamid` / `markClientPingFailedByWamid`) :
`outcome SENT → FAILED` (l'`arm` ne bouge pas — ITT). Sans ce hook, le taux de
livraison serait gonflé en silence.

## 5. Config ([src/config.ts](src/config.ts))

| Var | Défaut | Rôle |
|-----|--------|------|
| `LEAD_NUDGE_ENABLED` | `false` | kill-switch — activation via `railway variables --set` après dry-run |
| `LEAD_NUDGE_DELAY_MINUTES` | `180` | silence minimal après le dernier message d'Awa |
| `LEAD_NUDGE_MAX_AGE_HOURS` | `22` | borne fenêtre 24 h (depuis le dernier inbound) |
| `LEAD_NUDGE_QUIET_START` / `_END` | `21` / `9` | heures silencieuses Dakar |
| `LEAD_NUDGE_HOLDOUT_MOD` | `6` | 1 candidat sur N en holdout (0 = désactivé) |

## 6. Câblage

- **`src/domain/leadNudgeRepo.ts`** (nouveau — évite de grossir repo.ts,
  partagé entre agents) : `silentLeadCandidates`, `claimSilentLeadNudge`,
  `completeOutboundNudge`, `markOutboundNudgeFailedByWamid`.
- **`src/domain/leadNudge.ts`** (nouveau) : `silentLeadNudgeMessage(lang, name)`
  (pure), `fnv1aMod(clientId, mod)` (pure), `isQuietHour(hour, start, end)`
  (pure), `sweepSilentLeadNudges(log)`.
- **[src/index.ts](src/index.ts)** : appel dans le sweeper 60 s, `try/catch`
  propre (une erreur ne bloque pas l'expiry sweep).
- **[src/webhooks/whatsapp.ts](src/webhooks/whatsapp.ts)** : ajout au
  `Promise.all` du handler de statuts `failed`.
- **[src/db/schema.ts](src/db/schema.ts)** : table + index §4.

## 7. Mesure (à 2 semaines OU ≥50 claims TREATMENT, le premier atteint)

Bilan opérationnel possible à J+7 (santé du sweep, volumes, plaintes) ; la
**décision** (V2, budget) attend la fenêtre complète — 7 jours et ~2 Clés,
c'est du bruit.

- **Principale, causale (ITT)** : conversion Clé `ACTIVATED` ≤72 h et taux de
  réponse, **tous `arm='TREATMENT'`** (y compris `FAILED`) vs
  **`arm='HOLDOUT'`**. Le holdout EST la baseline — pas de seuil absolu.
- **Secondaire, opérationnelle** : taux de livraison (`SENT` non repassés
  `FAILED` par le hook) et conversion parmi `outcome='SENT'`, `sent_at` comme
  origine des 72 h.
- **Relance plan (prod)** : conversion via `expiry_nudged_at` — compter comme
  converti le paiement tardif de l'ordre original **OU** l'activation d'un
  descendant (CTE récursif sur `retry_of_order_id`) ; segmenter par `is_key`.
- **Qualité du numéro** (WhatsApp Manager) : si la note baisse → allonger le
  délai, pas de V2.
- **Budget doublé** : coût/lead et coût/Clé avant/après. Leads ×2 sans ventes
  ×2 → signal « refine targeting », pas « spend more ». Le holdout isole
  l'effet nudge de l'effet budget.

## 8. Tests

- **Purs** (`npm test`) : copy FR/EN (snapshot) ; `fnv1aMod` déterministe
  (valeurs figées + distribution grossière) ; `isQuietHour` aux bornes
  (9 h, 20 h 59, 21 h, 8 h 59).
- **Intégration** (`npm run test:integration`) :
  - one-shot : 2 sweeps → 1 seul envoi ;
  - **réponse entre sélection et claim → 0 ligne** (les deux bras) ;
  - paiement/ordre créé entre-temps → 0 ligne ; takeover/handoff ouvert
    entre-temps → 0 ligne ;
  - **invariant des bras** : mêmes gardes — un même état bloquant refuse
    TREATMENT et HOLDOUT à l'identique ;
  - lead jamais-répondu → `TREATMENT/SENT` + turn + wamid + `sent_at` ;
  - lead en holdout → `HOLDOUT/SUPPRESSED`, jamais renudgé ensuite ;
  - client avec ordre plan `EXPIRED` → exclu (pas d'empilement avec la relance
    plan prod) ;
  - ancien client avec historique + nouveau lead → **candidat** (ancrage
    trigger, pas « 1 seul message ») ;
  - statut Meta `failed` → `outcome FAILED`, **`arm` inchangé**.
- Ship : `npm run agent:ship -- --full`.

## 9. Rollout

1. Implémentation dans le worktree `lead-nudges` (créé), flag `false`.
2. Ship → auto-deploy. **Dry-run prod** (read-only) : lister les candidats du
   moment, vérifier à la main (pas de payeur, pas de takeover, volumes
   plausibles ~10-30).
3. `railway variables --set LEAD_NUDGE_ENABLED=true`, surveiller un cycle de
   sweep dans les logs.
4. Mettre à jour PROGRESS.md (décision, chiffres §1, découverte §2).
5. Bilan opérationnel J+7 ; **décision à 2 semaines / 50 claims** (§7).

## 10. V2 (hors build) — template « réveil J+2 »

Leads jamais convertis, fenêtre fermée : template Meta one-shot ~48 h (créé par
Babakar, langue `en` par convention), `WA_LEAD_REVIVAL_TEMPLATE` + `_LANG`,
dedup `LEAD_REVIVAL:<client_id>` dans le même journal (mêmes colonnes
arm/outcome). **Uniquement si la mesure §7 le justifie** : si A récupère bien,
C est du spam ; si A plafonne, C prend le relais.

## Hors périmètre (explicite)

- Refactor du claim naïf de la relance plan/bookings en prod (dette réelle mais
  étroite et indépendante — chantier séparé si un jour nécessaire).
- Leads pré-30/07 (fenêtre morte, pitch d'époque buggé) — campagne « réveil »
  séparée, à décider avec la V2.
- Leads multi-messages qui ont calé (2-3 msgs, ~40 sur la période) — extension
  post-V1 : copy neutre ou état serveur déterministe requis.
- Clients non-pub.
- Aucun changement au prompt d'Awa ni au flux de paiement.
