import "dotenv/config";
import { sendReceptionEmail, emailNotificationsEnabled } from "../src/lib/notify.js";
import { config } from "../src/config.js";

async function main() {
  if (!emailNotificationsEnabled()) {
    console.error("BREVO_API_KEY is not set — nothing to test.");
    process.exit(1);
  }
  console.log(`Sending via Brevo: ${config.EMAIL_FROM} → ${config.RECEPTION_EMAIL}`);

  await sendReceptionEmail(
    "Test de notification — tout fonctionne ✅",
    "Ceci est un email de test envoyé par Awa (bot de réservation WhatsApp).\n\n" +
      "Si vous lisez ceci, les notifications automatiques à la réception sont opérationnelles :\n" +
      " • handoffs clients (annulations, plaintes, demandes d'appel)\n" +
      " • remboursements à traiter\n" +
      " • nouveaux clients WhatsApp à relier à un compte existant",
  );
  console.log("Test email sent: OK");
}

main().catch((e) => {
  console.error("BREVO SEND FAILED:", e?.message ?? e);
  process.exit(1);
});
