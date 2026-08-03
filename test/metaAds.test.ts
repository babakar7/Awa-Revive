import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("Meta Ads contract", () => {
  it("validates campaign mappings fail-closed", async () => {
    const { parseCampaignMap } = await import("../src/lib/metaAds.js");
    expect(parseCampaignMap("12001:pack_decouverte_ctwa")).toMatchObject({ ok: true });
    expect(parseCampaignMap("")).toMatchObject({ ok: false, error: "Campagne Meta non rattachée" });
    expect(parseCampaignMap("oops:campaign")).toMatchObject({ ok: false });
    expect(parseCampaignMap("12001:a,12001:b")).toMatchObject({ ok: false });
  });

  it("sums duplicate actions and rejects invalid numeric payloads", async () => {
    const { parseInsight } = await import("../src/lib/metaAds.js");
    expect(parseInsight({
      date_start: "2026-08-03",
      ad_id: "120249271231720239",
      campaign_id: "1201",
      spend: "7.25",
      impressions: "100",
      clicks: "8",
      actions: [
        { action_type: "link_click", value: "3" },
        { action_type: "link_click", value: "2" },
        { action_type: "onsite_conversion.total_messaging_connection", value: "4" },
      ],
    })).toMatchObject({ spend: 7.25, impressions: 100, clicks: 8, linkClicks: 5, results: 4 });
    expect(() => parseInsight({
      date_start: "2026-08-03", ad_id: "1", campaign_id: "2", spend: "NaN",
    })).toThrow(/spend/);
  });

  it("uses Bearer auth for every page and strips echoed query credentials", async () => {
    vi.stubEnv("META_ADS_TOKEN", "secret-token-that-must-not-enter-a-url");
    vi.stubEnv("META_AD_ACCOUNT_ID", "act_1873234112963855");
    vi.stubEnv("META_GRAPH_VERSION", "v25.0");
    vi.resetModules();
    const { fetchInsights } = await import("../src/lib/metaAds.js");
    const seen: Array<{ url: string; auth: string | null }> = [];
    const fakeFetch = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      const url = String(input);
      const auth = new Headers(init?.headers).get("authorization");
      seen.push({ url, auth });
      const data = [{ date_start: "2026-08-03", ad_id: "11", campaign_id: "22", spend: "1", impressions: "10", clicks: "2" }];
      return new Response(JSON.stringify(seen.length === 1 ? {
        data,
        paging: { next: "https://graph.facebook.com/v25.0/next?after=x&access_token=echoed-secret" },
      } : { data: [] }), { status: 200, headers: { "content-type": "application/json" } });
    });
    const rows = await fetchInsights({ since: "2026-08-01", until: "2026-08-03" }, fakeFetch as typeof fetch);
    expect(rows).toHaveLength(1);
    expect(seen).toHaveLength(2);
    expect(seen.every((request) => request.auth === "Bearer secret-token-that-must-not-enter-a-url")).toBe(true);
    expect(seen.every((request) => !request.url.includes("access_token") && !request.url.includes("secret-token"))).toBe(true);
    expect(new URL(seen[0].url).searchParams.get("action_report_time")).toBe("conversion");
    expect(new URL(seen[0].url).searchParams.get("action_attribution_windows")).toBe('["7d_click","1d_view"]');
  });

  it("uses exact calendar dates rather than rolling 168-hour windows", async () => {
    const { addCalendarDays, dateInTimezone } = await import("../src/domain/adInsightsSync.js");
    const today = dateInTimezone(new Date("2026-08-03T23:30:00Z"), "Africa/Dakar");
    expect(today).toBe("2026-08-03");
    expect(addCalendarDays(today, -6)).toBe("2026-07-28");
  });
});
