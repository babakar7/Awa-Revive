export interface PresentedChoice {
  choice_id: string;
  title: string;
}

export function normalizeChoiceText(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[’']/g, " ")
    .replace(/[·.,!?;:()[\]{}]/g, " ")
    .replace(/\b(\d{1,2})\s*h\s*(\d{2})\b/g, "$1 $2")
    .replace(/\s+/g, " ")
    .trim();
}

function paymentChoiceId(text: string): string | null {
  const normalized = normalizeChoiceText(text);
  if (/^(payer |paiement |par |avec )?wave( svp| merci)?$/.test(normalized)) return "pay_wave";
  if (/^(payer |paiement |par |avec )?(om|orange money)( svp| merci)?$/.test(normalized)) {
    return "pay_om";
  }
  if (/^(payer |paiement |par |avec )?(maxit|max it)( svp| merci)?$/.test(normalized)) {
    return "pay_maxit";
  }
  return null;
}

/**
 * Deliberately conservative: exact title, explicit payment rail, or a unique
 * time from the latest list. An ambiguous "mercredi" stays with the model.
 */
export function resolveFreeTextChoice(
  text: string,
  choices: readonly PresentedChoice[],
): PresentedChoice | null {
  if (choices.length === 0 || /^\[choix cliqu[eé]\]/i.test(text.trim())) return null;
  const normalized = normalizeChoiceText(text);
  const exact = choices.filter((choice) => normalizeChoiceText(choice.title) === normalized);
  if (exact.length === 1) return exact[0];

  const paymentId = paymentChoiceId(text);
  if (paymentId) {
    const payment = choices.filter((choice) => choice.choice_id === paymentId);
    if (payment.length === 1) return payment[0];
  }

  const time = normalized.match(/\b([01]?\d|2[0-3])\s+([0-5]\d)\b/);
  if (!time) return null;
  const hh = String(Number(time[1])).padStart(2, "0");
  const needle = `${hh} ${time[2]}`;
  const byTime = choices.filter((choice) => normalizeChoiceText(choice.title).includes(needle));
  return byTime.length === 1 ? byTime[0] : null;
}
