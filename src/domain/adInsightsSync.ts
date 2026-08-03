import type { PoolClient } from "pg";
import { config } from "../config.js";
import { pool } from "../db/index.js";
import {
  fetchAccountMetadata,
  fetchInsights,
  parseCampaignMap,
  type MetaInsightDaily,
} from "../lib/metaAds.js";

const SYNC_LOCK = 8_337_225;
const SYNC_INTERVAL_MS = 60 * 60 * 1_000;

export interface AdInsightsSyncState {
  last_started_at: Date | null;
  last_succeeded_at: Date | null;
  last_error: string | null;
  record_count: number;
  account_timezone: string | null;
  account_currency: string | null;
  account_status: number | null;
  updated_at: Date;
}

export type AdSyncResult = {
  ran: boolean;
  recordCount: number;
  reason?: "disabled" | "locked" | "fresh";
  message?: string;
};

export function dateInTimezone(now: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${value.year}-${value.month}-${value.day}`;
}

export function addCalendarDays(day: string, amount: number): string {
  const date = new Date(`${day}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + amount);
  return date.toISOString().slice(0, 10);
}

async function upsertRows(db: PoolClient, rows: MetaInsightDaily[], syncedAt: Date): Promise<void> {
  for (const row of rows) {
    await db.query(
      `insert into ad_insights_daily
        (day, ad_id, ad_name, adset_id, adset_name, campaign_id, campaign_name,
         spend, impressions, clicks, link_clicks, results, account_currency, synced_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       on conflict (day, ad_id) do update set
         ad_name=excluded.ad_name,
         adset_id=excluded.adset_id,
         adset_name=excluded.adset_name,
         campaign_id=excluded.campaign_id,
         campaign_name=excluded.campaign_name,
         spend=excluded.spend,
         impressions=excluded.impressions,
         clicks=excluded.clicks,
         link_clicks=excluded.link_clicks,
         results=excluded.results,
         account_currency=excluded.account_currency,
         synced_at=excluded.synced_at`,
      [
        row.day,
        row.adId,
        row.adName,
        row.adsetId,
        row.adsetName,
        row.campaignId,
        row.campaignName,
        row.spend,
        row.impressions,
        row.clicks,
        row.linkClicks,
        row.results,
        row.accountCurrency,
        syncedAt,
      ],
    );
  }
}

export async function adInsightsSyncState(): Promise<AdInsightsSyncState> {
  const row = (await pool.query(`select * from ad_insights_sync_state where id=1`)).rows[0];
  return (row ?? {
    last_started_at: null,
    last_succeeded_at: null,
    last_error: null,
    record_count: 0,
    account_timezone: null,
    account_currency: null,
    account_status: null,
    updated_at: new Date(0),
  }) as AdInsightsSyncState;
}

/** Crash-safe 30-day reconciliation. A failed or partial pull never mutates the cache. */
export async function syncAdInsights(force = false): Promise<AdSyncResult> {
  const mapping = parseCampaignMap();
  if (!config.META_ADS_TOKEN || !config.META_AD_ACCOUNT_ID || !mapping.ok) {
    return {
      ran: false,
      recordCount: 0,
      reason: "disabled",
      message: !mapping.ok && "error" in mapping ? mapping.error : "Connexion Meta Ads non configurée",
    };
  }

  const db = await pool.connect();
  let locked = false;
  try {
    locked = Boolean(
      (await db.query(`select pg_try_advisory_lock($1) as locked`, [SYNC_LOCK])).rows[0]?.locked,
    );
    if (!locked) return { ran: false, recordCount: 0, reason: "locked", message: "Synchronisation déjà en cours" };

    const current = (await db.query(`select * from ad_insights_sync_state where id=1`)).rows[0] as
      | AdInsightsSyncState
      | undefined;
    if (
      !force &&
      current?.last_succeeded_at &&
      Date.now() - new Date(current.last_succeeded_at).getTime() < SYNC_INTERVAL_MS
    ) {
      return { ran: false, recordCount: current.record_count, reason: "fresh" };
    }

    await db.query(
      `update ad_insights_sync_state
          set last_started_at=now(), last_error=null, updated_at=now()
        where id=1`,
    );
    const metadata = await fetchAccountMetadata();
    const until = dateInTimezone(new Date(), metadata.timezoneName);
    const since = addCalendarDays(until, -29);
    const rows = await fetchInsights({ since, until });
    const syncedAt = new Date();

    await db.query("begin");
    try {
      await upsertRows(db, rows, syncedAt);
      // Reconcile only after every page parsed successfully. Rows not touched by
      // this run are Meta ghost rows (including a formerly attributed zero day).
      await db.query(
        `delete from ad_insights_daily
          where day >= $1::date and day <= $2::date and synced_at <> $3`,
        [since, until, syncedAt],
      );
      await db.query(
        `update ad_insights_sync_state
            set last_succeeded_at=now(), last_error=null, record_count=$1,
                account_timezone=$2, account_currency=$3, account_status=$4,
                updated_at=now()
          where id=1`,
        [rows.length, metadata.timezoneName, metadata.currency, metadata.accountStatus],
      );
      await db.query("commit");
    } catch (error) {
      await db.query("rollback");
      throw error;
    }
    return { ran: true, recordCount: rows.length };
  } catch (error) {
    const message = String(error instanceof Error ? error.message : error).slice(0, 500);
    await db
      .query(
        `update ad_insights_sync_state set last_error=$1, updated_at=now() where id=1`,
        [message],
      )
      .catch(() => undefined);
    throw error;
  } finally {
    if (locked) {
      await db.query(`select pg_advisory_unlock($1)`, [SYNC_LOCK]).catch(() => undefined);
    }
    db.release();
  }
}
