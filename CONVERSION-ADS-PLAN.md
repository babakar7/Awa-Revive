# CONVERSION-ADS-PLAN — « Acquisition pubs Meta » sur /admin/conversion (API Meta au cœur)

> **Statut : PLAN — à valider avant implémentation.** Réécrit le 03/08/2026 pour
> intégrer l'**API Meta Marketing (Insights) dès la v1** (plus de « phase 2 »).
> Objectif : une vue self-service qui relie la **dépense réelle Meta** aux
> **ventes de Clés** de la DB, pour décider budget & ciblage sans script jetable.
> Contexte : budget doublé $5 → $10/jour le 03/08 ; leads pub → Clé L'Invitée
> (cf. [LEAD-FOLLOWUP-PLAN.md](LEAD-FOLLOWUP-PLAN.md)).

## 0. Idée directrice — Meta pour la dépense, notre DB pour l'argent

Meta sait : **dépense facturée réelle, impressions, clics, CTR, CPM, CPC,
coût-par-résultat** (résultat = conversation WhatsApp lancée) — par campagne / ad
set / **pub**, jour par jour. Meta NE sait PAS qu'un lead a acheté une **Clé à
30 000 F** — ça, seule notre DB le sait (`campaign_leads × pending_plan_orders`).

Le plan colle les deux **par ID de pub Meta** : chaque `campaign_leads.source_id`
est l'ID de la pub (`source_type='ad'`, ex. `120249271231720239`), capté du
referral click-to-WhatsApp. Donc : dépense (Meta) ÷ Clés (DB) = **coût par Clé
et ROAS réels**, joints sur une vraie clé, pas du texte.

> ⚠️ **Granularité réelle constatée en prod (03/08) :** tous les leads partagent
> aujourd'hui **un seul `source_id`** pour 3 headlines différentes. Donc la
> **dépense se joint au niveau PUB** (un seul ad id), pas par headline. La
> ventilation par `headline` (Bloc C) reste une lecture **qualitative côté DB**
> (« quel message convertit »), pas un coût/créa exact. Pour un coût/créa exact,
> il faudra soit séparer les créas en pubs distinctes (ad ids distincts), soit
> exploiter les *asset breakdowns* Meta (dynamic creative) — noté en §Hors périmètre.

## 1. Prérequis Meta (ce que Babakar fournit, ce que je branche)

L'infra Graph est déjà là (App Meta en config, on tape `graph.facebook.com/v21.0`
pour WhatsApp). Il manque juste la lecture pub :

1. **Un token `ads_read`** — le token WhatsApp actuel ne l'a pas. Créer un
   **token « system user » longue durée** dans Business Manager, avec accès au
   compte publicitaire. → var `META_ADS_TOKEN`.
2. **L'ID du compte publicitaire** `act_<…>` (visible dans Ads Manager). → var
   `META_AD_ACCOUNT_ID`.
3. (Usage interne Business : un system user suffit en général, sans App Review
   pour `ads_read`.)

**Moi je pose les vars Railway** (`railway variables --set`) — pas de manip
dashboard côté Babakar au-delà de fournir le token + l'account id. Tant qu'elles
ne sont pas posées, les blocs « dépense » affichent un état « Connecter Meta »
propre ; les blocs DB (qualité, Clés en volume, relances) marchent déjà.

## 2. Architecture — projection locale des insights (comme wix_attendance)

On ne tape pas l'API Meta à chaque affichage (lenteur + rate limits). On
**synchronise** les insights dans une table locale, exactement comme
`wix_attendance_records` projette Wix : rapide, résilient (dashboard jamais à
blanc si Meta hoquette), et ça constitue un **historique durable de dépense**
même si l'accès API change plus tard.

```sql
create table if not exists ad_insights_daily (
  day date not null,
  ad_id text not null,
  ad_name text,
  adset_name text,
  campaign_name text,
  spend numeric(12,2) not null default 0,     -- dans account_currency
  impressions integer not null default 0,
  clicks integer not null default 0,
  results integer not null default 0,         -- conversations WhatsApp lancées (CTWA)
  account_currency text,                      -- ex. 'USD' ou 'XOF'
  synced_at timestamptz not null default now(),
  primary key (day, ad_id)
);
create index if not exists idx_ad_insights_day on ad_insights_daily (day);
```

- **`src/lib/metaAds.ts`** : `fetchInsights({since, until, level:'ad', timeIncrement:1})`
  → `GET /v21.0/act_<id>/insights?fields=spend,impressions,clicks,ctr,cpm,cpc,actions,account_currency,ad_id,ad_name,adset_name,campaign_name&level=ad&time_increment=1&time_range={...}`.
  Mêmes patterns fetch/retry que [src/lib/whatsapp.ts](src/lib/whatsapp.ts).
  `results` = extrait de `actions` (action CTWA « onsite_conversion... » /
  messaging_conversation_started — à confirmer sur le compte réel, §9 étape 1).
- **`syncAdInsights()`** dans le sweep (cap ~1×/heure, comme
  `syncAttendanceLeaderboard`) : réabsorbe les ~30 derniers jours (les jours
  récents bougent : Meta réconcilie la dépense a posteriori) et upsert par
  `(day, ad_id)`. + un bouton **« Resynchroniser »** sur la page (owner).
- Le dashboard lit `ad_insights_daily` (jamais l'API en direct).

**Devise.** On lit `account_currency` renvoyé par Meta. Le CA est en FCFA. Si le
compte n'est pas en XOF (souvent USD), on convertit la dépense en FCFA via **un
taux éditable** (`app_state('usd_xof_rate')`, défaut ~610) pour coût/Clé & ROAS.
Affichage en devise native ET FCFA.

## 3. Le budget change de semaine en semaine — et c'est natif ici

Puisque la dépense vient d'`ad_insights_daily` **jour par jour**, un changement
de budget (le $5→$10 du 03/08, ou tout futur) est capturé **automatiquement** :
la dépense de chaque jour est la vraie dépense de ce jour. La dépense d'une
semaine = `sum(spend)` sur ses jours — une semaine à cheval sur un changement est
juste la somme des vraies dépenses quotidiennes. **Aucun budget à saisir à la
main.** Le repli manuel optionnel ne sert qu'avant configuration / panne API (§8).

## 4. Sources de données

- **Meta (via `ad_insights_daily`)** : dépense, impressions, clics, CTR, CPM,
  CPC, résultats — par jour et par pub.
- **`campaign_leads`** : leads, `source_id` (ad id, clé de jointure), `headline`,
  `created_at`, is_test exclus.
- **`conversations`** : qualité des leads (réponses après le message auto).
- **`pending_plan_orders`** (is_key, ACTIVATED, paid_at, amount_xof) +
  `key_registry` : Clés attribuées.
- **`outbound_nudges`** : relances manuelles.
- **Nouveau** : `ad_insights_daily` + `app_state('usd_xof_rate')`.

Fenêtres : **7 j / 30 j** + **tableau par semaine ISO** (tendance).

## 5. Les 4 blocs

### Bloc A — Dépense & livraison (Meta)
Par fenêtre + par semaine : **dépense réelle** ($/FCFA), impressions, clics,
**CTR, CPM, CPC**, **résultats** (conversations lancées) et **coût-par-résultat
Meta**. En regard, **leads comptés côté DB** et **coût/lead** = dépense ÷ leads
(notre définition de lead). Écart Meta-résultats vs nos-leads = signal
d'attribution. **La tendance hebdo montre le doublement** : si la dépense monte
mais pas les leads, coût/lead grimpe → « le budget sature l'audience ».

### Bloc B — Qualité des leads (ciblage) — DB
Leads classés par réponses tapées APRÈS le message auto (ancrage
`trigger_message_id`) : **0 = cliqueur réflexe** (message d'ouverture pré-rempli
= zéro intention), **1 = superficiel**, **≥2 = vraie conversation**. Les 3 % +
tendance. Si après $10 la part de réflexes grimpe (~40 %→60 %) → **« refine
targeting, don't spend more »**, visible.

### Bloc C — Clés & ROAS par pub (Meta × DB)
Jointure `campaign_leads.source_id = ad_insights_daily.ad_id` :
- **dépense par pub** (Meta) ; **Clés par pub** (DB, is_key ACTIVATED) ; **CA
  attribué** (Σ amount_xof) ; **coût/Clé** = dépense ÷ Clés ; **ROAS** = CA ÷
  dépense ; CTR/CPM par pub.
- **Ventilation par `headline`** (côté DB) : leads, ≥2-réponses, Clés, conversion
  par titre — la lecture « quel message convertit » qui aurait tué « Pack
  Découverte matcha » (26 leads, 0 Clé) et « Publicité en statut » (19, 0).
  *(Coût par headline = approximatif tant qu'un seul ad id — cf. §0 ⚠️.)*

### Bloc D — Relances manuelles — DB
`outbound_nudges` (kind='LEAD_SILENT') : envoyées vs ignorées ; parmi envoyées,
% ayant répondu (turn user après `sent_at`) et % ayant acheté une Clé sous 72 h.
**Directionnel, pas causal** (plus de holdout) — étiqueté comme tel.

## 6. Attribution & pièges (affichés honnêtement)

- **Attribution = « ce client vient d'une pub, puis a acheté une Clé ».**
  Généreuse (achat même 3 semaines après). À noter sur la page.
- **Dépense = ce que Meta facture** (mieux que le budget programmé), mais les
  jours récents se réajustent → resync régulier ; on affiche `synced_at`.
- **Granularité créa** : un seul ad id aujourd'hui → coût exact au niveau pub,
  pas par headline (§0 ⚠️).
- **Taux de change** approximatif/éditable → ROAS en ordre de grandeur si le
  compte n'est pas en XOF.
- **Résultat Meta ≠ notre lead** : Meta compte « conversation lancée », nous
  comptons une ligne `campaign_leads` ; petits écarts normaux.

## 7. Fichiers touchés

- **schema.ts** : `ad_insights_daily` (+ index).
- **`src/lib/metaAds.ts`** (nouveau) : appel Insights + parsing.
- **`src/domain/adInsightsSync.ts`** (nouveau) : `syncAdInsights()` (upsert, cap
  horaire), branché au sweep de [src/index.ts](src/index.ts).
- **`src/domain/adAcquisition.ts`** (nouveau) : `adAcquisitionDashboard()`
  (blocs A–D, lit la projection locale + DB) + get/set FX.
- **conversionPage.ts** : nouvelle section (fonctions de rendu pures, testables).
- **routes.ts** : `/conversion` appelle aussi `adAcquisitionDashboard()` ;
  `POST /conversion/resync-ads` (owner) ; form taux FX (owner).
- **config.ts** : `META_ADS_TOKEN`, `META_AD_ACCOUNT_ID`, `META_GRAPH_VERSION`
  (défaut v21.0).

## 8. Repli optionnel (résilience, pas le cœur)

Si `META_ADS_TOKEN`/`META_AD_ACCOUNT_ID` absents ou API en panne : les blocs
dépense affichent « Connecter Meta » / « Dépense indisponible » (avec la dernière
`synced_at`), les blocs DB rendent normalement. Un mini-journal `ad_budget_periods`
(budget/jour daté) reste **optionnel** comme estimation de secours — non
implémenté en v1 sauf besoin explicite.

## 9. Découpage de livraison

1. **Connexion Meta** : `metaAds.ts` + `ad_insights_daily` + `syncAdInsights()` +
   resync manuel + vars Railway. Vérifier qu'on lit la vraie dépense/résultats du
   compte (le mapping `actions`→résultat CTWA se confirme ici, sur données réelles).
2. **Bloc A** (dépense/livraison + coût/lead, 7j/30j/hebdo) — le cœur budget.
3. **Bloc C** (Clés/coût-Clé/ROAS par pub + ventilation headline).
4. **Bloc B** (qualité/ciblage).
5. **Bloc D** (relances).
Chaque étape = un push buildé+testé (auto-deploy). ~1–1,5 j au total.

## 10. Tests

- **Purs** : parsing insights (extraction `results` depuis `actions`, devise) ;
  agrégations fenêtre/semaine sur un jeu `ad_insights_daily` seedé (dont une
  semaine à cheval sur un changement de dépense) ; classification qualité 0/1/≥2 ;
  jointure Clés×pub ; rendu section (états « connecter Meta » / données présentes).
- **Intégration** : `metaAds` contre un **mock fetch** (comme Wix/Wave dans
  `test/integration/helpers.ts`) renvoyant un payload insights réaliste →
  `syncAdInsights` upsert correctement (idempotent, resync ne double pas) ;
  dashboard joint dépense (mock) × leads/Clés (seed) et calcule coût/Clé + ROAS ;
  route `/admin/conversion` renvoie 200 avec la section ; exclusion is_test.

## Hors périmètre
- Achat/édition de campagnes via l'API (lecture seule).
- Attribution multi-touch / fenêtre stricte (on garde « lead pub → Clé plus tard »).
- Le funnel de réservation existant n'est pas modifié.
- **Coût/créa exact par headline** tant que les créas partagent un ad id (§0 ⚠️)
  — à débloquer en séparant les pubs en ad ids distincts, ou via les *asset
  breakdowns* Meta (dynamic creative).
