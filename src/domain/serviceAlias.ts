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
  const requested = normalize(input);
  if (!requested) return null;
  const matches = services.filter((service) => {
    const name = normalize(service.name);
    return name === requested || name.replace(/\breformer\b/g, "").replace(/\s+/g, " ").trim() === requested;
  });
  return matches.length === 1 ? matches[0]!.id : null;
}
