import { config } from "../config.js";

const GRAPH_HOST = "graph.facebook.com";
const CTWA_RESULT = "onsite_conversion.total_messaging_connection";

export interface MetaCampaignMapping {
  campaignId: string;
  campaignKey: string;
}

export type CampaignMapResult =
  | { ok: true; entries: MetaCampaignMapping[]; byId: Map<string, string> }
  | { ok: false; error: string; entries: []; byId: Map<string, string> };

export interface MetaAccountMetadata {
  currency: string;
  timezoneName: string;
  accountStatus: number;
}

export interface MetaInsightDaily {
  day: string;
  adId: string;
  adName: string | null;
  adsetId: string | null;
  adsetName: string | null;
  campaignId: string;
  campaignName: string | null;
  spend: number;
  impressions: number;
  clicks: number;
  linkClicks: number;
  results: number;
  accountCurrency: string | null;
}

interface MetaAction {
  action_type?: unknown;
  value?: unknown;
}

interface MetaPage {
  data?: unknown;
  paging?: { next?: unknown };
  error?: { message?: unknown; code?: unknown };
}

export function parseCampaignMap(raw = config.AD_CAMPAIGN_MAP): CampaignMapResult {
  const value = raw.trim();
  const empty = new Map<string, string>();
  if (!value) {
    return { ok: false, error: "Campagne Meta non rattachée", entries: [], byId: empty };
  }
  const entries: MetaCampaignMapping[] = [];
  const seen = new Set<string>();
  for (const item of value.split(",")) {
    const pair = item.trim();
    const separator = pair.indexOf(":");
    const campaignId = separator < 0 ? "" : pair.slice(0, separator).trim();
    const campaignKey = separator < 0 ? "" : pair.slice(separator + 1).trim();
    if (!/^\d+$/.test(campaignId) || !/^[a-z0-9][a-z0-9_-]*$/i.test(campaignKey)) {
      return {
        ok: false,
        error: `AD_CAMPAIGN_MAP invalide près de « ${pair.slice(0, 80)} »`,
        entries: [],
        byId: empty,
      };
    }
    if (seen.has(campaignId)) {
      return {
        ok: false,
        error: `AD_CAMPAIGN_MAP contient deux fois la campagne ${campaignId}`,
        entries: [],
        byId: empty,
      };
    }
    seen.add(campaignId);
    entries.push({ campaignId, campaignKey });
  }
  return { ok: true, entries, byId: new Map(entries.map((row) => [row.campaignId, row.campaignKey])) };
}

function graphVersion(): string {
  return /^v\d+\.\d+$/.test(config.META_GRAPH_VERSION) ? config.META_GRAPH_VERSION : "v25.0";
}

function accountPath(): string {
  const id = config.META_AD_ACCOUNT_ID.replace(/^act_/, "");
  if (!/^\d+$/.test(id)) throw new Error("META_AD_ACCOUNT_ID invalide");
  return `act_${id}`;
}

function safeGraphUrl(raw: string): URL {
  const url = new URL(raw);
  if (url.protocol !== "https:" || url.hostname !== GRAPH_HOST) {
    throw new Error("URL de pagination Meta refusée");
  }
  // Meta may echo credentials in a paging link even when the first request used
  // a header. Strip them before the next request and before any error can expose it.
  url.searchParams.delete("access_token");
  return url;
}

async function fetchJson<T>(rawUrl: string, fetchImpl: typeof fetch): Promise<T> {
  if (!config.META_ADS_TOKEN) throw new Error("META_ADS_TOKEN absent");
  const url = safeGraphUrl(rawUrl);
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetchImpl(url, {
        headers: { Authorization: `Bearer ${config.META_ADS_TOKEN}` },
        signal: AbortSignal.timeout(20_000),
      });
      const body = (await response.json()) as MetaPage;
      if (response.ok && !body.error) return body as T;
      const message = String(body.error?.message ?? `Meta HTTP ${response.status}`);
      const error = Object.assign(new Error(`Meta Ads API: ${message.slice(0, 300)}`), {
        retryable: response.status === 429 || response.status >= 500,
      });
      if (!error.retryable) throw error;
      lastError = error;
    } catch (error) {
      if ((error as { retryable?: boolean }).retryable === false) throw error;
      lastError = error;
      if (attempt === 2) break;
    }
    await new Promise((resolve) => setTimeout(resolve, 250 * 2 ** attempt));
  }
  throw lastError instanceof Error ? lastError : new Error("Meta Ads API indisponible");
}

function finiteNumber(value: unknown, field: string, integer = false): number {
  const number = typeof value === "number" ? value : Number(String(value ?? "0"));
  if (!Number.isFinite(number) || number < 0 || (integer && !Number.isInteger(number))) {
    throw new Error(`Valeur Meta invalide pour ${field}`);
  }
  return number;
}

function actionTotal(actions: unknown, actionType: string): number {
  if (actions === undefined || actions === null) return 0;
  if (!Array.isArray(actions)) throw new Error("Valeur Meta invalide pour actions");
  return actions.reduce((sum, raw) => {
    const action = raw as MetaAction;
    return action.action_type === actionType
      ? sum + finiteNumber(action.value, `actions.${actionType}`, true)
      : sum;
  }, 0);
}

export function parseInsight(raw: unknown): MetaInsightDaily {
  if (!raw || typeof raw !== "object") throw new Error("Ligne Meta Insights invalide");
  const row = raw as Record<string, unknown>;
  const day = String(row.date_start ?? "");
  const adId = String(row.ad_id ?? "");
  const campaignId = String(row.campaign_id ?? "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !/^\d+$/.test(adId) || !/^\d+$/.test(campaignId)) {
    throw new Error("Identifiants ou date Meta Insights invalides");
  }
  const text = (value: unknown): string | null =>
    typeof value === "string" && value.trim() ? value.trim() : null;
  return {
    day,
    adId,
    adName: text(row.ad_name),
    adsetId: text(row.adset_id),
    adsetName: text(row.adset_name),
    campaignId,
    campaignName: text(row.campaign_name),
    spend: finiteNumber(row.spend, "spend"),
    impressions: finiteNumber(row.impressions, "impressions", true),
    clicks: finiteNumber(row.clicks, "clicks", true),
    linkClicks: actionTotal(row.actions, "link_click"),
    results: actionTotal(row.actions, CTWA_RESULT),
    accountCurrency: text(row.account_currency),
  };
}

export async function fetchAccountMetadata(fetchImpl: typeof fetch = fetch): Promise<MetaAccountMetadata> {
  const url = new URL(`https://${GRAPH_HOST}/${graphVersion()}/${accountPath()}`);
  url.searchParams.set("fields", "currency,timezone_name,account_status");
  const body = await fetchJson<Record<string, unknown>>(url.toString(), fetchImpl);
  const currency = String(body.currency ?? "").trim().toUpperCase();
  const timezoneName = String(body.timezone_name ?? "").trim();
  const accountStatus = finiteNumber(body.account_status, "account_status", true);
  if (!currency || !timezoneName) throw new Error("Métadonnées du compte Meta incomplètes");
  return { currency, timezoneName, accountStatus };
}

export async function fetchInsights(
  args: { since: string; until: string },
  fetchImpl: typeof fetch = fetch,
): Promise<MetaInsightDaily[]> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(args.since) || !/^\d{4}-\d{2}-\d{2}$/.test(args.until)) {
    throw new Error("Fenêtre Meta invalide");
  }
  const first = new URL(`https://${GRAPH_HOST}/${graphVersion()}/${accountPath()}/insights`);
  first.searchParams.set(
    "fields",
    "spend,impressions,clicks,actions,account_currency,ad_id,ad_name,adset_id,adset_name,campaign_id,campaign_name",
  );
  first.searchParams.set("level", "ad");
  first.searchParams.set("time_increment", "1");
  first.searchParams.set("action_report_time", "conversion");
  first.searchParams.set("action_attribution_windows", JSON.stringify(["7d_click", "1d_view"]));
  first.searchParams.set("time_range", JSON.stringify({ since: args.since, until: args.until }));
  first.searchParams.set("limit", "500");

  const rows: MetaInsightDaily[] = [];
  let next: string | null = first.toString();
  while (next) {
    const page: MetaPage = await fetchJson<MetaPage>(next, fetchImpl);
    if (!Array.isArray(page.data)) throw new Error("Payload Meta Insights invalide");
    rows.push(...page.data.map(parseInsight));
    next = typeof page.paging?.next === "string" && page.paging.next ? page.paging.next : null;
  }
  return rows;
}
