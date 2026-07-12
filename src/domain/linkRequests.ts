import crypto from "node:crypto";
import { config } from "../config.js";
import { pool } from "../db/index.js";
import { notifyReception } from "../lib/notify.js";
import * as repo from "./repo.js";

/**
 * Liaison d'un numéro WhatsApp à une fiche Wix existante (cas
 * Dieynaba/Rokhaya : la fiche qui porte l'abonnement est enregistrée sous un
 * AUTRE numéro). Deux voies, dans l'ordre :
 *  1. self-service — un code 6 chiffres envoyé à l'email de la fiche, que le
 *     client recopie sur WhatsApp (la preuve = l'accès à la boîte mail) ;
 *  2. repli réception — file « Liaisons en attente » sur /admin/crm, liaison
 *     en 1 clic.
 * Une seule demande OUVERTE par client (index partiel) : chaque nouvelle
 * tentative réutilise la même ligne, la file admin reste propre.
 *
 * Sécurité : le code n'existe qu'en sha256(code:id) en DB et ne transite que
 * par l'email — jamais dans un résultat d'outil (le modèle ne peut donc pas
 * le divulguer, même sous prompt-injection).
 */

export type LinkRequestStatus =
  | "AWAITING_EMAIL"
  | "AWAITING_CODE"
  | "VERIFIED"
  | "NEEDS_RECEPTION"
  | "LINKED"
  | "DISMISSED";

export interface LinkRequest {
  id: string;
  client_id: string;
  claimed_email: string | null;
  /** Name the client gave for a NEW account (only set on the create-account
   *  path, where wix_contact_id stays null until the fiche is created). */
  claimed_name: string | null;
  /** The proven existing fiche to attach to; null on the create-account path
   *  (no fiche yet — one is created at submit_verification_code time). */
  wix_contact_id: string | null;
  code_hash: string | null;
  code_expires_at: Date | null;
  attempts: number;
  emails_sent: number;
  status: LinkRequestStatus;
  detail: string | null;
  reception_notified_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export const CODE_TTL_MINUTES = 10;
export const MAX_CODE_ATTEMPTS = 5;
export const MAX_EMAILS_PER_DAY = 3;
/** Une demande AWAITING_* silencieuse plus vieille que ça part en réception. */
export const STALE_AFTER_MINUTES = 30;

const OPEN_STATUSES = "('AWAITING_EMAIL','AWAITING_CODE','NEEDS_RECEPTION')";

// ---------- helpers purs (testables sans DB) ----------

export function generateCode(): string {
  return crypto.randomInt(0, 1_000_000).toString().padStart(6, "0");
}

export function hashCode(code: string, requestId: string): string {
  return crypto.createHash("sha256").update(`${code}:${requestId}`).digest("hex");
}

export function verifyCode(code: string, requestId: string, storedHash: string): boolean {
  const a = Buffer.from(hashCode(code, requestId), "hex");
  const b = Buffer.from(storedHash, "hex");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** Un code de vérification plausible dans un message client : 6 chiffres. */
export function looksLikeCode(text: string): boolean {
  return /^\d{6}$/.test(text.trim());
}

// ---------- accès DB ----------

export async function getOpen(clientId: string): Promise<LinkRequest | null> {
  const res = await pool.query(
    `select * from link_requests where client_id = $1 and status in ${OPEN_STATUSES}`,
    [clientId],
  );
  return res.rows[0] ?? null;
}

/** La demande ouverte du client, créée en AWAITING_EMAIL si aucune. */
export async function getOrOpen(clientId: string): Promise<LinkRequest> {
  const existing = await getOpen(clientId);
  if (existing) return existing;
  const res = await pool.query(
    `insert into link_requests (client_id) values ($1)
     on conflict (client_id) where status in ${OPEN_STATUSES} do nothing
     returning *`,
    [clientId],
  );
  return res.rows[0] ?? (await getOpen(clientId))!;
}

/**
 * Un code vient d'être envoyé : passe (ou repasse) la demande en
 * AWAITING_CODE. Le compteur d'emails se remet à 1 après 24h d'inactivité —
 * un client légitime peut réessayer le lendemain sans intervention.
 */
export async function setAwaitingCode(
  id: string,
  email: string,
  wixContactId: string | null,
  codeHash: string,
  claimedName?: string | null,
): Promise<void> {
  await pool.query(
    `update link_requests
        set status = 'AWAITING_CODE', claimed_email = $2, wix_contact_id = $3,
            code_hash = $4, code_expires_at = now() + ($5 || ' minutes')::interval,
            claimed_name = coalesce($6, claimed_name),
            attempts = 0, detail = null,
            emails_sent = case when updated_at < now() - interval '24 hours'
                               then 1 else emails_sent + 1 end,
            updated_at = now()
      where id = $1`,
    [id, email, wixContactId, codeHash, String(CODE_TTL_MINUTES), claimedName ?? null],
  );
}

/** true = le client peut encore recevoir un code (quota 24h non atteint). */
export function canSendCode(request: LinkRequest): boolean {
  const staleDay = request.updated_at < new Date(Date.now() - 24 * 3600 * 1000);
  return staleDay || request.emails_sent < MAX_EMAILS_PER_DAY;
}

/** Incrémente le compteur d'essais et renvoie sa nouvelle valeur. */
export async function registerFailedAttempt(id: string): Promise<number> {
  const res = await pool.query(
    `update link_requests set attempts = attempts + 1, updated_at = now()
      where id = $1 returning attempts`,
    [id],
  );
  return res.rows[0]?.attempts ?? MAX_CODE_ATTEMPTS;
}

export async function markVerified(id: string, contactId: string): Promise<void> {
  await pool.query(
    `update link_requests
        set status = 'VERIFIED', linked_contact_id = $2, linked_by = 'client',
            code_hash = null, updated_at = now()
      where id = $1`,
    [id, contactId],
  );
}

export async function markNeedsReception(id: string, detail: string): Promise<void> {
  await pool.query(
    `update link_requests
        set status = 'NEEDS_RECEPTION', detail = $2, code_hash = null, updated_at = now()
      where id = $1`,
    [id, detail],
  );
}

export async function markLinked(
  id: string,
  contactId: string,
  adminUser: string,
): Promise<void> {
  await pool.query(
    `update link_requests
        set status = 'LINKED', linked_contact_id = $2, linked_by = $3, updated_at = now()
      where id = $1`,
    [id, contactId, adminUser],
  );
}

export async function dismiss(id: string, adminUser: string): Promise<void> {
  await pool.query(
    `update link_requests
        set status = 'DISMISSED', linked_by = $2, updated_at = now()
      where id = $1`,
    [id, adminUser],
  );
}

export interface ReceptionQueueEntry extends LinkRequest {
  wa_phone: string;
  client_name: string | null;
  client_claimed_email: string | null;
}

/** File « Liaisons en attente » du dashboard, la plus ancienne d'abord. */
export async function receptionQueue(): Promise<ReceptionQueueEntry[]> {
  const res = await pool.query(
    `select lr.*, c.wa_phone, c.name as client_name, c.claimed_email as client_claimed_email
       from link_requests lr join clients c on c.id = lr.client_id
      where lr.status = 'NEEDS_RECEPTION'
      order by lr.created_at asc`,
  );
  return res.rows;
}

export async function getByIdForAdmin(id: string): Promise<ReceptionQueueEntry | null> {
  const res = await pool.query(
    `select lr.*, c.wa_phone, c.name as client_name, c.claimed_email as client_claimed_email
       from link_requests lr join clients c on c.id = lr.client_id
      where lr.id = $1`,
    [id],
  );
  return res.rows[0] ?? null;
}

// ---------- notification réception (voie de repli) ----------

const HANDOFF_PREFIX = "Abonnement introuvable — client affirme en avoir un";

/**
 * Préviens la réception qu'une liaison attend dans le dashboard. Dédup à deux
 * niveaux : reception_notified_at sur la demande (une notif par demande) et
 * le registre handoffs 24h par client (un client qui insiste ne spamme pas).
 * Ne lève jamais — une notif ratée ne doit pas casser la réponse au client.
 */
export async function notifyLinkNeedsReception(
  request: Pick<LinkRequest, "id" | "client_id" | "reception_notified_at">,
  client: { name: string | null; wa_phone: string },
  detail: string,
): Promise<void> {
  try {
    if (request.reception_notified_at) return;
    await pool.query(
      `update link_requests set reception_notified_at = now(), updated_at = now()
        where id = $1 and reception_notified_at is null`,
      [request.id],
    );
    if (await repo.recentHandoffExists(request.client_id, HANDOFF_PREFIX, 24)) return;
    await repo.recordHandoff(request.client_id, `${HANDOFF_PREFIX} (${detail})`);
    notifyReception(
      "🔗 Liaison de compte en attente — 1 clic dans le dashboard",
      `Un client affirme avoir un abonnement/compte, mais Awa ne peut pas le relier : ${detail}.\n` +
        `  Client : ${client.name ?? "?"} (+${client.wa_phone.replace(/^\+/, "")})\n\n` +
        `À faire (1 clic) : ${config.BASE_URL}/admin/crm → section « Liaisons en attente » → ` +
        `vérifier la fiche proposée puis « Lier cette fiche ». Awa reconnaîtra son abonnement ` +
        `immédiatement.\n\n` +
        `Awa a prévenu le client que l'équipe s'en occupe.`,
    );
  } catch (err) {
    console.error(`Link-request notification failed for request ${request.id} (non-blocking):`, err);
  }
}

/**
 * Sweep (60 s, index.ts) : les demandes AWAITING_* silencieuses depuis plus
 * de STALE_AFTER_MINUTES basculent en NEEDS_RECEPTION + notif — le cas
 * Dieynaba « merci puis disparaît » ne se perd plus, même après un restart.
 */
export async function escalateStaleLinkRequests(): Promise<number> {
  const res = await pool.query(
    `update link_requests lr
        set status = 'NEEDS_RECEPTION',
            detail = coalesce(lr.detail, 'client silencieux — vérification email jamais aboutie'),
            code_hash = null, updated_at = now()
       from clients c
      where c.id = lr.client_id
        and lr.status in ('AWAITING_EMAIL','AWAITING_CODE')
        and lr.updated_at < now() - ($1 || ' minutes')::interval
      returning lr.id, lr.client_id, lr.reception_notified_at, lr.detail,
                c.name, c.wa_phone`,
    [String(STALE_AFTER_MINUTES)],
  );
  for (const row of res.rows) {
    await notifyLinkNeedsReception(
      { id: row.id, client_id: row.client_id, reception_notified_at: row.reception_notified_at },
      { name: row.name, wa_phone: row.wa_phone },
      row.detail,
    );
  }
  return res.rowCount ?? 0;
}
