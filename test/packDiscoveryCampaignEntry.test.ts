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

  it("with an empty allowlist, treats any ad referral as a campaign lead (fallback)", () => {
    expect(
      isPackDiscoveryCampaignEntry({ text: "n'importe quoi", referral: { sourceId: "ad_999" } as never, allowedSourceIds: [] }),
    ).toEqual({ matched: true, matchedBy: "meta_referral" });
  });

  it("with a non-empty allowlist, a referral whose sourceId is not listed falls through to the text check", () => {
    // Unrelated text + unlisted ad id → no match at all.
    expect(
      isPackDiscoveryCampaignEntry({ text: "bonjour, vos horaires ?", referral: { sourceId: "ad_other" } as never, allowedSourceIds: ["ad_123"] }),
    ).toEqual({ matched: false, matchedBy: null });
    // Unlisted ad id but a canonical opener still matches by message.
    expect(
      isPackDiscoveryCampaignEntry({ text: "Bonjour ! Puis-je en savoir plus à ce sujet ?", referral: { sourceId: "ad_other" } as never, allowedSourceIds: ["ad_123"] }),
    ).toEqual({ matched: true, matchedBy: "message" });
  });

  it("a referral without a sourceId falls through to the text check", () => {
    expect(
      isPackDiscoveryCampaignEntry({ text: "bonjour, vos horaires ?", referral: {} as never, allowedSourceIds: [] }),
    ).toEqual({ matched: false, matchedBy: null });
  });
});
