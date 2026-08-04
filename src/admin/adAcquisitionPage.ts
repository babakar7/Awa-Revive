import type {
  AcquisitionPeriod,
  AdAcquisitionDashboard,
  DeliveryMetrics,
} from "../domain/adAcquisition.js";
import { escapeHtml as esc, fmtDate, fmtFcfa } from "./helpers.js";

function pct(value: number | null): string {
  return value === null ? "—" : `${value.toLocaleString("fr-FR", { maximumFractionDigits: 1 })} %`;
}

function decimal(value: number | null, suffix = ""): string {
  return value === null ? "—" : `${value.toLocaleString("fr-FR", { maximumFractionDigits: 2 })}${suffix}`;
}

function nativeMoney(value: number, currency: string): string {
  return new Intl.NumberFormat("fr-FR", { style: "currency", currency, maximumFractionDigits: 2 }).format(value);
}

function deliveryCard(label: string, row: DeliveryMetrics, currency: string, fxRate: number, inProgress: boolean): string {
  const xof = currency === "USD" ? `≈ ${fmtFcfa(Math.round(row.spend*fxRate))}` : currency === "XOF" ? fmtFcfa(row.spend) : "conversion indisponible";
  return `<article class="card"><span class="eyebrow">${esc(label)}${inProgress?` · <span class="badge badge--amber">en cours</span>`:""}</span><div class="stat-grid report-stat-grid">
  <div class="stat"><span>Dépense livrée</span><b>${nativeMoney(row.spend,currency)}</b><span>${xof} · facturée par Meta</span></div>
  <div class="stat"><span>Leads DB</span><b>${row.leads}</b><span>${row.results} résultats Meta</span></div>
  <div class="stat"><span>Coût / lead DB</span><b>${row.costPerLead===null?"—":nativeMoney(row.costPerLead,currency)}</b><span>dates et fuseau alignés</span></div>
  <div class="stat"><span>CTR</span><b>${pct(row.ctr)}</b><span>${row.impressions.toLocaleString("fr-FR")} impressions</span></div>
  <div class="stat"><span>Clics lien</span><b>${row.linkClicks.toLocaleString("fr-FR")}</b><span>${row.clicks.toLocaleString("fr-FR")} clics (tous)</span></div>
  <div class="stat"><span>Coût / résultat Meta</span><b>${row.costPerResult===null?"—":nativeMoney(row.costPerResult,currency)}</b><span>CPC (tous) ${row.cpc===null?"—":nativeMoney(row.cpc,currency)} · CPM ${row.cpm===null?"—":nativeMoney(row.cpm,currency)}</span></div>
  </div></article>`;
}

function qualityCard(period: AcquisitionPeriod): string {
  const q = period.quality;
  const share = (value: number) => q.total ? `${((value/q.total)*100).toLocaleString("fr-FR",{maximumFractionDigits:1})} %` : "—";
  return `<div class="card"><span class="eyebrow">${esc(period.label)}</span><div class="stat-grid">
    <div class="stat"><span>0 réponse</span><b>${q.zero}</b><span>${share(q.zero)} cliqueurs réflexes</span></div>
    <div class="stat"><span>1 réponse</span><b>${q.one}</b><span>${share(q.one)} superficiels</span></div>
    <div class="stat"><span>≥ 2 réponses</span><b>${q.engaged}</b><span>${share(q.engaged)} vraies conversations</span></div>
  </div></div>`;
}

function nudgeCard(period: AcquisitionPeriod, financialReady: boolean): string {
  const n = period.nudges;
  const percent = (value: number) => n.matureSent ? pct((value/n.matureSent)*100) : "—";
  return `<div class="card"><span class="eyebrow">${esc(period.label)}</span><div class="stat-grid report-stat-grid">
    <div class="stat"><span>Envoyées</span><b>${n.sent}</b><span>${n.suppressed} ignorées · ${n.failed} échecs</span></div>
    <div class="stat"><span>Échantillon mature</span><b>${n.matureSent}</b><span>envoyées depuis plus de 72 h</span></div>
    <div class="stat"><span>Réponse sous 72 h</span><b>${percent(n.replied72h)}</b><span>${n.replied72h} clientes</span></div>
    <div class="stat"><span>Achat sous 72 h</span><b>${financialReady?percent(n.purchased72h):"—"}</b><span>${financialReady?`${n.purchased72h} clientes`:"allowlist Clés incomplète"}</span></div>
  </div><p class="muted">Indicatif, non randomisé : le flux manuel ne comporte pas de groupe holdout.</p></div>`;
}

function cohortSummary(period: AcquisitionPeriod, data: AdAcquisitionDashboard): string {
  const sales = period.ads.reduce((sum,row) => sum+row.acquisitionSales,0);
  const revenue = period.ads.reduce((sum,row) => sum+row.acquisitionRevenueXof,0);
  const renewals = period.ads.reduce((sum,row) => sum+row.influencedRenewals,0);
  const spendXof = data.currency==="XOF" ? period.delivery.spend : data.currency==="USD" ? period.delivery.spend*data.fxRate : null;
  const roas = spendXof && spendXof>0 ? revenue/spendXof : null;
  return `<article class="card ad-roas-hero"><span class="eyebrow">Cohorte ${esc(period.label)} · <span class="badge badge--amber">en maturation</span></span><div class="stat-grid ad-roas-grid">
    <div class="stat ad-roas-primary"><span>ROAS attribué estimé</span><b>${decimal(roas,"×")}</b><span>CA acquisition ÷ dépense · première Clé à &lt; 30 j</span></div>
    <div class="stat"><span>Ventes acquisition</span><b>${sales}</b><span>${fmtFcfa(revenue)} brut</span></div>
    <div class="stat"><span>Renouvellements influencés</span><b>${renewals}</b><span>montrés à part</span></div>
  </div></article>`;
}

function adsTable(period: AcquisitionPeriod, data: AdAcquisitionDashboard): string {
  const financialReady = !data.eligibilityError;
  const planLines = (breakdown: Record<string,{sales:number;revenueXof:number}>) => Object.entries(breakdown)
    .map(([planId,value]) => `${esc(planId)} : ${value.sales} · ${fmtFcfa(value.revenueXof)}`).join("<br>");
  const rows = period.ads.map((row) => `<tr>
    <td data-label="Pub"><b>${esc(row.adName)}</b><div class="muted">${esc(row.campaignName)} · ${esc(row.adId)}</div></td>
    <td data-label="Dépense"><b>${nativeMoney(row.spend,data.currency)}</b><div class="muted">${data.currency==="USD"?`≈ ${fmtFcfa(Math.round(row.spend*data.fxRate))} · `:""}${row.impressions.toLocaleString("fr-FR")} impr.</div></td>
    <td data-label="Leads">${row.leads}<div class="muted">CTR ${pct(row.ctr)}</div></td>
    <td data-label="Acquisition"><b>${financialReady?row.acquisitionSales:"—"}</b><div class="muted">${financialReady?`${fmtFcfa(row.acquisitionRevenueXof)} brut${planLines(row.planBreakdown)?`<br>${planLines(row.planBreakdown)}`:""}`:"allowlist Clés incomplète"}</div></td>
    <td data-label="Coût / Clé"><b>${financialReady&&row.costPerKeyXof!==null?fmtFcfa(Math.round(row.costPerKeyXof)):"—"}</b></td>
    <td data-label="ROAS"><b>${financialReady?decimal(row.roas,"×"):"—"}</b><div class="muted">attribué estimé</div></td>
    <td data-label="Provisioning">${financialReady?`${row.activated} activées<div class="muted">${row.toActivate} à activer</div>`:"—"}</td>
    <td data-label="Renouvellements">${financialReady?row.influencedRenewals:"—"}<div class="muted">hors ROAS acquisition</div></td>
  </tr>`).join("");
  return rows ? `<div class="card"><p><span class="badge badge--amber">cohortes en maturation</span> Les leads de cette période n’ont pas tous atteint leur fenêtre complète.</p><div class="table-wrap"><table class="responsive-table"><thead><tr><th>Pub</th><th>Dépense</th><th>Leads</th><th>Ventes acquisition</th><th>Coût / Clé</th><th>ROAS</th><th>Activation</th><th>Renouvellements</th></tr></thead><tbody>${rows}</tbody></table></div></div>`
    : `<div class="card empty"><b>Aucune dépense Meta dans cette fenêtre</b><p>Une pub avec dépense et zéro lead apparaîtra ici dès la prochaine synchronisation.</p></div>`;
}

function headlineTable(period: AcquisitionPeriod, financialReady: boolean): string {
  const rows = period.headlines.map((row) => `<tr><td data-label="Titre"><b>${esc(row.headline)}</b></td><td data-label="Leads">${row.leads}</td><td data-label="≥2 réponses">${row.engaged}</td><td data-label="Clés acquisition">${financialReady?`${row.acquisitionSales}<div class="muted">${row.leads?pct((row.acquisitionSales/row.leads)*100):"—"}</div>`:"—"}</td><td data-label="Renouvellements">${financialReady?row.influencedRenewals:"—"}</td></tr>`).join("");
  return `<div class="card">${rows?`<div class="table-wrap"><table class="responsive-table"><thead><tr><th>Headline</th><th>Leads</th><th>≥2 réponses</th><th>Clés / conversion</th><th>Renouvellements</th></tr></thead><tbody>${rows}</tbody></table></div>`:`<div class="empty"><b>Aucun headline attribué sur ${esc(period.label)}</b></div>`}<p class="muted">Lecture first-touch qualitative. Aucun coût par headline n’est calculé tant que les créas partagent le même ad_id.</p></div>`;
}

function cashSummary(period: AcquisitionPeriod, data: AdAcquisitionDashboard, financialReady: boolean): string {
  const cash = period.cash;
  return `<div class="stat-grid report-stat-grid">
    <div class="stat"><span>CA brut encaissé — toutes Clés</span><b>${financialReady?fmtFcfa(cash.allRevenueXof):"—"}</b><span>${financialReady?`${cash.allSales} ventes des 3 plans`:"allowlist Clés incomplète"}</span></div>
    <div class="stat"><span>CA brut relié à un lead pub</span><b>${financialReady?fmtFcfa(cash.attributedRevenueXof):"—"}</b><span>${financialReady?`${cash.attributedSales} ventes attribuées`:"allowlist Clés incomplète"}</span></div>
    <div class="stat"><span>FX utilisé</span><b>${data.fxRate.toLocaleString("fr-FR")}</b><span>USD → XOF · ROAS estimé</span></div>
  </div>`;
}

function periodPanel(
  key: "today" | "yesterday" | "7" | "30",
  period: AcquisitionPeriod,
  data: AdAcquisitionDashboard,
  financialReady: boolean,
  metaUnavailable: boolean,
): string {
  const hidden = key === "7" ? "" : " hidden";
  const delivery = metaUnavailable
    ? `<div class="card empty"><b>Dépense indisponible</b><p>Rattache la campagne Meta pour afficher la dépense ; les blocs DB ci-dessous restent disponibles.</p></div>`
    : deliveryCard(period.label,period.delivery,data.currency,data.fxRate,key!=="yesterday");
  const partialNote = key === "today"
    ? `<div class="card"><p><span class="badge badge--amber">jour en cours</span> Journée non close : dépense, leads et ventes s’accumulent encore. Un chiffre bas en cours de journée n’est pas une contre-performance — compare plutôt à Hier.</p></div>`
    : "";
  return `<section id="acquisition-panel-${key}" data-acquisition-period-panel="${key}" role="tabpanel" aria-labelledby="acquisition-tab-${key}"${hidden}>
${partialNote}
${financialReady&&!metaUnavailable?cohortSummary(period,data):""}
${delivery}
<div class="section-header"><div><span class="eyebrow">Performance par pub · ${esc(period.label)}</span><h2>Dépense, Clés et ROAS</h2></div></div>
${adsTable(period,data)}
${cashSummary(period,data,financialReady)}
<div class="section-header"><div><span class="eyebrow">Qualité · ${esc(period.label)}</span><h2>Intention après le message automatique</h2></div></div>
${qualityCard(period)}
<div class="section-header"><div><span class="eyebrow">Messages publicitaires · ${esc(period.label)}</span><h2>Ventilation qualitative par headline</h2></div></div>
${headlineTable(period,financialReady)}
<div class="section-header"><div><span class="eyebrow">Relances manuelles · ${esc(period.label)}</span><h2>Résultats directionnels à 72 h</h2></div></div>
${nudgeCard(period,financialReady)}
</section>`;
}

function weeksTable(data: AdAcquisitionDashboard): string {
  const rows = data.weeks.map((row) => `<tr><td data-label="Semaine"><b>${esc(row.week)}</b>${row.inProgress?` <span class="badge badge--amber">en cours</span>`:""}</td><td data-label="Dépense">${nativeMoney(row.spend,data.currency)}</td><td data-label="Leads">${row.leads}</td><td data-label="Coût / lead">${row.costPerLead===null?"—":nativeMoney(row.costPerLead,data.currency)}</td><td data-label="CTR">${pct(row.ctr)}</td></tr>`).join("");
  return rows?`<div class="card"><div class="table-wrap"><table class="responsive-table"><thead><tr><th>Semaine ISO</th><th>Dépense</th><th>Leads DB</th><th>Coût / lead</th><th>CTR</th></tr></thead><tbody>${rows}</tbody></table></div></div>`:"";
}

export function renderAdAcquisition(data: AdAcquisitionDashboard, owner: boolean): string {
  const warnings = [
    data.configError ? `<div class="card warn"><b>${esc(data.configError)}</b><p>La synchronisation Meta est désactivée ; aucun zéro de dépense n’est présenté comme une donnée réelle.</p></div>` : "",
    data.eligibilityError ? `<div class="card warn"><b>${esc(data.eligibilityError)}</b><p>Les ventes et le ROAS restent indisponibles tant que l’allowlist est incomplète.</p></div>` : "",
    data.sync.last_error ? `<div class="card warn"><b>Dernière synchronisation en erreur</b><p>${esc(data.sync.last_error)}</p></div>` : "",
    data.sync.account_status!==null && data.sync.account_status!==1 ? `<div class="card warn"><b>Compte publicitaire non actif</b><p>Statut Meta : ${data.sync.account_status}.</p></div>` : "",
    !data.sync.last_succeeded_at && !data.configError ? `<div class="card warn"><b>Première synchronisation Meta en attente</b><p>La dépense apparaîtra après le premier pull complet.</p></div>` : "",
    data.stale && data.sync.last_succeeded_at ? `<div class="card warn"><b>Données Meta anciennes</b><p>Dernier succès : ${fmtDate(data.sync.last_succeeded_at)}.</p></div>` : "",
  ].join("");
  const controls = owner ? `<div class="card"><div class="row between"><form method="post" action="/admin/conversion/resync-ads"><button class="act" type="submit">Resynchroniser Meta</button></form><form method="post" action="/admin/conversion/ads-fx" class="row"><label>Taux USD→XOF <input name="rate" type="number" min="100" max="2000" step="0.01" value="${data.fxRate}"></label><button class="act act--ghost" type="submit">Enregistrer</button></form></div><p class="muted">Taux utilisé : ${data.fxRate.toLocaleString("fr-FR")} · ${data.fxUpdatedAt?`mis à jour ${fmtDate(data.fxUpdatedAt)}`:"valeur par défaut"}. Dernier succès Meta : ${data.sync.last_succeeded_at?fmtDate(data.sync.last_succeeded_at):"jamais"}. Fuseau : ${esc(data.timezone)}.</p></div>` : "";
  const financialReady = !data.eligibilityError;
  const mappingUnavailable = Boolean(data.configError && (data.configError.includes("AD_CAMPAIGN_MAP") || data.configError.includes("non rattachée")));
  const metaUnavailable = mappingUnavailable || !data.sync.last_succeeded_at;
  return `<section data-acquisition-dashboard><div class="section-header activity-section-header"><div><span class="eyebrow">Acquisition pubs Meta</span><h2>Dépense → conversations → Clés</h2><p class="activity-period-copy" data-acquisition-period-copy aria-live="polite">Résultats des 7 derniers jours</p></div>
<div class="period-toggle" role="tablist" aria-label="Période des statistiques publicitaires">
  <button id="acquisition-tab-today" type="button" role="tab" data-acquisition-period="today" aria-selected="false" aria-controls="acquisition-panel-today" tabindex="-1">Aujourd’hui</button>
  <button id="acquisition-tab-yesterday" type="button" role="tab" data-acquisition-period="yesterday" aria-selected="false" aria-controls="acquisition-panel-yesterday" tabindex="-1">Hier</button>
  <button id="acquisition-tab-7" type="button" role="tab" class="active" data-acquisition-period="7" aria-selected="true" aria-controls="acquisition-panel-7" tabindex="0">7 jours</button>
  <button id="acquisition-tab-30" type="button" role="tab" data-acquisition-period="30" aria-selected="false" aria-controls="acquisition-panel-30" tabindex="-1">30 jours</button>
</div></div>
${warnings}
${periodPanel("today",data.today,data,financialReady,metaUnavailable)}
${periodPanel("yesterday",data.yesterday,data,financialReady,metaUnavailable)}
${periodPanel("7",data.sevenDays,data,financialReady,metaUnavailable)}
${periodPanel("30",data.thirtyDays,data,financialReady,metaUnavailable)}
<div class="section-header"><div><span class="eyebrow">Tendance</span><h2>Performance hebdomadaire</h2></div></div>
${weeksTable(data)}
${controls}
<noscript><style>[data-acquisition-period-panel][hidden]{display:block!important}</style></noscript>
</section>`;
}
