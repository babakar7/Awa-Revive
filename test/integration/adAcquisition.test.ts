import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { migrate, pool } from "../../src/db/index.js";
import { adAcquisitionDashboard } from "../../src/domain/adAcquisition.js";
import { addCalendarDays, dateInTimezone, syncAdInsights } from "../../src/domain/adInsightsSync.js";
import { truncateAll } from "./helpers.js";

beforeAll(async () => {
  await migrate();
});

beforeEach(async () => {
  await truncateAll();
  await pool.query(
    `insert into ad_insights_sync_state
      (id,last_succeeded_at,record_count,account_timezone,account_currency,account_status)
     values (1,now(),0,'Africa/Dakar','USD',1)
     on conflict(id) do update set last_succeeded_at=now(),record_count=0,
       account_timezone='Africa/Dakar',account_currency='USD',account_status=1,last_error=null`,
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function client(phone: string, isTest = false): Promise<string> {
  return (await pool.query(
    `insert into clients(wa_phone,name,is_test) values($1,$2,$3) returning id`,
    [phone,phone,isTest],
  )).rows[0].id;
}

async function lead(clientId: string, createdAt: string, adId = "7001"): Promise<void> {
  await pool.query(
    `insert into campaign_leads
      (client_id,campaign_key,matched_by,source_type,source_id,headline,created_at)
     values($1,'pack_decouverte_ctwa','meta_referral','ad',$2,'Cinema',$3)`,
    [clientId,adId,createdAt],
  );
}

async function sale(clientId: string, paidAt: string, status = "SCHEDULED", planId = "key-invitee") {
  await pool.query(
    `insert into pending_plan_orders
      (client_id,plan_id,plan_name,amount_xof,status,is_key,paid_at,created_at)
     values($1,$2,'Clé',30000,$3,true,$4,$4)`,
    [clientId,planId,status,paidAt],
  );
}

describe("Meta acquisition dashboard", () => {
  it("paginates, upserts idempotently, and reconciles ghost rows only after success", async () => {
    const today = dateInTimezone(new Date(), "Africa/Dakar");
    let run = 0;
    const fakeFetch = vi.fn(async (input: URL | RequestInfo) => {
      const url = String(input);
      if (!url.includes("/insights") && !url.includes("/ads-next")) {
        return new Response(JSON.stringify({ currency:"USD",timezone_name:"Africa/Dakar",account_status:1 }),{status:200});
      }
      if (url.includes("/ads-next")) {
        return new Response(JSON.stringify({ data:[{
          date_start:today,ad_id:"7002",campaign_id:"9001",spend:"2",impressions:"20",clicks:"1",
        }] }),{status:200});
      }
      run += 1;
      const rows = [{
        date_start:today,ad_id:"7001",campaign_id:"9001",spend:"5",impressions:"100",clicks:"10",
        actions:[{action_type:"link_click",value:"8"}],
      }];
      return new Response(JSON.stringify(run===1
        ? { data:rows,paging:{next:"https://graph.facebook.com/v25.0/ads-next?after=1"} }
        : { data:rows }),{status:200});
    });
    vi.stubGlobal("fetch",fakeFetch);
    expect(await syncAdInsights(true)).toMatchObject({ran:true,recordCount:2});
    expect(Number((await pool.query(`select count(*) n from ad_insights_daily`)).rows[0].n)).toBe(2);
    expect(await syncAdInsights(true)).toMatchObject({ran:true,recordCount:1});
    expect((await pool.query(`select ad_id from ad_insights_daily order by ad_id`)).rows).toEqual([{ad_id:"7001"}]);
  });

  it("keeps the prior cache when a later pagination page fails", async () => {
    const today = dateInTimezone(new Date(), "Africa/Dakar");
    await pool.query(
      `insert into ad_insights_daily(day,ad_id,campaign_id,spend) values($1,'7999','9001',9)`,[today],
    );
    vi.stubGlobal("fetch",vi.fn(async (input: URL | RequestInfo) => {
      const url = String(input);
      if (!url.includes("/insights") && !url.includes("/broken-next")) {
        return new Response(JSON.stringify({currency:"USD",timezone_name:"Africa/Dakar",account_status:1}),{status:200});
      }
      if (url.includes("/broken-next")) return new Response(JSON.stringify({error:{message:"page failed"}}),{status:400});
      return new Response(JSON.stringify({data:[{
        date_start:today,ad_id:"7001",campaign_id:"9001",spend:"1",impressions:"1",clicks:"1",
      }],paging:{next:"https://graph.facebook.com/v25.0/broken-next"}}),{status:200});
    }));
    await expect(syncAdInsights(true)).rejects.toThrow(/page failed/);
    expect((await pool.query(`select ad_id from ad_insights_daily`)).rows).toEqual([{ad_id:"7999"}]);
  });

  it("returns already-in-progress instead of running two syncs concurrently", async () => {
    const today = dateInTimezone(new Date(),"Africa/Dakar");
    let releaseMetadata!: () => void;
    const metadataGate = new Promise<void>((resolve) => { releaseMetadata=resolve; });
    let metadataStarted!: () => void;
    const started = new Promise<void>((resolve) => { metadataStarted=resolve; });
    vi.stubGlobal("fetch",vi.fn(async (input: URL | RequestInfo) => {
      const url = String(input);
      if (!url.includes("/insights")) {
        metadataStarted();
        await metadataGate;
        return new Response(JSON.stringify({currency:"USD",timezone_name:"Africa/Dakar",account_status:1}),{status:200});
      }
      return new Response(JSON.stringify({data:[{
        date_start:today,ad_id:"7001",campaign_id:"9001",spend:"1",impressions:"1",clicks:"1",
      }]}),{status:200});
    }));
    const first = syncAdInsights(true);
    await started;
    const second = await syncAdInsights(true);
    expect(second).toMatchObject({ran:false,reason:"locked"});
    releaseMetadata();
    await expect(first).resolves.toMatchObject({ran:true});
  });

  it("does not fan out spend or revenue and separates acquisition from renewals", async () => {
    const today = dateInTimezone(new Date(), "Africa/Dakar");
    const yesterday = addCalendarDays(today,-1);
    await pool.query(
      `insert into ad_insights_daily
        (day,ad_id,ad_name,campaign_id,campaign_name,spend,impressions,clicks,link_clicks,results,account_currency)
       values
        ($1,'7001','Cinema','9001','CLE INVITEE',5,100,10,8,4,'USD'),
        ($2,'7001','Cinema','9001','CLE INVITEE',10,200,20,16,8,'USD'),
        ($2,'7002','Waste','9001','CLE INVITEE',3,60,3,2,0,'USD')`,
      [yesterday,today],
    );
    const acquisition = await client("221770001001");
    const renewal = await client("221770001002");
    const test = await client("221770001003",true);
    const leadAt = `${yesterday}T10:00:00Z`;
    await lead(acquisition,leadAt);
    await lead(renewal,leadAt);
    await lead(test,leadAt);
    await sale(acquisition,`${yesterday}T11:00:00Z`);
    await sale(renewal,`${addCalendarDays(yesterday,-10)}T09:00:00Z`,"ACTIVATED");
    await sale(renewal,`${yesterday}T12:00:00Z`);
    await sale(test,`${yesterday}T12:30:00Z`);

    const dashboard = await adAcquisitionDashboard();
    expect(dashboard.thirtyDays.delivery.spend).toBe(18);
    expect(dashboard.thirtyDays.delivery.leads).toBe(2);
    const cinema = dashboard.thirtyDays.ads.find((row) => row.adId === "7001");
    expect(cinema).toMatchObject({
      spend:15,
      leads:2,
      acquisitionSales:1,
      acquisitionRevenueXof:30000,
      influencedRenewals:1,
      activated:0,
      toActivate:1,
    });
    expect(dashboard.thirtyDays.ads.find((row) => row.adId === "7002")).toMatchObject({ leads:0,spend:3 });
    expect(dashboard.thirtyDays.cash.allSales).toBe(3);
    expect(dashboard.thirtyDays.cash.attributedSales).toBe(2);
  });

  it("excludes pre-click, Aquabike, sur-mesure and the strict J+30 boundary", async () => {
    const today = dateInTimezone(new Date(), "Africa/Dakar");
    await pool.query(
      `insert into ad_insights_daily(day,ad_id,campaign_id,spend,impressions,clicks)
       values($1,'7001','9001',10,100,5)`,[today],
    );
    const id = await client("221770001010");
    const leadAt = `${today}T08:00:00Z`;
    await lead(id,leadAt);
    await sale(id,`${addCalendarDays(today,-1)}T08:00:00Z`);
    await sale(id,`${today}T09:00:00Z`,"PAID","aquabike-plan");
    await sale(id,`${today}T10:00:00Z`,"PAID","sur-mesure-plan");
    await sale(id,`${addCalendarDays(today,30)}T08:00:00Z`);
    const dashboard = await adAcquisitionDashboard();
    expect(dashboard.thirtyDays.ads[0]).toMatchObject({ acquisitionSales:0,acquisitionRevenueXof:0 });
  });
});
