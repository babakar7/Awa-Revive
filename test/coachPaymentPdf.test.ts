import { describe, expect, it } from "vitest";
import {
  coachPaymentCourseSourceLabel,
  coachPaymentCourseSubLines,
} from "../src/lib/coachPaymentPdf.js";

describe("coach payment PDF course source", () => {
  it("identifies cancelled Wix sessions from their stored snapshot", () => {
    expect(
      coachPaymentCourseSourceLabel({ source: "wix", wix_status: "CANCELLED" }),
    ).toBe("Wix · annulée");
    expect(
      coachPaymentCourseSourceLabel({ source: "wix", wix_status: "CONFIRMED" }),
    ).toBe("Wix");
    expect(
      coachPaymentCourseSourceLabel({ source: "manual", wix_status: null }),
    ).toBe("Manuel");
  });
});

describe("coach payment PDF course sub-lines", () => {
  it("returns nothing for a plain Wix course", () => {
    expect(coachPaymentCourseSubLines({ manual_reason: null, holiday: false })).toEqual([]);
  });

  it("returns only the reason for a non-holiday manual course", () => {
    expect(coachPaymentCourseSubLines({ manual_reason: "Remplacement", holiday: false })).toEqual([
      "Motif : Remplacement",
    ]);
  });

  it("returns only the markup note for a Wix course on a holiday", () => {
    expect(coachPaymentCourseSubLines({ manual_reason: null, holiday: true })).toEqual([
      "Jour férié · majoration +50 %",
    ]);
  });

  it("stacks both the reason and the markup note for a manual holiday course", () => {
    expect(coachPaymentCourseSubLines({ manual_reason: "Remplacement", holiday: true })).toEqual([
      "Motif : Remplacement",
      "Jour férié · majoration +50 %",
    ]);
  });
});
