import { pool } from "../db/index.js";
import {
  formatQuoteNumber,
  isQuoteStatus,
  type QuoteFormData,
  type QuoteItem,
  type QuoteStatus,
} from "./quoteRules.js";

/**
 * SQL for event quotes ("devis"). Numbering is a per-year atomic counter in
 * app_state (single ON CONFLICT statement = atomic in PG — the house style, no
 * transactions in src/). Unlike invoices, a quote IS editable and re-generable
 * (it is not an accounting document): updateQuote/setQuoteStatus mutate it, but
 * the number and issued_on never change.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface Quote {
  id: string;
  number: string;
  client_name: string;
  client_company: string | null;
  client_role: string | null;
  client_phone: string | null;
  event_title: string;
  description: string | null;
  event_date: Date | null;
  event_time: string | null;
  participants: string | null;
  location: string;
  items_json: unknown;
  conditions: string;
  validity_days: number;
  issued_on: Date;
  status: QuoteStatus;
  created_by: string | null;
  created_at: Date;
  updated_at: Date;
}

/** Defensive parse of the stored JSONB back into typed lines. */
export function quoteItems(q: Quote): QuoteItem[] {
  const raw = Array.isArray(q.items_json) ? q.items_json : [];
  return raw
    .filter((i: any) => typeof i?.label === "string")
    .map((i: any) => ({
      label: String(i.label),
      detail: i?.detail == null ? null : String(i.detail),
      amount_xof: Number.isFinite(i?.amount_xof) ? Number(i.amount_xof) : null,
    }));
}

/**
 * Mint the next DEV-YYYY-NNNN. Atomic per-year counter: the single ON CONFLICT
 * statement takes the row lock, so concurrent creations never collide. Dakar is
 * UTC year-round, so getUTCFullYear() is the studio's calendar year.
 */
export async function nextQuoteNumber(now = new Date()): Promise<string> {
  const year = now.getUTCFullYear();
  const res = await pool.query(
    `insert into app_state (key, value) values ($1, '1')
       on conflict (key) do update
         set value = ((app_state.value)::int + 1)::text, updated_at = now()
     returning value`,
    [`quote_seq_${year}`],
  );
  return formatQuoteNumber(year, Number(res.rows[0].value));
}

/** Mint a number then insert. A fault between the two burns a number (harmless
 *  gap) — acceptable, keeps numbering strictly increasing. */
export async function createQuote(
  data: QuoteFormData,
  createdBy: string | null,
): Promise<Quote> {
  const number = await nextQuoteNumber();
  const res = await pool.query(
    `insert into quotes
       (number, client_name, client_company, client_role, client_phone,
        event_title, description, event_date, event_time, participants,
        location, items_json, conditions, validity_days, created_by)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
     returning *`,
    [
      number,
      data.client_name,
      data.client_company,
      data.client_role,
      data.client_phone,
      data.event_title,
      data.description,
      data.event_date,
      data.event_time,
      data.participants,
      data.location,
      JSON.stringify(data.items),
      data.conditions,
      data.validity_days,
      createdBy,
    ],
  );
  return res.rows[0] as Quote;
}

/** Update every editable field (number and issued_on stay put). */
export async function updateQuote(id: string, data: QuoteFormData): Promise<Quote | null> {
  if (!UUID_RE.test(String(id))) return null;
  const res = await pool.query(
    `update quotes set
       client_name = $2, client_company = $3, client_role = $4, client_phone = $5,
       event_title = $6, description = $7, event_date = $8, event_time = $9,
       participants = $10, location = $11, items_json = $12, conditions = $13,
       validity_days = $14, updated_at = now()
     where id = $1
     returning *`,
    [
      id,
      data.client_name,
      data.client_company,
      data.client_role,
      data.client_phone,
      data.event_title,
      data.description,
      data.event_date,
      data.event_time,
      data.participants,
      data.location,
      JSON.stringify(data.items),
      data.conditions,
      data.validity_days,
    ],
  );
  return (res.rows[0] as Quote) ?? null;
}

export async function setQuoteStatus(id: string, status: string): Promise<boolean> {
  if (!UUID_RE.test(String(id)) || !isQuoteStatus(status)) return false;
  const res = await pool.query(
    `update quotes set status = $2, updated_at = now() where id = $1`,
    [id, status],
  );
  return (res.rowCount ?? 0) > 0;
}

export async function findQuote(id: string): Promise<Quote | null> {
  if (!UUID_RE.test(String(id))) return null;
  const res = await pool.query(`select * from quotes where id = $1`, [id]);
  return (res.rows[0] as Quote) ?? null;
}

export async function listQuotes(limit = 100): Promise<Quote[]> {
  const res = await pool.query(`select * from quotes order by created_at desc limit $1`, [limit]);
  return res.rows as Quote[];
}
