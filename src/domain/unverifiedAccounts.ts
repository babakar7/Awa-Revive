import { pool } from "../db/index.js";
import * as wix from "../lib/wix.js";
import { sendText } from "../lib/whatsapp.js";
import { applyFrenchRegister } from "../lib/frenchRegister.js";
import { invalidateMembershipCache } from "../lib/membershipContext.js";
import * as repo from "./repo.js";
import * as links from "./linkRequests.js";
import { backfillBookingContacts } from "./bookingContactBackfill.js";

/**
 * Repli « compte créé sans vérification » pour les NOUVELLES clientes qui
 * abandonnent au milieu de la vérification email (code jamais recopié).
 *
 * Avant : 30 min de silence → NEEDS_RECEPTION + handoff, et la vente restait
 * suspendue à une intervention humaine (Marouche 08/08 : L'Invitée + créneau
 * choisis, email donné, plus rien). Demande de Babakar (08/08) : au bout d'un
 * moment, créer le compte SANS vérification et prévenir la cliente qu'elle
 * peut réserver sa séance — le repli existait déjà à chaud côté outil
 * (`client_declined_verification`), il manquait la version différée.
 *
 * Périmètre STRICT : la voie CRÉATION uniquement (`wix_contact_id` null +
 * email + nom donnés par la cliente). La liaison d'un compte EXISTANT reste
 * escaladée à la réception : sans preuve de la boîte mail, auto-lier
 * offrirait le compte (abonnement, historique) de n'importe qui à n'importe
 * quel numéro. Ici la fiche est neuve et ne possède rien — même modèle de
 * confiance que `client_declined_verification`.
 *
 * Aval : `markLinked` (LINKED + linked_contact_id, par « auto-sans-verification »)
 * rend la preuve visible de `recentlyResolved`/`latestProvenLinkRequest` — le
 * prochain `create_plan_payment_link` passe sans redemander de vérification —
 * et ferme le handoff « Compte non relié » éventuel. Échec Wix → la demande
 * est ÉCARTÉE en silence (DISMISSED), AUCUNE intervention humaine : une
 * cliente qui a abandonné sans payer et dont la création Wix échoue (souvent
 * un contact déjà existant sur cet email/téléphone, ou un aléa Wix) ne donne
 * rien à faire à la réception (décision Babakar 11/08, Pape Alassane). Si elle
 * revient et paie, le flux d'activation payé recrée/rattrape la fiche.
 */

/** Injectable pour les tests d'intégration (pas de vrai Wix/WhatsApp). */
export interface UnverifiedAccountDeps {
  createContact: (args: { name?: string; phone: string; email?: string }) => Promise<string>;
  send: (to: string, body: string) => Promise<string | null>;
}

const defaultDeps: UnverifiedAccountDeps = {
  createContact: (args) => wix.createContact(args),
  send: (to, body) => sendText(to, body),
};

export const AUTO_LINKED_BY = "auto-sans-verification";

/**
 * Délai de silence avant la création sans vérification. 5 min (Babakar
 * 08/08) : le code expire de toute façon à 10 min, et une cliente qui tape
 * son code pendant la création tombe sur « compte déjà prêt » (bénin).
 * Indépendant du STALE_AFTER_MINUTES (30 min) de l'escalade réception, qui
 * ne concerne plus que la liaison d'un compte existant.
 */
export const UNVERIFIED_CREATE_AFTER_MINUTES = 5;

/**
 * Le message proactif : compte créé, PAS de vérification à finir, et la porte
 * ouverte pour reprendre la réservation en cours (l'agent retrouve tout le
 * contexte dès que la cliente répond).
 */
export function unverifiedAccountMessage(email: string, lang: string | null): string {
  if (lang === "en") {
    return (
      `Good news 😊 I've gone ahead and created your Revive account with the email ${email} — ` +
      `no need to finish the email verification, there's nothing else to do.\n\n` +
      `If you'd still like to book your class, just reply here and we'll pick up right where we ` +
      `left off (payment, then confirmation) 🙏🏾`
    );
  }
  return (
    `Bonne nouvelle 😊 J'ai créé ton compte Revive avec l'email ${email} — pas besoin de ` +
    `finir la vérification par code, tu n'as rien d'autre à faire.\n\n` +
    `Si tu veux toujours réserver ta séance, réponds-moi simplement ici et on reprend là où on ` +
    `s'était arrêtées (paiement, puis confirmation) 🙏🏾`
  );
}

interface StaleCreateCandidate {
  id: string;
  claimed_email: string;
  claimed_name: string;
  reception_notified_at: Date | null;
  client_id: string;
  wa_phone: string;
  name: string | null;
  language: string | null;
  fr_register: string | null;
}

/**
 * Sweep (60 s, index.ts — AVANT escalateStaleLinkRequests, qui ne voit donc
 * plus ces lignes) : chaque demande de CRÉATION silencieuse depuis
 * UNVERIFIED_CREATE_AFTER_MINUTES est convertie en compte réel. Renvoie le nombre de
 * comptes créés. Ne lève jamais pour une ligne : un échec bascule cette
 * demande-là vers la réception et la boucle continue.
 */
export async function completeStaleCreateAccountRequests(
  deps: UnverifiedAccountDeps = defaultDeps,
): Promise<number> {
  const res = await pool.query(
    `select lr.id, lr.claimed_email, lr.claimed_name, lr.reception_notified_at,
            c.id as client_id, c.wa_phone, c.name, c.language, c.fr_register
       from link_requests lr
       join clients c on c.id = lr.client_id
      where lr.status = 'AWAITING_CODE'
        and lr.wix_contact_id is null
        and lr.claimed_email is not null
        and lr.claimed_name is not null
        and lr.updated_at < now() - ($1 || ' minutes')::interval`,
    [String(UNVERIFIED_CREATE_AFTER_MINUTES)],
  );
  let created = 0;
  for (const row of res.rows as StaleCreateCandidate[]) {
    // Claim atomique : updated_at repart de zéro, la ligne sort du périmètre
    // « stale » des passes concurrentes/suivantes pendant qu'on travaille.
    const claimed = await pool.query(
      `update link_requests
          set detail = 'création du compte sans vérification (client silencieux)',
              updated_at = now()
        where id = $1 and status = 'AWAITING_CODE'
        returning id`,
      [row.id],
    );
    if ((claimed.rowCount ?? 0) === 0) continue;

    const phone = `+${row.wa_phone.replace(/^\+/, "")}`;
    let contactId: string;
    try {
      contactId = await deps.createContact({
        name: row.claimed_name ?? row.name ?? undefined,
        phone,
        email: row.claimed_email,
      });
    } catch (err) {
      console.error(`Unverified account creation failed for request ${row.id}:`, err);
      // Le client a abandonné sans payer : une création Wix ratée (souvent un
      // contact déjà existant sur cet email/téléphone, ou un aléa Wix) ne
      // justifie AUCUNE intervention humaine — la réception n'a rien à faire
      // pour un prospect qui n'a pas payé (Babakar 11/08, Pape Alassane). On
      // écarte la demande en silence (DISMISSED) : elle sort du périmètre du
      // sweep création ET de l'escalade réception 30 min, et tout handoff
      // « Compte non relié » déjà ouvert est refermé (autoClose). S'il revient
      // et paie, le flux d'activation payé recrée/rattrape la fiche.
      await links.dismiss(row.id, "system-auto");
      continue;
    }

    // LINKED + linked_contact_id : preuve durable côté achat de plan, et
    // fermeture du handoff « Compte non relié » éventuel (autoClose).
    await links.markLinked(row.id, contactId, AUTO_LINKED_BY);
    invalidateMembershipCache(row.client_id);
    void backfillBookingContacts({ clientId: row.client_id, phone, contactId });

    const msg = applyFrenchRegister(
      unverifiedAccountMessage(row.claimed_email, row.language),
      row.language !== "en" && row.fr_register === "vous",
    );
    try {
      await deps.send(row.wa_phone, msg);
      await repo.addTurn(row.client_id, "assistant", msg);
    } catch (err) {
      // Compte créé quand même : au pire l'agent l'annonce au prochain message.
      console.error(`Unverified-account notice failed for client ${row.client_id} (non-blocking):`, err);
    }
    created += 1;
  }
  return created;
}
