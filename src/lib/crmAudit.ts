import { config } from "../config.js";

/**
 * CRM hygiene audit, shared by `npm run crm:audit` (email to reception) and
 * the /admin/crm page (interactive cleanup). Awa recognizes clients by their
 * WhatsApp number: a Wix contact without a phone can never be matched, and
 * two contacts sharing one number make Awa refuse to choose (deliberate
 * caution) — both lists exist to be emptied.
 */

export interface AuditContact {
  id: string;
  name: string;
  email: string | null;
  phones: string[]; // stored spellings, verbatim
  hasE164: boolean;
  createdDate: string | null;
}

export interface DuplicateGroup {
  /** Normalized digits shared by the group (senegalese → last 9 digits). */
  key: string;
  contacts: AuditContact[];
}

export interface CrmAudit {
  total: number;
  noPhone: AuditContact[];
  duplicates: DuplicateGroup[];
}

function headers(): Record<string, string> {
  return {
    Authorization: config.WIX_API_KEY,
    "wix-site-id": config.WIX_SITE_ID,
    "Content-Type": "application/json",
  };
}

function toAuditContact(c: any): AuditContact {
  const phones: any[] = c?.info?.phones?.items ?? [];
  return {
    id: c.id,
    name:
      [c?.info?.name?.first, c?.info?.name?.last].filter(Boolean).join(" ").trim() ||
      "(sans nom)",
    email: c?.info?.emails?.items?.[0]?.email ?? null,
    phones: phones.map((p) => String(p?.e164Phone ?? p?.phone ?? "")).filter(Boolean),
    hasE164: phones.some((p) => typeof p?.e164Phone === "string" && p.e164Phone.length > 5),
    createdDate: c?.createdDate ?? null,
  };
}

/** Normalize any spelling to comparable digits (senegalese → last 9 digits). */
export function phoneKey(spelling: string): string | null {
  const digits = spelling.replace(/\D/g, "");
  if (digits.length < 7) return null;
  return digits.length >= 9 ? digits.slice(-9) : digits;
}

export async function fetchAllContacts(): Promise<any[]> {
  const all: any[] = [];
  for (let offset = 0; offset < 5000; offset += 100) {
    const res = await fetch("https://www.wixapis.com/contacts/v4/contacts/query", {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ query: { paging: { limit: 100, offset } } }),
    });
    if (!res.ok) throw new Error(`contacts query failed (${res.status}): ${await res.text()}`);
    const data: any = await res.json();
    const batch: any[] = data?.contacts ?? [];
    all.push(...batch);
    if (batch.length < 100) break;
  }
  return all;
}

/** Pure classification — testable without network. Takes raw Wix contacts. */
export function auditContacts(rawContacts: any[]): CrmAudit {
  const noPhone: AuditContact[] = [];
  const byPhone = new Map<string, AuditContact[]>();
  for (const raw of rawContacts) {
    const c = toAuditContact(raw);
    if (c.phones.length === 0) {
      noPhone.push(c);
      continue;
    }
    for (const spelling of c.phones) {
      const key = phoneKey(spelling);
      if (!key) continue;
      const list = byPhone.get(key) ?? [];
      if (!list.some((x) => x.id === c.id)) list.push(c);
      byPhone.set(key, list);
    }
  }
  const duplicates = [...byPhone.entries()]
    .filter(([, cs]) => cs.length > 1)
    .map(([key, contacts]) => ({ key, contacts }))
    .sort((a, b) => b.contacts.length - a.contacts.length);
  return { total: rawContacts.length, noPhone, duplicates };
}

export async function runCrmAudit(): Promise<CrmAudit> {
  return auditContacts(await fetchAllContacts());
}

/**
 * Which fiche of a duplicate group survives a merge — same rule for display
 * (GET /admin/crm) and enforcement (POST, recomputed server-side):
 *   1. the fiche holding an active abonnement (Wix doesn't guarantee a plan
 *      survives being merged INTO another fiche — so the plan holder stays),
 *   2. else a fiche whose number is stored in e164 (matchable as-is),
 *   3. else the oldest fiche (longest history).
 * Returns null when SEVERAL fiches hold plans — that merge is blocked.
 */
export function pickMergeTarget(
  contacts: Pick<AuditContact, "id" | "hasE164" | "createdDate">[],
  planHolderIds: Set<string>,
): string | null {
  const holders = contacts.filter((c) => planHolderIds.has(c.id));
  if (holders.length > 1) return null;
  if (holders.length === 1) return holders[0].id;
  const byAge = (a: (typeof contacts)[number], b: (typeof contacts)[number]) =>
    Date.parse(a.createdDate ?? "9999-12-31") - Date.parse(b.createdDate ?? "9999-12-31");
  const e164 = contacts.filter((c) => c.hasE164).sort(byAge);
  if (e164.length > 0) return e164[0].id;
  return [...contacts].sort(byAge)[0]?.id ?? null;
}
