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
  if (args.referral?.sourceId && args.allowedSourceIds.includes(args.referral.sourceId)) return { matched: true, matchedBy: "meta_referral" as const };
  return CANONICAL_MESSAGES.has(normalizeCampaignMessage(args.text)) ? { matched: true, matchedBy: "message" as const } : { matched: false, matchedBy: null };
}
export function isCampaignReformerService(args: { serviceId: string; serviceName: string; configuredServiceIds: string[] }) {
  return args.configuredServiceIds.length ? args.configuredServiceIds.includes(args.serviceId) : /\breformer\b/i.test(args.serviceName);
}
