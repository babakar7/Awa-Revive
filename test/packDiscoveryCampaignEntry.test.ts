import { describe, expect, it } from "vitest";
import { isPackDiscoveryCampaignEntry, normalizeCampaignMessage } from "../src/domain/packDiscoveryCampaign.js";

describe("Pack Découverte campaign entry matching", () => {
  const match = (text: string) => isPackDiscoveryCampaignEntry({ text, allowedSourceIds: [] });

  it("matches the original pre-filled ad opener regardless of case/accents/punctuation", () => {
    expect(match("Bonjour, je veux réserver le Pack Découverte")).toEqual({ matched: true, matchedBy: "message" });
    expect(match("bonjour je veux reserver le pack decouverte")).toEqual({ matched: true, matchedBy: "message" });
  });

  it("matches the new 'puis-je en savoir plus' ad opener", () => {
    expect(normalizeCampaignMessage("Bonjour ! Puis-je en savoir plus à ce sujet ?")).toBe("bonjour puis je en savoir plus a ce sujet");
    expect(match("Bonjour ! Puis-je en savoir plus à ce sujet ?")).toEqual({ matched: true, matchedBy: "message" });
  });

  it("does not match unrelated messages", () => {
    expect(match("Bonjour, quels sont vos horaires ?")).toEqual({ matched: false, matchedBy: null });
    expect(match("Puis-je en savoir plus sur le yoga ?")).toEqual({ matched: false, matchedBy: null });
  });

  it("matches a Meta referral whose sourceId is allow-listed", () => {
    expect(
      isPackDiscoveryCampaignEntry({ text: "anything", referral: { sourceId: "ad_123" } as never, allowedSourceIds: ["ad_123"] }),
    ).toEqual({ matched: true, matchedBy: "meta_referral" });
  });
});
