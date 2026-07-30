import { describe, expect, it } from "vitest";
import { coachPaymentCourseSourceLabel } from "../src/lib/coachPaymentPdf.js";

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
