/**
 * CRM hygiene audit → email to reception. Same data as the /admin/crm page
 * (shared lib: src/lib/crmAudit.ts) — the page is where duplicates get merged;
 * this email is the periodic reminder/summary.
 *
 * Usage: npm run crm:audit            (sends the email)
 *        npm run crm:audit -- --dry   (prints to stdout only)
 */
import { config } from "../src/config.js";
import { sendReceptionEmail } from "../src/lib/notify.js";
import { runCrmAudit } from "../src/lib/crmAudit.js";

async function main() {
  const dry = process.argv.includes("--dry");
  const audit = await runCrmAudit();

  const lines: string[] = [];
  lines.push(
    `Audit CRM Wix du ${new Date().toLocaleDateString("fr-FR", { timeZone: config.TIMEZONE })} — ${audit.total} fiches contact.`,
    "",
    "Pourquoi c'est important : Awa reconnaît les clientes par leur numéro WhatsApp.",
    "Une fiche SANS téléphone = abonnement et réservations invisibles pour Awa ;",
    "un même numéro sur PLUSIEURS fiches = Awa refuse de choisir (prudence).",
    "",
    `Le nettoyage des doublons se fait en un clic ici : ${config.BASE_URL}/admin/crm`,
    "",
    `1) FICHES SANS TÉLÉPHONE : ${audit.noPhone.length}`,
    "   → ajouter le numéro WhatsApp de la cliente sur sa fiche Wix.",
  );
  for (const c of audit.noPhone) {
    lines.push(`   - ${c.name}${c.email ? ` — ${c.email}` : ""}`);
  }
  lines.push(
    "",
    `2) NUMÉROS EN DOUBLON (${audit.duplicates.length}) :`,
    `   → fusionner depuis ${config.BASE_URL}/admin/crm (ou Wix → Contacts → Merge).`,
  );
  for (const g of audit.duplicates) {
    lines.push(`   - …${g.key} : ${g.contacts.map((c) => c.name).join(" / ")}`);
  }
  const body = lines.join("\n");
  const subject = `🗂 Hygiène CRM — ${audit.noPhone.length} fiche(s) sans téléphone, ${audit.duplicates.length} numéro(s) en doublon`;

  if (dry) {
    console.log(subject + "\n\n" + body);
    return;
  }
  const ok = await sendReceptionEmail(subject, body);
  console.log(ok ? `Email envoyé à ${config.RECEPTION_EMAIL}.` : "Échec d'envoi de l'email (voir logs).");
  console.log(`(${audit.total} contacts, ${audit.noPhone.length} sans téléphone, ${audit.duplicates.length} doublons)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
