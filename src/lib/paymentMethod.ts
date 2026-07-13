/** Human-facing label for every payment rail stored in the database. */
export function paymentMethodLabel(raw: unknown): string {
  const method = String(raw ?? "").trim().toLowerCase();
  switch (method) {
    case "wave":
      return "Wave";
    case "orange_money":
    case "om":
      return "Orange Money";
    case "maxit":
    case "max_it":
      return "Max It";
    case "membership":
      return "Abonnement";
    default:
      return method || "—";
  }
}
