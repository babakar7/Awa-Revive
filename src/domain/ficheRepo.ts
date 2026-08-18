import { pool } from "../db/index.js";
import { normalizeRoleKeys, parseRoleKeys, roleKeysOverlap } from "./ficheRules.js";

/**
 * SQL des fiches de poste. Publier fige les TROIS champs d'un coup
 * (role_label, role_keys, body) — voir le commentaire de job_fiches dans
 * db/schema.ts. L'admin est le seul écrivain : pas de transaction, comme le
 * reste de la maison (cf. staffPlanningRepo).
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TOKEN_RE = /^[0-9a-f]{32}$/i;

export interface JobFiche {
  id: string;
  role_label: string;
  role_keys: string;
  body: string;
  published_role_label: string | null;
  published_role_keys: string | null;
  published_body: string | null;
  published_at: Date | null;
  public_token: string;
  token_rotated_at: Date | null;
  last_sent_at: Date | null;
  last_sent_count: number;
  updated_at: Date;
  updated_by: string | null;
  created_at: Date;
}

const COLUMNS = `id, role_label, role_keys, body,
  published_role_label, published_role_keys, published_body, published_at,
  public_token, token_rotated_at, last_sent_at, last_sent_count,
  updated_at, updated_by, created_at`;

export async function listFiches(): Promise<JobFiche[]> {
  const res = await pool.query(`select ${COLUMNS} from job_fiches order by role_label`);
  return res.rows as JobFiche[];
}

export async function getFiche(id: string): Promise<JobFiche | null> {
  if (!UUID_RE.test(String(id))) return null;
  const res = await pool.query(`select ${COLUMNS} from job_fiches where id=$1`, [id]);
  return (res.rows[0] as JobFiche) ?? null;
}

/** Le lien public ne sert QUE des fiches publiées — un brouillon est un 404. */
export async function getPublishedFicheByToken(token: string): Promise<JobFiche | null> {
  if (!TOKEN_RE.test(String(token))) return null;
  const res = await pool.query(
    `select ${COLUMNS} from job_fiches where public_token=$1 and published_body is not null`,
    [token],
  );
  return (res.rows[0] as JobFiche) ?? null;
}

/**
 * Aucune fiche ne doit disputer un rôle à une autre : l'index unique sur
 * lower(role_label) ne verrait ni « Cuisine / Bar » vs « Bar / Cuisine », ni
 * deux fiches se recouvrant seulement sur « bar ». Contrôle en TS car les clés
 * sont normalisées en TS (pas d'unaccent garanti côté Postgres).
 */
export async function findRoleConflict(
  roleKeys: string,
  excludeId?: string,
): Promise<{ id: string; role_label: string; keys: string[] } | null> {
  const wanted = parseRoleKeys(roleKeys);
  const res = await pool.query(`select id, role_label, role_keys from job_fiches`);
  for (const row of res.rows as Array<{ id: string; role_label: string; role_keys: string }>) {
    if (excludeId && row.id === excludeId) continue;
    const shared = roleKeysOverlap(wanted, parseRoleKeys(row.role_keys));
    if (shared.length) return { id: row.id, role_label: row.role_label, keys: shared };
  }
  return null;
}

export async function createFiche(input: {
  roleLabel: string;
  roleKeys: string;
  body: string;
  by: string | null;
}): Promise<JobFiche> {
  const res = await pool.query(
    `insert into job_fiches (role_label, role_keys, body, updated_by)
     values ($1,$2,$3,$4) returning ${COLUMNS}`,
    [input.roleLabel, input.roleKeys, input.body, input.by],
  );
  return res.rows[0] as JobFiche;
}

export async function saveDraft(
  id: string,
  input: { roleLabel: string; roleKeys: string; body: string; by: string | null },
): Promise<boolean> {
  if (!UUID_RE.test(String(id))) return false;
  const res = await pool.query(
    `update job_fiches
        set role_label=$2, role_keys=$3, body=$4, updated_by=$5, updated_at=now()
      where id=$1`,
    [id, input.roleLabel, input.roleKeys, input.body, input.by],
  );
  return (res.rowCount ?? 0) > 0;
}

/**
 * Publier = recopier les trois champs du brouillon dans l'instantané. Refuse un
 * corps vide : un lien qui n'affiche rien vaut moins qu'un lien qui n'existe pas.
 */
export async function publishFiche(id: string, by: string | null): Promise<boolean> {
  if (!UUID_RE.test(String(id))) return false;
  const res = await pool.query(
    `update job_fiches
        set published_role_label = role_label,
            published_role_keys  = role_keys,
            published_body       = body,
            published_at = now(), updated_by=$2, updated_at=now()
      where id=$1 and trim(body) <> ''`,
    [id, by],
  );
  return (res.rowCount ?? 0) > 0;
}

/** Dépublier plutôt que supprimer : le lien reste, il répond simplement 404. */
export async function unpublishFiche(id: string, by: string | null): Promise<boolean> {
  if (!UUID_RE.test(String(id))) return false;
  const res = await pool.query(
    `update job_fiches
        set published_role_label=null, published_role_keys=null,
            published_body=null, published_at=null,
            updated_by=$2, updated_at=now()
      where id=$1`,
    [id, by],
  );
  return (res.rowCount ?? 0) > 0;
}

export async function regenerateToken(id: string, by: string | null): Promise<string | null> {
  if (!UUID_RE.test(String(id))) return null;
  const res = await pool.query(
    `update job_fiches
        set public_token = replace(gen_random_uuid()::text, '-', ''),
            token_rotated_at = now(), updated_by=$2, updated_at=now()
      where id=$1 returning public_token`,
    [id, by],
  );
  return (res.rows[0]?.public_token as string) ?? null;
}

export async function markSent(id: string, acceptedCount: number): Promise<void> {
  if (!UUID_RE.test(String(id))) return;
  await pool.query(
    `update job_fiches set last_sent_at=now(), last_sent_count=$2 where id=$1`,
    [id, acceptedCount],
  );
}

/** Refusée si la fiche a déjà été envoyée : des liens circulent déjà. */
export async function deleteFiche(id: string): Promise<boolean> {
  if (!UUID_RE.test(String(id))) return false;
  const res = await pool.query(`delete from job_fiches where id=$1 and last_sent_at is null`, [id]);
  return (res.rowCount ?? 0) > 0;
}

/** Rôles distincts du répertoire, pour le <datalist> de saisie. */
export async function distinctStaffRoles(): Promise<string[]> {
  const res = await pool.query(
    `select distinct role from staff_contacts where coalesce(trim(role),'') <> '' order by role`,
  );
  return res.rows.map((r: any) => r.role as string);
}

export interface FicheSendEntry {
  recipient_phone: string;
  status: string;
  error: string | null;
  created_at: Date;
}

/**
 * Dernier envoi PAR PERSONNE pour CETTE fiche. Le filtre job_fiche_id est
 * indispensable : sur source='fiche_poste' seul, les envois de toutes les
 * fiches se mélangeraient. Ordre déterministe (created_at puis id) — deux
 * lignes peuvent partager l'horodatage dans une même boucle d'envoi.
 */
export async function lastFicheSendByPhone(
  ficheId: string,
): Promise<Map<string, FicheSendEntry>> {
  if (!UUID_RE.test(String(ficheId))) return new Map();
  const res = await pool.query(
    `select distinct on (recipient_phone)
            recipient_phone, status, error, created_at
       from notification_log
      where job_fiche_id = $1 and recipient_phone is not null
      order by recipient_phone, created_at desc, id desc`,
    [ficheId],
  );
  return new Map(
    (res.rows as FicheSendEntry[]).map((r) => [r.recipient_phone.replace(/\D/g, ""), r]),
  );
}

export { normalizeRoleKeys };
