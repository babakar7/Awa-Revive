/**
 * Rattrapage des réservations Wix payées parties SANS fiche contact
 * (WIX-ORPHAN-BOOKINGS-PLAN.md §6).
 *
 * Le flux de paiement crée désormais la fiche manquante avant de réserver, mais
 * les réservations d'avant restent orphelines : elles n'apparaissent dans
 * l'historique d'aucune fiche, et le tableau de bord Wix les rapproche d'une
 * homonyme (cas Penda, 17/08/2026 — la liste de participants affichait le
 * numéro d'une autre Penda de septembre 2025).
 *
 * Pour chaque cliente ayant au moins une réservation orpheline :
 *   - fiche unique trouvée      → rattachement (backfill existant, PATCH Wix)
 *   - aucune fiche + nom correct → création de la fiche PUIS rattachement
 *   - plusieurs fiches (ambigu)  → LISTÉ, jamais traité (ce serait un doublon :
 *     à fusionner d'abord dans /admin/crm § Doublons)
 *   - nom inexploitable          → LISTÉ (« A », « L » : une fiche nommée ainsi
 *     ne serait jamais reconnue ensuite)
 *
 * Idempotent : une réservation déjà rattachée n'est plus candidate.
 *
 * Usage : railway run npx tsx scripts/backfill-orphan-booking-contacts.ts        (dry-run)
 *         railway run npx tsx scripts/backfill-orphan-booking-contacts.ts --apply
 *         …--apply --phone=+221789580984   (limiter à une cliente)
 */
import { execFileSync } from "node:child_process";

try {
  const out = execFileSync("railway", ["variables", "--service", "Postgres", "--json"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const publicUrl = JSON.parse(out)?.DATABASE_PUBLIC_URL;
  if (typeof publicUrl === "string" && /^postgres(?:ql)?:\/\//.test(publicUrl)) {
    process.env.DATABASE_URL = publicUrl;
  }
} catch {
  // Pas de CLI Railway (exécution serveur) — on garde le DATABASE_URL injecté.
}

const APPLY = process.argv.includes("--apply");
const ONLY_PHONE = process.argv.find((a) => a.startsWith("--phone="))?.slice("--phone=".length);
const LOOKBACK_DAYS = Number(
  process.argv.find((a) => a.startsWith("--days="))?.slice("--days=".length) ?? 90,
);
const PACE_MS = 400;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Candidate {
  clientId: string;
  name: string | null;
  phone: string;
  bookingIds: string[];
}

async function main() {
  const { pool, closeDb } = await import("../src/db/index.js");
  const wix = await import("../src/lib/wix.js");
  const { contactPlanForBooking } = await import("../src/domain/bookingContact.js");
  const { backfillBookingContacts } = await import("../src/domain/bookingContactBackfill.js");

  const { rows } = await pool.query<{
    client_id: string;
    name: string | null;
    wa_phone: string;
    booking_ids: string[];
  }>(
    `select pb.client_id, c.name, c.wa_phone, array_agg(pb.wix_booking_id) booking_ids
       from pending_bookings pb
       join clients c on c.id = pb.client_id
      where pb.status = 'BOOKED'
        and pb.wix_booking_id is not null
        and pb.created_at > now() - ($1 || ' days')::interval
        and coalesce(c.is_test, false) = false
        and ($2::text is null or c.wa_phone like '%' || $2 || '%')
      group by pb.client_id, c.name, c.wa_phone`,
    [String(LOOKBACK_DAYS), ONLY_PHONE ? ONLY_PHONE.replace(/\D/g, "") : null],
  );

  console.log(
    `${rows.length} cliente(s) avec des réservations des ${LOOKBACK_DAYS} derniers jours` +
      `${APPLY ? "" : " — DRY RUN, aucune écriture"}\n`,
  );

  // 1. Qui a au moins une réservation orpheline côté Wix ?
  const candidates: Candidate[] = [];
  for (const row of rows) {
    try {
      const snaps = await wix.getBookingContactSnapshots(row.booking_ids.slice(0, 25));
      const orphans = snaps.filter((s) => !s.contactId).map((s) => s.bookingId);
      if (orphans.length > 0) {
        candidates.push({
          clientId: row.client_id,
          name: row.name,
          phone: `+${row.wa_phone.replace(/^\+/, "")}`,
          bookingIds: orphans,
        });
      }
    } catch (err) {
      console.error(`  ⚠️  lecture Wix impossible pour ${row.wa_phone}:`, (err as Error).message);
    }
    await sleep(PACE_MS);
  }

  console.log(`${candidates.length} cliente(s) avec au moins une réservation sans fiche.\n`);

  // 2. Décider, puis (si --apply) réparer.
  const skipped: string[] = [];
  let created = 0;
  let attached = 0;
  let repaired = 0;

  for (const cand of candidates) {
    const label = `${cand.name ?? "(sans nom)"} ${cand.phone} — ${cand.bookingIds.length} résa(s)`;
    let plan;
    try {
      plan = contactPlanForBooking(
        await wix.resolvePhoneContact(cand.phone, cand.name ?? undefined),
        cand.name,
      );
    } catch (err) {
      console.log(`  ⏭️  ${label} : lecture Wix en échec (${(err as Error).message})`);
      skipped.push(label);
      continue;
    }

    if (plan.action === "skip") {
      const why =
        plan.gap === "ambiguous"
          ? "plusieurs fiches portent ce numéro → fusionner d'abord (/admin/crm)"
          : "nom inexploitable → compléter le prénom d'abord";
      console.log(`  ⏭️  ${label} : ${why}`);
      skipped.push(`${label} — ${why}`);
      continue;
    }

    let contactId: string;
    if (plan.action === "attach") {
      contactId = plan.contact.id;
      console.log(`  🔗 ${label} : fiche existante ${contactId}`);
      attached += 1;
    } else {
      if (!APPLY) {
        console.log(`  ➕ ${label} : fiche à CRÉER (« ${plan.name} »)`);
        created += 1;
        continue;
      }
      contactId = await wix.createContact({ name: plan.name, phone: cand.phone });
      console.log(`  ➕ ${label} : fiche créée ${contactId}`);
      created += 1;
      await pool
        .query(`update clients set wix_contact_id = $2, updated_at = now() where id = $1`, [
          cand.clientId,
          contactId,
        ])
        .catch(() => undefined);
    }

    if (!APPLY) continue;
    const res = await backfillBookingContacts({
      clientId: cand.clientId,
      phone: cand.phone,
      contactId,
    });
    repaired += res.repaired;
    console.log(`     ↳ ${res.repaired} réservation(s) rattachée(s), ${res.failed} échec(s)`);
    await pool
      .query(`update pending_bookings set contact_gap = null where client_id = $1`, [cand.clientId])
      .catch(() => undefined);
    await sleep(PACE_MS);
  }

  console.log(
    `\n${APPLY ? "Terminé" : "DRY RUN"} — fiches créées: ${created}, fiches retrouvées: ` +
      `${attached}, réservations rattachées: ${repaired}, laissées de côté: ${skipped.length}`,
  );
  if (skipped.length) {
    console.log("\nÀ traiter à la main :");
    for (const s of skipped) console.log(`  · ${s}`);
  }
  await closeDb();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
