import { pool } from "../db/index.js";

/**
 * SQL for the room's FIXED seating spots (the studio's existing physical layout):
 * stable places per area ("Canapé 1", "T3"), each placed once on the area map at
 * a proportional position. Reception taps the real spot to take an order there —
 * there is no "create a table" step. Seeded/edited rarely; reads are simple.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ServiceSpot {
  id: string;
  area_id: string;
  label: string;
  capacity: number | null;
  capacity_max: number | null;
  pos_x: number;
  pos_y: number;
  sort_order: number;
  active: boolean;
}

const COLS = "id, area_id, label, capacity, capacity_max, pos_x, pos_y, sort_order, active";

export async function listActiveSpots(): Promise<ServiceSpot[]> {
  const res = await pool.query(
    `select ${COLS} from service_spots where active order by sort_order, label`,
  );
  return res.rows as ServiceSpot[];
}

export async function getSpot(id: string): Promise<ServiceSpot | null> {
  if (!UUID_RE.test(String(id))) return null;
  const res = await pool.query(`select ${COLS} from service_spots where id = $1`, [id]);
  return (res.rows[0] as ServiceSpot) ?? null;
}
