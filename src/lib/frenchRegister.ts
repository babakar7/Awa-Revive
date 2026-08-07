export type FrenchRegister = "tu" | "vous";

/** Explicit formal pronouns latch vouvoiement; ambiguous messages keep state. */
export function detectFrenchRegister(text: string): "vous" | null {
  const normalized = text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
  return /\b(vous|votre|vos)\b/.test(normalized) ? "vous" : null;
}

/**
 * Convert the finite client-facing template vocabulary to vouvoiement. Model
 * replies are handled by dynamic context; this covers deterministic messages.
 */
export function applyFrenchRegister(text: string, formal: boolean): string {
  if (!formal) return text;
  const cased = (source: string, replacement: string) =>
    /^\p{Lu}/u.test(source)
      ? replacement.charAt(0).toLocaleUpperCase("fr") + replacement.slice(1)
      : replacement;
  return text
    .replace(/\btu n[’']auras\b/gi, (m) => cased(m, "vous n’aurez"))
    .replace(/\btu n[’']as\b/gi, (m) => cased(m, "vous n’avez"))
    .replace(/\btu n[’']es\b/gi, (m) => cased(m, "vous n’êtes"))
    .replace(/\btu auras\b/gi, (m) => cased(m, "vous aurez"))
    .replace(/\btu peux\b/gi, (m) => cased(m, "vous pouvez"))
    .replace(/\btu dois\b/gi, (m) => cased(m, "vous devez"))
    .replace(/\btu veux\b/gi, (m) => cased(m, "vous voulez"))
    .replace(/\btu as\b/gi, (m) => cased(m, "vous avez"))
    // Unicode lookarounds, not \b : l'ASCII \b voit une frontière après une
    // lettre accentuée (« êtes » → « êvos », « piéton » → « piévotre »).
    .replace(/(?<!\p{L})ton(?!\p{L})/giu, (m) => cased(m, "votre"))
    .replace(/(?<!\p{L})ta(?!\p{L})/giu, (m) => cased(m, "votre"))
    .replace(/(?<!\p{L})tes(?!\p{L})/giu, (m) => cased(m, "vos"))
    .replace(/(^|[\s([{"'])(te)(?=$|[\s.,!?;:)\]}"'])/gi, (_, prefix, pronoun) =>
      `${prefix}${cased(pronoun, "vous")}`,
    )
    .replace(/\btu\b/gi, (m) => cased(m, "vous"))
    .replace(/\bmontre\b/gi, (m) => cased(m, "montrez"))
    .replace(/\bréponds\b/gi, (m) => cased(m, "répondez"))
    .replace(/\bréessaie\b/gi, (m) => cased(m, "réessayez"))
    .replace(/(^|[\s([{"'])(écris)(?=$|[\s.,!?;:)\]}"'-])/gi, (_, prefix, verb) =>
      `${prefix}${cased(verb, "écrivez")}`,
    )
    .replace(/\benvoie\b/gi, (m) => cased(m, "envoyez"))
    .replace(/\bouvre\b/gi, (m) => cased(m, "ouvrez"))
    .replace(/\bappuie\b/gi, (m) => cased(m, "appuyez"))
    .replace(/\bdis-nous\b/gi, (m) => cased(m, "dites-nous"))
    .replace(/\bdis\b/gi, (m) => cased(m, "dites"))
    .replace(/\bt'en\b/gi, (m) => cased(m, "vous en"))
    .replace(/\bt'aide\b/gi, (m) => cased(m, "vous aide"))
    .replace(/\bt'aider\b/gi, (m) => cased(m, "vous aider"));
}
