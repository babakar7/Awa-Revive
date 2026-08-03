import { describe, expect, it } from "vitest";
import { renderAdAcquisition } from "../src/admin/adAcquisitionPage.js";
import type { AdAcquisitionDashboard, AcquisitionPeriod, DeliveryMetrics } from "../src/domain/adAcquisition.js";

const delivery: DeliveryMetrics = {
  spend:15,impressions:300,clicks:30,linkClicks:24,results:12,leads:2,
  ctr:10,cpm:50,cpc:.5,costPerResult:1.25,costPerLead:7.5,
};

const period: AcquisitionPeriod = {
  label:"30 jours",start:"2026-07-05",endExclusive:"2026-08-04",maturing:true,delivery,
  ads:[{
    ...delivery,adId:"7001",adName:"Cinema",campaignName:"CLE INVITEE",
    acquisitionSales:1,acquisitionRevenueXof:30000,activated:0,toActivate:1,
    influencedRenewals:1,costPerKeyXof:9150,roas:3.28,
    planBreakdown:{"key-invitee":{sales:1,revenueXof:30000}},
  }],
  quality:{zero:1,one:0,engaged:1,total:2},
  headlines:[{headline:"<Cinema>",leads:2,engaged:1,acquisitionSales:1,influencedRenewals:1}],
  cash:{allSales:3,allRevenueXof:90000,attributedSales:2,attributedRevenueXof:60000},
  nudges:{sent:3,suppressed:1,failed:0,matureSent:2,replied72h:1,purchased72h:1},
};

function dashboard(overrides: Partial<AdAcquisitionDashboard> = {}): AdAcquisitionDashboard {
  return {
    enabled:true,configError:null,eligibilityError:null,
    sync:{last_started_at:new Date(),last_succeeded_at:new Date(),last_error:null,record_count:2,
      account_timezone:"America/Los_Angeles",account_currency:"USD",account_status:1,updated_at:new Date()},
    stale:false,currency:"USD",timezone:"America/Los_Angeles",fxRate:610,fxUpdatedAt:new Date(),
    sevenDays:{...period,label:"7 jours"},thirtyDays:period,weeks:[],...overrides,
  };
}

describe("Meta acquisition admin section", () => {
  it("renders acquisition and renewal separately without trusting headline HTML", () => {
    const html = renderAdAcquisition(dashboard(),true);
    expect(html).toContain("Ventes acquisition");
    expect(html).toContain("Renouvellements");
    expect(html).toContain("cohortes en maturation");
    expect(html).toContain("Resynchroniser Meta");
    expect(html).toContain("&lt;Cinema&gt;");
    expect(html).not.toContain("<Cinema>");
    expect(html).toContain('role="tablist"');
    expect(html).toContain('data-acquisition-period="7" aria-selected="true"');
    expect(html).toContain('data-acquisition-period="30" aria-selected="false"');
    expect(html).toContain('data-acquisition-period-panel="30" role="tabpanel" aria-labelledby="acquisition-tab-30" hidden');
    expect(html.indexOf("ad-roas-primary")).toBeLessThan(html.indexOf("Dépense livrée"));
  });

  it("hides fake zero spend when campaign mapping is unavailable but keeps DB sections", () => {
    const html = renderAdAcquisition(dashboard({enabled:false,configError:"Campagne Meta non rattachée",weeks:[]}),false);
    expect(html).toContain("Dépense indisponible");
    expect(html).toContain("Qualité · 30 jours");
    expect(html).not.toContain("Resynchroniser Meta");
  });
});
