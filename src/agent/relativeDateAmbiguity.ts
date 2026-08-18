const MIDNIGHT_ROLLOVER_END_HOUR = 4;

const RELATIVE_TOMORROW = /\b(?:demain|tomorrow)\b/i;
const EXPLICIT_WEEKDAY =
  /\b(?:lundi|mardi|mercredi|jeudi|vendredi|samedi|dimanche|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i;
const EXPLICIT_NUMERIC_DATE = /\b\d{1,2}\s*[\/-]\s*\d{1,2}(?:\s*[\/-]\s*\d{2,4})?\b/;
const EXPLICIT_NAMED_DATE =
  /\b\d{1,2}\s+(?:janvier|fevrier|février|mars|avril|mai|juin|juillet|aout|août|septembre|octobre|novembre|decembre|décembre|january|february|march|april|may|june|july|august|september|october|november|december)\b/i;

/**
 * Just after midnight, clients often keep using "demain" for the morning that
 * has technically become today. Treat the bare relative word as ambiguous;
 * an explicit weekday or calendar date remains authoritative.
 */
export function isMidnightTomorrowAmbiguous(message: string, now = new Date()): boolean {
  const dakarHour = Number(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: "Africa/Dakar",
      hour: "2-digit",
      hourCycle: "h23",
    }).format(now),
  );

  if (!Number.isFinite(dakarHour) || dakarHour >= MIDNIGHT_ROLLOVER_END_HOUR) return false;
  if (!RELATIVE_TOMORROW.test(message)) return false;

  return !(
    EXPLICIT_WEEKDAY.test(message) ||
    EXPLICIT_NUMERIC_DATE.test(message) ||
    EXPLICIT_NAMED_DATE.test(message)
  );
}

