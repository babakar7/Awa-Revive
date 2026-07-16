import { describe, expect, it } from "vitest";
import {
  formatInvoiceNumber,
  normalizeSourceKind,
  parseInvoiceLineFields,
} from "../src/domain/invoiceRules.js";

describe("formatInvoiceNumber", () => {
  it("zero-pads to 4 digits", () => {
    expect(formatInvoiceNumber(2026, 1)).toBe("FAC-2026-0001");
    expect(formatInvoiceNumber(2026, 42)).toBe("FAC-2026-0042");
  });
  it("never truncates past 4 digits", () => {
    expect(formatInvoiceNumber(2026, 10000)).toBe("FAC-2026-10000");
  });
});

describe("parseInvoiceLineFields", () => {
  it("computes per-line and grand totals server-side", () => {
    const r = parseInvoiceLineFields({
      line_label_0: "Pilates Reformer",
      line_qty_0: "4",
      line_unit_0: "12000",
      line_label_1: "Iced Matcha",
      line_qty_1: "2",
      line_unit_1: "3500",
      client_name: "ignored",
    });
    expect(r).toEqual({
      lines: [
        { label: "Pilates Reformer", qty: 4, unit_xof: 12000, total_xof: 48000 },
        { label: "Iced Matcha", qty: 2, unit_xof: 3500, total_xof: 7000 },
      ],
      totalXof: 55000,
    });
  });

  it("skips untouched blank rows but keeps ordered indices", () => {
    const r = parseInvoiceLineFields({
      line_label_0: "A",
      line_qty_0: "1",
      line_unit_0: "1000",
      line_label_1: "",
      line_qty_1: "",
      line_unit_1: "",
    });
    expect(r).toEqual({ lines: [{ label: "A", qty: 1, unit_xof: 1000, total_xof: 1000 }], totalXof: 1000 });
  });

  it("rejects an empty basket", () => {
    expect(parseInvoiceLineFields({})).toEqual({ error: expect.stringContaining("au moins une") });
    expect(parseInvoiceLineFields({ line_label_0: "", line_qty_0: "", line_unit_0: "" })).toEqual({
      error: expect.stringContaining("au moins une"),
    });
  });

  it("rejects a line with amounts but no label", () => {
    expect(parseInvoiceLineFields({ line_label_0: "", line_qty_0: "2", line_unit_0: "500" })).toEqual({
      error: expect.stringContaining("désignation"),
    });
  });

  it("rejects bad quantities and units", () => {
    const bad = (over: Record<string, string>) =>
      parseInvoiceLineFields({ line_label_0: "X", line_qty_0: "1", line_unit_0: "100", ...over });
    expect(bad({ line_qty_0: "0" })).toHaveProperty("error");
    expect(bad({ line_qty_0: "100" })).toHaveProperty("error");
    expect(bad({ line_qty_0: "abc" })).toHaveProperty("error");
    expect(bad({ line_qty_0: "1.5" })).toHaveProperty("error");
    expect(bad({ line_unit_0: "-100" })).toHaveProperty("error");
    expect(bad({ line_unit_0: "" })).toHaveProperty("error");
  });

  it("accepts a zero unit price on a line as long as the grand total is > 0", () => {
    const r = parseInvoiceLineFields({
      line_label_0: "Offert",
      line_qty_0: "1",
      line_unit_0: "0",
      line_label_1: "Séance",
      line_qty_1: "1",
      line_unit_1: "12000",
    });
    expect(r).toMatchObject({ totalXof: 12000 });
  });

  it("rejects an all-zero total", () => {
    expect(parseInvoiceLineFields({ line_label_0: "Offert", line_qty_0: "2", line_unit_0: "0" })).toEqual({
      error: expect.stringContaining("supérieur à 0"),
    });
  });

  it("rejects more than 20 lines", () => {
    const body: Record<string, string> = {};
    for (let i = 0; i < 21; i++) {
      body[`line_label_${i}`] = `L${i}`;
      body[`line_qty_${i}`] = "1";
      body[`line_unit_${i}`] = "100";
    }
    expect(parseInvoiceLineFields(body)).toEqual({ error: expect.stringContaining("max 20") });
  });
});

describe("normalizeSourceKind", () => {
  it("whitelists known kinds, defaults to manual", () => {
    expect(normalizeSourceKind("booking")).toBe("booking");
    expect(normalizeSourceKind("delivery")).toBe("delivery");
    expect(normalizeSourceKind("garbage")).toBe("manual");
    expect(normalizeSourceKind(undefined)).toBe("manual");
  });
});
