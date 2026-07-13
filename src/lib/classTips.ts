/**
 * Short pre-class tips (tenue / what to bring). Matched by ACTIVITY KEYWORDS
 * in the service name — never a hard-coded list of full class names (same
 * invariant as business-info: the live Wix catalog is the source of classes).
 * Pure; null when no tip applies (do not invent).
 *
 * Chaussettes antidérapantes = Reformer only (business-info). Other studio
 * floor classes (mat Pilates, yoga, fusion, inversion) get tenue de sport only.
 */

export type TipLang = "fr" | "en" | "wo";

const TIPS: Record<"reformer" | "studio" | "aqua" | "boxe", Record<TipLang, string>> = {
  reformer: {
    fr: "💡 Tenue de sport confortable + chaussettes antidérapantes obligatoires pour le Reformer (en vente au studio).",
    en: "💡 Comfortable sports clothes + non-slip socks are required for Reformer (available at the studio).",
    wo: "💡 Tenue sport bu yomb + caabi antidérapantes dañu ko soxla ci Reformer (jëndees na ko ci studio bi).",
  },
  studio: {
    fr: "💡 Pense à une tenue de sport confortable.",
    en: "💡 Wear comfortable sports clothes.",
    wo: "💡 Solloo tenue sport bu yomb.",
  },
  aqua: {
    fr: "💡 Pense à ton maillot de bain ou lycra.",
    en: "💡 Bring a swimsuit or lycra.",
    wo: "💡 Indil sa maillot de bain walla lycra.",
  },
  boxe: {
    fr: "💡 Tenue de sport, baskets propres et une bouteille d'eau.",
    en: "💡 Sports clothes, clean trainers, and a water bottle.",
    wo: "💡 Tenue sport, baskets yu set ak benn butel d'eau.",
  },
};

function normalizeLang(lang: string | null | undefined): TipLang {
  if (lang === "en" || lang === "wo") return lang;
  return "fr";
}

/**
 * Return a one-line tip for this class name, or null if unknown.
 * Order: aqua → boxe → reformer (socks) → other studio-floor activities.
 */
export function classTip(serviceName: string, lang?: string | null): string | null {
  const s = serviceName
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
  const l = normalizeLang(lang);

  // Aqua first so e.g. a future "Aqua Pilates" still gets swimsuit tip.
  if (
    s.includes("aqua") ||
    s.includes("natation") ||
    s.includes("nageur") ||
    s.includes("nage ") ||
    s.endsWith(" nage") ||
    s === "nage"
  ) {
    return TIPS.aqua[l];
  }
  if (s.includes("boxe") || s.includes("boxing")) {
    return TIPS.boxe[l];
  }
  // Non-slip socks ONLY for Reformer (not generic Pilates / yoga / fusion).
  if (s.includes("reformer")) {
    return TIPS.reformer[l];
  }
  if (s.includes("pilates") || s.includes("fusion") || s.includes("yoga") || s.includes("inversion")) {
    return TIPS.studio[l];
  }
  return null;
}
