/**
 * CRM hygiene audit → email to reception.
 *
 * Awa recognizes clients by their WhatsApp number, so a Wix contact without a
 * phone can never be matched (no abonnement detected, no studio bookings
 * shown), and two contacts sharing one number make Awa refuse to choose
 * (deliberate caution). This script lists both problems and emails them to
 * RECEPTION_EMAIL so the team can fix the fiches / merge the duplicates.
 *
 * Usage: npm run crm:audit            (sends the email)
 *        npm run crm:audit -- --dry   (prints to stdout only)
 */
import { config } from "../src/config.js";
import { sendReceptionEmail } from "../src/lib/notify.js";

const H = {
  Authorization: config.WIX_API_KEY,
  "wix-site-id": config.WIX_SITE_ID,
  "Content-Type": "application/json",
};

async function fetchAllContacts(): Promise<any[]> {
  const all: any[] = [];
  for (let offset = 0; offset < 5000; offset += 100) {
    const res = await fetch("https://www.wixapis.com/contacts/v4/contacts/query", {
      method: "POST",
      headers: H,
      body: JSON.stringify({ query: { paging: { limit: 100, offset } } }),
    });
    if (!res.ok) throw new Error(`contacts query failed (${res.status}): ${await res.text()}`);
    const data: any = await res.json();
    const batch: any[] = data?.contacts ?? [];
    all.push(...batch);
    if (batch.length < 100) break;
  }
  return all;
}

const fullName = (c: any) =>
  [c?.info?.name?.first, c?.info?.name?.last].filter(Boolean).join(" ").trim() || "(sans nom)";
const firstEmail = (c: any) => c?.info?.emails?.items?.[0]?.email ?? null;

/** Normalize any spelling to comparable digits (senegalese → last 9 digits). */
function phoneKey(p: any): string | null {
  const raw: string = p?.e164Phone ?? p?.phone ?? "";
  const digits = raw.replace(/\D/g, "");
  if (digits.length < 7) return null;
  return digits.length >= 9 ? digits.slice(-9) : digits;
}

async function main() {
  const dry = process.argv.includes("--dry");
  const contacts = await fetchAllContacts();

  const noPhone: any[] = [];
  const byPhone = new Map<string, any[]>();
  for (const c of contacts) {
    const phones: any[] = c?.info?.phones?.items ?? [];
    if (phones.length === 0) {
      noPhone.push(c);
      continue;
    }
    for (const p of phones) {
      const key = phoneKey(p);
      if (!key) continue;
      const list = byPhone.get(key) ?? [];
      if (!list.some((x) => x.id === c.id)) list.push(c);
      byPhone.set(key, list);
    }
  }
  const duplicates = [...byPhone.entries()].filter(([, cs]) => cs.length > 1);

  const lines: string[] = [];
  lines.push(
    `Audit CRM Wix du ${new Date().toLocaleDateString("fr-FR", { timeZone: config.TIMEZONE })} — ${contacts.length} fiches contact.`,
    "",
    "Pourquoi c'est important : Awa reconnaît les clientes par leur numéro WhatsApp.",
    "Une fiche SANS téléphone = abonnement et réservations invisibles pour Awa ;",
    "un même numéro sur PLUSIEURS fiches = Awa refuse de choisir (prudence).",
    "",
    `1) FICHES SANS TÉLÉPHONE : ${noPhone.length}`,
    "   → ajouter le numéro WhatsApp de la cliente sur sa fiche Wix.",
  );
  for (const c of noPhone) {
    lines.push(`   - ${fullName(c)}${firstEmail(c) ? ` — ${firstEmail(c)}` : ""}`);
  }
  lines.push("", `2) NUMÉROS EN DOUBLON (${duplicates.length}) :`, "   → fusionner les fiches dans Wix (Contacts > … > Merge).");
  for (const [key, cs] of duplicates) {
    lines.push(`   - …${key} : ${cs.map((c) => fullName(c)).join(" / ")}`);
  }
  const body = lines.join("\n");
  const subject = `🗂 Hygiène CRM — ${noPhone.length} fiche(s) sans téléphone, ${duplicates.length} numéro(s) en doublon`;

  if (dry) {
    console.log(subject + "\n\n" + body);
    return;
  }
  const ok = await sendReceptionEmail(subject, body);
  console.log(ok ? `Email envoyé à ${config.RECEPTION_EMAIL}.` : "Échec d'envoi de l'email (voir logs).");
  console.log(`(${contacts.length} contacts, ${noPhone.length} sans téléphone, ${duplicates.length} doublons)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
