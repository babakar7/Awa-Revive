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
import { auditActiveSubscribers, auditContacts, fetchAllContacts } from "../src/lib/crmAudit.js";
import { listAllActiveOrders, phoneMatchVariants } from "../src/lib/wix.js";

async function main() {
  const dry = process.argv.includes("--dry");
  const [rawContacts, orders] = await Promise.all([fetchAllContacts(), listAllActiveOrders()]);
  const audit = auditContacts(rawContacts);
  const unreachable = auditActiveSubscribers(orders, rawContacts, phoneMatchVariants);

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
    `1) ABONNÉES ACTIVES INJOIGNABLES : ${unreachable.length} — LA priorité`,
    "   → elles paient un abonnement mais Awa ne peut pas les reconnaître :",
    "     ajouter leur numéro WhatsApp (+221...) sur leur fiche Wix.",
  );
  for (const u of unreachable) {
    const why =
      u.issue === "no_phone"
        ? "aucun téléphone"
        : u.issue === "phone_unmatchable"
          ? `numéro mal formaté (${(u.contact?.phones ?? []).join(", ")})`
          : "fiche introuvable";
    lines.push(
      `   - ${u.contact?.name ?? u.contactId} — ${u.plans.map((p) => p.planName).join(" · ")} — ${why}`,
    );
  }
  lines.push(
    "",
    `2) FICHES SANS TÉLÉPHONE : ${audit.noPhone.length}`,
    "   → ajouter le numéro WhatsApp de la cliente sur sa fiche Wix.",
  );
  for (const c of audit.noPhone) {
    lines.push(`   - ${c.name}${c.email ? ` — ${c.email}` : ""}`);
  }
  lines.push(
    "",
    `3) NUMÉROS EN DOUBLON (${audit.duplicates.length}) :`,
    `   → fusionner depuis ${config.BASE_URL}/admin/crm (ou Wix → Contacts → Merge).`,
  );
  for (const g of audit.duplicates) {
    lines.push(`   - …${g.key} : ${g.contacts.map((c) => c.name).join(" / ")}`);
  }
  const body = lines.join("\n");
  const subject = `🗂 Hygiène CRM — ${unreachable.length} abonnée(s) injoignable(s), ${audit.noPhone.length} fiche(s) sans téléphone, ${audit.duplicates.length} doublon(s)`;

  if (dry) {
    console.log(subject + "\n\n" + body);
    return;
  }
  const ok = await sendReceptionEmail(subject, body);
  console.log(ok ? `Email envoyé à ${config.RECEPTION_EMAIL}.` : "Échec d'envoi de l'email (voir logs).");
  console.log(
    `(${audit.total} contacts, ${unreachable.length} abonnées injoignables, ${audit.noPhone.length} sans téléphone, ${audit.duplicates.length} doublons)`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
