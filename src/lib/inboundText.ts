/** Decode a click-to-WhatsApp prefill only when it is valid percent-encoded text. */
export function normalizeInboundText(text: string): string {
  if (!/%[0-9a-f]{2}/i.test(text)) return text;
  try {
    const decoded = decodeURIComponent(text);
    return decoded.includes("\0") ? text : decoded;
  } catch {
    return text;
  }
}
