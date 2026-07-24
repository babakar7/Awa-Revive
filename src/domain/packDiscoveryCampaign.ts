import type { WhatsAppReferral } from "../lib/whatsapp.js";
export const PACK_DISCOVERY_CAMPAIGN = "pack_decouverte_ctwa";
const CANONICAL = "bonjour je veux reserver le pack decouverte";
export function normalizeCampaignMessage(text: string): string {
  return text.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLocaleLowerCase("fr").replace(/[^\p{L}\p{N}]+/gu, " ").trim().replace(/\s+/g, " ");
}
export function isPackDiscoveryCampaignEntry(args: { text: string; referral?: WhatsAppReferral; allowedSourceIds: string[] }) {
  if (args.referral?.sourceId && args.allowedSourceIds.includes(args.referral.sourceId)) return { matched: true, matchedBy: "meta_referral" as const };
  return normalizeCampaignMessage(args.text) === CANONICAL ? { matched: true, matchedBy: "message" as const } : { matched: false, matchedBy: null };
}
export function isCampaignReformerService(args: { serviceId: string; serviceName: string; configuredServiceIds: string[] }) {
  return args.configuredServiceIds.length ? args.configuredServiceIds.includes(args.serviceId) : /\breformer\b/i.test(args.serviceName);
}
