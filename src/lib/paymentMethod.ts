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
    case "cash":
      return "Espèces à la livraison";
    default:
      return method || "—";
  }
}

export interface PaymentMethodOption {
  id: "pay_wave" | "pay_om" | "pay_maxit";
  method: "wave" | "orange_money" | "maxit";
  title: string;
}

const MOBILE_PAYMENT_OPTIONS: PaymentMethodOption[] = [
  { id: "pay_wave", method: "wave", title: "Payer Wave" },
  { id: "pay_om", method: "orange_money", title: "Payer Orange Money" },
  { id: "pay_maxit", method: "maxit", title: "Payer Max It" },
];

/** Keep explicit choice while making the client's last successful rail easiest to tap. */
export function orderedPaymentMethodOptions(
  preferred: unknown,
  omEnabled = true,
): PaymentMethodOption[] {
  const available = omEnabled
    ? MOBILE_PAYMENT_OPTIONS
    : MOBILE_PAYMENT_OPTIONS.filter((option) => option.method === "wave");
  const method = String(preferred ?? "").trim().toLowerCase();
  return [...available].sort((a, b) => Number(b.method === method) - Number(a.method === method));
}
