import { normalizeName } from "./notificationRules.js";
import { phoneDigits, type StaffContact } from "./notificationRepo.js";

/**
 * Règles pures des fiches de poste : normalisation des rôles, choix des
 * destinataires, composition du message WhatsApp, rendu du corps en HTML.
 * Aucun accès DB ici — tout est testable sans réseau ni Postgres.
 */

export const MAX_ROLE_LABEL = 60;
export const MAX_FICHE_BODY = 8000;

export interface FicheLike {
  id: string;
  role_label: string;
  role_keys: string;
  body: string;
  published_role_label: string | null;
  published_role_keys: string | null;
  published_body: string | null;
  published_at: Date | null;
}

/**
 * « Cuisine / Bar » → "bar,cuisine". Clés normalisées avec la MÊME fonction que
 * le routage cuisine (normalizeName : NFD, sans accents, minuscules), pour que
 * l'appariement des fiches ne puisse jamais diverger du sien. Dédupliqué et
 * TRIÉ : sans tri, « Cuisine / Bar » et « Bar / Cuisine » produiraient deux CSV
 * différents pour le même ensemble de rôles.
 */
export function normalizeRoleKeys(label: string): string[] {
  const parts = String(label ?? "")
    .split(/[\/,;+&·|]+/)
    .map((p) => normalizeName(p))
    .filter((p) => p.length > 0);
  return [...new Set(parts)].sort();
}

export function parseRoleKeys(csv: string | null): string[] {
  return String(csv ?? "")
    .split(",")
    .map((k) => k.trim())
    .filter((k) => k.length > 0);
}

/** Deux fiches ne doivent jamais se disputer un même rôle. */
export function roleKeysOverlap(a: string[], b: string[]): string[] {
  const setB = new Set(b);
  return a.filter((k) => setB.has(k));
}

export interface FicheRecipients {
  /** Destinataires réels : rôle correspondant, numéro exploitable, dédoublonnés. */
  targets: StaffContact[];
  /** Bon rôle mais numéro absent ou trop court — à corriger dans le répertoire. */
  noPhone: StaffContact[];
  /** Bon rôle et bon numéro, mais en sourdine : exclus du lot, PAS perdus. */
  muted: StaffContact[];
}

/**
 * Qui reçoit cette fiche. On matche sur les clés PUBLIÉES : envoyer selon les
 * clés brouillon livrerait l'artefact publié à un rôle qui n'a jamais été
 * publié avec lui.
 *
 * Les contacts en sourdine sont exclus du lot mais REMONTÉS : la sourdine vise
 * les rappels de cours, pas un message du gérant — les avaler en silence serait
 * un faux « envoyé à toute l'équipe ». La page offre un envoi individuel.
 */
export function matchFicheRecipients(
  contacts: StaffContact[],
  publishedRoleKeys: string | null,
): FicheRecipients {
  const keys = new Set(parseRoleKeys(publishedRoleKeys));
  const out: FicheRecipients = { targets: [], noPhone: [], muted: [] };
  if (keys.size === 0) return out;

  const seen = new Set<string>();
  for (const c of contacts) {
    if (!keys.has(normalizeName(c.role))) continue;
    const digits = phoneDigits(c.phone ?? "");
    if (digits.length < 8) {
      out.noPhone.push(c);
      continue;
    }
    if (seen.has(digits)) continue;
    seen.add(digits);
    if (c.muted) out.muted.push(c);
    else out.targets.push(c);
  }
  return out;
}

/** Un contact est-il TOUJOURS un destinataire légitime de cette fiche ? */
export function contactMatchesFiche(
  contact: StaffContact,
  publishedRoleKeys: string | null,
): boolean {
  return (
    new Set(parseRoleKeys(publishedRoleKeys)).has(normalizeName(contact.role)) &&
    phoneDigits(contact.phone ?? "").length >= 8
  );
}

/** Rôles présents dans le répertoire que AUCUNE fiche ne couvre. */
export function rolesWithoutFiche(
  contacts: StaffContact[],
  fiches: Array<{ role_keys: string }>,
): string[] {
  const covered = new Set(fiches.flatMap((f) => parseRoleKeys(f.role_keys)));
  const missing = new Map<string, string>();
  for (const c of contacts) {
    const key = normalizeName(c.role);
    if (!key || covered.has(key) || missing.has(key)) continue;
    missing.set(key, c.role.trim());
  }
  return [...missing.values()].sort((a, b) => a.localeCompare(b, "fr"));
}

/** Le brouillon diffère-t-il de l'instantané publié, sur l'un des trois champs ? */
export function hasUnpublishedChanges(f: FicheLike): boolean {
  if (f.published_body === null) return false;
  return (
    f.body !== f.published_body ||
    f.role_label !== f.published_role_label ||
    f.role_keys !== f.published_role_keys
  );
}

export function ficheUrl(baseUrl: string, token: string): string {
  return `${String(baseUrl).replace(/\/+$/, "")}/fiche/${token}`;
}

function firstNameOf(name: string): string {
  return String(name ?? "").trim().split(/\s+/)[0] ?? "";
}

function frDate(d: Date | null): string {
  if (!d) return "";
  return new Intl.DateTimeFormat("fr-FR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    timeZone: "Africa/Dakar",
  }).format(d);
}

/**
 * Message court + lien. Le corps DOIT survivre à toTemplateParam (550 car.,
 * retours à la ligne aplatis en " | ") en gardant l'URL intacte : c'est le seul
 * contenu utile du message, tout le reste est sur la page.
 *
 * Pas de « merci de confirmer que tu l'as lue » : sur le chemin template ce
 * texte est enveloppé dans WA_RECEPTION_TEMPLATE, dont le pied fixe dit « merci
 * de ne pas répondre ». Demander un accusé qu'on ne trace pas, dans un message
 * qui interdit de répondre, serait trompeur.
 */
export function buildFicheMessage(input: {
  staffName: string;
  roleLabel: string;
  publishedAt: Date | null;
  url: string;
}): { subject: string; body: string } {
  const prenom = firstNameOf(input.staffName);
  const salutation = prenom ? `Bonjour ${prenom}, ` : "Bonjour, ";
  const maj = input.publishedAt ? ` (mise à jour le ${frDate(input.publishedAt)})` : "";
  return {
    subject: `Fiche de poste — ${input.roleLabel}`.slice(0, 120),
    body:
      `${salutation}voici ta fiche de poste « ${input.roleLabel} » ` +
      `au studio Revive${maj}.\nÀ lire en entier ici : ${input.url}`,
  };
}

// ---------- rendu du corps ----------

function esc(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/**
 * Mini-markdown en LISTE BLANCHE : on échappe d'ABORD, puis on ne reconnaît que
 * paragraphes, puces et listes numérotées. Ni gras, ni lien, ni HTML brut — le
 * corps est saisi par un humain pressé, pas par un auteur de gabarit, et la
 * page publique n'a aucun script pour amortir une injection.
 */
export function renderFicheBodyHtml(text: string): string {
  const lines = String(text ?? "").replace(/\r\n?/g, "\n").split("\n");
  const out: string[] = [];
  let list: "ul" | "ol" | null = null;
  let para: string[] = [];

  const closeList = () => {
    if (list) {
      out.push(`</${list}>`);
      list = null;
    }
  };
  const closePara = () => {
    if (para.length) {
      out.push(`<p>${para.join("<br>")}</p>`);
      para = [];
    }
  };

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) {
      closePara();
      closeList();
      continue;
    }
    const bullet = /^[-*•]\s+(.*)$/.exec(line);
    const numbered = /^\d+[.)]\s+(.*)$/.exec(line);
    if (bullet) {
      closePara();
      if (list !== "ul") {
        closeList();
        out.push("<ul>");
        list = "ul";
      }
      out.push(`<li>${esc(bullet[1])}</li>`);
    } else if (numbered) {
      closePara();
      if (list !== "ol") {
        closeList();
        out.push("<ol>");
        list = "ol";
      }
      out.push(`<li>${esc(numbered[1])}</li>`);
    } else {
      closeList();
      para.push(esc(line));
    }
  }
  closePara();
  closeList();
  return out.join("\n");
}

// ---------- validation de formulaire ----------

export interface FicheFormInput {
  roleLabel: string;
  roleKeys: string;
  body: string;
}

export function parseFicheForm(
  body: Record<string, unknown>,
): FicheFormInput | { error: string } {
  const roleLabel = String(body?.role_label ?? "").trim();
  if (!roleLabel) return { error: "le rôle est obligatoire" };
  if (roleLabel.length > MAX_ROLE_LABEL)
    return { error: `le rôle ne peut pas dépasser ${MAX_ROLE_LABEL} caractères` };

  const keys = normalizeRoleKeys(roleLabel);
  if (keys.length === 0) return { error: "le rôle est obligatoire" };

  const text = String(body?.body ?? "").replace(/\r\n?/g, "\n");
  if (text.length > MAX_FICHE_BODY)
    return { error: `la fiche ne peut pas dépasser ${MAX_FICHE_BODY} caractères` };

  return { roleLabel, roleKeys: keys.join(","), body: text };
}
