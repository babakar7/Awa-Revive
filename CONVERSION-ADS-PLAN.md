# CONVERSION-ADS-PLAN — section « Acquisition pubs Meta » sur /admin/conversion

> **Statut : PLAN — à valider avant implémentation.** Rédigé le 03/08/2026.
> Objectif : donner à Babakar une vue self-service sur ce que sa dépense pub
> produit (aujourd'hui : zéro visibilité dashboard, tout vit dans des scripts
> jetables). Contexte : budget pub doublé $5 → $10/jour le 03/08 ; les leads pub
> alimentent la Clé L'Invitée (cf. [LEAD-FOLLOWUP-PLAN.md](LEAD-FOLLOWUP-PLAN.md)).

## 0. Décision produit centrale — le budget change de semaine en semaine

Le budget n'est PAS constant : $5/jour depuis le lancement (~24/07), $10/jour
depuis le 03/08, et il rebougera. Un champ « budget » unique donnerait donc des
coûts/lead faux. **On modélise le budget comme un journal daté de changements**,
et la dépense d'une fenêtre = somme, jour par jour, du budget quotidien en
vigueur ce jour-là.

Conséquence concrète : la semaine qui contient le 03/08 est *mixte* (quelques
jours à $5, quelques-uns à $10) → sa dépense est calculée au prorata, pas
approximée. Chaque changement futur = une nouvelle ligne datée saisie dans
l'admin. C'est ce qui rend le coût/lead et le coût/Clé honnêtes semaine après
semaine.

```
create table if not exists ad_budget_periods (
  id uuid primary key default gen_random_uuid(),
  effective_from date not null unique,   -- jour (Dakar) où ce budget/jour prend effet
  daily_amount_usd numeric(10,2) not null check (daily_amount_usd >= 0),
  note text,
  created_by text,
  created_at timestamptz not null default now()
);
```

Le budget quotidien d'un jour `d` = la ligne au plus grand `effective_from <= d`.
Dépense d'une fenêtre `[start, end)` :

```sql
select coalesce(sum(p.daily_amount_usd), 0) as spend_usd
  from generate_series($1::date, $2::date - 1, interval '1 day') g(day)
  left join lateral (
    select daily_amount_usd from ad_budget_periods b
     where b.effective_from <= g.day
     order by b.effective_from desc limit 1
  ) p on true;
```

**Devise.** Babakar raisonne en dollars (Meta). Le CA est en FCFA (Clé = 30 000 F).
Pour un coût/Clé et un ROAS comparables, on convertit via **un seul taux
USD→XOF éditable** (clé `usd_xof_rate` dans `app_state`, défaut ~610). La page
affiche la dépense en $ ET en FCFA ; coût/Clé et ROAS calculés en FCFA. Le taux
n'a pas besoin d'être parfait — c'est un tableau de bord de décision, pas une
compta.

**Amorçage.** Insérer deux lignes connues (éditables ensuite) :
`2026-07-24 → 5.00` et `2026-08-03 → 10.00`. La date exacte du démarrage à $5
est à confirmer par Babakar (premier lead le 24/07).

## 1. Où ça se branche

Architecture actuelle (propre, on la prolonge) :
- [src/domain/bookingFunnel.ts](src/domain/bookingFunnel.ts) →
  `bookingConversionDashboard()` assemble les données.
- [src/admin/conversionPage.ts](src/admin/conversionPage.ts) →
  `renderConversionPage(dashboard)` rend le HTML.
- [src/admin/routes.ts](src/admin/routes.ts) → `GET /admin/conversion`.

Nouveau : un module `src/domain/adAcquisition.ts` exposant
`adAcquisitionDashboard()` (indépendant du funnel de réservation — ce sont deux
funnels différents). La route appelle les deux et passe les deux au rendu ; la
page gagne une **section « Acquisition — pubs Meta »** au-dessus ou en tête du
funnel de réservation. **On ne mélange pas** : le funnel de réservation répond à
« où callent les acheteurs en cours d'achat ? » ; la section pub répond à « ma
dépense marche-t-elle, et faut-il changer le budget ou le ciblage ? ».

## 0bis. Deux sources possibles pour la DÉPENSE — journal manuel vs API Meta

La dépense peut venir de deux endroits. Ils ne s'excluent pas : le journal
manuel ship tout de suite sans dépendance ; l'API Meta le remplace ensuite par
la vérité facturée + des métriques que la DB ne connaît pas.

**Option A — journal manuel `ad_budget_periods` (§0). Recommandé pour la v1.**
Zéro dépendance externe, ship aujourd'hui. Donne la dépense *programmée*
(budget/jour saisi), pas la *facturée*. Suffit pour coût/lead et coût/Clé à
l'ordre de grandeur.

**Option B — Meta Marketing API (Insights). Phase 2.**
`GET https://graph.facebook.com/v21.0/act_<AD_ACCOUNT_ID>/insights` renvoie la
**dépense réelle facturée** + `impressions, clicks, ctr, cpm, cpc, reach`, et —
crucial — les **breakdowns par campagne / ad set / créa** et le
`cost_per_result` (résultat = conversation WhatsApp lancée, pour une pub CTWA).
On peut demander `time_increment=1` (série jour par jour) ou une ventilation par
semaine, ce qui alimente directement le Bloc A et enrichit le Bloc C (CTR/CPM
par `headline`).

Ce qu'il faut pour l'option B :
- **App Meta déjà présente** (App ID en config, on tape déjà graph.facebook.com
  v21.0 pour WhatsApp) — l'infra Graph est là.
- **Un token avec la permission `ads_read`** — le token WhatsApp actuel ne l'a
  probablement pas ; il faut un **token « system user »** longue durée du
  Business Manager, avec accès au compte publicitaire. Nouvelle var
  `META_ADS_TOKEN`.
- **L'ID du compte publicitaire** `act_<...>` → nouvelle var `META_AD_ACCOUNT_ID`.
- (Éventuellement une App Review pour `ads_read` selon le mode de l'app ; en
  usage interne/Business, un system user suffit souvent sans review.)

**Répartition idéale (le meilleur des deux) :** Meta pour la **dépense +
livraison** (spend réel, CTR, CPM, cost-per-result par créa) ; notre DB pour le
**résultat argent** (Clés achetées, CA, ROAS) — parce que Meta voit « une
conversation lancée » mais PAS « a acheté une Clé à 30 000 F », ça, c'est nous
qui le savons via `campaign_leads × pending_plan_orders`. On colle les deux par
créa (`headline` ↔ ad name).

**Recommandation :** livrer la v1 sur l'option A (le journal reste de toute façon
utile comme repli/annotation), puis brancher l'option B en phase 2 pour passer
« dépense estimée » → « dépense réelle + CTR/CPM/coût-par-résultat par créa ».
Le reste du dashboard (blocs, attribution DB) ne change pas — seule la source
`windowSpendUsd` bascule du journal vers Meta (avec repli sur le journal si
l'API est indisponible).

## 2. Sources de données — tout existe déjà, zéro nouveau tracking

- `campaign_leads` (client_id, campaign_key, **headline**, matched_by, created_at).
- `conversations` (pour la qualité des leads : réponses après le message auto).
- `pending_plan_orders` (is_key, status, paid_at, amount_xof) + `key_registry`.
- `outbound_nudges` (relances manuelles : outcome, sent_at).
- `clients.is_test` (exclusion équipe/tests, comme le reste du dashboard).
- Nouveau : `ad_budget_periods` (§0) + `app_state('usd_xof_rate')`.

Fenêtres : **7 j / 30 j** (comme le funnel existant) + un **tableau par semaine
ISO** (là où le changement de budget se voit vraiment).

## 3. Les 4 blocs de la section

### Bloc A — Volume & dépense (le nerf de la décision budget)
Par fenêtre (7 j, 30 j) et par semaine :
- **Leads** : `count(campaign_leads)` (is_test exclus).
- **Dépense** : requête §0, en $ et FCFA.
- **Coût / lead** = dépense / leads.
- Tendance hebdo : leads, dépense, coût/lead par semaine ISO. **C'est ici que
  le doublement se lit** : si les leads ne suivent pas la dépense, le coût/lead
  monte → signal « le budget sature l'audience ».

### Bloc B — Qualité des leads (jauge de CIBLAGE)
Classer les leads de la fenêtre par nombre de réponses tapées APRÈS le message
auto (même ancrage `trigger_message_id` que les relances) :
- **0 réponse** = cliqueur réflexe (le message d'ouverture est pré-rempli par la
  pub → zéro intention) ;
- **1 réponse** = superficiel ;
- **≥2 réponses** = vraie conversation.

Afficher les 3 %. **Tendance clé** : si après le passage à $10 la part de
cliqueurs réflexes grimpe (~40 % → 60 %), Meta achète des clics moins chers mais
pires → **« refine targeting, don't spend more »** rendu visible, avec ta propre
définition de l'intention.

### Bloc C — Ventes Clés attribuées aux pubs
- **Clés achetées par des leads pub** (buyer a une ligne `campaign_leads`, achat
  après `campaign_leads.created_at`) : `pending_plan_orders` is_key +
  status='ACTIVATED' (ou `key_registry`). Compte 7 j / 30 j.
- **Conversion lead → Clé**, **CA attribué** (Σ amount_xof).
- **Coût / Clé** = dépense (FCFA) / Clés. **ROAS** = CA / dépense.
- **Ventilation par créa (`headline`)** : leads, Clés, conversion par titre de
  pub. C'est ce qui aurait attrapé « Pack Découverte matcha » (26 leads, 0 vente)
  et « Publicité en statut » (19 leads, 0 vente) sans re-lancer un script.

### Bloc D — Relances manuelles (efficacité de /admin/relances)
Depuis `outbound_nudges` (kind='LEAD_SILENT') :
- envoyées vs ignorées ;
- parmi les envoyées : % ayant répondu (turn user après `sent_at`) et % ayant
  acheté une Clé sous 72 h. **Directionnel, pas causal** (plus de holdout depuis
  le passage en manuel) — à étiqueter comme tel sur la page.

## 4. Attribution & pièges (à afficher honnêtement)

- **Attribution = « ce client vient d'une pub, puis a acheté une Clé un jour ».**
  Généreuse : un lead qui achète 3 semaines plus tard compte encore. Suffisant à
  cette échelle, mais à noter sur la page (pas de fenêtre d'attribution stricte).
- **Coût/lead & coût/Clé dépendent du budget saisi** : si le journal
  `ad_budget_periods` n'est pas à jour, les coûts sont faux. Bandeau d'alerte si
  aucune période ne couvre la fenêtre affichée.
- **La dépense Meta réelle peut différer du budget** (Meta sous-dépense parfois).
  On affiche le budget *programmé*, pas le *facturé* — approximation assumée
  (pas d'API Meta Ads branchée). À afficher comme « dépense estimée ».
- **Taux USD→XOF** approximatif et éditable — le ROAS est un ordre de grandeur.

## 5. Admin — éditer le budget

Petit formulaire (page `/admin/conversion` en bas, ou `/admin/pub-budget`) :
- liste des périodes (`effective_from`, `$/jour`, note) + ajout d'une ligne ;
- champ taux USD→XOF.
Réservé au propriétaire (comme le journal/rapport). Écrit `ad_budget_periods` +
`app_state('usd_xof_rate')`. Journalisé dans `admin_audit_log`.

## 6. Fichiers touchés

- **schema.ts** : table `ad_budget_periods` + amorçage des 2 périodes connues.
- **`src/domain/adAcquisition.ts`** (nouveau) : `adAcquisitionDashboard()`
  (blocs A–D) + `windowSpendUsd(start,end)` + repo budget (list/upsert period,
  get/set FX).
- **conversionPage.ts** : nouvelle section rendue depuis le nouveau dashboard
  (fonctions pures de rendu, testables).
- **routes.ts** : `/conversion` appelle aussi `adAcquisitionDashboard()` ;
  routes POST du budget (owner-only).
- **navBadges / layout** : inchangés (section dans une page existante).

## 7. Tests

- **Purs** : `windowSpendUsd` sur un changement de budget en milieu de fenêtre
  (le cas $5→$10 du 03/08 : une fenêtre de 7 j à cheval doit donner un mix, pas
  5×7 ni 10×7) ; classification qualité 0/1/≥2 ; rendu de la section (pas de
  throw, bandeau si budget manquant).
- **Intégration** : seed leads (réflexe/superficiel/engagé) + une Clé attribuée
  + une relance envoyée → le dashboard rend les bons compteurs ; ventilation par
  headline ; exclusion is_test ; route `/admin/conversion` renvoie 200 avec la
  section.

## 8. Découpage de livraison (incrémental)

1. **Budget d'abord** : table + amorçage + `windowSpendUsd` + éditeur admin +
   tests. Rien d'autre n'a de sens sans dépense correcte.
2. **Blocs A & C** (volume/dépense/coût-lead + Clés/coût-Clé/ROAS par créa) —
   le cœur de la décision budget.
3. **Bloc B** (qualité/ciblage).
4. **Bloc D** (efficacité des relances).
Chaque étape = un push buildé+testé (auto-deploy). ~0,5–1 j au total.

## 9. Phase 2 — brancher l'API Meta (option B, §0bis)

Quand Babakar fournit un token `ads_read` + l'ID de compte publicitaire :
- Nouveau `src/lib/metaAds.ts` : `fetchInsights({since, until, timeIncrement, breakdowns})`
  sur `graph.facebook.com/v21.0/act_<id>/insights` (mêmes patterns fetch/retry
  que `src/lib/whatsapp.ts`).
- `windowSpendUsd` bascule sur la dépense facturée Meta, **repli sur le journal**
  si l'API échoue (dashboard jamais à blanc).
- Bloc A gagne CTR/CPM ; Bloc C gagne CTR/CPM/coût-par-résultat par créa (jointure
  `headline` ↔ nom de la pub Meta).
- Vars : `META_ADS_TOKEN`, `META_AD_ACCOUNT_ID` (posées via `railway variables --set`).
- Cache court (≤1 h) des insights pour ne pas taper l'API à chaque affichage.

## Hors périmètre
- Attribution multi-touch ou fenêtre d'attribution stricte (on garde « lead pub
  → a acheté une Clé plus tard »).
- Le funnel de réservation existant n'est pas modifié.
- Achat/gestion des pubs depuis l'admin (lecture seule ; on ne crée/édite pas de
  campagnes via l'API).
