import { describe, expect, it } from "vitest";
import {
  DEFAULT_CONDITIONS,
  formatQuoteNumber,
  isQuoteStatus,
  parseQuoteForm,
  parseQuoteItemFields,
  quoteTotal,
} from "../src/domain/quoteRules.js";

describe("formatQuoteNumber", () => {
  it("zero-pads to 4 digits", () => {
    expect(formatQuoteNumber(2026, 1)).toBe("DEV-2026-0001");
    expect(formatQuoteNumber(2026, 716)).toBe("DEV-2026-0716");
  });
  it("never truncates past 4 digits", () => {
    expect(formatQuoteNumber(2026, 10000)).toBe("DEV-2026-10000");
  });
});

describe("parseQuoteItemFields", () => {
  it("skips fully blank rows and keeps filled ones", () => {
    const r = parseQuoteItemFields({
      item_label_0: "Privatisation demi-journée",
      item_detail_0: "coach dédié",
      item_amount_0: "105000",
      item_label_1: "",
      item_detail_1: "",
      item_amount_1: "",
    });
    expect("items" in r && r.items).toEqual([
      { label: "Privatisation demi-journée", detail: "coach dédié", amount_xof: 105000 },
    ]);
  });

  it("treats empty or 0 amount as Inclus (null)", () => {
    const r = parseQuoteItemFields({
      item_label_0: "Cookies",
      item_detail_0: "fournis par la cliente",
      item_amount_0: "",
      item_label_1: "Café",
      item_amount_1: "0",
    });
    expect("items" in r && r.items).toEqual([
      { label: "Cookies", detail: "fournis par la cliente", amount_xof: null },
      { label: "Café", detail: null, amount_xof: null },
    ]);
  });

  it("accepts amounts with spaces as thousands separators", () => {
    const r = parseQuoteItemFields({ item_label_0: "X", item_amount_0: "105 000" });
    expect("items" in r && r.items[0].amount_xof).toBe(105000);
  });

  it("rejects a non-integer amount", () => {
    const r = parseQuoteItemFields({ item_label_0: "X", item_amount_0: "abc" });
    expect("error" in r).toBe(true);
  });

  it("rejects a detail with no label", () => {
    const r = parseQuoteItemFields({ item_label_0: "", item_detail_0: "orphan detail" });
    expect("error" in r).toBe(true);
  });

  it("errors when no line is filled", () => {
    const r = parseQuoteItemFields({ item_label_0: "", item_amount_0: "" });
    expect("error" in r).toBe(true);
  });
});

describe("quoteTotal", () => {
  it("sums priced lines and ignores Inclus (null)", () => {
    expect(
      quoteTotal([
        { label: "a", detail: null, amount_xof: 105000 },
        { label: "b", detail: null, amount_xof: null },
        { label: "c", detail: null, amount_xof: 5000 },
      ]),
    ).toBe(110000);
  });
});

describe("parseQuoteForm", () => {
  const base = {
    client_name: "Dienaba",
    event_title: "Pilates & Cookies",
    item_label_0: "Privatisation",
    item_amount_0: "105000",
  };

  it("requires a client name", () => {
    const r = parseQuoteForm({ ...base, client_name: "" });
    expect("error" in r).toBe(true);
  });

  it("requires an event title", () => {
    const r = parseQuoteForm({ ...base, event_title: "" });
    expect("error" in r).toBe(true);
  });

  it("rejects an out-of-range validity", () => {
    expect("error" in parseQuoteForm({ ...base, validity_days: "0" })).toBe(true);
    expect("error" in parseQuoteForm({ ...base, validity_days: "500" })).toBe(true);
  });

  it("keeps a valid ISO date and drops a malformed one", () => {
    const ok = parseQuoteForm({ ...base, event_date: "2026-09-27" });
    expect("data" in ok && ok.data.event_date).toBe("2026-09-27");
    const bad = parseQuoteForm({ ...base, event_date: "27/09/2026" });
    expect("data" in bad && bad.data.event_date).toBe(null);
  });

  it("defaults conditions and validity when omitted", () => {
    const r = parseQuoteForm(base);
    expect("data" in r && r.data.conditions).toBe(DEFAULT_CONDITIONS);
    expect("data" in r && r.data.validity_days).toBe(15);
  });
});

describe("isQuoteStatus", () => {
  it("accepts known statuses and rejects others", () => {
    expect(isQuoteStatus("SENT")).toBe(true);
    expect(isQuoteStatus("BOGUS")).toBe(false);
  });
});
