import { describe, expect, it } from "vitest";
import {
  PACK_DISCOVERY_CANONICAL_MESSAGE,
  isCampaignReformerService,
  isPackDiscoveryCampaignEntry,
  normalizeCampaignMessage,
} from "../src/domain/packDiscoveryCampaign.js";

describe("Pack Découverte Meta campaign recognition", () => {
  it.each([
    "BOnjour, je veux reserver le pack decouverte",
    " Bonjour je veux réserver le Pack Découverte ! ",
    "Bonjour   je veux réserver le pack découverte",
  ])("normalizes the preset campaign message: %s", (message) => {
    expect(normalizeCampaignMessage(message)).toBe(PACK_DISCOVERY_CANONICAL_MESSAGE);
    expect(isPackDiscoveryCampaignEntry({ text: message, allowedSourceIds: [] })).toEqual({
      matched: true,
      matchedBy: "message",
    });
  });

  it("prioritizes an allowlisted Meta Click-to-WhatsApp referral", () => {
    expect(
      isPackDiscoveryCampaignEntry({
        text: "salut",
        referral: { sourceId: "ad-pack" },
        allowedSourceIds: ["ad-pack"],
      }),
    ).toEqual({ matched: true, matchedBy: "meta_referral" });
  });

  it("does not treat another ad as the Pack Découverte campaign", () => {
    expect(
      isPackDiscoveryCampaignEntry({
        text: "salut",
        referral: { sourceId: "other-ad" },
        allowedSourceIds: ["ad-pack"],
      }),
    ).toEqual({ matched: false, matchedBy: null });
  });
});

describe("Pack Découverte Reformer guard", () => {
  it("uses configured IDs when supplied", () => {
    expect(
      isCampaignReformerService({
        serviceId: "reformer-1",
        serviceName: "Pilates Reformer Foundation",
        configuredServiceIds: ["reformer-2"],
      }),
    ).toBe(false);
  });

  it("falls back to a Reformer-only service name check", () => {
    expect(
      isCampaignReformerService({
        serviceId: "r",
        serviceName: "Pilates Reformer Foundation",
        configuredServiceIds: [],
      }),
    ).toBe(true);
    expect(
      isCampaignReformerService({
        serviceId: "y",
        serviceName: "Yoga Flow",
        configuredServiceIds: [],
      }),
    ).toBe(false);
  });
});
