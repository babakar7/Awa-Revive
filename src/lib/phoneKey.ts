/**
 * Canonical phone key — the ONE normalization shared by CRM audit, the Wix
 * booking/attendance mirrors, Wix payment movements and client matching. Every
 * source that wants to answer "is this the same person?" must key through here,
 * so a booking made in Wix, a payment, and a `clients.wa_phone` all collapse to
 * the same string or none of them do.
 *
 * Rules (deliberately fail-closed for anything we can't place with confidence):
 *  - Senegal: `221` + the 9-digit national number (mobiles start with 7). A
 *    number already carrying the 221 country code is kept as-is.
 *  - Other country, stated internationally (`+`, `00`, or already country-coded
 *    to ≥11 digits): the full international digit string.
 *  - Ambiguous local foreign number (no country context, or too short): no key.
 *    Never guess a country — a wrong guess collides two unrelated people, which
 *    is worse than leaving the row unmatched.
 *
 * The return value is a bare digit string (no `+`), because every consumer
 * compares it against `regexp_replace(wa_phone,'\D','','g')`-style digits.
 */
export function canonicalPhoneKey(input: string | null | undefined): string | null {
  const raw = String(input ?? "").trim();
  if (!raw) return null;
  const statedPlus = raw.startsWith("+");
  let digits = raw.replace(/\D/g, "");
  if (!digits) return null;
  let statedIntl = statedPlus;
  // "00" is the international access prefix — drop it, treat the rest as full
  // international digits.
  if (digits.startsWith("00")) {
    digits = digits.slice(2);
    statedIntl = true;
  }
  // Senegal, already country-coded (221 + 9 national digits).
  if (digits.length === 12 && digits.startsWith("221")) return digits;
  // Senegal, local mobile spelling (9 digits, national numbers start with 7).
  if (digits.length === 9 && digits.startsWith("7")) return `221${digits}`;
  // Any other country, but only when the caller stated it internationally and
  // there are enough digits to be a real E.164 number.
  if (statedIntl && digits.length >= 11) return digits;
  // Everything else is ambiguous — no key.
  return null;
}
