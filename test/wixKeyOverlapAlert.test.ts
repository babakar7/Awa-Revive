import { describe, expect, it } from "vitest";
import {
  formatKeyOverlapAlert,
  shouldAlertKeyOverlap,
} from "../src/webhooks/wix.js";

describe("Wix Key overlap alert", () => {
  const overlap = {
    newOrderId: "new-order",
    newStart: new Date("2026-07-30T00:00:00.000Z"),
    previousKind: "KEY" as const,
    previousOrderId: "previous-order",
    previousEnd: new Date("2026-08-29T09:48:00.000Z"),
  };

  it("names the client and links directly to her Awa conversation", () => {
    const body = formatKeyOverlapAlert({
      ...overlap,
      clientName: "Arame Diop",
      clientPhone: "+221 76 648 40 16",
      clientId: "client/avec espace",
      wixContactId: "wix-contact",
      baseUrl: "https://awa.revive.sn/",
    });

    expect(body).toContain("Cliente : Arame Diop (+221766484016)");
    expect(body).toContain(
      "Ouvrir la conversation : https://awa.revive.sn/admin/conversations/client%2Favec%20espace",
    );
    expect(body).toContain("La Clé Wix new-order démarre le 2026-07-30");
    expect(body).toContain("la Clé précédente previous-order se termine le 2026-08-29");
  });

  it("keeps a Wix contact reference when the client has never messaged Awa", () => {
    const body = formatKeyOverlapAlert({
      ...overlap,
      clientName: "Cliente Wix",
      wixContactId: "wix-contact",
      baseUrl: "https://awa.revive.sn",
    });

    expect(body).toContain("Cliente : Cliente Wix");
    expect(body).toContain("Contact Wix : wix-contact");
    expect(body).not.toContain("/admin/conversations/");
  });

  it("does not alert when the new Key starts on the previous plan's expiry day", () => {
    expect(
      shouldAlertKeyOverlap(
        new Date("2026-07-30T00:00:00.000Z"),
        new Date("2026-07-30T23:59:59.000Z"),
      ),
    ).toBe(false);
  });

  it("alerts when the new Key starts on an earlier calendar day", () => {
    expect(
      shouldAlertKeyOverlap(
        new Date("2026-07-29T23:59:59.000Z"),
        new Date("2026-07-30T00:00:00.000Z"),
      ),
    ).toBe(true);
  });
});
