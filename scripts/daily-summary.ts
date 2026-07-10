/**
 * Daily plain-text summary (SPEC §5 REFUND_NEEDED + §11 non-goals: "a daily
 * plain-text summary log is enough"). Run manually or via cron:
 *   npm run summary
 */
import "dotenv/config";
import pg from "pg";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

const { rows: booked } = await pool.query(
  `select b.service_name, b.slot_start, b.amount_xof, c.wa_phone, c.name
     from pending_bookings b join clients c on c.id = b.client_id
    where b.status = 'BOOKED' and b.updated_at::date = current_date
    order by b.slot_start`,
);

const { rows: refunds } = await pool.query(
  `select b.id, b.service_name, b.slot_start, b.amount_xof, b.wave_session_id, c.wa_phone, c.name
     from pending_bookings b join clients c on c.id = b.client_id
    where b.status = 'REFUND_NEEDED'
    order by b.updated_at desc`,
);

const { rows: handoffs } = await pool.query(
  `select h.reason, h.created_at, c.wa_phone, c.name
     from handoffs h join clients c on c.id = h.client_id
    where h.created_at::date = current_date
    order by h.created_at`,
);

const { rows: expired } = await pool.query(
  `select count(*)::int as n from pending_bookings
    where status = 'EXPIRED' and updated_at::date = current_date`,
);

console.log(`=== Revive — daily summary ${new Date().toISOString().slice(0, 10)} ===\n`);

console.log(`BOOKINGS TODAY (${booked.length}):`);
for (const b of booked) {
  console.log(`  • ${b.service_name} @ ${b.slot_start.toISOString()} — ${b.name ?? "?"} (${b.wa_phone}) — ${b.amount_xof} XOF`);
}

console.log(`\n⚠️  REFUNDS NEEDED (${refunds.length}) — process manually in the Wave portal:`);
for (const r of refunds) {
  console.log(
    `  • ${r.amount_xof} XOF → ${r.name ?? "?"} (${r.wa_phone}) — ${r.service_name} @ ${r.slot_start.toISOString()}\n` +
      `    booking ${r.id} / wave session ${r.wave_session_id ?? "?"}`,
  );
}

console.log(`\nHANDOFFS TODAY (${handoffs.length}):`);
for (const h of handoffs) {
  console.log(`  • ${h.created_at.toISOString()} — ${h.name ?? "?"} (${h.wa_phone}): ${h.reason}`);
}

console.log(`\nExpired links today: ${expired[0].n}`);

await pool.end();
