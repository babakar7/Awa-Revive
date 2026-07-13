/**
 * Capability shortcuts on vague openers ("bonjour", "salut"…).
 *
 * Tiered (product 13/07):
 *  1. Unlinked number → account-linking only (no menu)
 *  2. Active payment link → no menu
 *  3. Upcoming bookings → [Mes prochains cours] [Réserver] [Autre]
 *  4. Else → full orientation menu (book / planning / plan / menu / reception)
 *
 * "Once per conversation" ≈ once per CAPABILITY_MENU_WINDOW_MS (24h): after a
 * capability present_options is actually delivered, we stamp capability_menu_at
 * and suppress further menus until the window elapses (a new day/chat stretch
 * can show again). Free text always works.
 */

/** How long after showing a menu we refuse to show another (ms). */
export const CAPABILITY_MENU_WINDOW_MS = 24 * 60 * 60 * 1000;

export type CapabilityMenuKind = "upcoming" | "onboarding";

/** Option ids used by both menus — present_options stamps the once-per-window flag when any match. */
export const CAPABILITY_OPTION_IDS = new Set([
  "my_bookings",
  "book",
  "other",
  "cap_book",
  "cap_schedule",
  "cap_plan",
  "cap_menu",
  "cap_reception",
]);

/**
 * True for short greetings / help openers with no booking intent.
 * Pure and unit-tested. Interactive clicks and long messages are never vague.
 */
export function isVagueOpener(text: string): boolean {
  const raw = text.trim();
  if (!raw) return false;
  // Clicks and system-prefixed turns are never "openers".
  if (/^\[(choix cliqué|note vocale|image reçue)/i.test(raw)) return false;

  const t = raw
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[!?.…,;:]+$/g, "")
    .trim();

  if (t.length > 48) return false;

  // Exact short greetings / availability / help (whole message).
  if (
    /^(bonjour|bonsoir|salut|hello|hi|hey|coucou|hola|bjr|slt|salam|good morning|good evening)(\s+.*)?$/.test(
      t,
    )
  ) {
    // "bonjour je veux reformer" is NOT vague — has intent after greeting.
    const rest = t.replace(
      /^(bonjour|bonsoir|salut|hello|hi|hey|coucou|hola|bjr|slt|salam|good morning|good evening)\s*/i,
      "",
    );
    if (!rest || /^(a wa|awa|!|\?)*$/.test(rest)) return true;
    // "bonjour !" only
    if (rest.length <= 2) return true;
    return false;
  }

  if (
    /^(dispo|disponible|tu es la|vous etes la|t es la|aide|help|a l aide|comment ca va|ca va|quoi de neuf|tu fais quoi|que peux tu faire|c est quoi)(\s*\?)?$/.test(
      t,
    )
  ) {
    return true;
  }

  return false;
}

/**
 * Which capability menu (if any) to offer this turn. Pure.
 * Habit is intentionally NOT a hard block: habit only applies when the client
 * expresses a booking intent without naming a class/time (separate prompt rule).
 */
export function capabilityMenuKind(args: {
  isVague: boolean;
  unlinkedNeverAsked: boolean;
  hasActivePaymentLink: boolean;
  upcomingBookingsCount: number;
  /** Last time a capability menu was actually delivered (null = never). */
  capabilityMenuAt: Date | string | null;
  now?: Date;
}): CapabilityMenuKind | null {
  if (!args.isVague) return null;
  if (args.unlinkedNeverAsked) return null;
  if (args.hasActivePaymentLink) return null;

  const now = args.now ?? new Date();
  if (args.capabilityMenuAt) {
    const last = new Date(args.capabilityMenuAt).getTime();
    if (!Number.isNaN(last) && now.getTime() - last < CAPABILITY_MENU_WINDOW_MS) {
      return null; // once per conversation window
    }
  }

  if (args.upcomingBookingsCount >= 1) return "upcoming";
  return "onboarding";
}

export function isCapabilityOptionId(id: string): boolean {
  return CAPABILITY_OPTION_IDS.has(id);
}
