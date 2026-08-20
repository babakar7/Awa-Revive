import { pool } from "../db/index.js";
import * as wix from "../lib/wix.js";

/**
 * Garantit qu'une réservation payée part TOUJOURS avec une fiche contact Wix
 * (plan : WIX-ORPHAN-BOOKINGS-PLAN.md).
 *
 * Historique du trou (cas Penda, 17/08/2026) : `findContactByPhone` renvoie
 * `null` aussi bien quand AUCUN contact ne porte le numéro que quand PLUSIEURS
 * le portent sans que le prénom tranche. Le chemin de réservation traitait les
 * deux pareil — il réservait sans `contactId`. Résultat mesuré sur 01/07→20/08 :
 * 12 réservations d'Awa sur 121 (10 %) orphelines, 9 clientes, dont une revenue
 * 3 fois sans jamais exister dans le CRM ; le tableau de bord Wix les rapproche
 * alors d'un homonyme, et la réception appelle la mauvaise personne.
 *
 * Ici on sépare les deux cas : « aucun contact » ⇒ on crée la fiche ;
 * « ambigu » ⇒ on ne crée SURTOUT pas (ce serait fabriquer un doublon), on
 * réserve comme avant et on marque le trou pour l'admin.
 *
 * Rien de tout ça ne peut faire échouer une réservation : le paiement est déjà
 * encaissé quand on passe ici.
 */

/** Pourquoi une réservation est partie sans fiche (colonne `contact_gap`). */
export type ContactGap = "ambiguous" | "bad_name" | "lookup_failed" | "create_failed";

export type BookingContactPlan =
  | { action: "attach"; contact: wix.WixContactMatch }
  | { action: "create"; name: string }
  | { action: "skip"; gap: ContactGap };

/**
 * Un nom exploitable pour CRÉER une fiche : au moins deux lettres. Le nom de
 * profil WhatsApp peut valoir « A » ou « L » (incident PROGRESS §6.6bis, où un
 * « A » a fini dans Wix) — mieux vaut une réservation sans fiche qu'une fiche
 * permanente nommée « A », qu'aucun rapprochement futur ne saura reconnaître.
 * Les accents, apostrophes et traits d'union sont normaux dans les prénoms
 * d'ici (Marème, N'Diaye, Anne-Marie) ; les emoji ne comptent pas comme lettres.
 */
export function usableContactName(name: string | null | undefined): boolean {
  const letters = String(name ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .match(/\p{Letter}/gu);
  return (letters?.length ?? 0) >= 2;
}

/**
 * Décision pure (testée unitairement) : que faire de la résolution par
 * téléphone avant de réserver.
 */
export function contactPlanForBooking(
  resolution: wix.PhoneContactResolution,
  name: string | null | undefined,
): BookingContactPlan {
  if (resolution.kind === "one") return { action: "attach", contact: resolution.contact };
  if (resolution.kind === "ambiguous") return { action: "skip", gap: "ambiguous" };
  const trimmed = String(name ?? "").trim();
  if (!usableContactName(trimmed)) return { action: "skip", gap: "bad_name" };
  return { action: "create", name: trimmed };
}

export interface BookingContactOutcome {
  /** Fiche à rattacher à la réservation (null = réservation inline, comme avant). */
  contact: wix.WixContactMatch | null;
  /** Renseigné uniquement quand aucune fiche n'a pu être obtenue. */
  gap: ContactGap | null;
  /** Vrai quand la fiche vient d'être créée (utile pour les logs/tests). */
  created: boolean;
}

export interface BookingContactDeps {
  resolve: (phone: string, nameHint?: string) => Promise<wix.PhoneContactResolution>;
  create: (args: { name?: string; phone: string; email?: string }) => Promise<string>;
}

const defaultDeps: BookingContactDeps = {
  resolve: (phone, nameHint) => wix.resolvePhoneContact(phone, nameHint),
  create: (args) => wix.createContact(args),
};

type ContactLog = { info: (o: unknown, m?: string) => void; error: (o: unknown, m?: string) => void };

function lockKey(phone: string): string {
  return `wix-contact:${phone.replace(/\D/g, "")}`;
}

/**
 * Résout — et au besoin crée — la fiche Wix de ce client, puis la mémorise
 * localement. Ne lève JAMAIS : tout échec dégrade vers `{ contact: null }`,
 * c'est-à-dire exactement le comportement d'avant (réservation inline).
 *
 * La création se fait sous verrou consultatif transactionnel keyé sur le
 * numéro, avec re-résolution sous verrou : deux paiements simultanés du même
 * client ne peuvent pas créer deux fiches.
 */
export async function ensureBookingContact(
  args: { clientId: string; phone: string; name?: string | null; email?: string | null },
  deps: BookingContactDeps = defaultDeps,
  log: ContactLog = console,
): Promise<BookingContactOutcome> {
  let plan: BookingContactPlan;
  try {
    plan = contactPlanForBooking(
      await deps.resolve(args.phone, args.name ?? undefined),
      args.name,
    );
  } catch (err) {
    log.error({ err, clientId: args.clientId }, "Wix contact lookup failed before booking");
    return { contact: null, gap: "lookup_failed", created: false };
  }

  if (plan.action === "attach") {
    await rememberContactId(args.clientId, plan.contact.id);
    return { contact: plan.contact, gap: null, created: false };
  }
  if (plan.action === "skip") return { contact: null, gap: plan.gap, created: false };

  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query(`select pg_advisory_xact_lock(hashtext($1))`, [lockKey(args.phone)]);

    // Re-résolution SOUS verrou : une passe concurrente vient peut-être de
    // créer la fiche (deux liens payés à la même seconde).
    const again = contactPlanForBooking(
      await deps.resolve(args.phone, args.name ?? undefined),
      args.name,
    );
    if (again.action === "attach") {
      await client.query("commit");
      await rememberContactId(args.clientId, again.contact.id);
      return { contact: again.contact, gap: null, created: false };
    }
    if (again.action === "skip") {
      await client.query("commit");
      return { contact: null, gap: again.gap, created: false };
    }

    const contactId = await deps.create({
      name: again.name,
      phone: args.phone,
      ...(args.email ? { email: args.email } : {}),
    });
    await client.query(
      `update clients set wix_contact_id = $2, updated_at = now() where id = $1`,
      [args.clientId, contactId],
    );
    await client.query("commit");
    log.info({ clientId: args.clientId, contactId }, "Wix contact created for paid booking");
    return { contact: { id: contactId, fullName: again.name }, gap: null, created: true };
  } catch (err) {
    await client.query("rollback").catch(() => undefined);
    // Fiche non créée (souvent : contact déjà existant sur cet email/téléphone,
    // ou aléa Wix). La réservation part quand même — le paiement est encaissé.
    log.error({ err, clientId: args.clientId }, "Wix contact creation failed before booking");
    return { contact: null, gap: "create_failed", created: false };
  } finally {
    client.release();
  }
}

/** Mémorise l'id de fiche côté local (confort de lecture ; Wix reste la vérité). */
async function rememberContactId(clientId: string, contactId: string): Promise<void> {
  await pool
    .query(
      `update clients set wix_contact_id = $2, updated_at = now()
        where id = $1 and (wix_contact_id is null or wix_contact_id <> $2)`,
      [clientId, contactId],
    )
    .catch(() => undefined);
}
