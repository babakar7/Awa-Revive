import { pool } from "../db/index.js";

/**
 * SQL for the room's service areas (Canapé / Terrasse / Pergola). Seeded once in
 * schema.ts; this module reads them for the reception PWA and (later) edits the
 * diagram. Areas are few and stable, so reads are simple ordered selects.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ServiceArea {
  id: string;
  code: string;
  name: string;
  diagram_url: string | null;
  diagram_version: number;
  sort_order: number;
  active: boolean;
}

const COLS = "id, code, name, diagram_url, diagram_version, sort_order, active";

export async function listActiveAreas(): Promise<ServiceArea[]> {
  const res = await pool.query(
    `select ${COLS} from service_areas where active order by sort_order, name`,
  );
  return res.rows as ServiceArea[];
}

export async function getArea(id: string): Promise<ServiceArea | null> {
  if (!UUID_RE.test(String(id))) return null;
  const res = await pool.query(`select ${COLS} from service_areas where id = $1`, [id]);
  return (res.rows[0] as ServiceArea) ?? null;
}
