import "dotenv/config";
import { sendReceptionWhatsApp, toTemplateParam } from "../src/lib/notify.js";
import { sendTemplate } from "../src/lib/whatsapp.js";
import { config } from "../src/config.js";

const SUBJECT = "Test de notification — tout fonctionne ✅";
const BODY =
  "Ceci est un message de test envoyé par Awa (bot de réservation WhatsApp).\n\n" +
  "Si vous lisez ceci, les notifications WhatsApp à la réception sont opérationnelles :\n" +
  " • handoffs clients (annulations, plaintes, demandes d'appel)\n" +
  " • remboursements à traiter\n" +
  " • nouveaux clients WhatsApp à relier à un compte existant";

// --template: force the template path (normally only used when the 24h
// window is closed) to verify the approved template end to end.
async function main() {
  const forceTemplate = process.argv.includes("--template");
  console.log(`Sending WhatsApp notification to reception: ${config.RECEPTION_PHONE}`);

  if (forceTemplate) {
    if (!config.WA_RECEPTION_TEMPLATE) {
      console.error("WA_RECEPTION_TEMPLATE is not set — nothing to test.");
      process.exit(1);
    }
    console.log(
      `Forcing template "${config.WA_RECEPTION_TEMPLATE}" (${config.WA_RECEPTION_TEMPLATE_LANG})`,
    );
    await sendTemplate(
      config.RECEPTION_PHONE.replace(/\D/g, ""),
      config.WA_RECEPTION_TEMPLATE,
      config.WA_RECEPTION_TEMPLATE_LANG,
      [toTemplateParam(SUBJECT, 120), toTemplateParam(BODY)],
    );
  } else {
    await sendReceptionWhatsApp(SUBJECT, BODY);
  }
  console.log("Test WhatsApp notification sent: OK");
}

main().catch((e) => {
  console.error("WHATSAPP SEND FAILED:", e?.message ?? e);
  console.error(
    "Si l'erreur contient le code 131047, la fenêtre de 24h est fermée et aucun " +
      "template de secours n'est configuré (WA_RECEPTION_TEMPLATE). " +
      "Si elle contient 132001, le template n'existe pas ou n'est pas encore approuvé.",
  );
  process.exit(1);
});
