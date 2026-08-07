import { pool } from "../db/index.js";
import { sendText } from "../lib/whatsapp.js";
import { applyFrenchRegister } from "../lib/frenchRegister.js";
import * as repo from "./repo.js";

/**
 * Non-livraison des emails de code de vérification (webhook Brevo).
 *
 * Cas réel 05–07/08 (kaeva18@gmail.com) : boîte Gmail PLEINE → chaque code
 * renvoyé rebondissait en silence, la cliente répétait « je n'ai pas reçu »
 * et Awa renvoyait à l'infini vers une boîte morte — vente perdue. Brevo
 * accepte l'envoi (HTTP 201) puis apprend le rebond quelques secondes plus
 * tard : seule la voie webhook nous met au courant.
 *
 * Deux consommateurs :
 *  1. temps réel — un rebond sur l'email d'une demande AWAITING_CODE déclenche
 *     UN message WhatsApp proactif au client (autre email / réessayer /
 *     continuer sans vérification), claim atomique via bounce_notified_at ;
 *  2. côté outil — request_email_verification consulte latestBounce() avant
 *     tout renvoi vers la même adresse et guide le modèle vers le repli
 *     sans-vérification au lieu de renvoyer un code voué au rebond.
 */

export type BounceKind = "inbox_full" | "invalid_address" | "other";

/**
 * Événements Brevo qui signifient « pas livré », après normalisation
 * (minuscules, sans _/-, sans pluriel) : le webhook dit `soft_bounce`, l'API
 * statistiques dit `softBounces` — même événement, deux graphies.
 */
const BOUNCE_EVENTS = new Set(["softbounce", "hardbounce", "blocked", "invalid", "invalidemail", "error"]);

export interface BounceEvent {
  email: string;
  /** Nom d'événement Brevo brut, en minuscules (soft_bounce, blocked…). */
  event: string;
  reason: string | null;
  messageId: string | null;
  /** Idempotence Brevo : un retry relivre le même couple message/événement. */
  dedupKey: string;
}

/**
 * Extrait un événement de rebond d'un item du webhook Brevo. Renvoie null
 * pour tout ce qui n'est pas un rebond (delivered, opened…) ou est malformé —
 * le webhook ignore alors l'item sans erreur (Brevo pousse ce qu'on coche,
 * mais on reste défensif si quelqu'un coche trop large dans le dashboard).
 */
export function parseBounceEvent(raw: unknown): BounceEvent | null {
  if (typeof raw !== "object" || raw === null) return null;
  const item = raw as Record<string, unknown>;
  const event = String(item.event ?? "").trim().toLowerCase();
  const email = String(item.email ?? "").trim().toLowerCase();
  if (!BOUNCE_EVENTS.has(event.replace(/[_-]/g, "").replace(/s$/, ""))) return null;
  if (!email.includes("@")) return null;
  const messageId = typeof item["message-id"] === "string" && item["message-id"]
    ? String(item["message-id"])
    : typeof item.messageId === "string" && item.messageId
      ? String(item.messageId)
      : null;
  const reason = typeof item.reason === "string" && item.reason.trim() ? item.reason.trim() : null;
  const ts = String(item.ts_event ?? item.ts ?? item.date ?? "");
  return {
    email,
    event,
    reason,
    messageId,
    dedupKey: `brevo:${event}:${messageId ?? `${email}:${ts}`}`,
  };
}

/**
 * Pourquoi ça a rebondi, pour adapter le conseil au client. `inbox_full` est
 * le cas qui a motivé tout le chantier (Gmail « out of storage space ») :
 * renvoyer ne sert à rien tant que le client n'a pas fait de place.
 */
export function classifyBounce(event: string, reason: string | null): BounceKind {
  const r = reason ?? "";
  if (/out of storage|over.?quota|quota exceeded|mailbox (is )?full|insufficient .*storage|4\.2\.2/i.test(r)) {
    return "inbox_full";
  }
  if (
    /^hard/.test(event) || /invalid/.test(event) ||
    /unknown user|user unknown|does not exist|no such user|invalid recipient|address rejected|5\.1\.1/i.test(r)
  ) {
    return "invalid_address";
  }
  return "other";
}

/**
 * Le message WhatsApp proactif envoyé au client dont le code vient de
 * rebondir. Toujours les trois issues, dans l'ordre : corriger/autre email →
 * réessayer une fois le problème réglé → continuer SANS vérification (le
 * repli existe déjà côté outils ; Awa reprend la main sur la réponse).
 */
export function bounceClientMessage(kind: BounceKind, email: string, lang: string | null): string {
  if (lang === "en") {
    const why =
      kind === "inbox_full"
        ? `quick heads-up: the email with your code could not be delivered to ${email} — that mailbox is full (no storage left).`
        : kind === "invalid_address"
          ? `quick heads-up: the email with your code bounced — ${email} seems invalid (maybe a typo?).`
          : `quick heads-up: the email with your code could not be delivered to ${email} for now.`;
    return (
      `Ah, ${why} 📩\n\nYou can send me another email address, ` +
      (kind === "inbox_full" ? `free up some space and ask me to resend, ` : `send it again corrected, `) +
      `or we simply continue without the email check — your choice 🙏🏾`
    );
  }
  const why =
    kind === "inbox_full"
      ? `l'email avec ton code n'a pas pu être livré à ${email} : ta boîte mail est pleine (plus d'espace de stockage).`
      : kind === "invalid_address"
        ? `l'email avec ton code n'est pas passé — l'adresse ${email} semble invalide (une faute de frappe peut-être ?).`
        : `l'email avec ton code n'a pas pu être livré à ${email} pour le moment.`;
  return (
    `Petite info : ${why} 📩\n\nTu peux me donner une autre adresse email, ` +
    (kind === "inbox_full"
      ? `libérer un peu d'espace puis me demander de renvoyer le code, `
      : `me la renvoyer corrigée, `) +
    `ou on continue simplement sans la vérification email — comme tu préfères 🙏🏾`
  );
}

// ---------- accès DB ----------

export async function recordBounce(evt: BounceEvent): Promise<void> {
  await pool.query(
    `insert into email_bounces (email, event, reason, message_id) values ($1, $2, $3, $4)`,
    [evt.email, evt.event, evt.reason, evt.messageId],
  );
}

export interface RecordedBounce {
  email: string;
  event: string;
  reason: string | null;
  occurred_at: Date;
}

/**
 * Le rebond le plus récent connu pour cette adresse. 7 jours : assez long
 * pour couvrir un client qui revient « je n'ai rien reçu » deux jours plus
 * tard (cas réel), assez court pour laisser une boîte réparée retenter sans
 * friction éternelle.
 */
export async function latestBounce(email: string, days = 7): Promise<RecordedBounce | null> {
  const res = await pool.query(
    `select email, event, reason, occurred_at from email_bounces
      where email = $1 and occurred_at > now() - ($2 || ' days')::interval
      order by occurred_at desc limit 1`,
    [email.trim().toLowerCase(), String(days)],
  );
  return res.rows[0] ?? null;
}

/**
 * Traite un rebond : l'enregistre, puis — si une vérification AWAITING_CODE
 * attend précisément un code parti vers cette adresse — prévient le client
 * sur WhatsApp (une seule fois par demande, claim atomique). Le client vient
 * de nous écrire il y a quelques secondes, la fenêtre 24h Meta est donc
 * ouverte ; si l'envoi échoue quand même, le rattrapage reste la voie outil
 * (latestBounce) au prochain message du client. Ne lève jamais.
 */
export async function handleBounce(evt: BounceEvent): Promise<void> {
  await recordBounce(evt);
  const res = await pool.query(
    `update link_requests lr
        set bounce_notified_at = now(), updated_at = now()
       from clients c
      where c.id = lr.client_id
        and lr.status = 'AWAITING_CODE'
        and lower(lr.claimed_email) = $1
        and lr.bounce_notified_at is null
      returning lr.client_id, c.wa_phone, c.language, c.fr_register`,
    [evt.email],
  );
  const row = res.rows[0];
  if (!row) return;
  const kind = classifyBounce(evt.event, evt.reason);
  const msg = applyFrenchRegister(
    bounceClientMessage(kind, evt.email, row.language),
    row.language !== "en" && row.fr_register === "vous",
  );
  try {
    await sendText(row.wa_phone, msg);
    await repo.addTurn(row.client_id, "assistant", msg);
  } catch (err) {
    console.error(`Bounce alert to client failed (non-blocking, email ${evt.email}):`, err);
  }
}
