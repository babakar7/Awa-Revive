import { config } from "../config.js";
import { pool } from "../db/index.js";
import { parseCampaignMap } from "../lib/metaAds.js";
import { addCalendarDays, adInsightsSyncState, dateInTimezone, type AdInsightsSyncState } from "./adInsightsSync.js";

export interface DeliveryMetrics {
  spend: number;
  impressions: number;
  clicks: number;
  linkClicks: number;
  results: number;
  leads: number;
  ctr: number | null;
  cpm: number | null;
  cpc: number | null;
  costPerResult: number | null;
  costPerLead: number | null;
}

export interface AdAcquisitionRow extends DeliveryMetrics {
  adId: string;
  adName: string;
  campaignName: string;
  acquisitionSales: number;
  acquisitionRevenueXof: number;
  activated: number;
  toActivate: number;
  influencedRenewals: number;
  costPerKeyXof: number | null;
  roas: number | null;
  planBreakdown: Record<string, { sales: number; revenueXof: number }>;
}

export interface LeadQuality {
  zero: number;
  one: number;
  engaged: number;
  total: number;
}

export interface HeadlinePerformance {
  headline: string;
  leads: number;
  engaged: number;
  acquisitionSales: number;
  influencedRenewals: number;
}

export interface NudgeMetrics {
  sent: number;
  suppressed: number;
  failed: number;
  matureSent: number;
  replied72h: number;
  purchased72h: number;
}

export interface AcquisitionPeriod {
  label: string;
  start: string;
  endExclusive: string;
  maturing: boolean;
  delivery: DeliveryMetrics;
  ads: AdAcquisitionRow[];
  quality: LeadQuality;
  headlines: HeadlinePerformance[];
  cash: { allSales: number; allRevenueXof: number; attributedSales: number; attributedRevenueXof: number };
  nudges: NudgeMetrics;
}

export interface WeeklyDelivery extends DeliveryMetrics {
  week: string;
  inProgress: boolean;
}

export interface AdAcquisitionDashboard {
  enabled: boolean;
  configError: string | null;
  eligibilityError: string | null;
  sync: AdInsightsSyncState;
  stale: boolean;
  currency: string;
  timezone: string;
  fxRate: number;
  fxUpdatedAt: Date | null;
  sevenDays: AcquisitionPeriod;
  thirtyDays: AcquisitionPeriod;
  weeks: WeeklyDelivery[];
}

type RawAdRow = {
  ad_id: string;
  ad_name: string | null;
  campaign_name: string | null;
  spend: string;
  impressions: string;
  clicks: string;
  link_clicks: string;
  results: string;
  leads: string;
  acq_sales: string;
  acq_revenue_xof: string;
  activated: string;
  to_activate: string;
  influenced_renewals: string;
  plan_breakdown: Record<string, { sales: number; revenueXof: number }> | null;
};

function ratio(numerator: number, denominator: number, multiplier = 1): number | null {
  return denominator > 0 ? (numerator / denominator) * multiplier : null;
}

function number(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function deliveryFrom(row: Partial<Record<keyof RawAdRow, unknown>>): DeliveryMetrics {
  const spend = number(row.spend);
  const impressions = number(row.impressions);
  const clicks = number(row.clicks);
  const linkClicks = number(row.link_clicks);
  const results = number(row.results);
  const leads = number(row.leads);
  return {
    spend,
    impressions,
    clicks,
    linkClicks,
    results,
    leads,
    ctr: ratio(clicks, impressions, 100),
    cpm: ratio(spend, impressions, 1_000),
    cpc: ratio(spend, clicks),
    costPerResult: ratio(spend, results),
    costPerLead: ratio(spend, leads),
  };
}

function eligiblePlanIds(): string[] {
  return [config.INVITEE_PLAN_ID, config.HABITUEE_PLAN_ID, config.RESIDENTE_PLAN_ID].filter(Boolean);
}

async function fxState(): Promise<{ rate: number; updatedAt: Date | null }> {
  const row = (await pool.query(`select value, updated_at from app_state where key='usd_xof_rate'`)).rows[0];
  const rate = Number(row?.value ?? 610);
  return { rate: Number.isFinite(rate) && rate > 0 ? rate : 610, updatedAt: row?.updated_at ?? null };
}

export async function setUsdXofRate(rate: number): Promise<void> {
  if (!Number.isFinite(rate) || rate < 100 || rate > 2_000) throw new Error("Taux USD→XOF invalide");
  await pool.query(
    `insert into app_state (key,value,updated_at) values ('usd_xof_rate',$1,now())
     on conflict (key) do update set value=excluded.value, updated_at=now()`,
    [String(rate)],
  );
}

const ATTRIBUTION_CTES = `
mapped as (
  select * from unnest($3::text[], $4::text[]) as x(campaign_id,campaign_key)
),
meta_by_ad as (
  select i.ad_id, max(i.ad_name) ad_name, max(i.campaign_name) campaign_name,
         sum(i.spend) spend, sum(i.impressions)::bigint impressions,
         sum(i.clicks)::bigint clicks, sum(i.link_clicks)::bigint link_clicks,
         sum(i.results)::bigint results, max(i.campaign_id) campaign_id
    from ad_insights_daily i join mapped m on m.campaign_id=i.campaign_id
   where i.day >= $1::date and i.day < $2::date
   group by i.ad_id
),
base_leads as (
  select l.id, l.source_id ad_id, l.client_id, l.created_at lead_at,
         coalesce(nullif(l.headline,''),'(sans titre)') headline
    from campaign_leads l
    join clients c on c.id=l.client_id and c.is_test=false
    join meta_by_ad ma on ma.ad_id=l.source_id
    join mapped m on m.campaign_id=ma.campaign_id and m.campaign_key=l.campaign_key
   where l.matched_by='meta_referral' and l.source_type='ad' and l.source_id is not null
     and (l.created_at at time zone $6)::date >= $1::date
     and (l.created_at at time zone $6)::date < $2::date
),
eligible_sales as (
  select bl.id lead_id, bl.ad_id, bl.headline, bl.lead_at, p.id order_id, p.plan_id,
         p.amount_xof, p.status,
         row_number() over (partition by bl.id order by p.paid_at,p.id) sale_rank,
         not exists (
           select 1 from pending_plan_orders prior
            where prior.client_id=bl.client_id and prior.plan_id=any($5::text[])
              and prior.paid_at is not null
              and prior.status in ('PAID','SCHEDULED','ACTIVATED')
              and prior.paid_at < bl.lead_at
         ) is_acquisition
    from base_leads bl
    join pending_plan_orders p on p.client_id=bl.client_id
   where p.plan_id=any($5::text[]) and p.paid_at is not null
     and p.status in ('PAID','SCHEDULED','ACTIVATED')
     and p.paid_at >= bl.lead_at and p.paid_at < bl.lead_at + interval '30 days'
),
first_per_lead as (select * from eligible_sales where sale_rank=1),
ranked_sales as (
  select fpl.*,
         row_number() over (partition by order_id order by lead_at,lead_id) attribution_rank
    from first_per_lead fpl
),
first_sales as (select * from ranked_sales where attribution_rank=1),
db_by_ad as (
  select bl.ad_id, count(*)::int leads,
         count(fs.order_id) filter(where fs.is_acquisition)::int acq_sales,
         coalesce(sum(fs.amount_xof) filter(where fs.is_acquisition),0)::bigint acq_revenue_xof,
         count(fs.order_id) filter(where fs.is_acquisition and fs.status='ACTIVATED')::int activated,
         count(fs.order_id) filter(where fs.is_acquisition and fs.status<>'ACTIVATED')::int to_activate,
         count(fs.order_id) filter(where not fs.is_acquisition)::int influenced_renewals
    from base_leads bl left join first_sales fs on fs.lead_id=bl.id group by bl.ad_id
),
plan_counts as (
  select ad_id, plan_id, count(*)::int sales, sum(amount_xof)::bigint revenue_xof
    from first_sales where is_acquisition group by ad_id,plan_id
),
plans_by_ad as (
  select ad_id, jsonb_object_agg(plan_id,jsonb_build_object('sales',sales,'revenueXof',revenue_xof)) plan_breakdown
    from plan_counts group by ad_id
)`;

async function adRows(
  start: string,
  endExclusive: string,
  timezone: string,
  campaignIds: string[],
  campaignKeys: string[],
  plans: string[],
  fxRate: number,
  currency: string,
): Promise<AdAcquisitionRow[]> {
  const result = await pool.query(
    `with ${ATTRIBUTION_CTES}
     select ma.*, coalesce(d.leads,0) leads, coalesce(d.acq_sales,0) acq_sales,
            coalesce(d.acq_revenue_xof,0) acq_revenue_xof, coalesce(d.activated,0) activated,
            coalesce(d.to_activate,0) to_activate,
            coalesce(d.influenced_renewals,0) influenced_renewals,
            coalesce(pb.plan_breakdown,'{}'::jsonb) plan_breakdown
       from meta_by_ad ma left join db_by_ad d using(ad_id)
       left join plans_by_ad pb using(ad_id) order by ma.spend desc,ma.ad_id`,
    [start, endExclusive, campaignIds, campaignKeys, plans, timezone],
  );
  const nativeToXof = currency === "XOF" ? 1 : currency === "USD" ? fxRate : null;
  return (result.rows as RawAdRow[]).map((row) => {
    const delivery = deliveryFrom(row);
    const acquisitionSales = number(row.acq_sales);
    const acquisitionRevenueXof = number(row.acq_revenue_xof);
    const spendXof = nativeToXof === null ? null : delivery.spend * nativeToXof;
    return {
      ...delivery,
      adId: row.ad_id,
      adName: row.ad_name ?? row.ad_id,
      campaignName: row.campaign_name ?? "Campagne Meta",
      acquisitionSales,
      acquisitionRevenueXof,
      activated: number(row.activated),
      toActivate: number(row.to_activate),
      influencedRenewals: number(row.influenced_renewals),
      costPerKeyXof: spendXof === null ? null : ratio(spendXof, acquisitionSales),
      roas: spendXof === null ? null : ratio(acquisitionRevenueXof, spendXof),
      planBreakdown: row.plan_breakdown ?? {},
    };
  });
}

async function quality(
  start: string,
  endExclusive: string,
  timezone: string,
  campaignIds: string[],
  campaignKeys: string[],
  plans: string[],
): Promise<{ quality: LeadQuality; headlines: HeadlinePerformance[] }> {
  const result = await pool.query(
    `with leads as (
       select l.id,l.client_id,coalesce(nullif(l.headline,''),'(sans titre)') headline,
              coalesce(anchor.created_at,l.created_at) anchor_at
         from campaign_leads l join clients c on c.id=l.client_id and c.is_test=false
         left join lateral (
           select x.created_at from conversations x
            where x.client_id=l.client_id and x.wa_message_id=l.trigger_message_id
            order by x.created_at asc limit 1
         ) anchor on true
        where l.matched_by='meta_referral' and l.source_type='ad' and l.source_id is not null
          and l.campaign_key=any($4::text[])
          and (cardinality($3::text[])=0 or exists(
            select 1 from ad_insights_daily i
             where i.ad_id=l.source_id and i.campaign_id=any($3::text[])))
          and (l.created_at at time zone $5)::date >= $1::date
          and (l.created_at at time zone $5)::date < $2::date
     ), scored as (
       select l.*,count(u.id)::int replies from leads l left join conversations u
         on u.client_id=l.client_id and u.role='user' and u.created_at>l.anchor_at
        group by l.id,l.client_id,l.headline,l.anchor_at
     ) select headline,count(*)::int leads,
              count(*) filter(where replies=0)::int zero,
              count(*) filter(where replies=1)::int one,
              count(*) filter(where replies>=2)::int engaged
         from scored group by headline order by count(*) desc,headline`,
    [start, endExclusive, campaignIds, campaignKeys, timezone],
  );
  const rows = result.rows as Array<{ headline: string; leads: string; zero: string; one: string; engaged: string }>;
  const summary = rows.reduce(
    (acc, row) => ({
      zero: acc.zero + number(row.zero), one: acc.one + number(row.one),
      engaged: acc.engaged + number(row.engaged), total: acc.total + number(row.leads),
    }),
    { zero: 0, one: 0, engaged: 0, total: 0 },
  );
  const sales = campaignIds.length && plans.length
    ? await pool.query(
        `with ${ATTRIBUTION_CTES}
         select headline,
                count(*) filter(where is_acquisition)::int acquisition_sales,
                count(*) filter(where not is_acquisition)::int influenced_renewals
           from first_sales group by headline`,
        [start,endExclusive,campaignIds,campaignKeys,plans,timezone],
      )
    : { rows: [] as Array<Record<string, unknown>> };
  const salesByHeadline = new Map<string,{ acquisitionSales:number; influencedRenewals:number }>(
    sales.rows.map((row) => [String(row.headline), {
      acquisitionSales:number(row.acquisition_sales), influencedRenewals:number(row.influenced_renewals),
    }] as const),
  );
  return {
    quality: summary,
    headlines: rows.map((row) => {
      const attributed = salesByHeadline.get(row.headline);
      return {
        headline: row.headline, leads: number(row.leads), engaged: number(row.engaged),
        acquisitionSales: attributed?.acquisitionSales ?? 0,
        influencedRenewals: attributed?.influencedRenewals ?? 0,
      };
    }),
  };
}

async function cashMetrics(
  start: string,
  endExclusive: string,
  timezone: string,
  plans: string[],
  campaignIds: string[],
  campaignKeys: string[],
) {
  const all = await pool.query(
    `select count(*)::int sales,coalesce(sum(p.amount_xof),0)::bigint revenue
       from pending_plan_orders p join clients c on c.id=p.client_id and c.is_test=false
      where p.plan_id=any($3::text[]) and p.paid_at is not null
        and p.status in ('PAID','SCHEDULED','ACTIVATED')
        and (p.paid_at at time zone $4)::date >= $1::date
        and (p.paid_at at time zone $4)::date < $2::date`,
    [start, endExclusive, plans, timezone],
  );
  let attributedSales = 0;
  let attributedRevenueXof = 0;
  if (plans.length && campaignIds.length) {
    const attributed = await pool.query(
      `with mapped as (
         select distinct campaign_key
           from unnest($3::text[],$4::text[]) x(campaign_id,campaign_key)
       ),
       base_leads as (
         select l.id,l.client_id,l.created_at lead_at
           from campaign_leads l join clients c on c.id=l.client_id and c.is_test=false
           join mapped m on m.campaign_key=l.campaign_key
          where l.matched_by='meta_referral' and l.source_type='ad' and l.source_id is not null
       ), candidates as (
         select bl.id lead_id,bl.lead_at,p.id order_id,p.paid_at,p.amount_xof,
                row_number() over(partition by bl.id order by p.paid_at,p.id) sale_rank
           from base_leads bl join pending_plan_orders p on p.client_id=bl.client_id
          where p.plan_id=any($5::text[]) and p.paid_at is not null
            and p.status in ('PAID','SCHEDULED','ACTIVATED')
            and p.paid_at>=bl.lead_at and p.paid_at<bl.lead_at+interval '30 days'
       ), first_per_lead as (select * from candidates where sale_rank=1),
       once_per_order as (
         select distinct on(order_id) order_id,paid_at,amount_xof
           from first_per_lead order by order_id,lead_at
       ) select count(*)::int sales,coalesce(sum(amount_xof),0)::bigint revenue
           from once_per_order
          where (paid_at at time zone $6)::date >= $1::date
            and (paid_at at time zone $6)::date < $2::date`,
      [start,endExclusive,campaignIds,campaignKeys,plans,timezone],
    );
    attributedSales = number(attributed.rows[0]?.sales);
    attributedRevenueXof = number(attributed.rows[0]?.revenue);
  }
  return {
    allSales: number(all.rows[0]?.sales), allRevenueXof: number(all.rows[0]?.revenue),
    attributedSales, attributedRevenueXof,
  };
}

async function nudgeMetrics(start: string, endExclusive: string, timezone: string, plans: string[]): Promise<NudgeMetrics> {
  const result = await pool.query(
    `select
       count(*) filter(where n.outcome='SENT')::int sent,
       count(*) filter(where n.outcome='SUPPRESSED')::int suppressed,
       count(*) filter(where n.outcome='FAILED')::int failed,
       count(*) filter(where n.outcome='SENT' and n.sent_at <= now()-interval '72 hours')::int mature_sent,
       count(*) filter(where n.outcome='SENT' and n.sent_at <= now()-interval '72 hours' and exists(
         select 1 from conversations u where u.client_id=n.client_id and u.role='user'
          and u.created_at>n.sent_at and u.created_at<=n.sent_at+interval '72 hours'))::int replied,
       count(*) filter(where n.outcome='SENT' and n.sent_at <= now()-interval '72 hours' and exists(
         select 1 from pending_plan_orders p where p.client_id=n.client_id and p.plan_id=any($3::text[])
          and p.paid_at is not null and p.status in ('PAID','SCHEDULED','ACTIVATED')
          and p.paid_at>n.sent_at and p.paid_at<=n.sent_at+interval '72 hours'))::int purchased
      from outbound_nudges n join clients c on c.id=n.client_id and c.is_test=false
     where n.kind='LEAD_SILENT' and n.arm='MANUAL'
       and (n.assigned_at at time zone $4)::date >= $1::date
       and (n.assigned_at at time zone $4)::date < $2::date`,
    [start, endExclusive, plans, timezone],
  );
  const row = result.rows[0] ?? {};
  return {
    sent: number(row.sent), suppressed: number(row.suppressed), failed: number(row.failed),
    matureSent: number(row.mature_sent), replied72h: number(row.replied), purchased72h: number(row.purchased),
  };
}

function sumDelivery(ads: AdAcquisitionRow[]): DeliveryMetrics {
  return deliveryFrom({
    spend: ads.reduce((sum, row) => sum + row.spend, 0),
    impressions: ads.reduce((sum, row) => sum + row.impressions, 0),
    clicks: ads.reduce((sum, row) => sum + row.clicks, 0),
    link_clicks: ads.reduce((sum, row) => sum + row.linkClicks, 0),
    results: ads.reduce((sum, row) => sum + row.results, 0),
    leads: ads.reduce((sum, row) => sum + row.leads, 0),
  });
}

async function period(args: {
  label: string; start: string; endExclusive: string; timezone: string; currency: string;
  fxRate: number; campaignIds: string[]; campaignKeys: string[]; plans: string[];
}): Promise<AcquisitionPeriod> {
  const [ads, leadQuality, cash, nudges] = await Promise.all([
    args.campaignIds.length
      ? adRows(args.start,args.endExclusive,args.timezone,args.campaignIds,args.campaignKeys,args.plans,args.fxRate,args.currency)
      : Promise.resolve([]),
    quality(args.start,args.endExclusive,args.timezone,args.campaignIds,args.campaignKeys,args.plans),
    cashMetrics(args.start,args.endExclusive,args.timezone,args.plans,args.campaignIds,args.campaignKeys),
    nudgeMetrics(args.start,args.endExclusive,args.timezone,args.plans),
  ]);
  return {
    label: args.label, start: args.start, endExclusive: args.endExclusive, maturing: true,
    delivery: sumDelivery(ads), ads, quality: leadQuality.quality, headlines: leadQuality.headlines,
    cash,
    nudges,
  };
}

async function weeklyDelivery(
  start: string, endExclusive: string, timezone: string, campaignIds: string[], campaignKeys: string[],
): Promise<WeeklyDelivery[]> {
  const result = await pool.query(
    `with mapped as (select * from unnest($3::text[],$4::text[]) x(campaign_id,campaign_key)),
     meta as (
       select to_char(date_trunc('week',i.day::timestamp),'IYYY-"S"IW') week,
              sum(i.spend) spend,sum(i.impressions)::bigint impressions,sum(i.clicks)::bigint clicks,
              sum(i.link_clicks)::bigint link_clicks,sum(i.results)::bigint results
         from ad_insights_daily i join mapped m on m.campaign_id=i.campaign_id
        where i.day >= $1::date and i.day < $2::date group by 1
     ), leads as (
       select to_char(date_trunc('week',(l.created_at at time zone $5)),'IYYY-"S"IW') week,count(distinct l.id)::int leads
         from campaign_leads l join clients c on c.id=l.client_id and c.is_test=false
         join mapped m on m.campaign_key=l.campaign_key
        where l.matched_by='meta_referral' and l.source_type='ad' and l.source_id is not null
          and (l.created_at at time zone $5)::date >= $1::date and (l.created_at at time zone $5)::date < $2::date
          and exists(select 1 from ad_insights_daily i where i.ad_id=l.source_id and i.campaign_id=m.campaign_id)
        group by 1
     ) select meta.*,coalesce(leads.leads,0) leads from meta left join leads using(week) order by week desc`,
    [start,endExclusive,campaignIds,campaignKeys,timezone],
  );
  const currentWeek = (await pool.query(`select to_char(date_trunc('week',now() at time zone $1),'IYYY-"S"IW') week`,[timezone])).rows[0]?.week;
  return result.rows.map((row) => ({ week: row.week, inProgress: row.week===currentWeek, ...deliveryFrom(row) }));
}

export async function adAcquisitionDashboard(): Promise<AdAcquisitionDashboard> {
  const [sync, fx] = await Promise.all([adInsightsSyncState(), fxState()]);
  const mapping = parseCampaignMap();
  const plans = eligiblePlanIds();
  const timezone = sync.account_timezone || config.TIMEZONE;
  const currency = sync.account_currency || "USD";
  const today = dateInTimezone(new Date(), timezone);
  const endExclusive = addCalendarDays(today, 1);
  const emptyMapping = { campaignIds: [] as string[], campaignKeys: ["pack_decouverte_ctwa"] };
  const mapped = mapping.ok
    ? { campaignIds: mapping.entries.map((row) => row.campaignId), campaignKeys: mapping.entries.map((row) => row.campaignKey) }
    : emptyMapping;
  const eligibilityError = plans.length === 3 ? null : "Les 3 plan_id des Clés Revive ne sont pas configurés";
  const args = { timezone,currency,fxRate:fx.rate,...mapped,plans };
  const start7 = addCalendarDays(today,-6);
  const start30 = addCalendarDays(today,-29);
  const [sevenDays,thirtyDays,weeks] = await Promise.all([
    period({label:"7 jours",start:start7,endExclusive,...args}),
    period({label:"30 jours",start:start30,endExclusive,...args}),
    mapping.ok ? weeklyDelivery(start30,endExclusive,timezone,mapped.campaignIds,mapped.campaignKeys) : Promise.resolve([]),
  ]);
  return {
    enabled: Boolean(config.META_ADS_TOKEN && config.META_AD_ACCOUNT_ID && mapping.ok),
    configError: mapping.ok
      ? (!config.META_ADS_TOKEN || !config.META_AD_ACCOUNT_ID ? "Connexion Meta Ads non configurée" : null)
      : "error" in mapping ? mapping.error : "Campagne Meta non rattachée",
    eligibilityError,
    sync,
    stale: !sync.last_succeeded_at || Date.now()-new Date(sync.last_succeeded_at).getTime()>2*60*60*1_000,
    currency,timezone,fxRate:fx.rate,fxUpdatedAt:fx.updatedAt,sevenDays,thirtyDays,weeks,
  };
}
