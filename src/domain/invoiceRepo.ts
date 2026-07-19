import { pool } from "../db/index.js";
import { extrasFromJson, type ExtraLine } from "../lib/cafeMenu.js";
import { paymentMethodLabel } from "../lib/paymentMethod.js";
import { formatInvoiceNumber, type InvoiceLine } from "./invoiceRules.js";

/**
 * SQL for reception invoices. Numbering is a per-year atomic counter in
 * app_state (single ON CONFLICT statement = atomic in PG — the house style, no
 * transactions anywhere in src/). Invoices are immutable once created: no update
 * or delete. The only mutation is markInvoiceSent, which records the WhatsApp
 * delivery outcome, not the invoice content.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface Invoice {
  id: string;
  number: string;
  client_name: string;
  client_phone: string | null;
  client_ref: string | null;
  lines_json: unknown;
  total_xof: number;
  note: string | null;
  source_kind: string | null;
  source_id: string | null;
  payment_method: string | null;
  payment_ref: string | null;
  paid_at: Date | null;
  sent_at: Date | null;
  sent_status: string | null;
  created_by: string | null;
  created_at: Date;
}

export function invoiceLines(inv: Invoice): InvoiceLine[] {
  const raw = Array.isArray(inv.lines_json) ? inv.lines_json : [];
  return raw
    .filter(
      (l: any) =>
        typeof l?.label === "string" &&
        Number.isFinite(l?.qty) &&
        Number.isFinite(l?.unit_xof) &&
        Number.isFinite(l?.total_xof),
    )
    .map((l: any) => ({
      label: String(l.label),
      qty: Number(l.qty),
      unit_xof: Number(l.unit_xof),
      total_xof: Number(l.total_xof),
    }));
}

/**
 * Mint the next FAC-YYYY-NNNN. Atomic per-year counter: the single ON CONFLICT
 * statement takes the row lock, so concurrent creations never collide. Dakar is
 * UTC year-round, so getUTCFullYear() is the studio's calendar year.
 */
export async function nextInvoiceNumber(now = new Date()): Promise<string> {
  const year = now.getUTCFullYear();
  const res = await pool.query(
    `insert into app_state (key, value) values ($1, '1')
       on conflict (key) do update
         set value = ((app_state.value)::int + 1)::text, updated_at = now()
     returning value`,
    [`invoice_seq_${year}`],
  );
  return formatInvoiceNumber(year, Number(res.rows[0].value));
}

export interface CreateInvoiceInput {
  client_name: string;
  client_phone: string | null;
  client_ref: string | null;
  lines: InvoiceLine[];
  total_xof: number;
  note: string | null;
  source_kind: string;
  source_id: string | null;
  payment_method: string | null;
  payment_ref: string | null;
  paid_at: Date | null;
  created_by: string | null;
}

/** Mint a number then insert the invoice. A DB fault between the two burns a
 *  number (harmless gap) — acceptable, keeps numbering strictly increasing. */
export async function createInvoice(input: CreateInvoiceInput): Promise<Invoice> {
  const number = await nextInvoiceNumber();
  const res = await pool.query(
    `insert into invoices
       (number, client_name, client_phone, client_ref, lines_json, total_xof, note,
        source_kind, source_id, payment_method, payment_ref, paid_at, created_by)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
     returning *`,
    [
      number,
      input.client_name,
      input.client_phone,
      input.client_ref,
      JSON.stringify(input.lines),
      input.total_xof,
      input.note,
      input.source_kind,
      input.source_id,
      input.payment_method,
      input.payment_ref,
      input.paid_at,
      input.created_by,
    ],
  );
  return res.rows[0] as Invoice;
}

export async function findInvoice(id: string): Promise<Invoice | null> {
  if (!UUID_RE.test(String(id))) return null;
  const res = await pool.query(`select * from invoices where id = $1`, [id]);
  return (res.rows[0] as Invoice) ?? null;
}

/**
 * The invoice already emitted for a given paid item, if any — one facture per
 * payment: re-asking resends the SAME number instead of minting a new one
 * (immutability + no duplicate numbers for the same transaction).
 */
export async function findInvoiceBySource(
  sourceKind: string,
  sourceId: string,
): Promise<Invoice | null> {
  if (!UUID_RE.test(String(sourceId))) return null;
  const res = await pool.query(
    `select * from invoices where source_kind = $1 and source_id = $2
      order by created_at desc limit 1`,
    [sourceKind, sourceId],
  );
  return (res.rows[0] as Invoice) ?? null;
}

export async function listInvoices(limit = 100): Promise<Invoice[]> {
  const res = await pool.query(`select * from invoices order by created_at desc limit $1`, [limit]);
  return res.rows as Invoice[];
}

export async function markInvoiceSent(
  id: string,
  status: "sent" | "failed" | "window_closed",
): Promise<void> {
  await pool.query(
    `update invoices
        set sent_status = $2,
            sent_at = case when $2 = 'sent' then now() else sent_at end
      where id = $1`,
    [id, status],
  );
}

// ---------- prefill: recent paid items across all clients ----------

export interface InvoiceCandidate {
  kind: "booking" | "plan" | "cafe" | "delivery";
  id: string;
  clientName: string;
  clientPhone: string | null;
  lines: InvoiceLine[];
  totalXof: number;
  paidVia: string;
  paymentRef: string | null;
  paidAt: Date;
}

function extrasToLines(value: unknown): InvoiceLine[] {
  return extrasFromJson(value).map((e: ExtraLine) => ({
    label: e.name,
    qty: e.qty,
    unit_xof: e.unitPriceXof,
    total_xof: e.lineTotalXof,
  }));
}

/** Last-30-days paid items across bookings/plans/cafes/deliveries, ~15 rows,
 *  each ready to prefill a facture (client + lines + payment). */
export async function recentPaidCandidates(): Promise<InvoiceCandidate[]> {
  const [bookings, plans, cafes, deliveries] = await Promise.all([
    pool.query(
      `select b.id, b.service_name, b.slot_start, b.amount_xof, b.wave_session_id,
              b.payment_method, b.updated_at, b.created_at, c.name as client_name, c.wa_phone
         from pending_bookings b join clients c on c.id = b.client_id
        where b.status = 'BOOKED' and b.amount_xof > 0
          and b.updated_at > now() - interval '30 days'
        order by b.updated_at desc limit 10`,
    ),
    pool.query(
      `select p.id, p.plan_name, p.amount_xof, p.wave_session_id, p.payment_method,
              p.updated_at, p.created_at, c.name as client_name, c.wa_phone
         from pending_plan_orders p join clients c on c.id = p.client_id
        where p.status in ('ACTIVATED','PAID')
          and p.updated_at > now() - interval '30 days'
        order by p.updated_at desc limit 10`,
    ),
    pool.query(
      `select o.id, o.service_name, o.extras_json, o.amount_xof, o.wave_session_id,
              o.payment_method, o.updated_at, o.created_at, c.name as client_name, c.wa_phone
         from pending_cafe_orders o join clients c on c.id = o.client_id
        where o.status = 'PAID'
          and o.updated_at > now() - interval '30 days'
        order by o.updated_at desc limit 10`,
    ),
    pool.query(
      `select id, client_name, client_phone, items_json, amount_xof, delivered_at,
              updated_at, created_at
         from delivery_orders
        where status = 'DELIVERED'
          and coalesce(delivered_at, updated_at) > now() - interval '30 days'
        order by coalesce(delivered_at, updated_at) desc limit 10`,
    ),
  ]);

  const out: InvoiceCandidate[] = [];
  for (const b of bookings.rows) {
    const dateLabel = b.slot_start
      ? ` — ${new Date(b.slot_start).toLocaleDateString("fr-FR", { timeZone: "Africa/Dakar", day: "2-digit", month: "2-digit" })}`
      : "";
    out.push({
      kind: "booking",
      id: b.id,
      clientName: b.client_name ?? "?",
      clientPhone: b.wa_phone ?? null,
      lines: [{ label: `${b.service_name}${dateLabel}`, qty: 1, unit_xof: b.amount_xof, total_xof: b.amount_xof }],
      totalXof: b.amount_xof,
      paidVia: paymentMethodLabel(b.payment_method),
      paymentRef: b.wave_session_id || null,
      paidAt: new Date(b.updated_at ?? b.created_at),
    });
  }
  for (const p of plans.rows) {
    out.push({
      kind: "plan",
      id: p.id,
      clientName: p.client_name ?? "?",
      clientPhone: p.wa_phone ?? null,
      lines: [{ label: `Abonnement — ${p.plan_name}`, qty: 1, unit_xof: p.amount_xof, total_xof: p.amount_xof }],
      totalXof: p.amount_xof,
      paidVia: paymentMethodLabel(p.payment_method),
      paymentRef: p.wave_session_id || null,
      paidAt: new Date(p.updated_at ?? p.created_at),
    });
  }
  for (const o of cafes.rows) {
    const lines = extrasToLines(o.extras_json);
    out.push({
      kind: "cafe",
      id: o.id,
      clientName: o.client_name ?? "?",
      clientPhone: o.wa_phone ?? null,
      lines: lines.length ? lines : [{ label: "Commande bar", qty: 1, unit_xof: o.amount_xof, total_xof: o.amount_xof }],
      totalXof: o.amount_xof,
      paidVia: paymentMethodLabel(o.payment_method),
      paymentRef: o.wave_session_id || null,
      paidAt: new Date(o.updated_at ?? o.created_at),
    });
  }
  for (const d of deliveries.rows) {
    const lines = extrasToLines(d.items_json);
    out.push({
      kind: "delivery",
      id: d.id,
      clientName: d.client_name ?? "?",
      clientPhone: d.client_phone ?? null,
      lines: lines.length ? lines : [{ label: "Livraison bar", qty: 1, unit_xof: d.amount_xof, total_xof: d.amount_xof }],
      totalXof: d.amount_xof,
      paidVia: "Espèces / à la livraison",
      paymentRef: null,
      paidAt: new Date(d.delivered_at ?? d.updated_at ?? d.created_at),
    });
  }
  out.sort((a, b) => b.paidAt.getTime() - a.paidAt.getTime());
  return out.slice(0, 15);
}
