import type { WhatsAppReferral } from "../lib/whatsapp.js";
export const PACK_DISCOVERY_CAMPAIGN = "pack_decouverte_ctwa";
// Pre-filled messages carried by the click-to-WhatsApp Meta ads. Add every ad
// variant's exact opener here (already normalized: accent-stripped, lower-cased,
// punctuation collapsed to single spaces \u2014 see normalizeCampaignMessage).
const CANONICAL_MESSAGES = new Set([
  "bonjour je veux reserver le pack decouverte",
  "bonjour puis je en savoir plus a ce sujet",
]);
export function normalizeCampaignMessage(text: string): string {
  return text.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLocaleLowerCase("fr").replace(/[^\p{L}\p{N}]+/gu, " ").trim().replace(/\s+/g, " ");
}
export function isPackDiscoveryCampaignEntry(args: { text: string; referral?: WhatsAppReferral; allowedSourceIds: string[] }) {
  // A click-to-WhatsApp ad click carries a referral.sourceId. Trust it only when it is explicitly
  // allow-listed: an empty configuration must never turn every Meta ad into the Pack campaign.
  // Canonical pre-filled messages remain a deliberate fallback while an ad ID is being configured.
  const sourceId = args.referral?.sourceId;
  if (sourceId && args.allowedSourceIds.includes(sourceId)) return { matched: true, matchedBy: "meta_referral" as const };
  return CANONICAL_MESSAGES.has(normalizeCampaignMessage(args.text)) ? { matched: true, matchedBy: "message" as const } : { matched: false, matchedBy: null };
}
export function isCampaignReformerService(args: { serviceId: string; serviceName: string; configuredServiceIds: string[] }) {
  // Configuration narrows the eligible Reformer service; it must never widen the Pack offer to
  // another class such as Step.
  return /\breformer\b/i.test(args.serviceName)
    && (args.configuredServiceIds.length === 0 || args.configuredServiceIds.includes(args.serviceId));
}
