import type { WhatsAppReferral } from "../lib/whatsapp.js";

export const PACK_DISCOVERY_CAMPAIGN = "pack_decouverte_ctwa";
export const PACK_DISCOVERY_CANONICAL_MESSAGE = "bonjour je veux reserver le pack decouverte";

/** Case/diacritic/punctuation-insensitive comparison for Meta's preset text. */
export function normalizeCampaignMessage(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("fr")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

export function isPackDiscoveryCampaignEntry(args: {
  text: string;
  referral?: WhatsAppReferral;
  allowedSourceIds: string[];
}): { matched: boolean; matchedBy: "meta_referral" | "message" | null } {
  const sourceId = args.referral?.sourceId?.trim();
  if (sourceId && args.allowedSourceIds.includes(sourceId)) {
    return { matched: true, matchedBy: "meta_referral" };
  }
  return normalizeCampaignMessage(args.text) === PACK_DISCOVERY_CANONICAL_MESSAGE
    ? { matched: true, matchedBy: "message" }
    : { matched: false, matchedBy: null };
}

/** Restrict the discounted first visit to Reformer, never arbitrary classes. */
export function isCampaignReformerService(args: {
  serviceId: string;
  serviceName: string;
  configuredServiceIds: string[];
}): boolean {
  if (args.configuredServiceIds.length > 0) return args.configuredServiceIds.includes(args.serviceId);
  return /\breformer\b/i.test(args.serviceName);
}
