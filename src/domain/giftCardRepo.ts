import { pool } from "../db/index.js";
import type { GiftCardFormData } from "./giftCardRules.js";

/**
 * SQL for gift cards. Marketing objects, not accounting documents: no number,
 * no update/delete (an error = generate a new one). markGiftCardSent records
 * the WhatsApp delivery outcome, not the card content. Same best-effort,
 * no-transaction house style as invoiceRepo.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface GiftCard {
  id: string;
  offer_line1: string;
  offer_line2: string | null;
  recipient_name: string;
  from_name: string;
  send_phone: string | null;
  sent_at: Date | null;
  sent_status: string | null;
  created_by: string | null;
  created_at: Date;
}

export async function createGiftCard(
  data: GiftCardFormData,
  createdBy: string | null,
): Promise<GiftCard> {
  const res = await pool.query(
    `insert into gift_cards
       (offer_line1, offer_line2, recipient_name, from_name, send_phone, created_by)
     values ($1,$2,$3,$4,$5,$6)
     returning *`,
    [data.offer_line1, data.offer_line2, data.recipient_name, data.from_name, data.send_phone, createdBy],
  );
  return res.rows[0] as GiftCard;
}

export async function findGiftCard(id: string): Promise<GiftCard | null> {
  if (!UUID_RE.test(String(id))) return null;
  const res = await pool.query(`select * from gift_cards where id = $1`, [id]);
  return (res.rows[0] as GiftCard) ?? null;
}

export async function listGiftCards(limit = 100): Promise<GiftCard[]> {
  const res = await pool.query(`select * from gift_cards order by created_at desc limit $1`, [limit]);
  return res.rows as GiftCard[];
}

export async function markGiftCardSent(
  id: string,
  status: "sent" | "failed" | "window_closed",
): Promise<void> {
  await pool.query(
    `update gift_cards
        set sent_status = $2,
            sent_at = case when $2 = 'sent' then now() else sent_at end
      where id = $1`,
    [id, status],
  );
}
