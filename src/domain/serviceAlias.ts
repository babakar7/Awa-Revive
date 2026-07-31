export type ServiceIdentity = { id: string; name: string };

function normalize(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("fr")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

/**
 * Recover only a unique, name-like alias such as `pilates_foundation`.
 * Opaque ids (including a mistaken plan UUID) are never guessed.
 */
export function resolveServiceAlias(input: string, services: ServiceIdentity[]): string | null {
  if (!/^[\p{L}\p{N}_-]+$/u.test(input)) return null;
  const withoutGenericTerms = (value: string) =>
    normalize(value)
      .replace(/\b(?:pilates|reformer)\b/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  const requested = withoutGenericTerms(input);
  // Generic-only guesses ("reformer", "pilates_reformer") are ambiguous by
  // construction and must never resolve to whichever Wix service comes first.
  if (!requested) return null;
  const matches = services.filter((service) => {
    const name = withoutGenericTerms(service.name);
    return name !== "" && name === requested;
  });
  return matches.length === 1 ? matches[0]!.id : null;
}
