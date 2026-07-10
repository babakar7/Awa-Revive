/**
 * Mark a REFUND_NEEDED booking as REFUNDED after processing the refund
 * manually in the Wave portal.
 *
 * Usage:
 *   npm run refund:done -- <booking_id>
 *   npm run refund:done -- --list        # show pending refunds
 */
import "dotenv/config";
import pg from "pg";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

const arg = process.argv[2];
if (!arg) {
  console.error("Usage: npm run refund:done -- <booking_id> | --list");
  process.exit(1);
}

if (arg === "--list") {
  const { rows } = await pool.query(
    `select b.id, b.amount_xof, b.service_name, b.wave_session_id, b.updated_at, c.name, c.wa_phone
       from pending_bookings b join clients c on c.id = b.client_id
      where b.status = 'REFUND_NEEDED' order by b.updated_at`,
  );
  if (rows.length === 0) console.log("No pending refunds. ✅");
  for (const r of rows) {
    console.log(
      `${r.id}\n  ${r.amount_xof} XOF — ${r.service_name} — ${r.name ?? "?"} (${r.wa_phone})\n` +
        `  wave session: ${r.wave_session_id} — flagged ${r.updated_at.toISOString()}`,
    );
  }
} else {
  const res = await pool.query(
    `update pending_bookings set status = 'REFUNDED', updated_at = now()
      where id = $1 and status = 'REFUND_NEEDED' returning id, amount_xof, service_name`,
    [arg],
  );
  if (res.rowCount === 0) {
    console.error(`No REFUND_NEEDED booking with id ${arg} (already refunded, or wrong id?)`);
    process.exit(1);
  }
  const b = res.rows[0];
  console.log(`✅ Marked REFUNDED: ${b.id} (${b.amount_xof} XOF — ${b.service_name})`);
}

await pool.end();
